import json
import time

from pathlib import Path
from web3 import Web3
from eth_account import Account


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

C0 = Account.from_key(DEPLOYMENT_FILE["contributors"][0]["key"])  # Auto voter
C1 = Account.from_key(DEPLOYMENT_FILE["contributors"][1]["key"])
C2 = Account.from_key(DEPLOYMENT_FILE["contributors"][2]["key"])
new_contributor = None

applicants = [Account.from_key(a["key"]) for a in DEPLOYMENT_FILE["applicants"]]
new_applicant = None

BTC_GENESIS_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
BTC_GOOD_ADDR = "1AwHZcytLpkAAUyWYu99eUb34ArLBvFngC"
BTC_LOW_ADDR = "18K352vvZr8t31VJbH5Lj2aVSETxgukB1v"
BTC_EMPTY_ADDR = "1DemoEmptyAddressNeverRequestedXX"

acct_labels = {}
loan_contracts = {}


def get_account_label(acct):
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
    print(f"   {get_account_label(applicant)} requested an oracle update for {btc} (fee {fee} wei)")


def wait_for_oracle_update(btc, timeout=90):
    print(f"   - waiting for the oracle daemon to push a balance for {btc} …")
    deadline = time.time() + timeout
    while time.time() < deadline:
        bal = btc_oracle.functions.get_balance(btc).call()
        if bal > 0:
            print(f"   - Daemon pushed {bal} sat (~{bal*30//100_000_000} ETH equiv)")
            return bal
        time.sleep(2)
    raise RuntimeError("Oracle Daemon did not push a balance in time. Check daemon execution and address.")


def request_and_wait_for_oracle(applicant, btc):
    request_oracle_update(applicant, btc)
    wait_for_oracle_update(btc)


def current_contributors():
    cs = [(C0, "C0 (bot)"), (C1, "C1"), (C2, "C2")]
    if new_contributor is not None:
        cs.append((new_contributor, "new contributor"))
    return cs


def print_snapshot(involved_applicants=None):
    for c, name in current_contributors():
        deposited = w3.from_wei(lending_service.functions.deposited(c.address).call(), "ether")
        locked = w3.from_wei(lending_service.functions.locked(c.address).call(), "ether")
        print(f"     {name:8} wallet: {get_eth_balance(c.address):8.3f}  deposited: {deposited}  locked: {locked}")
    for it in (involved_applicants or []):
        print(f"     {get_account_label(it):8} wallet: {get_eth_balance(it.address):8.3f}  (applicant)")
    print(f"     Pool Collateral Percentage: {lending_service.functions.collateral_percent().call()}   "
          f"Compensation Pool: {w3.from_wei(lending_service.functions.compensation_pool().call(),'ether')} ETH")


def print_status_table():
    print("      Loans:")
    for name, loan in loan_contracts.items():
        succ = loan.functions.successful().call()
        failed_marked = loan.functions.failed_marked().call()
        expired = loan.functions.is_failed().call()
        state = "SUCCESSFUL" if succ else ("FAILED (compensated)" if failed_marked else
                                        ("Expired, unpaid" if expired else "ACTIVE"))
        print(f"      - {name}: {state}")


def oracle_balance_wei_equivalent(btc) -> int:
    sats = btc_oracle.functions.get_balance(btc).call()
    return sats * 30 * 10**18 // 100_000_000


def rejection_reason(amount_wei, btc) -> str:
    cumulative_disposable = sum(lending_service.functions.deposited(c.address).call() - lending_service.functions.locked(c.address).call()
              for c, _ in current_contributors())
    if cumulative_disposable < amount_wei:
        return (f"INSUFFICIENT POOL — cumulative disposable "
                f"{w3.from_wei(cumulative_disposable,'ether')} ETH < requested {w3.from_wei(amount_wei,'ether')} ETH")
    if oracle_balance_wei_equivalent(btc) < amount_wei:
        return (f"BITCOIN LIQUIDITY TOO LOW — oracle balance is "
                f"{w3.from_wei(oracle_balance_wei_equivalent(btc),'ether')} ETH-equiv < requested "
                f"{w3.from_wei(amount_wei,'ether')} ETH")
    return "MAJORITY REJECT — approve weight did not exceed reject weight (non-voters count as reject)"


def failure_reason(loan) -> str:
    lent_amount = loan.functions.lent_amount().call()
    repaid = loan.functions.total_base_repaid().call()
    return (f"Expired without full repayment — base repaid "
            f"{w3.from_wei(repaid,'ether')} of {w3.from_wei(lent_amount,'ether')} ETH principal")


def vote_non_bot_contributors(pid, approve=True):
    for c in [C1, C2] + ([new_contributor] if new_contributor is not None else []):
        send_transaction(c, lending_service.functions.vote(pid, approve))
    print(f"   Demo cast {'APPROVE' if approve else 'REJECT'} for the non-bot contributors on #{pid}")
    time.sleep(3)   # Give the auto-voter time to notice the proposal_submitted event


def submit_and_resolve_proposal(name, applicant, amount, rate, duration, btc=BTC_GENESIS_ADDR, approve=True):
    pid = lending_service.functions.next_proposal_id().call()
    send_transaction(applicant, lending_service.functions.submit_proposal(to_wei(amount), rate, duration, btc))
    print(f"   Proposal #{pid} submitted by {get_account_label(applicant)} "
          f"(amount: {amount}, rate: {rate}%, dur: {duration}, btc: {btc})")
    vote_non_bot_contributors(pid, approve=approve)
    mine_blocks(13)

    receipt = send_transaction(applicant, lending_service.functions.resolve_proposal(pid))
    event = lending_service.events.proposal_resolved().process_receipt(receipt)[0]["args"]
    approved = event["approved"]
    if approved:
        print(f"   Proposal #{pid}: APPROVED")
        loan_contracts[name] = get_loan_contract(event["loan_contract"])
        print_status_table()
        return loan_contracts[name]
    print(f"   Proposal #{pid}: REJECTED: {rejection_reason(to_wei(amount), btc)}")
    return None


def claim_compensation(contributor, name, cname):
    loan = loan_contracts[name]
    before = w3.from_wei(loan.functions.remaining_due(contributor.address).call(), "ether")
    send_transaction(contributor, lending_service.functions.claim_compensation(loan.address))
    after = w3.from_wei(loan.functions.remaining_due(contributor.address).call(), "ether")
    print(f"   {cname} Claimed compensation on {name}: owed {before} -> {after} ETH")


def main():
    global new_contributor, new_applicant
    acct_labels.update({C0.address: "C0 (bot)", C1.address: "C1", C2.address: "C2"})
    for i, a in enumerate(applicants):
        acct_labels[a.address] = f"app{i}"

    print("\nSETUP — three contributors deposit (C0 is the auto voter)")
    for c in (C0, C1, C2):
        send_transaction(c, lending_service.functions.deposit(), value=to_wei(30))
    print("After initial deposits")
    print_snapshot()

    print("\nNEW ACCOUNT — contributor that joins the pool")
    new_contributor = create_funded_account(40, "new contributor")
    send_transaction(new_contributor, lending_service.functions.deposit(), value=to_wei(30))
    print("After contributor deposits")
    print_snapshot()

    print("\nORACLE — request real balance updates; the daemon pushes them")
    request_and_wait_for_oracle(applicants[0], BTC_GENESIS_ADDR)
    request_and_wait_for_oracle(applicants[0], BTC_GOOD_ADDR)
    request_and_wait_for_oracle(applicants[0], BTC_LOW_ADDR)

    print("\nTIMELINE — open loans; they become active concurrently")
    submit_and_resolve_proposal("L0 (app0)", applicants[0], 6, 50, 1000)   # Repaid last
    submit_and_resolve_proposal("L2 (app2)", applicants[2], 4, 100, 1000)  # Repaid early, funds the pool

    submit_and_resolve_proposal("Empty BTC address", applicants[3], 5, 10, 1000, btc=BTC_EMPTY_ADDR)

    submit_and_resolve_proposal("L5 (app3,good)", applicants[3], 3, 15, 1000, btc=BTC_GOOD_ADDR)
    l1 = submit_and_resolve_proposal("L1 (app1)", applicants[1], 4, 20, 60)  # Partial, fails
    print("After the first submissions")
    print_snapshot(involved_applicants=[applicants[0], applicants[2]])

    print("\nNEW ACCOUNT — applicant that submits a loan")
    new_applicant = create_funded_account(20, "new applicant")
    l3 = submit_and_resolve_proposal("L3 (new applicant)", new_applicant, 3, 10, 60)  # Not repaid, fails. Compensated
    print("After the new applicant's loan opens")
    print_snapshot(involved_applicants=[new_applicant])

    print("\nTIMELINE — partial repayments while other loans run")
    send_transaction(applicants[1], loan_contracts["L1 (app1)"].functions.repay(), value=to_wei(1))
    print("   L1 partially repaid 1 ETH")
    send_transaction(applicants[2], loan_contracts["L2 (app2)"].functions.repay(), value=to_wei(1))
    print("   L2 partially repaid 1 ETH")
    print("After partials")
    print_snapshot(involved_applicants=[applicants[1], applicants[2]])

    print("\nTIMELINE — rejection #2: funding pool has value but not enough")
    submit_and_resolve_proposal("Low pool", applicants[4], 100_000, 10, 1000)

    print("\nTIMELINE — rejection #3: contributors vote it down (bot approves but is outvoted)")
    submit_and_resolve_proposal("Majority rejected", applicants[4], 5, 10, 1000, approve=False)

    print("\nTIMELINE — rejection #4: real BTC balance exists but is too low for the amount")
    submit_and_resolve_proposal("Low BTC balance", applicants[3], 10, 10, 1000, btc=BTC_LOW_ADDR)

    print("\nTIMELINE — L2 repaid successfully while L0/L1/L3 still run")
    send_transaction(applicants[2], loan_contracts["L2 (app2)"].functions.repay(), value=calculate_total_due(4, 100) - to_wei(1))
    print("   L2 fully repaid")
    print_status_table()
    print("after L2 success")
    print_snapshot(involved_applicants=[applicants[2]])

    print("\nTIMELINE — L1 expires and is compensated")
    mine_until_failed(loan_contracts["L1 (app1)"])
    print(f"   L1 FAILED — reason: {failure_reason(loan_contracts['L1 (app1)'])}")
    claim_compensation(C1, "L1 (app1)", "C1")
    print("after C1's compensation on L1")
    print_snapshot()
    print_status_table()

    print("\nTIMELINE — L3 (new applicant's loan) expires; the new contributor compensates")
    mine_until_failed(loan_contracts["L3 (new applicant)"])
    print(f"   L3 FAILED — reason: {failure_reason(loan_contracts['L3 (new applicant)'])}")
    claim_compensation(new_contributor, "L3 (new applicant)", "new contributor")
    print("After new contributor's compensation on L3")
    print_snapshot()
    print_status_table()

    print("\nTIMELINE — a compensated loan is repaid IN FULL afterward, and STAYS failed")
    send_transaction(new_applicant, loan_contracts["L3 (new applicant)"].functions.repay(), value=calculate_total_due(3, 10))
    print(f"   L3 repaid in full after failure — successful={loan_contracts['L3 (new applicant)'].functions.successful().call()} "
          f"(stays failed), failedMarked={loan_contracts['L3 (new applicant)'].functions.failed_marked().call()}")
    print_status_table()

    print("\nTIMELINE — L5 (backed by the good BTC address) is repaid in full")
    send_transaction(applicants[3], loan_contracts["L5 (app3,good)"].functions.repay(), value=calculate_total_due(3, 15))
    print(f"   L5 repaid — successful={loan_contracts['L5 (app3,good)'].functions.successful().call()}")
    print_status_table()

    print("\nTIMELINE — L0 is finally repaid in full, LAST")
    send_transaction(applicants[0], loan_contracts["L0 (app0)"].functions.repay(), value=calculate_total_due(6, 50))
    print("   L0 fully repaid")
    print_status_table()
    print("After L0 success")
    print_snapshot(involved_applicants=[applicants[0]])

    print("\nTIMELINE — a contributor withdraws part of their freed disposable value")
    send_transaction(C2, lending_service.functions.withdraw(to_wei(3)))
    print("   C2 withdrew 3 ETH")
    print("After withdrawal")
    print_snapshot()

    print("\nDONE — final state")
    print_snapshot()
    print_status_table()


if __name__ == "__main__":
    main()
