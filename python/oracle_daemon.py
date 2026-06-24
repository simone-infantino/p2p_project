# oracle/oracle_daemon.py
#
# Off-chain responder for the Bitcoin liquidity oracle.
#
# Loads the UTXO balance snapshot produced by the scanner, then watches the
# oracle contract for UpdateRequested events and pushes the corresponding
# balance on-chain via pushBalance().
#
# Unlike a plain "from_block=latest" filter, this version checkpoints the last
# processed block to disk and resumes from there on restart, so no request is
# dropped if the daemon is briefly down (spec 1.4: "serves all new requests ...
# not dropping intentionally any request").

import json
import os
import time
from pathlib import Path

from web3 import Web3
from eth_account import Account

# ── configuration ─────────────────────────────────────────────────────────────
RPC          = "http://127.0.0.1:8545"
ORACLE_ADDR  = Web3.to_checksum_address("0xYOUR_ORACLE_CONTRACT")
ORACLE_KEY   = "0x..."                       # private key of the oracle owner account
ABI_PATH     = "artifacts/contracts/BitcoinOracle.sol/BitcoinOracle.json"
SNAPSHOT     = "utxo_snapshot.tsv"
STATE_FILE   = "oracle_state.json"           # checkpoint of last processed block
POLL_SECONDS = 2

w3 = Web3(Web3.HTTPProvider(RPC))
abi = json.loads(Path(ABI_PATH).read_text())["abi"]
oracle = w3.eth.contract(address=ORACLE_ADDR, abi=abi)
owner = Account.from_key(ORACLE_KEY)

# ── load the UTXO snapshot once at startup ─────────────────────────────────────
balances: dict[str, int] = {}
for line in Path(SNAPSHOT).read_text().splitlines():
    if not line:
        continue
    addr, sats = line.split("\t")
    balances[addr] = int(sats)
print(f"loaded {len(balances)} addresses from snapshot")


# ── checkpoint helpers ─────────────────────────────────────────────────────────
def deployment_block() -> int:
    """Block where the oracle was deployed; used as the very first checkpoint."""
    try:
        return int(oracle.functions.deploymentBlock().call())
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
    tx = oracle.functions.pushBalance(
        btc_addr_str.encode("ascii"), sats
    ).build_transaction({
        "from": owner.address,
        "nonce": nonce,
        "gas": 200_000,
        "gasPrice": w3.to_wei(1, "gwei"),
    })
    signed = owner.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    w3.eth.wait_for_transaction_receipt(h)
    return h


# ── event processing ───────────────────────────────────────────────────────────
def process_range(from_block: int, to_block: int) -> None:
    if from_block > to_block:
        return
    # web3.py v7 uses from_block/to_block; on v6 use fromBlock/toBlock instead.
    events = oracle.events.UpdateRequested().get_logs(
        from_block=from_block, to_block=to_block
    )
    for ev in events:
        btc_bytes = ev["args"]["btcAddr"]                 # raw bytes (non-indexed)
        addr = btc_bytes.decode("ascii", errors="replace")
        sats = balances.get(addr, 0)                      # unknown address -> 0
        txh = push_balance(addr, sats)
        print(f"pushed {addr} = {sats} sat  (tx {txh.hex()})")


def serve() -> None:
    last = load_last_block()
    print(f"oracle daemon resuming from block {last}")
    while True:
        latest = w3.eth.block_number
        if latest >= last:
            # inclusive [last, latest]; next pass starts at latest+1 (no overlap)
            process_range(last, latest)
            last = latest + 1
            save_last_block(last)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    serve()