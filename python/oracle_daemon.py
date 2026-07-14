import json
import os
import time
from pathlib import Path
from web3 import Web3
from eth_account import Account

# ── Configuration ─────────────────────────────────────────────────────────────

DEPLOYMENT_FILE = json.loads(Path("state/deployment.json").read_text())
STATE_FILE = "state/oracle_state.json"
SNAPSHOT_FILE = "offchain-scanner/utxo_snapshot.txt"
ORACLE_ABI_PATH = "hardhat/artifacts/contracts/BitcoinOracle.sol/BitcoinOracle.json"

RPC_URL = DEPLOYMENT_FILE["rpc"]
ORACLE_ADDR = Web3.to_checksum_address(DEPLOYMENT_FILE["oracle"]["address"])

POLL_SECONDS = 2

w3 = Web3(Web3.HTTPProvider(RPC_URL))
from web3.middleware import ExtraDataToPOAMiddleware
w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

abi = json.loads(Path(ORACLE_ABI_PATH).read_text())["abi"]
oracle = w3.eth.contract(address=ORACLE_ADDR, abi=abi)

# deployer == owner == daemon: the key that setup.py used to deploy the oracle
owner = Account.from_key(DEPLOYMENT_FILE["oracle"]["ownerKey"])

GAS_PRICE = int(DEPLOYMENT_FILE.get("gasPrice") or w3.to_wei(1, "gwei"))

# ── UTXO snapshot: (re)loadable so the daemon tracks a LIVE, incrementally-written
#    file. The scanner rewrites the snapshot atomically after each block, so here we
#    reload whenever the file's modification time changes. This keeps the daemon
#    current with the scanner instead of being frozen at whatever existed at startup.
balances: dict[str, int] = {}
_snapshot_mtime: float = -1.0


# ── Functions ─────────────────────────────────────────────────────────────────

def reload_snapshot_if_changed() -> None:
    global _snapshot_mtime
    try:
        mtime = os.path.getmtime(SNAPSHOT_FILE)
    except FileNotFoundError:
        return  # Scanner hasn't produced a snapshot yet -> serve an empty set
    if mtime == _snapshot_mtime:
        return  # Unchanged since last load -> nothing to do

    fresh: dict[str, int] = {}
    for line in Path(SNAPSHOT_FILE).read_text().splitlines():
        if not line:
            continue
        addr, sats = line.split("\t")
        fresh[addr] = int(sats)

    # Swap in the freshly loaded map, then record the mtime we loaded
    balances.clear()
    balances.update(fresh)
    _snapshot_mtime = mtime
    print(f"loaded {len(balances)} addresses from snapshot (mtime {mtime})")


def get_deployment_block() -> int:
    try:
        return int(oracle.functions.deployed_block().call())
    except Exception:
        return 0


def load_last_block() -> int:
    if os.path.exists(STATE_FILE):
        return int(json.loads(Path(STATE_FILE).read_text())["last_block"])
    return get_deployment_block()


def save_last_block(block_number: int) -> None:
    Path(STATE_FILE).write_text(json.dumps({"last_block": block_number}))


def push_balance(btc_addr: str, sats: int):
    nonce = w3.eth.get_transaction_count(owner.address)
    tx = oracle.functions.push_balance(
        btc_addr, sats
    ).build_transaction({
        "from": owner.address,
        "nonce": nonce,
        "gas": 200_000,
        "gasPrice": GAS_PRICE,
    })
    signed_tx = owner.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return tx_hash


def process_range(from_block: int, to_block: int) -> None:
    if from_block > to_block:
        return
    events = oracle.events.update_requested().get_logs(
        from_block=from_block, to_block=to_block
    )
    for ev in events:
        btc_bytes = ev["args"]["BTC_addr"]  # raw bytes (non-indexed)
        addr = btc_bytes
        sats = balances.get(addr, 0)  # unknown address -> 0
        tx_hash = push_balance(addr, sats)
        print(f"pushed {addr} = {sats} sat  (tx {tx_hash.hex()})")


# ── Execution ─────────────────────────────────────────────────────────────────

def serve() -> None:
    reload_snapshot_if_changed()
    next_block = load_last_block()
    print(f"oracle daemon resuming from block {next_block}")
    while True:
        reload_snapshot_if_changed()

        latest_block = w3.eth.block_number
        if latest_block >= next_block:
            process_range(next_block, latest_block)
            next_block = latest_block + 1
            save_last_block(next_block)

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    serve()
