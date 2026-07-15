import json
from pathlib import Path

from eth_account import Account
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware


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
w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

assert w3.is_connected(), f"cannot reach geth at {RPC_URL}"

GAS_PRICE = w3.eth.gas_price or w3.to_wei(1, "gwei")


def load_contract_artifact(name: str):
    path = ARTIFACTS / f"{name}.sol" / f"{name}.json"
    data = json.loads(path.read_text())
    return data["abi"], data["bytecode"]


def create_funded_account(funder, eth_amount: int) -> Account:  
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
    contract_factory = w3.eth.contract(abi=abi, bytecode=bytecode)

    constructor = contract_factory.constructor(*args)

    gas_est = constructor.estimate_gas({"from": acct.address})

    tx = constructor.build_transaction(
        {
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address),
            "gas": int(gas_est * 1.2),
            "gasPrice": GAS_PRICE,
        }
    )

    signed_tx = acct.sign_transaction(tx)

    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)

    assert rcpt.status == 1, "deployment reverted"

    return w3.eth.contract(address=rcpt.contractAddress, abi=abi)


def send_transaction(acct: Account, fn):
    gas_est = fn.estimate_gas({"from": acct.address})

    tx = fn.build_transaction(
        {
            "from": acct.address,
            "nonce": w3.eth.get_transaction_count(acct.address),
            "gas": int(gas_est * 1.2),
            "gasPrice": GAS_PRICE,
        }
    )

    signed_tx = acct.sign_transaction(tx)

    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)

    return w3.eth.wait_for_transaction_receipt(tx_hash)


def create_accounts(funder):
    oracle_acct = create_funded_account(funder, FUND_ORACLE)
    admin_acct = create_funded_account(funder, FUND_ADMIN)

    contributors = [
        create_funded_account(funder, FUND_CONTRIBUTOR)
        for _ in range(NUM_CONTRIBUTORS)
    ]

    applicants = [
        create_funded_account(funder, FUND_APPLICANT)
        for _ in range(NUM_APPLICANTS)
    ]

    return oracle_acct, admin_acct, contributors, applicants


def print_accounts(oracle_acct, admin_acct, contributors, applicants):
    print(f"  oracle/daemon : {oracle_acct.address}")
    print(f"  admin         : {admin_acct.address}")

    for i, contributor in enumerate(contributors):
        print(f"  contributor  {i}: {contributor.address}")

    for i, applicant in enumerate(applicants):
        print(f"  applicant    {i}: {applicant.address}")


def deploy_oracle(oracle_acct):
    oracle_abi, oracle_bytecode = load_contract_artifact("BitcoinOracle")

    oracle = deploy_contract(oracle_acct, oracle_abi, oracle_bytecode, 1)

    gas = oracle.functions.push_balance(SAMPLE_BTC_ADDR, 5_000_000_000).estimate_gas({"from": oracle_acct.address})

    min_fee = gas * w3.to_wei("0.1", "gwei")

    send_transaction(oracle_acct, oracle.functions.set_minimum_fee(min_fee))
    return oracle, gas, min_fee


def deploy_lending_service(admin_acct, oracle):
    ls_abi, ls_bytecode = load_contract_artifact("LendingService")

    service = deploy_contract(admin_acct, ls_abi, ls_bytecode, oracle.address)

    return service


def save_deployment_file(oracle, oracle_acct, min_fee, service, admin_acct, contributors, applicants):
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
            {
                "address": a.address,
                "key": w3.to_hex(a.key),
            }
            for a in contributors
        ],
        "applicants": [
            {
                "address": a.address,
                "key": w3.to_hex(a.key),
            }
            for a in applicants
        ],
    }

    DEPLOYMENT_FILE.write_text(json.dumps(deployment, indent=2))


def main():
    funder = w3.eth.accounts[0]
    print("\nFunder (prefunded, transfers only)")
    print("  Address:", funder)

    print("\nCreating accounts ...")
    oracle_acct, admin_acct, contributors, applicants = create_accounts(funder)
    print_accounts(oracle_acct, admin_acct, contributors, applicants)

    print("\nDeploying BitcoinOracle...")
    oracle, gas, min_fee = deploy_oracle(oracle_acct)
    print(f"  BitcoinOracle @ {oracle.address}")
    print(f"  pushBalance gas ~{gas}, minimumFee set to {min_fee} wei")

    print("\nDeploying LendingService from the admin account ...")
    service = deploy_lending_service(admin_acct, oracle)
    print(f"  LendingService @ {service.address}")

    save_deployment_file(oracle, oracle_acct, min_fee, service, admin_acct, contributors, applicants)
    print(f"\nWrote {DEPLOYMENT_FILE}")


if __name__ == "__main__":
    main()