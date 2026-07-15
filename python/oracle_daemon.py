import json
import time
from pathlib import Path

from eth_account import Account
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware


DEPLOYMENT_FILE = json.loads(Path("state/deployment.json").read_text())
STATE_FILE = Path("state/oracle_state.json")
SNAPSHOT_FILE = Path("offchain-scanner/utxo_snapshot.txt")
ORACLE_ABI_PATH = Path("hardhat/artifacts/contracts/BitcoinOracle.sol/BitcoinOracle.json")

RPC_URL = DEPLOYMENT_FILE["rpc"]
ORACLE_ADDR = Web3.to_checksum_address(DEPLOYMENT_FILE["oracle"]["address"])

POLL_SECONDS = 2

w3 = Web3(Web3.HTTPProvider(RPC_URL))
w3.middleware_onion.inject(ExtraDataToPOAMiddleware,layer=0,)

abi = json.loads(ORACLE_ABI_PATH.read_text())["abi"]

oracle = w3.eth.contract(address=ORACLE_ADDR,abi=abi,)

owner = Account.from_key(DEPLOYMENT_FILE["oracle"]["ownerKey"])

GAS_PRICE = int(DEPLOYMENT_FILE.get("gasPrice")or w3.to_wei(1, "gwei"))


def reload_snapshot_if_changed(balances: dict[str, int], _snapshot_mtime: float):
    if not SNAPSHOT_FILE.exists():
        return balances, _snapshot_mtime

    mtime = SNAPSHOT_FILE.stat().st_mtime

    if mtime == _snapshot_mtime:
        return balances, _snapshot_mtime

    fresh: dict[str, int] = {}

    for line in SNAPSHOT_FILE.read_text().splitlines():
        if not line:
            continue

        addr, sats = line.split("\t")
        fresh[addr] = int(sats)

    balances = fresh
    _snapshot_mtime = mtime

    print(f"\nLoaded {len(balances)} addresses from snapshot " f"(mtime {mtime})")

    return balances, _snapshot_mtime


def get_deployment_block() -> int:
    try:
        return int(oracle.functions.deployed_block().call())
    except Exception:
        return 0


def load_last_block() -> int:
    if STATE_FILE.exists():
        return int(json.loads(STATE_FILE.read_text())["last_block"])

    return get_deployment_block()


def save_last_block(block_number: int) -> None:
    STATE_FILE.write_text(json.dumps({"last_block": block_number}))


def push_balance(btc_addr: str, sats: int):
    nonce = w3.eth.get_transaction_count(owner.address)

    transaction = oracle.functions.push_balance(btc_addr, sats).build_transaction(
        {
            "from": owner.address,
            "nonce": nonce,
            "gas": 200_000,
            "gasPrice": GAS_PRICE,
        }
    )

    signed_transaction = owner.sign_transaction(transaction)
    tx_hash = w3.eth.send_raw_transaction(signed_transaction.raw_transaction)
    w3.eth.wait_for_transaction_receipt(tx_hash)

    return tx_hash


def process_block_range(from_block: int, to_block: int, balances: dict[str, int]) -> None:

    if from_block > to_block:
        return

    events = oracle.events.update_requested().get_logs(from_block=from_block, to_block=to_block)

    for event in events:
        btc_addr = event["args"]["BTC_addr"]
        sats = balances.get(btc_addr, 0)
        tx_hash = push_balance(btc_addr, sats)

        print(f"Pushed {btc_addr} = {sats} sat " f"(tx {tx_hash.hex()})")


def main() -> None:
    balances: dict[str, int] = {}
    snapshot_mtime: float = -1.0

    balances, snapshot_mtime = reload_snapshot_if_changed(balances, snapshot_mtime)

    next_block = load_last_block()
    print(f"Resuming from block {next_block}")

    while True:
        balances, snapshot_mtime = reload_snapshot_if_changed(balances, snapshot_mtime)

        latest_block = w3.eth.block_number

        if latest_block >= next_block:
            process_block_range(next_block, latest_block, balances)
            next_block = latest_block + 1
            save_last_block(next_block)

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()