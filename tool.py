#!/usr/bin/env python3

import subprocess
import sys

# -----------------------------------------------------------------------------
# CONFIG
# -----------------------------------------------------------------------------

CHAINDATA_DIR = "chain/data"
GENESIS_FILE = "chain/project2526genesis.json"
PASSWORD_FILE = "chain/psw.txt"

ACCOUNT_PUB_ADDR = "d278d247a52c550508ea2b2c9321d816238fb523"

CHAIN_HOST = "127.0.0.1"
CHAIN_PORT = 8545
CHAIN_URL = f"http://{CHAIN_HOST}:{CHAIN_PORT}"
CHAIN_NET_ID = 202526

# -----------------------------------------------------------------------------
# BLOCKCHAIN FUNCTIONS
# -----------------------------------------------------------------------------

def initialize_chain():
    """Clean the geth data directory and initialize the blockchain."""

    subprocess.run(
        ["rm", "-rf", f"{CHAINDATA_DIR}/geth/*"],
        shell=False,
        check=True
    )

    cmd = [
        "geth",
        "--datadir", CHAINDATA_DIR,
        "init",
        GENESIS_FILE,
    ]

    subprocess.run(cmd, check=True)

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

def deployment_setup():
    """Run the setup using the virtual environment Python."""
    print ("Deployment setup")
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

def geth_attach():
    """Open the Geth JavaScript console."""
    subprocess.run(["geth", "attach", CHAIN_URL])

# -----------------------------------------------------------------------------
# MENU
# -----------------------------------------------------------------------------

MENU_ACTIONS = {
    "1": ("Initialize Geth chain (run once)", initialize_chain),
    "2": ("Start Geth chain", start_chain),
    "3": ("Deployment (run once) to initialize accounts, funds, contracts", deployment_setup),
    "4": ("Start Oracle Daemon", oracle_daemon),
    "5": ("Start Auto Voter", auto_voter),
    "6": ("Start Demo (lending workflow simulation)", demo),
    "7": ("Attach to Geth (query the chain)", geth_attach),
}

def print_header(title):
    print("" + "=" * 70)
    print(f" {title}")
    print("=" * 70 + "")

def print_menu(): 
    print_header("Blockchain Utility")

    print("\nWorkflow")
    for key in ("1", "2", "3", "4", "5", "6"):
        print(f"{key}) {MENU_ACTIONS[key][0]}")

    print("\nOther")
    for key in ("7",):
        print(f"{key}) {MENU_ACTIONS[key][0]}")
    print("0|q) Exit")

# -----------------------------------------------------------------------------
# MAIN
# -----------------------------------------------------------------------------

def exit_program():
    print("\nExit.")
    sys.exit(0)

def main():
    try:
        while True:
            print_menu()

            choice = input("\nSelect an option: ").strip().lower()

            if choice in ("0", "q"):
                exit_program()

            action = MENU_ACTIONS.get(choice)

            if action is None:
                print("Invalid option.")
                continue

            #_, func = action
            #print_header(action[0])
            #func()

            title, func = action
            print_header(title)
            func()
            print()

    except KeyboardInterrupt:
        print()
        exit_program()


if __name__ == "__main__":
    main()