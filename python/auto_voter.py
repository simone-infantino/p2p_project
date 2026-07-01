#!/usr/bin/env python3
"""
auto_voter.py — an automated contributor that APPROVES every new loan proposal.

This implements the spec's "automated strategy for a contributor that always
votes to approve any new loan proposal (even if the vote may be irrelevant if
the entirety of the contributor funds are locked in active loans)". It must
"notice" new proposals: it watches the chain for ProposalSubmitted events and
fires an approve vote for each one — unconditionally, with no judgement.

It plays contributors[0] from deployment.json (the demo deposits that account's
funds; this bot only votes for it). Run it alongside the demo:

    python oracle_daemon.py     # terminal 1
    python auto_voter.py        # terminal 2
    python demo.py              # terminal 3
"""

import json
import time
from pathlib import Path

from web3 import Web3
from eth_account import Account

DEPLOYMENT = json.loads(Path("deployment.json").read_text())
RPC = DEPLOYMENT["rpc"]
GAS_PRICE = int(DEPLOYMENT["gasPrice"])
SERVICE_ADDR = Web3.to_checksum_address(DEPLOYMENT["lendingService"]["address"])

# This bot IS contributor[0]: it holds that account's key and votes for it.
voter = Account.from_key(DEPLOYMENT["contributors"][0]["key"])

w3 = Web3(Web3.HTTPProvider(RPC))
from web3.middleware import ExtraDataToPOAMiddleware
w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

assert w3.is_connected(), f"cannot reach geth at {RPC}"
abi = json.loads(Path("hardhat/artifacts/contracts/LendingService.sol/LendingService.json").read_text())["abi"]
service = w3.eth.contract(address=SERVICE_ADDR, abi=abi)

STATE = Path("auto_voter_state.json")   # checkpoint: last block we've scanned


def load_checkpoint() -> int:
    if STATE.exists():
        return json.loads(STATE.read_text()).get("last_block", 0)
    return 0


def save_checkpoint(block: int):
    STATE.write_text(json.dumps({"last_block": block}))


def approve(pid: int):
    """Always vote approve. If the vote is impossible (window closed, not yet a
    contributor, etc.) we just skip — the strategy never withholds on purpose."""
    try:
        fn = service.functions.vote(pid, True)
        gas = fn.estimate_gas({"from": voter.address})
        tx = fn.build_transaction({
            "from": voter.address,
            "nonce": w3.eth.get_transaction_count(voter.address),
            "gas": int(gas * 1.3),
            "gasPrice": GAS_PRICE,
        })
        signed = voter.sign_transaction(tx)
        # web3.py v7: signed.raw_transaction ; v6: signed.rawTransaction
        h = w3.eth.send_raw_transaction(signed.raw_transaction)
        w3.eth.wait_for_transaction_receipt(h)
        print(f"  ✓ approved proposal #{pid}")
    except Exception as e:
        # e.g. "voting window closed", "not a contributor" — the always-approve
        # strategy simply can't act here, so it moves on.
        print(f"  · could not vote on #{pid} ({e})")


def serve():
    last = load_checkpoint()
    print(f"auto-voter {voter.address[:12]}… watching ProposalSubmitted from block {last}")
    while True:
        latest = w3.eth.block_number
        if latest >= last:
            try:
                # web3.py v7 arg names; on v6 use fromBlock/toBlock
                logs = service.events.ProposalSubmitted().get_logs(
                    from_block=last, to_block=latest)
                for ev in logs:
                    pid = ev["args"]["id"]
                    print(f"noticed new proposal #{pid} — approving (always)")
                    approve(pid)
                save_checkpoint(latest + 1)
                last = latest + 1
            except Exception as e:
                print("poll error:", e)
        time.sleep(2)


if __name__ == "__main__":
    serve()
