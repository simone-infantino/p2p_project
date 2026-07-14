import json
from pathlib import Path
from web3 import Web3
from eth_account import Account

# ── Configuration ─────────────────────────────────────────────────────────────
DEPLOYMENT_FILE = Path("state/deployment.json")
ARTIFACTS = Path("hardhat/artifacts/contracts")

RPC_URL = "http://127.0.0.1:8545"

NUM_CONTRIBUTORS = 3
NUM_APPLICANTS = 5

# Funding amounts in ETH
FUND_ORACLE = 20
FUND_ADMIN = 50
FUND_CONTRIBUTOR = 100
FUND_APPLICANT = 50

SAMPLE_BTC_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"

w3 = Web3(Web3.HTTPProvider(RPC_URL))
from web3.middleware import ExtraDataToPOAMiddleware
w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
assert w3.is_connected(), f"cannot reach geth at {RPC_URL}"

funder = w3.eth.accounts[0]
print("funder (prefunded, transfers only):", funder)

GAS_PRICE = w3.eth.gas_price or w3.to_wei(1, "gwei")


# ── Functions ─────────────────────────────────────────────────────────────────

def load_contract_artifact(name: str):
    path = ARTIFACTS / f"{name}.sol" / f"{name}.json"
    data = json.loads(path.read_text())
    return data["abi"], data["bytecode"]


def create_funded_account(eth_amount: int) -> Account:
    acct = Account.create()
    tx = {
        "from": funder,
        "to": acct.address,
        "value": w3.to_wei(eth_amount, "ether"),
        "gas": 21_000,
        "gasPrice": GAS_PRICE,
        "nonce": w3.eth.get_transaction_count(funder),
    }
    tx_hash = w3.eth.send_transaction(tx)
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return acct


def deploy_contract(acct: Account, abi, bytecode, *args):
    c = w3.eth.contract(abi=abi, bytecode=bytecode)
    ctor = c.constructor(*args)
    gas_est = ctor.estimate_gas({"from": acct.address})
    tx = ctor.build_transaction({
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "gas": int(gas_est * 1.2),
        "gasPrice": GAS_PRICE,
    })
    signed_tx = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(tx_hash)
    assert r.status == 1, "deployment reverted"
    return w3.eth.contract(address=r.contractAddress, abi=abi)


def send_transaction(acct: Account, fn):
    gas_est = fn.estimate_gas({"from": acct.address})
    tx = fn.build_transaction({
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "gas": int(gas_est * 1.2),
        "gasPrice": GAS_PRICE,
    })
    signed_tx = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(tx_hash)


# ── Execution ─────────────────────────────────────────────────────────────────

# 1. Create and fund all roles
print("Creating accounts ...")
oracle_acct = create_funded_account(FUND_ORACLE)  # owns BitcoinOracle, used by daemon
admin_acct = create_funded_account(FUND_ADMIN)  # deploys & administers LendingService
contributors = [create_funded_account(FUND_CONTRIBUTOR) for _ in range(NUM_CONTRIBUTORS)]
applicants = [create_funded_account(FUND_APPLICANT) for _ in range(NUM_APPLICANTS)]
print(f"  oracle/daemon : {oracle_acct.address}")
print(f"  admin         : {admin_acct.address}")
for i, a in enumerate(contributors):
    print(f"  contributor {i}: {a.address}")
for i, a in enumerate(applicants):
    print(f"  applicant   {i}: {a.address}")

# 2. Deploy BitcoinOracle FROM the oracle account (owner == daemon)
print("Deploying BitcoinOracle from the oracle account ...")
oracle_abi, oracle_bytecode = load_contract_artifact("BitcoinOracle")
oracle = deploy_contract(oracle_acct, oracle_abi, oracle_bytecode, 1)
print(f"  BitcoinOracle @ {oracle.address}")

# 3. Compute and set the spec minimum fee = gas(pushBalance) * 0.1 gwei
gas = oracle.functions.push_balance(SAMPLE_BTC_ADDR, 5_000_000_000).estimate_gas(
    {"from": oracle_acct.address}
)
min_fee = gas * w3.to_wei("0.1", "gwei")
send_transaction(oracle_acct, oracle.functions.set_minimum_fee(min_fee))
print(f"  pushBalance gas ~{gas}, minimumFee set to {min_fee} wei")

# 4. Deploy LendingService FROM the admin account
print("Deploying LendingService from the admin account ...")
ls_abi, ls_bytecode = load_contract_artifact("LendingService")
service = deploy_contract(admin_acct, ls_abi, ls_bytecode, oracle.address)
print(f"  LendingService @ {service.address}")

# 5. Persist everything for the other scripts
deployment = {
    "rpc": RPC_URL,
    "gasPrice": str(GAS_PRICE),
    "oracle": {
        "address": oracle.address,
        "ownerAddress": oracle_acct.address,
        "ownerKey": w3.to_hex(oracle_acct.key),
        "minimumFee": str(min_fee),
    },
    "lendingService": {
        "address": service.address,
        "adminAddress": admin_acct.address,
        "adminKey": w3.to_hex(admin_acct.key),
    },
    "contributors": [
        {"address": a.address, "key": w3.to_hex(a.key)} for a in contributors
    ],
    "applicants": [
        {"address": a.address, "key": w3.to_hex(a.key)} for a in applicants
    ],
}
DEPLOYMENT_FILE.write_text(json.dumps(deployment, indent=2))
print(f"\nWrote {DEPLOYMENT_FILE}")
