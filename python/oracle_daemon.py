# oracle/oracle_daemon.py
#
# Off-chain responder for the Bitcoin liquidity oracle.
#
# Loads the UTXO balance snapshot produced by the scanner, then watches the
# oracle contract for update_requested events and pushes the corresponding
# balance on-chain via push_balance().
#
# Config (RPC, oracle address, owner key) is read from deployment.json, which
# is produced by setup.py. deployer == owner == this daemon's signing account,
# so nothing is hardcoded here. KEEP deployment.json OUT OF VERSION CONTROL.
#
# The daemon checkpoints the last processed block to disk and resumes from there
# on restart, so no request is dropped if it is briefly down (spec 1.4:
# "serves all new requests ... not dropping intentionally any request").

import json
import os
import time
from pathlib import Path

from web3 import Web3
from eth_account import Account

# ── configuration (from setup.py's deployment.json) ───────────────────────────
DEPLOYMENT = json.loads(Path("state/deployment.json").read_text())

RPC          = DEPLOYMENT["rpc"]
ORACLE_ADDR  = Web3.to_checksum_address(DEPLOYMENT["oracle"]["address"])
ABI_PATH     = "hardhat/artifacts/contracts/BitcoinOracle.sol/BitcoinOracle.json"
SNAPSHOT     = "offchain-scanner/utxo_snapshot.txt"
STATE_FILE   = "state/oracle_state.json"           # checkpoint of last processed block
POLL_SECONDS = 2

w3 = Web3(Web3.HTTPProvider(RPC))
from web3.middleware import ExtraDataToPOAMiddleware
w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

abi = json.loads(Path(ABI_PATH).read_text())["abi"]
oracle = w3.eth.contract(address=ORACLE_ADDR, abi=abi)

# deployer == owner == daemon: the key that setup.py used to deploy the oracle
owner = Account.from_key(DEPLOYMENT["oracle"]["ownerKey"])

GAS_PRICE = int(DEPLOYMENT.get("gasPrice") or w3.to_wei(1, "gwei"))

# ── UTXO snapshot: (re)loadable so the daemon tracks a LIVE, incrementally-written
#    file. The scanner rewrites the snapshot atomically after each block, so here we
#    reload whenever the file's modification time changes. This keeps the daemon
#    current with the scanner instead of being frozen at whatever existed at startup.
balances: dict[str, int] = {}
_snapshot_mtime: float = -1.0


def reload_snapshot_if_changed() -> None:
    """Reload the snapshot into `balances` if the file is new or has changed.
    Cheap to call every poll: it only re-reads when the mtime advances."""
    global _snapshot_mtime
    try:
        mtime = os.path.getmtime(SNAPSHOT)
    except FileNotFoundError:
        # scanner hasn't produced a snapshot yet; serve an empty set for now
        return
    if mtime == _snapshot_mtime:
        return  # unchanged since last load -> nothing to do

    fresh: dict[str, int] = {}
    for line in Path(SNAPSHOT).read_text().splitlines():
        if not line:
            continue
        addr, sats = line.split("\t")
        fresh[addr] = int(sats)
    # swap in the freshly loaded map, then record the mtime we loaded
    balances.clear()
    balances.update(fresh)
    _snapshot_mtime = mtime
    print(f"loaded {len(balances)} addresses from snapshot (mtime {mtime})")


# initial load at startup (may be empty if the scanner hasn't started yet)
reload_snapshot_if_changed()


# ── checkpoint helpers ─────────────────────────────────────────────────────────
def deployment_block() -> int:
    """Block where the oracle was deployed; used as the very first checkpoint."""
    try:
        return int(oracle.functions.deployed_block().call())
    except Exception:
        return 0  # fallback if the getter isn't present


def load_last_block() -> int:
    if os.path.exists(STATE_FILE):
        return int(json.loads(Path(STATE_FILE).read_text())["last_block"])
    return deployment_block()


def save_last_block(b: int) -> None:
    Path(STATE_FILE).write_text(json.dumps({"last_block": b}))


# ── on-chain push ──────────────────────────────────────────────────────────────
def push_balance(btc_addr_str: str, sats: int):
    nonce = w3.eth.get_transaction_count(owner.address)
    tx = oracle.functions.push_balance(
        btc_addr_str, sats
    ).build_transaction({
        "from": owner.address,
        "nonce": nonce,
        "gas": 200_000,
        "gasPrice": GAS_PRICE,
    })
    signed = owner.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    w3.eth.wait_for_transaction_receipt(h)
    return h


# ── event processing ───────────────────────────────────────────────────────────
def process_range(from_block: int, to_block: int) -> None:
    if from_block > to_block:
        return
    events = oracle.events.update_requested().get_logs(
        from_block=from_block, to_block=to_block
    )
    for ev in events:
        btc_bytes = ev["args"]["BTC_addr"]                 # raw bytes (non-indexed)
        addr = btc_bytes
        sats = balances.get(addr, 0)                      # unknown address -> 0
        txh = push_balance(addr, sats)
        print(f"pushed {addr} = {sats} sat  (tx {txh.hex()})")


def serve() -> None:
    last = load_last_block()
    print(f"oracle daemon resuming from block {last}")
    while True:
        # pick up any new balances the scanner has written since our last pass,
        # so requests are answered against the latest snapshot (not the startup copy)
        reload_snapshot_if_changed()

        latest = w3.eth.block_number
        if latest >= last:
            # inclusive [last, latest]; next pass starts at latest+1 (no overlap)
            process_range(last, latest)
            last = latest + 1
            save_last_block(last)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    serve()
