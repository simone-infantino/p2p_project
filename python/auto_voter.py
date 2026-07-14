import json
import time
from pathlib import Path
from web3 import Web3
from eth_account import Account

# ── Configuration ─────────────────────────────────────────────────────────────

DEPLOYMENT_FILE = json.loads(Path("state/deployment.json").read_text())
STATE_FILE = Path("state/auto_voter_state.json")

RPC_URL = DEPLOYMENT_FILE["rpc"]
GAS_PRICE = int(DEPLOYMENT_FILE["gasPrice"])
SERVICE_ADDR = Web3.to_checksum_address(DEPLOYMENT_FILE["lendingService"]["address"])

POLL_SECONDS = 2

# Bot that controls contributor[0] and automatically approves every proposal
voter_account = Account.from_key(DEPLOYMENT_FILE["contributors"][0]["key"])

w3 = Web3(Web3.HTTPProvider(RPC_URL))
from web3.middleware import ExtraDataToPOAMiddleware
w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

assert w3.is_connected(), f"cannot reach geth at {RPC_URL}"
abi = json.loads(Path("hardhat/artifacts/contracts/LendingService.sol/LendingService.json").read_text())["abi"]
service = w3.eth.contract(address=SERVICE_ADDR, abi=abi)


# ── Functions ─────────────────────────────────────────────────────────────────

def load_checkpoint() -> int:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text()).get("last_block", 0)
    return 0


def save_checkpoint(block: int):
    STATE_FILE.write_text(json.dumps({"last_block": block}))


def approve_proposal(pid: int):
    try:
        fn = service.functions.vote(pid, True)
        gas_est = fn.estimate_gas({"from": voter_account.address})
        tx = fn.build_transaction({
            "from": voter_account.address,
            "nonce": w3.eth.get_transaction_count(voter_account.address),
            "gas": int(gas_est * 1.3),
            "gasPrice": GAS_PRICE,
        })
        signed_tx = voter_account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
        w3.eth.wait_for_transaction_receipt(tx_hash)
        print(f"  ✓ approved proposal #{pid}")
    except Exception as e:
        print(f"  · could not vote on #{pid} ({e})")


# ── Execution ─────────────────────────────────────────────────────────────────

def serve():
    next_block = load_checkpoint()
    print(f"auto-voter {voter_account.address[:12]}… watching proposal_submitted from block {next_block}")
    while True:
        latest_block = w3.eth.block_number
        if latest_block >= next_block:
            try:
                logs = service.events.proposal_submitted().get_logs(
                    from_block=next_block, to_block=latest_block)
                for ev in logs:
                    pid = ev["args"]["id"]
                    print(f"noticed new proposal #{pid} — approving (always)")
                    approve_proposal(pid)
                save_checkpoint(latest_block + 1)
                next_block = latest_block + 1
            except Exception as e:
                print("poll error:", e)

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    serve()
