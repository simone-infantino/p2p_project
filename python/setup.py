#!/usr/bin/env python3
"""
Initial setup for the P2P lending service.

Creates and funds every starting account, deploys BitcoinOracle and
LendingService, computes the spec-defined oracle minimum fee, and writes
all addresses + keys to deployment.json for the other scripts to consume.

Spec constraints honoured:
  * Prefunded genesis accounts are used ONLY to transfer value to fresh
    accounts. All contract deployments originate from fresh accounts.
  * BitcoinOracle is deployed FROM the oracle/daemon account, so that
    owner == the account the daemon signs pushBalance() with.

Run AFTER `npx hardhat compile` (so the artifacts exist) and with geth running.
"""

import json
from pathlib import Path

from web3 import Web3
from eth_account import Account

# ── configuration ─────────────────────────────────────────────────────────────
RPC = "http://127.0.0.1:8545"
ARTIFACTS = Path("hardhat/artifacts/contracts")
OUT = Path("deployment.json")

NUM_CONTRIBUTORS = 3
NUM_APPLICANTS = 5

# Funding amounts (ETH). Contributors get more so they can make real deposits;
# applicants need gas + enough to pay loan interest in the demo.
FUND_ORACLE = 20
FUND_ADMIN = 50
FUND_CONTRIBUTOR = 100
FUND_APPLICANT = 50

# A representative BTC address (ASCII bytes) used only to estimate pushBalance gas.
SAMPLE_BTC = b"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"

w3 = Web3(Web3.HTTPProvider(RPC))
from web3.middleware import ExtraDataToPOAMiddleware
w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
assert w3.is_connected(), f"cannot reach geth at {RPC}"

# Prefunded genesis account. Must be unlocked in geth (geth --unlock ...
# --allow-insecure-unlock when serving over HTTP). Used ONLY for value transfers.
funder = w3.eth.accounts[0]
print("funder (prefunded, transfers only):", funder)

GAS_PRICE = w3.eth.gas_price or w3.to_wei(1, "gwei")


# ── helpers ────────────────────────────────────────────────────────────────────
def load_artifact(name: str):
    path = ARTIFACTS / f"{name}.sol" / f"{name}.json"
    data = json.loads(path.read_text())
    return data["abi"], data["bytecode"]


def new_funded_account(eth_amount: int) -> Account:
    """Create a fresh local account and fund it from the prefunded account."""
    acct = Account.create()
    tx = {
        "from": funder,
        "to": acct.address,
        "value": w3.to_wei(eth_amount, "ether"),
        "gas": 21_000,
        "gasPrice": GAS_PRICE,
        "nonce": w3.eth.get_transaction_count(funder),
    }
    h = w3.eth.send_transaction(tx)  # geth signs, funder is unlocked
    w3.eth.wait_for_transaction_receipt(h)
    return acct


def deploy(acct: Account, abi, bytecode, *args):
    """Deploy a contract from a fresh (locally-signed) account."""
    c = w3.eth.contract(abi=abi, bytecode=bytecode)
    ctor = c.constructor(*args)
    gas_est = ctor.estimate_gas({"from": acct.address})
    tx = ctor.build_transaction({
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "gas": int(gas_est * 1.2),  # 20% headroom
        "gasPrice": GAS_PRICE,
    })
    signed = acct.sign_transaction(tx)
    # web3.py v7: signed.raw_transaction ; v6: signed.rawTransaction
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h)
    assert r.status == 1, "deployment reverted"
    return w3.eth.contract(address=r.contractAddress, abi=abi)


def send(acct: Account, fn):
    """Send a state-changing contract call from a fresh account."""
    gas_est = fn.estimate_gas({"from": acct.address})
    tx = fn.build_transaction({
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "gas": int(gas_est * 1.2),
        "gasPrice": GAS_PRICE,
    })
    signed = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(h)


# ── 1. create and fund all roles ────────────────────────────────────────────────
print("creating accounts ...")
oracle_acct = new_funded_account(FUND_ORACLE)   # owns BitcoinOracle, used by daemon
admin_acct = new_funded_account(FUND_ADMIN)     # deploys & administers LendingService
contributors = [new_funded_account(FUND_CONTRIBUTOR) for _ in range(NUM_CONTRIBUTORS)]
applicants = [new_funded_account(FUND_APPLICANT) for _ in range(NUM_APPLICANTS)]
print(f"  oracle/daemon : {oracle_acct.address}")
print(f"  admin         : {admin_acct.address}")
for i, a in enumerate(contributors):
    print(f"  contributor {i}: {a.address}")
for i, a in enumerate(applicants):
    print(f"  applicant   {i}: {a.address}")

# ── 2. deploy BitcoinOracle FROM the oracle account (owner == daemon) ────────────
print("deploying BitcoinOracle from the oracle account ...")
oracle_abi, oracle_bytecode = load_artifact("BitcoinOracle")
oracle = deploy(oracle_acct, oracle_abi, oracle_bytecode, 1)  # placeholder fee
print(f"  BitcoinOracle @ {oracle.address}")

# ── 3. compute and set the spec minimum fee = gas(pushBalance) * 0.1 gwei ─────────
gas = oracle.functions.pushBalance(SAMPLE_BTC, 5_000_000_000).estimate_gas(
    {"from": oracle_acct.address}
)
min_fee = gas * w3.to_wei("0.1", "gwei")
send(oracle_acct, oracle.functions.setMinimumFee(min_fee))
print(f"  pushBalance gas ~{gas}, minimumFee set to {min_fee} wei")

# ── 4. deploy LendingService FROM the admin account ──────────────────────────────
print("deploying LendingService from the admin account ...")
ls_abi, ls_bytecode = load_artifact("LendingService")
service = deploy(admin_acct, ls_abi, ls_bytecode, oracle.address)
print(f"  LendingService @ {service.address}")

# ── 5. persist everything for the other scripts ──────────────────────────────────
deployment = {
    "rpc": RPC,
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
OUT.write_text(json.dumps(deployment, indent=2))
print(f"\nwrote {OUT}  (KEEP THIS OUT OF VERSION CONTROL — it holds private keys)")