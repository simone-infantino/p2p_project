#!/usr/bin/env python3

import subprocess
import sys

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

CHAINDATA_DIR = "chain/data"
GENESIS_FILE = "chain/project2526genesis.json"

ACCOUNT_PUB_ADDR = "d278d247a52c550508ea2b2c9321d816238fb523"

CHAIN_HOST = "127.0.0.1"
CHAIN_PORT = 8545
CHAIN_URL = f"http://{CHAIN_HOST}:{CHAIN_PORT}"
CHAIN_NET_ID = 202526

PASSWORD_FILE = "chain/psw.txt"

# -----------------------------------------------------------------------------
# Functions
# -----------------------------------------------------------------------------

def start_chain():
    """Start the local geth node."""
    cmd = [
        "geth",
        "--datadir", CHAINDATA_DIR,
        "--networkid", str(CHAIN_NET_ID),
        "--unlock", f"0x{ACCOUNT_PUB_ADDR}",
        "--password", PASSWORD_FILE,
        "--mine",
        "--miner.etherbase", f"0x{ACCOUNT_PUB_ADDR}",
        "--allow-insecure-unlock",
        "--http",
        "--http.corsdomain", CHAIN_URL,
        "--http.api", "web3,eth,debug,personal,net",
    ]

    subprocess.run(cmd)


def geth_attach():
    """Open the Geth JavaScript console."""
    subprocess.run(["geth", "attach", CHAIN_URL])

def setup():
    """Run the setup using the virtual environment Python."""
    python = "venv/bin/python3"
    subprocess.run([python, "python/setup.py"])

def oracle_daemon():
    """Run the oracle daemon using the virtual environment Python."""
    python = "venv/bin/python3"
    subprocess.run([python, "python/oracle_daemon.py"])

def auto_voter():
    """Run the auto-voter using the virtual environment Python."""
    python = "venv/bin/python3"
    subprocess.run([python, "python/auto_voter.py"])

def demo():
    """Run the demo using the virtual environment Python."""
    python = "venv/bin/python3"
    subprocess.run([python, "python/demo.py"])

# -----------------------------------------------------------------------------
# Menu
# -----------------------------------------------------------------------------

def menu():
    while True:
        print("\n==============================")
        print(" Blockchain Utility")
        print("==============================")
        print("1) Start Geth")
        print("2) Attach to Geth")
        print("3) Start Oracle Daemon")
        print("4) Start Auto Voter")
        print("5) Start Demo")
        print("6) Start Setup")
        print("0) Exit")

        choice = input("\nSelect an option: ").strip()

        if choice == "1":
            start_chain()

        elif choice == "2":
            geth_attach()

        elif choice == "3":
            oracle_daemon()

        elif choice == "4":
            auto_voter()
        
        elif choice == "5":
            demo()
        
        elif choice == "6":
            setup()
        
        elif choice == "0":
            print("Bye.")
            sys.exit(0)

        else:
            print("Invalid option.")


if __name__ == "__main__":
    menu()