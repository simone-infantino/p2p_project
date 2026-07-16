#!/usr/bin/env python3

import subprocess
import sys
from pathlib import Path

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

def offchain_scanner():
    try:
        # 1. Create bt_chain_blocks directory
        subprocess.run(["mkdir", "-p", "bt_chain_blocks"], check=True)

        # 2. Copy Bitcoin blocks (may take up space and time)
        bitcoin_blocks_src = Path.home() / ".bitcoin" / "blocks"
        subprocess.run(
            ["cp", "-r", str(bitcoin_blocks_src) + "/.", "bt_chain_blocks/"],
            check=True
        )

        # 3. Go to the Java project directory and compile
        project_dir = Path("offchain-scanner")
        subprocess.run(["mvn", "clean", "package"], cwd=project_dir, check=True)

        # 4. Run the generated .jar file
        subprocess.run([
            "java",
            "-jar",
            "target/offchain-scanner-1.0-SNAPSHOT-jar-with-dependencies.jar",
            "../bt_chain_blocks",
            "utxo_snapshot.txt",
            "131000"
        ], cwd=project_dir, check=True)

        print("Off-chain scan completed successfully.")

    except subprocess.CalledProcessError as e:
        print(f"Error while executing the command: {e}")
        raise

def venv_setup():
    """Create Python virtual environment and install dependencies."""

    venv_path = Path("venv")
    if not venv_path.exists():
        print("\n== Creating virtual environment ==")
        subprocess.run([sys.executable, "-m", "venv", "venv"], check=True)

    python = venv_path / "bin" / "python3"

    print("\n== Installing dependencies ==")
    subprocess.run([str(python), "-m", "pip", "install", "--upgrade", "pip"], check=True)

    subprocess.run([
        str(python),
        "-m",
        "pip",
        "install",
        "web3"
    ], check=True)

    print("\n== Venv ready ==")

def venv_activate():
    return Path("venv") / "bin" / "python3"

def initialize_chain():
    """Clean Geth data and initialize the blockchain."""

    # Delete Geth data and socket
    subprocess.run(
        f"rm -rf {CHAINDATA_DIR}/geth && rm -f {CHAINDATA_DIR}/geth.ipc",
        shell=True,
        check=True,
    )

    # Geth initialization
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
        "--http.api", "web3,eth,debug,personal,net, txpool",
    ]

    subprocess.run(cmd)

def deployment_setup():
    """Run the setup using the virtual environment Python."""
    python = venv_activate()

    # Delete state files and run script
    subprocess.run("mkdir -p state", shell=True)
    subprocess.run("rm -f state/*", shell=True)
    subprocess.run([python, "python/setup.py"])

def oracle_daemon():
    """Run the oracle daemon using the virtual environment Python."""
    python = venv_activate()
    subprocess.run([python, "python/oracle_daemon.py"])

def auto_voter():
    """Run the auto-voter using the virtual environment Python."""
    python = venv_activate()
    subprocess.run([python, "python/auto_voter.py"])

def demo():
    """Run the demo using the virtual environment Python."""
    python = venv_activate()
    subprocess.run([python, "python/demo.py"])

def geth_attach():
    """Open the Geth JavaScript console."""
    subprocess.run(["geth", "attach", CHAIN_URL])

# -----------------------------------------------------------------------------
# MENU
# -----------------------------------------------------------------------------

MENU_ACTIONS = {
    "1": ("Copy blocks and run Offchain Scanner (run once)", offchain_scanner),
    "2": ("Setup Python venv (run once)", venv_setup),
    "3": ("Initialize Geth chain (run once)", initialize_chain),
    "4": ("Start Geth chain", start_chain),
    "5": ("Deployment (run once) to initialize accounts, funds, contracts", deployment_setup),
    "6": ("Start Oracle Daemon", oracle_daemon),
    "7": ("Start Auto Voter", auto_voter),
    "8": ("Start Demo", demo),
    "9": ("Attach to Geth (query the chain)", geth_attach),
}

def print_header(title):
    print("" + "=" * 70)
    print(f" {title}")
    print("=" * 70 + "")

def print_menu(): 
    print_header("Blockchain Utility")

    print("\nWorkflow")
    for key in ("1", "2", "3", "4", "5", "6", "7", "8"):
        print(f"{key}) {MENU_ACTIONS[key][0]}")

    print("\nOther")
    for key in ("9",):
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