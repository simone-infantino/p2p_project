# scripts/setup.py
from web3 import Web3
from pathlib import Path
import json, time

w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:8545"))
funder = w3.eth.accounts[0]   # prefunded account from genesis

def fund_new_account(eth_amount):
    acct = w3.eth.account.create()
    tx = {"from": funder, "to": acct.address, "value": w3.to_wei(eth_amount, "ether"),
          "gas": 21000, "gasPrice": w3.to_wei(1, "gwei")}
    h = w3.eth.send_transaction(tx)
    w3.eth.wait_for_transaction_receipt(h)
    return acct

def deploy(acct, abi, bytecode, *args):
    c = w3.eth.contract(abi=abi, bytecode=bytecode)
    tx = c.constructor(*args).build_transaction({
        "from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address),
        "gas": 6_000_000, "gasPrice": w3.to_wei(1, "gwei"),
    })
    signed = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h)
    return w3.eth.contract(address=r.contractAddress, abi=abi)

# load Hardhat artifacts, deploy oracle, then service
artifact = json.loads(Path("artifacts/contracts/BitcoinOracle.sol/BitcoinOracle.json").read_text())
deployer = fund_new_account(50)
oracle   = deploy(deployer, artifact["abi"], artifact["bytecode"], 100_000)  # min fee