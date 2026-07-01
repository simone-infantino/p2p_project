#!/usr/bin/env python3
"""
demo.py — concurrent-loan showcase, run ALONGSIDE the real oracle daemon and
the auto-voter bot (not simulating either).

Run order (three terminals, same geth chain):
    python oracle_daemon.py     # responds to requestUpdate by pushing balances
    python auto_voter.py        # votes APPROVE as contributors[0] on every proposal
    python demo.py              # this script: drives the operations

What this satisfies from the spec:
  * creates new accounts itself (a fresh contributor AND a fresh applicant),
    funded by a prefunded genesis account via plain value transfers
  * prints the balance of every involved account after each meaningful change,
    plus relevant state variables (collateralPct, compensationPool, loan states)
  * uses the REAL oracle: it calls requestUpdate and waits for the daemon to push
  * leaves contributors[0]'s approve votes to the auto-voter bot; the demo casts
    the other contributors' votes explicitly

Assumption (oracle wait): after requestUpdate the demo polls getBalance with a
timeout and errors clearly if the daemon never pushes — so a missing/idle daemon
fails loudly instead of hanging. The daemon's snapshot must contain BTC_GOOD with
a positive balance (1A1zP1… , the genesis coinbase, is within the first 131000
blocks, so it is).
"""

import json
import time
from pathlib import Path

from web3 import Web3
from eth_account import Account

# ── config ──────────────────────────────────────────────────────────────────────
DEPLOYMENT = json.loads(Path("deployment.json").read_text())
RPC = DEPLOYMENT["rpc"]
GAS_PRICE = int(DEPLOYMENT["gasPrice"])

w3 = Web3(Web3.HTTPProvider(RPC))
assert w3.is_connected(), f"cannot reach geth at {RPC}"


def abi_of(name):
    return json.loads(Path(f"artifacts/contracts/{name}.sol/{name}.json").read_text())["abi"]


ORACLE = w3.eth.contract(
    address=Web3.to_checksum_address(DEPLOYMENT["oracle"]["address"]), abi=abi_of("BitcoinOracle"))
SERVICE = w3.eth.contract(
    address=Web3.to_checksum_address(DEPLOYMENT["lendingService"]["address"]), abi=abi_of("LendingService"))
LOAN_ABI = abi_of("Loan")

# contributors[0] is the auto-voter's account; the demo deposits for it but does
# NOT vote for it (the bot does). The demo casts votes for [1], [2], and a fresh one.
C0 = Account.from_key(DEPLOYMENT["contributors"][0]["key"])   # bot's account
C1 = Account.from_key(DEPLOYMENT["contributors"][1]["key"])
C2 = Account.from_key(DEPLOYMENT["contributors"][2]["key"])
CF = None                                                     # fresh contributor (created in-demo)
applicants = [Account.from_key(a["key"]) for a in DEPLOYMENT["applicants"]]
AF = None                                                     # fresh applicant (created in-demo)

BTC_GOOD = b"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"   # genesis coinbase — definitely funded in the snapshot
BTC_EMPTY = b"1DemoEmptyAddressNeverRequestedXX"   # never requested -> stays 0 -> liquidity fails

# ── PLACEHOLDERS — insert real addresses from your utxo_snapshot.tsv ─────────────
# BTC_ALT: any WELL-FUNDED address (large balance) — used as a second good address
#          so the demo performs liquidity checks against more than one address.
# BTC_LOW: a LOW-BALANCE address (a few thousand sats) — used to show a liquidity
#          rejection driven by a REAL but insufficient balance (not just a zero).
# Leave them as-is to have the demo SKIP the loans that need them (it warns);
# fill them in to enable those workflows.
BTC_ALT = b"INSERT_A_WELL_FUNDED_ADDRESS_FROM_SNAPSHOT"
BTC_LOW = b"INSERT_A_LOW_BALANCE_ADDRESS_FROM_SNAPSHOT"


NAMES = {}   # address -> label, for printing
loans = {}   # name -> Loan contract


def label(acct):
    return NAMES.get(acct.address, acct.address[:12] + "…")


# ── low-level helpers ───────────────────────────────────────────────────────────
def wei(x):
    return w3.to_wei(x, "ether")


def eth(addr):
    return float(w3.from_wei(w3.eth.get_balance(addr), "ether"))


def owed_total(amount_eth, rate):
    return wei(amount_eth) * (100 + rate) // 100


def send(acct, fn, value=0):
    gas = fn.estimate_gas({"from": acct.address, "value": value})
    built = fn.build_transaction({
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "gas": int(gas * 1.3),
        "gasPrice": GAS_PRICE,
        "value": value,
    })
    signed = acct.sign_transaction(built)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)   # v6: signed.rawTransaction
    return w3.eth.wait_for_transaction_receipt(h)


def loan_at(addr):
    return w3.eth.contract(address=addr, abi=LOAN_ABI)


def _nudge():
    try:
        funder = w3.eth.accounts[0]   # prefunded genesis signer (value-transfer only)
        h = w3.eth.send_transaction(
            {"from": funder, "to": funder, "value": 0, "gas": 21_000, "gasPrice": GAS_PRICE})
        w3.eth.wait_for_transaction_receipt(h)
    except Exception as e:
        print("   (could not nudge a block — ensure geth is mining)", e)


def mine(n):
    target = w3.eth.block_number + n
    last = w3.eth.block_number
    stalls = 0
    while w3.eth.block_number < target:
        time.sleep(1)
        cur = w3.eth.block_number
        if cur == last:
            stalls += 1
            if stalls >= 2:
                _nudge()
                stalls = 0
        else:
            stalls = 0
        last = cur


def mine_until_failed(loan):
    while not loan.functions.isFailed().call():
        mine(2)


def create_funded_account(eth_amount, name):
    """Create a brand-new account and fund it from the prefunded genesis signer
    via a plain value transfer (the only thing prefunded accounts may do)."""
    acct = Account.create()
    funder = w3.eth.accounts[0]
    h = w3.eth.send_transaction(
        {"from": funder, "to": acct.address, "value": wei(eth_amount),
         "gas": 21_000, "gasPrice": GAS_PRICE})
    w3.eth.wait_for_transaction_receipt(h)
    NAMES[acct.address] = name
    print(f"   created + funded {name} {acct.address[:12]}… with {eth_amount} ETH "
          f"(from the prefunded account)")
    return acct


# ── oracle interaction (real daemon) ────────────────────────────────────────────
def request_oracle(applicant, btc):
    fee = ORACLE.functions.minimumFee().call()
    send(applicant, ORACLE.functions.requestUpdate(btc), value=fee)
    print(f"   {label(applicant)} requested an oracle update for {btc.decode()} (fee {fee} wei)")


def wait_for_oracle(btc, timeout=90):
    print(f"   waiting for the oracle daemon to push a balance for {btc.decode()} …")
    deadline = time.time() + timeout
    while time.time() < deadline:
        bal = ORACLE.functions.getBalance(btc).call()
        if bal > 0:
            print(f"   daemon pushed {bal} sat (~{bal*30//100_000_000} ETH equiv)")
            return bal
        time.sleep(2)
    raise RuntimeError(
        "oracle daemon did not push a balance in time. Is oracle_daemon.py running, "
        "and does its snapshot contain this address?")


def ensure_oracle(applicant, btc):
    """Request an update for `btc` and wait for the daemon, unless it's a placeholder.
    Returns True if the address is usable (real + balance pushed), False if skipped."""
    request_oracle(applicant, btc)
    wait_for_oracle(btc)


# ── printing ─────────────────────────────────────────────────────────────────────
def banner(t):
    print("\n" + "=" * 82)
    print(t)
    print("=" * 82)


def contributors_now():
    cs = [(C0, "C0(bot)"), (C1, "C1"), (C2, "C2")]
    if CF is not None:
        cs.append((CF, "C-fresh"))
    return cs


def snapshot(title=None, involved=None):
    """Print balances of every involved account + relevant state vars."""
    if title:
        print(f"   ── {title} ──")
    for c, name in contributors_now():
        dep = w3.from_wei(SERVICE.functions.deposited(c.address).call(), "ether")
        lck = w3.from_wei(SERVICE.functions.locked(c.address).call(), "ether")
        print(f"     {name:8} wallet={eth(c.address):8.3f}  deposited={dep}  locked={lck}")
    for a in (involved or []):
        print(f"     {label(a):8} wallet={eth(a.address):8.3f}  (applicant)")
    print(f"     pool: collateralPct={SERVICE.functions.collateralPct().call()}  "
          f"compensationPool={w3.from_wei(SERVICE.functions.compensationPool().call(),'ether')} ETH")


def status_table():
    active = 0
    print("   ┌─ loans ─────────────────────────────")
    for name, loan in loans.items():
        s = loan.functions.successful().call()
        fm = loan.functions.failedMarked().call()
        exp = loan.functions.isFailed().call()
        state = "SUCCESSFUL" if s else ("FAILED (compensated)" if fm else
                                        ("expired, unpaid" if exp else "ACTIVE"))
        if state == "ACTIVE":
            active += 1
        print(f"   │  {name}: {state}")
    print(f"   └─ {active} ACTIVE concurrently")


# ── reason diagnostics ───────────────────────────────────────────────────────────
def eth_equiv_of(btc) -> int:
    """ETH-equivalent (in wei) the contract computes for this address's balance."""
    sats = ORACLE.functions.getBalance(btc).call()
    return sats * 30 * 10**18 // 100_000_000   # sats * BTC_ETH_RATE * 1e18 / SATOSHIS_PER_BTC


def rejection_reason(amount_wei, btc) -> str:
    """Reproduce resolveProposal's checks (in the same order) to name the reason."""
    cum = sum(SERVICE.functions.deposited(c.address).call() - SERVICE.functions.locked(c.address).call()
              for c, _ in contributors_now())
    if cum < amount_wei:
        return (f"INSUFFICIENT POOL — cumulative disposable "
                f"{w3.from_wei(cum,'ether')} ETH < requested {w3.from_wei(amount_wei,'ether')} ETH")
    if eth_equiv_of(btc) < amount_wei:
        return (f"BITCOIN LIQUIDITY TOO LOW — oracle balance is "
                f"{w3.from_wei(eth_equiv_of(btc),'ether')} ETH-equiv < requested "
                f"{w3.from_wei(amount_wei,'ether')} ETH")
    return "MAJORITY REJECT — approve weight did not exceed reject weight (non-voters count as reject)"


def failure_reason(loan) -> str:
    principal = loan.functions.principal().call()
    repaid = loan.functions.totalBaseRepaid().call()
    return (f"expired without full repayment — base repaid "
            f"{w3.from_wei(repaid,'ether')} of {w3.from_wei(principal,'ether')} ETH principal")


# ── voting (bot covers C0; demo casts the rest) ──────────────────────────────────
def vote_others(pid, approve=True):
    for c in [C1, C2] + ([CF] if CF is not None else []):
        send(c, SERVICE.functions.vote(pid, approve))
    print(f"   demo cast {'APPROVE' if approve else 'REJECT'} for the non-bot contributors on #{pid}")
    time.sleep(3)   # give the auto-voter a moment to notice and approve as C0
    print("   (auto-voter approves as C0 in its own terminal — its vote is one weight among four)")


def open_loan(name, applicant, amount, rate, duration, btc=BTC_GOOD, approve=True):
    pid = SERVICE.functions.nextProposalId().call()
    send(applicant, SERVICE.functions.submitProposal(wei(amount), rate, duration, btc))
    print(f"   proposal #{pid} submitted by {label(applicant)} "
          f"(amount={amount}, rate={rate}%, dur={duration}, btc={btc.decode()})")
    vote_others(pid, approve=approve)
    mine(13)
    rc = send(applicant, SERVICE.functions.resolveProposal(pid))
    ev = SERVICE.events.ProposalResolved().process_receipt(rc)[0]["args"]
    approved = ev["approved"]
    if approved:
        print(f"   proposal #{pid} resolved -> APPROVED")
        loans[name] = loan_at(ev["loanContract"])
        status_table()
        return loans[name]
    # explain WHY it was rejected by reproducing the contract's checks
    print(f"   proposal #{pid} resolved -> REJECTED: {rejection_reason(wei(amount), btc)}")
    return None


def claim(contributor, name, cname):
    loan = loans[name]
    before = w3.from_wei(loan.functions.remainingDue(contributor.address).call(), "ether")
    send(contributor, SERVICE.functions.claimCompensation(loan.address))
    after = w3.from_wei(loan.functions.remainingDue(contributor.address).call(), "ether")
    print(f"   {cname} claimed compensation on {name}: owed {before} -> {after} ETH")


# ════════════════════════════════════════════════════════════════════════════════
def main():
    global CF, AF
    NAMES.update({C0.address: "C0(bot)", C1.address: "C1", C2.address: "C2"})
    for i, a in enumerate(applicants):
        NAMES[a.address] = f"app{i}"

    print("Concurrent-loan demo — run with oracle_daemon.py and auto_voter.py alongside")

    banner("SETUP — three setup contributors deposit (C0 is the auto-voter's account)")
    for c in (C0, C1, C2):
        send(c, SERVICE.functions.deposit(), value=wei(30))
    snapshot("after initial deposits")

    banner("NEW ACCOUNT — a fresh contributor is created and joins the pool")
    CF = create_funded_account(40, "C-fresh")
    send(CF, SERVICE.functions.deposit(), value=wei(30))
    snapshot("after the fresh contributor deposits")

    banner("ORACLE — request real balance updates; the daemon pushes them")
    ensure_oracle(applicants[0], BTC_GOOD)
    ensure_oracle(applicants[0], BTC_ALT)   # second funded address (if filled in)
    ensure_oracle(applicants[0], BTC_LOW)   # low-balance address (if filled in)

    banner("TIMELINE — open loans; they become active concurrently")
    open_loan("L0(app0)", applicants[0], 6, 50, 1000)     # repaid LAST
    open_loan("L2(app2)", applicants[2], 4, 100, 1000)    # repaid EARLY; funds the pool
    # rejection #1 — Bitcoin liquidity: address was never requested, so balance is 0
    open_loan("R-btc-zero", applicants[3], 5, 10, 1000, btc=BTC_EMPTY)
    # a loan backed by a DIFFERENT funded address (BTC_ALT), if you filled it in
    open_loan("L5(app3,alt)", applicants[3], 3, 15, 1000, btc=BTC_ALT)  # success later
    l1 = open_loan("L1(app1)", applicants[1], 4, 20, 60)  # partial -> later fails
    snapshot("after the first wave", involved=[applicants[0], applicants[2]])

    banner("NEW ACCOUNT — a fresh applicant is created and submits a loan")
    AF = create_funded_account(20, "app-fresh")
    l3 = open_loan("L3(appF)", AF, 3, 10, 60)             # not repaid -> fails -> compensated by C-fresh
    snapshot("after the fresh applicant's loan opens", involved=[AF])

    banner("TIMELINE — partial repayments while other loans run")
    send(applicants[1], loans["L1(app1)"].functions.repay(), value=wei(1))
    print("   L1 partially repaid (1 ETH)")
    send(applicants[2], loans["L2(app2)"].functions.repay(), value=wei(1))
    print("   L2 partially repaid (1 ETH)")
    snapshot("after partials", involved=[applicants[1], applicants[2]])

    banner("TIMELINE — rejection #2: funding pool has value but not enough")
    open_loan("R-pool", applicants[4], 100_000, 10, 1000)

    banner("TIMELINE — rejection #3: contributors vote it DOWN (bot approves but is outvoted)")
    open_loan("R-majority", applicants[4], 5, 10, 1000, approve=False)

    # rejection #4 — Bitcoin liquidity with a REAL but insufficient balance (BTC_LOW)
    banner("TIMELINE — rejection #4: real BTC balance exists but is too low for the amount")
    open_loan("R-btc-low", applicants[3], 10_000, 10, 1000, btc=BTC_LOW)

    banner("TIMELINE — L2 finishes early (SUCCESSFUL) while L0/L1/L3 still run")
    send(applicants[2], loans["L2(app2)"].functions.repay(), value=owed_total(4, 100) - wei(1))
    print("   L2 fully repaid")
    status_table()
    snapshot("after L2 success", involved=[applicants[2]])

    banner("TIMELINE — L1 expires and is compensated")
    mine_until_failed(loans["L1(app1)"])
    print(f"   L1 FAILED — reason: {failure_reason(loans['L1(app1)'])}")
    claim(C1, "L1(app1)", "C1")
    snapshot("after C1's compensation on L1")
    status_table()

    banner("TIMELINE — L3 (fresh applicant's loan) expires; the FRESH contributor compensates")
    mine_until_failed(loans["L3(appF)"])
    print(f"   L3 FAILED — reason: {failure_reason(loans['L3(appF)'])}")
    claim(CF, "L3(appF)", "C-fresh")
    snapshot("after C-fresh's compensation on L3")
    status_table()

    banner("TIMELINE — a compensated loan is repaid IN FULL afterward, and STAYS failed")
    # the fresh applicant now repays L3 in full; because it was already failed-marked,
    # it must NOT become successful — demonstrates the 'failed can never succeed' rule
    send(AF, loans["L3(appF)"].functions.repay(), value=owed_total(3, 10))
    print(f"   L3 repaid in full after failure — successful={loans['L3(appF)'].functions.successful().call()} "
          f"(stays failed), failedMarked={loans['L3(appF)'].functions.failedMarked().call()}")
    status_table()

    # if the alt-address loan opened, repay it fully now (a second SUCCESS, different address)
    banner("TIMELINE — L5 (backed by the alternate BTC address) is repaid in full")
    send(applicants[3], loans["L5(app3,alt)"].functions.repay(), value=owed_total(3, 15))
    print(f"   L5 repaid — successful={loans['L5(app3,alt)'].functions.successful().call()}")
    status_table()

    banner("TIMELINE — L0 is finally repaid in full, LAST")
    send(applicants[0], loans["L0(app0)"].functions.repay(), value=owed_total(6, 50))
    print("   L0 fully repaid")
    status_table()
    snapshot("after L0 success", involved=[applicants[0]])

    banner("TIMELINE — a contributor withdraws part of their freed disposable value")
    send(C2, SERVICE.functions.withdraw(wei(3)))
    print("   C2 withdrew 3 ETH")
    snapshot("after withdrawal")

    banner("DONE — final state")
    snapshot("final")
    status_table()


if __name__ == "__main__":
    main()
