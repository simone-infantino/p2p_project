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

def npm_modules_setup():
    project_dir = "hardhat"

    try:
        subprocess.run(
            ["npm", "ci"],
            cwd=project_dir,
            check=True
        )

    except subprocess.CalledProcessError as e:
        print(f"Error while executing command: {e}")
        raise

def hardhat_build():
    project_dir = "hardhat"

    try:
        subprocess.run(
            ["npx", "hardhat", "build"],
            cwd=project_dir,
            check=True
        )

    except subprocess.CalledProcessError as e:
        print(f"Error while executing command: {e}")
        raise

def hardhat_setup_and_build():
    npm_modules_setup()
    hardhat_build()

def offchain_scanner():
    try:
        # 1. Check Bitcoin blocks directory
        bitcoin_blocks_dir = Path("bt_chain_blocks")

        if not bitcoin_blocks_dir.exists():
            raise FileNotFoundError("Bitcoin blocks directory 'bt_chain_blocks' not found.")

        # Check that the directory is not empty
        if not any(bitcoin_blocks_dir.iterdir()):
            raise FileNotFoundError("Bitcoin blocks directory 'bt_chain_blocks' is empty.")

        print("Bitcoin blocks directory 'bt_chain_blocks' found.")

        # 2. Compile Java off-chain scanner
        project_dir = Path("offchain-scanner")

        subprocess.run(
            ["mvn", "clean", "package"],
            cwd=project_dir,
            check=True
        )

        # 3. Run generated .jar file
        subprocess.run([
            "java",
            "-jar",
            "target/offchain-scanner-1.0-SNAPSHOT-jar-with-dependencies.jar",
            "../bt_chain_blocks",
            "utxo_snapshot.txt",
            "131000"
        ], cwd=project_dir, check=True)

        print("Off-chain scan completed successfully.")

    except FileNotFoundError as e:
        print(f"Error: {e}")
        raise

    except subprocess.CalledProcessError as e:
        print(f"Error while executing the command: {e}")
        raise

def venv_setup():
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
    python = venv_activate()

    # Delete state files and run script
    subprocess.run("mkdir -p state", shell=True)
    subprocess.run("rm -f state/*", shell=True)
    subprocess.run([python, "python/setup.py"])

def oracle_daemon():
    python = venv_activate()
    subprocess.run([python, "python/oracle_daemon.py"])

def auto_voter():
    python = venv_activate()
    subprocess.run([python, "python/auto_voter.py"])

def demo():
    python = venv_activate()
    subprocess.run([python, "python/demo.py"])

def geth_attach():
    subprocess.run(["geth", "attach", CHAIN_URL])

# -----------------------------------------------------------------------------
# MENU
# -----------------------------------------------------------------------------

MENU_ACTIONS = {
    "1": ("Run Hardhat setup (run once)", hardhat_setup_and_build),
    "2": ("Run Offchain Scanner (run once)", offchain_scanner),
    "3": ("Setup Python venv (run once)", venv_setup),
    "4": ("Initialize Geth chain (run once)", initialize_chain),
    "5": ("Start Geth chain", start_chain),
    "6": ("Deployment (run once) to initialize accounts, funds, contracts", deployment_setup),
    "7": ("Start Oracle Daemon", oracle_daemon),
    "8": ("Start Auto Voter", auto_voter),
    "9": ("Start Demo", demo),
    "10": ("Attach to Geth (query the chain)", geth_attach),
}

def print_header(title):
    print("" + "=" * 70)
    print(f" {title}")
    print("=" * 70 + "")

def print_menu(): 
    print_header("Blockchain Utility")

    print("\nWorkflow")
    for key in ("1", "2", "3", "4", "5", "6", "7", "8", "9",):
        print(f"{key}) {MENU_ACTIONS[key][0]}")

    print("\nOther")
    for key in ("10",):
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

            title, func = action
            print_header(title)
            func()
            print()

    except KeyboardInterrupt:
        print()
        exit_program()


if __name__ == "__main__":
    main()