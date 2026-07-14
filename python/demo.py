import json
import time
from pathlib import Path
from web3 import Web3
from eth_account import Account

# ── Configuration ─────────────────────────────────────────────────────────────
DEPLOYMENT_FILE = json.loads(Path("state/deployment.json").read_text())

RPC_URL = DEPLOYMENT_FILE["rpc"]
GAS_PRICE = int(DEPLOYMENT_FILE["gasPrice"])

w3 = Web3(Web3.HTTPProvider(RPC_URL))
from web3.middleware import ExtraDataToPOAMiddleware
w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

assert w3.is_connected(), f"cannot reach geth at {RPC_URL}"


def load_contract_abi(name):
    return json.loads(Path(f"hardhat/artifacts/contracts/{name}.sol/{name}.json").read_text())["abi"]


btc_oracle = w3.eth.contract(
    address=Web3.to_checksum_address(DEPLOYMENT_FILE["oracle"]["address"]), abi=load_contract_abi("BitcoinOracle"))
lending_service = w3.eth.contract(
    address=Web3.to_checksum_address(DEPLOYMENT_FILE["lendingService"]["address"]), abi=load_contract_abi("LendingService"))
LOAN_ABI = load_contract_abi("Loan")

# contributors[0] is the auto-voter's account; the demo deposits for it but does
# NOT vote for it (the bot does). The demo casts votes for [1], [2], and a fresh one.
C0 = Account.from_key(DEPLOYMENT_FILE["contributors"][0]["key"])  # bot's account
C1 = Account.from_key(DEPLOYMENT_FILE["contributors"][1]["key"])
C2 = Account.from_key(DEPLOYMENT_FILE["contributors"][2]["key"])
CF = None                                                     # fresh contributor (created in-demo)
applicants = [Account.from_key(a["key"]) for a in DEPLOYMENT_FILE["applicants"]]
AF = None                                                     # fresh applicant (created in-demo)

BTC_GOOD_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"  # genesis coinbase — definitely funded in the snapshot
BTC_EMPTY_ADDR = "1DemoEmptyAddressNeverRequestedXX"  # never requested -> stays 0 -> liquidity fails

# ── PLACEHOLDERS — insert real addresses from your utxo_snapshot.txt ─────────────
# BTC_ALT_ADDR: any WELL-FUNDED address (large balance) — used as a second good address
#          so the demo performs liquidity checks against more than one address.
# BTC_LOW_ADDR: a LOW-BALANCE address (a few thousand sats) — used to show a liquidity
#          rejection driven by a REAL but insufficient balance (not just a zero).
# Leave them as-is to have the demo SKIP the loans that need them (it warns);
# fill them in to enable those workflows.
BTC_ALT_ADDR = "1AwHZcytLpkAAUyWYu99eUb34ArLBvFngC"
BTC_LOW_ADDR = "18K352vvZr8t31VJbH5Lj2aVSETxgukB1v"


acct_labels = {}  # address -> label, for printing
loan_contracts = {}  # name -> Loan contract


# ── Functions ─────────────────────────────────────────────────────────────────

def get_label(acct):
    return acct_labels.get(acct.address, acct.address[:12] + "…")


def to_wei(x):
    return w3.to_wei(x, "ether")


def get_eth_balance(addr):
    return float(w3.from_wei(w3.eth.get_balance(addr), "ether"))


def calculate_total_due(amount_eth, rate):
    return to_wei(amount_eth) * (100 + rate) // 100


def send_transaction(acct, fn, value=0):
    gas_est = fn.estimate_gas({"from": acct.address, "value": value})
    built = fn.build_transaction({
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "gas": int(gas_est * 1.3),
        "gasPrice": GAS_PRICE,
        "value": value,
    })
    signed_tx = acct.sign_transaction(built)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(tx_hash)


def get_loan_contract(addr):
    return w3.eth.contract(address=addr, abi=LOAN_ABI)


def mine_blocks(n):
    target = w3.eth.block_number + n
    while w3.eth.block_number < target:
        time.sleep(1)


def mine_until_failed(loan):
    while not loan.functions.is_failed().call():
        mine_blocks(2)


def create_funded_account(eth_amount, name):
    acct = Account.create()
    funder = w3.eth.accounts[0]
    tx_hash = w3.eth.send_transaction(
        {"from": funder, "to": acct.address, "value": to_wei(eth_amount),
         "gas": 21_000, "gasPrice": GAS_PRICE})
    w3.eth.wait_for_transaction_receipt(tx_hash)
    acct_labels[acct.address] = name
    print(f"   created + funded {name} {acct.address[:12]}… with {eth_amount} ETH "
          f"(from the prefunded account)")
    return acct


def request_oracle_update(applicant, btc):
    fee = btc_oracle.functions.minimum_fee().call()
    send_transaction(applicant, btc_oracle.functions.request_update(btc), value=fee)
    print(f"   {get_label(applicant)} requested an oracle update for {btc} (fee {fee} wei)")


def wait_for_oracle_update(btc, timeout=90):
    print(f"   waiting for the oracle daemon to push a balance for {btc} …")
    deadline = time.time() + timeout
    while time.time() < deadline:
        bal = btc_oracle.functions.get_balance(btc).call()
        if bal > 0:
            print(f"   daemon pushed {bal} sat (~{bal*30//100_000_000} ETH equiv)")
            return bal
        time.sleep(2)
    raise RuntimeError(
        "oracle daemon did not push a balance in time. Is oracle_daemon.py running, "
        "and does its snapshot contain this address?")


def request_and_wait_for_oracle(applicant, btc):
    request_oracle_update(applicant, btc)
    wait_for_oracle_update(btc)


def banner(t):
    print("\n" + "=" * 82)
    print(t)
    print("=" * 82)


def current_contributors():
    cs = [(C0, "C0(bot)"), (C1, "C1"), (C2, "C2")]
    if CF is not None:
        cs.append((CF, "C-fresh"))
    return cs


def print_snapshot(title=None, involved=None):
    """Print balances of every involved account + relevant state vars."""
    if title:
        print(f"   ── {title} ──")
    for c, name in current_contributors():
        dep = w3.from_wei(lending_service.functions.deposited(c.address).call(), "ether")
        lck = w3.from_wei(lending_service.functions.locked(c.address).call(), "ether")
        print(f"     {name:8} wallet={get_eth_balance(c.address):8.3f}  deposited={dep}  locked={lck}")
    for a in (involved or []):
        print(f"     {get_label(a):8} wallet={get_eth_balance(a.address):8.3f}  (applicant)")
    print(f"     pool: collateralPct={lending_service.functions.collateral_percent().call()}  "
          f"compensationPool={w3.from_wei(lending_service.functions.compensation_pool().call(),'ether')} ETH")


def print_status_table():
    active = 0
    print("   ┌─ loans ─────────────────────────────")
    for name, loan in loan_contracts.items():
        s = loan.functions.successful().call()
        fm = loan.functions.failed_marked().call()
        exp = loan.functions.is_failed().call()
        state = "SUCCESSFUL" if s else ("FAILED (compensated)" if fm else
                                        ("expired, unpaid" if exp else "ACTIVE"))
        if state == "ACTIVE":
            active += 1
        print(f"   │  {name}: {state}")
    print(f"   └─ {active} ACTIVE concurrently")


def oracle_balance_eth_equivalent(btc) -> int:
    """ETH-equivalent (in wei) the contract computes for this address's balance."""
    sats = btc_oracle.functions.get_balance(btc).call()
    return sats * 30 * 10**18 // 100_000_000   # sats * BTC_ETH_RATE * 1e18 / SATOSHIS_PER_BTC


def rejection_reason(amount_wei, btc) -> str:
    """Reproduce resolveProposal's checks (in the same order) to name the reason."""
    cum = sum(lending_service.functions.deposited(c.address).call() - lending_service.functions.locked(c.address).call()
              for c, _ in current_contributors())
    if cum < amount_wei:
        return (f"INSUFFICIENT POOL — cumulative disposable "
                f"{w3.from_wei(cum,'ether')} ETH < requested {w3.from_wei(amount_wei,'ether')} ETH")
    if oracle_balance_eth_equivalent(btc) < amount_wei:
        return (f"BITCOIN LIQUIDITY TOO LOW — oracle balance is "
                f"{w3.from_wei(oracle_balance_eth_equivalent(btc),'ether')} ETH-equiv < requested "
                f"{w3.from_wei(amount_wei,'ether')} ETH")
    return "MAJORITY REJECT — approve weight did not exceed reject weight (non-voters count as reject)"


def failure_reason(loan) -> str:
    principal = loan.functions.lent_amount().call()
    repaid = loan.functions.total_base_repaid().call()
    return (f"expired without full repayment — base repaid "
            f"{w3.from_wei(repaid,'ether')} of {w3.from_wei(principal,'ether')} ETH principal")


def vote_non_bot_contributors(pid, approve=True):
    for c in [C1, C2] + ([CF] if CF is not None else []):
        send_transaction(c, lending_service.functions.vote(pid, approve))
    print(f"   demo cast {'APPROVE' if approve else 'REJECT'} for the non-bot contributors on #{pid}")
    time.sleep(3)   # give the auto-voter a moment to notice and approve as C0
    print("   (auto-voter approves as C0 in its own terminal — its vote is one weight among four)")


def submit_and_resolve_proposal(name, applicant, amount, rate, duration, btc=BTC_GOOD_ADDR, approve=True):
    pid = lending_service.functions.next_proposal_id().call()
    send_transaction(applicant, lending_service.functions.submit_proposal(to_wei(amount), rate, duration, btc))
    print(f"   proposal #{pid} submitted by {get_label(applicant)} "
          f"(amount={amount}, rate={rate}%, dur={duration}, btc={btc})")
    vote_non_bot_contributors(pid, approve=approve)
    mine_blocks(13)
    rc = send_transaction(applicant, lending_service.functions.resolve_proposal(pid))
    ev = lending_service.events.proposal_resolved().process_receipt(rc)[0]["args"]
    approved = ev["approved"]
    if approved:
        print(f"   proposal #{pid} resolved -> APPROVED")
        loan_contracts[name] = get_loan_contract(ev["loan_contract"])
        print_status_table()
        return loan_contracts[name]
    # explain WHY it was rejected by reproducing the contract's checks
    print(f"   proposal #{pid} resolved -> REJECTED: {rejection_reason(to_wei(amount), btc)}")
    return None


def claim_compensation(contributor, name, cname):
    loan = loan_contracts[name]
    before = w3.from_wei(loan.functions.remaining_due(contributor.address).call(), "ether")
    send_transaction(contributor, lending_service.functions.claim_compensation(loan.address))
    after = w3.from_wei(loan.functions.remaining_due(contributor.address).call(), "ether")
    print(f"   {cname} claimed compensation on {name}: owed {before} -> {after} ETH")


# ── Execution ─────────────────────────────────────────────────────────────────

def main():
    global CF, AF
    acct_labels.update({C0.address: "C0(bot)", C1.address: "C1", C2.address: "C2"})
    for i, a in enumerate(applicants):
        acct_labels[a.address] = f"app{i}"

    print("Concurrent-loan demo — run with oracle_daemon.py and auto_voter.py alongside")

    banner("SETUP — three setup contributors deposit (C0 is the auto-voter's account)")
    for c in (C0, C1, C2):
        send_transaction(c, lending_service.functions.deposit(), value=to_wei(30))
    print_snapshot("after initial deposits")

    banner("NEW ACCOUNT — a fresh contributor is created and joins the pool")
    CF = create_funded_account(40, "C-fresh")
    send_transaction(CF, lending_service.functions.deposit(), value=to_wei(30))
    print_snapshot("after the fresh contributor deposits")

    banner("ORACLE — request real balance updates; the daemon pushes them")
    request_and_wait_for_oracle(applicants[0], BTC_GOOD_ADDR)
    request_and_wait_for_oracle(applicants[0], BTC_ALT_ADDR)  # second funded address (if filled in)
    request_and_wait_for_oracle(applicants[0], BTC_LOW_ADDR)  # low-balance address (if filled in)

    banner("TIMELINE — open loans; they become active concurrently")
    submit_and_resolve_proposal("L0(app0)", applicants[0], 6, 50, 1000)  # repaid LAST
    submit_and_resolve_proposal("L2(app2)", applicants[2], 4, 100, 1000)  # repaid EARLY; funds the pool
    # rejection #1 — Bitcoin liquidity: address was never requested, so balance is 0
    submit_and_resolve_proposal("R-btc-zero", applicants[3], 5, 10, 1000, btc=BTC_EMPTY_ADDR)
    # a loan backed by a DIFFERENT funded address (BTC_ALT), if you filled it in
    submit_and_resolve_proposal("L5(app3,alt)", applicants[3], 3, 15, 1000, btc=BTC_ALT_ADDR)  # success later
    l1 = submit_and_resolve_proposal("L1(app1)", applicants[1], 4, 20, 60)  # partial -> later fails
    print_snapshot("after the first wave", involved=[applicants[0], applicants[2]])

    banner("NEW ACCOUNT — a fresh applicant is created and submits a loan")
    AF = create_funded_account(20, "app-fresh")
    l3 = submit_and_resolve_proposal("L3(appF)", AF, 3, 10, 60)  # not repaid -> fails -> compensated by C-fresh
    print_snapshot("after the fresh applicant's loan opens", involved=[AF])

    banner("TIMELINE — partial repayments while other loans run")
    send_transaction(applicants[1], loan_contracts["L1(app1)"].functions.repay(), value=to_wei(1))
    print("   L1 partially repaid (1 ETH)")
    send_transaction(applicants[2], loan_contracts["L2(app2)"].functions.repay(), value=to_wei(1))
    print("   L2 partially repaid (1 ETH)")
    print_snapshot("after partials", involved=[applicants[1], applicants[2]])

    banner("TIMELINE — rejection #2: funding pool has value but not enough")
    submit_and_resolve_proposal("R-pool", applicants[4], 100_000, 10, 1000)

    banner("TIMELINE — rejection #3: contributors vote it DOWN (bot approves but is outvoted)")
    submit_and_resolve_proposal("R-majority", applicants[4], 5, 10, 1000, approve=False)

    # rejection #4 — Bitcoin liquidity with a REAL but insufficient balance (BTC_LOW)
    banner("TIMELINE — rejection #4: real BTC balance exists but is too low for the amount")
    submit_and_resolve_proposal("R-btc-low", applicants[3], 10, 10, 1000, btc=BTC_LOW_ADDR)

    banner("TIMELINE — L2 finishes early (SUCCESSFUL) while L0/L1/L3 still run")
    send_transaction(applicants[2], loan_contracts["L2(app2)"].functions.repay(), value=calculate_total_due(4, 100) - to_wei(1))
    print("   L2 fully repaid")
    print_status_table()
    print_snapshot("after L2 success", involved=[applicants[2]])

    banner("TIMELINE — L1 expires and is compensated")
    mine_until_failed(loan_contracts["L1(app1)"])
    print(f"   L1 FAILED — reason: {failure_reason(loan_contracts['L1(app1)'])}")
    claim_compensation(C1, "L1(app1)", "C1")
    print_snapshot("after C1's compensation on L1")
    print_status_table()

    banner("TIMELINE — L3 (fresh applicant's loan) expires; the FRESH contributor compensates")
    mine_until_failed(loan_contracts["L3(appF)"])
    print(f"   L3 FAILED — reason: {failure_reason(loan_contracts['L3(appF)'])}")
    claim_compensation(CF, "L3(appF)", "C-fresh")
    print_snapshot("after C-fresh's compensation on L3")
    print_status_table()

    banner("TIMELINE — a compensated loan is repaid IN FULL afterward, and STAYS failed")
    # the fresh applicant now repays L3 in full; because it was already failed-marked,
    # it must NOT become successful — demonstrates the 'failed can never succeed' rule
    send_transaction(AF, loan_contracts["L3(appF)"].functions.repay(), value=calculate_total_due(3, 10))
    print(f"   L3 repaid in full after failure — successful={loan_contracts['L3(appF)'].functions.successful().call()} "
          f"(stays failed), failedMarked={loan_contracts['L3(appF)'].functions.failed_marked().call()}")
    print_status_table()

    # if the alt-address loan opened, repay it fully now (a second SUCCESS, different address)
    banner("TIMELINE — L5 (backed by the alternate BTC address) is repaid in full")
    send_transaction(applicants[3], loan_contracts["L5(app3,alt)"].functions.repay(), value=calculate_total_due(3, 15))
    print(f"   L5 repaid — successful={loan_contracts['L5(app3,alt)'].functions.successful().call()}")
    print_status_table()

    banner("TIMELINE — L0 is finally repaid in full, LAST")
    send_transaction(applicants[0], loan_contracts["L0(app0)"].functions.repay(), value=calculate_total_due(6, 50))
    print("   L0 fully repaid")
    print_status_table()
    print_snapshot("after L0 success", involved=[applicants[0]])

    banner("TIMELINE — a contributor withdraws part of their freed disposable value")
    send_transaction(C2, lending_service.functions.withdraw(to_wei(3)))
    print("   C2 withdrew 3 ETH")
    print_snapshot("after withdrawal")

    banner("DONE — final state")
    print_snapshot("final")
    print_status_table()


if __name__ == "__main__":
    main()
