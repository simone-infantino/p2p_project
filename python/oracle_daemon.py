# oracle/oracle_daemon.py
import json, time
from pathlib import Path
from web3 import Web3
from eth_account import Account

RPC          = "http://127.0.0.1:8545"
ORACLE_ADDR  = Web3.to_checksum_address("0xYOUR_ORACLE_CONTRACT")
ORACLE_KEY   = "0x..."                       # private key of the oracle owner account (from setup.py)
ABI_PATH     = "artifacts/contracts/BitcoinOracle.sol/BitcoinOracle.json"
SNAPSHOT     = "utxo_snapshot.tsv"

w3 = Web3(Web3.HTTPProvider(RPC))
abi = json.loads(Path(ABI_PATH).read_text())["abi"]
oracle = w3.eth.contract(address=ORACLE_ADDR, abi=abi)
owner = Account.from_key(ORACLE_KEY)

# Load the balance snapshot produced by UtxoScanner once at startup.
balances = {}
for line in Path(SNAPSHOT).read_text().splitlines():
    if not line:
        continue
    addr, sats = line.split("\t")
    balances[addr] = int(sats)
print(f"loaded {len(balances)} addresses from snapshot")

def push_balance(btc_addr_str: str, sats: int):
    nonce = w3.eth.get_transaction_count(owner.address)
    tx = oracle.functions.pushBalance(btc_addr_str.encode("ascii"), sats).build_transaction({
        "from": owner.address,
        "nonce": nonce,
        "gas": 200_000,
        "gasPrice": w3.to_wei(1, "gwei"),
    })
    signed = owner.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    w3.eth.wait_for_transaction_receipt(h)
    return h

def serve():
    flt = oracle.events.UpdateRequested.create_filter(from_block="latest")
    print("oracle daemon listening for UpdateRequested ...")
    while True:
        for log in flt.get_new_entries():
            btc_bytes = log["args"]["btcAddr"]          # raw bytes (non-indexed)
            addr = btc_bytes.decode("ascii", errors="replace")
            sats = balances.get(addr, 0)                # unknown address -> 0
            txh = push_balance(addr, sats)
            print(f"pushed {addr} = {sats} sat  (tx {txh.hex()})")
        time.sleep(2)

if __name__ == "__main__":
    serve()