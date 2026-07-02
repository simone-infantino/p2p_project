# Project guide

## Setup chain using Geth

### Environment variables
Set `ACCOUNT_PUB_ADDR` with the one in `chain/keystore/file`
```shell
export CHAINDATA_DIR=chain/data
export GENESIS_FILE=chain/project2526genesis.json
export ACCOUNT_PUB_ADDR=d278d247a52c550508ea2b2c9321d816238fb523
export CHAIN_HOST=127.0.0.1
export CHAIN_PORT=8545
export CHAIN_URL="http://${CHAIN_HOST}:${CHAIN_PORT}"
export CHAIN_NET_ID=202526
```
### Clean (only if necessary)
Only if the keystore folder is located in `chain/keystore` (NOT in `data/keystore`)
```shell
rm -rf $CHAINDATA_DIR/*
```

### Copy prof file

Copy `psw-1.txt` and `UTC--2026-05-05...--d27...523` into `keystore` folder
```shell
mkdir $CHAINDATA_DIR/keystore
```
Copy into chain
```shell
0xd278...23psw.txt
project2526genesis.json
```

### Init (only once)
```shell
geth --datadir $CHAINDATA_DIR init $GENESIS_FILE
```

### Start node (clique)
```shell
geth --datadir "${CHAINDATA_DIR}" \
  --networkid "${CHAIN_NET_ID}" \
  --unlock "0x${ACCOUNT_PUB_ADDR}" \
  --password "chain/psw.txt" \
  --mine \
  --miner.etherbase="0x${ACCOUNT_PUB_ADDR}" \
  --allow-insecure-unlock \
  --http \
  --http.corsdomain="${CHAIN_URL}" \
  --http.api "web3,eth,debug,personal,net"
```

### Geth attach

Check block production
```shell
geth attach $CHAIN_URL
eth.blockNumber
```

Check account balance
```shell
eth.getBalance(eth.accounts[2])
eth.getBalance("ACCOUNT_ADDRESS")
```

### Chain file tree
```shell
.
└── chain
    ├── psw.txt
    ├── data
    │   ├── geth
    │   │   ├── LOCK
    │   │   ├── blobpool
    │   │   ├── chaindata
    │   │   ├── jwtsecret
    │   │   ├── lightchaindata
    │   │   ├── nodekey
    │   │   ├── nodes
    │   │   └── transactions.rlp
    │   ├── geth.ipc
    │   └── keystore
    │       └── UTC--2026-05-05..23
    └── project2526genesis.json
```

---

## PrivateEtherExplorer-master

Download and extract
```shell
wget https://github.com/adeshshukla/PrivateEtherExplorer/archive/refs/heads/master.zip
```

Edit `serverConfig.js` to set:
```
ChainPortNo: 8545,
ChainIpAddr: "localhost"
```

Install
```shell
npm install
npm start
```

Open `http://localhost:8546` in browser

---

## web3 Python library

[web3 documentation](https://web3py.readthedocs.io/en/stable/web3.eth.html)

Create a Python virtual environment and install `web3` library
```shell
python -m venv venv
source venv/bin/activate # Enter
pip install web3
pip list | grep web3 # Check version
deactivate # Exit
```

`example-1.py`
```python
from web3 import Web3
from web3.middleware import geth_poa_middleware
import time
import datetime
from datetime import datetime

url = "http://localhost:8545/"
web3 = Web3(Web3.HTTPProvider(url))
web3.middleware_onion.inject(geth_poa_middleware, layer=0)

ipc = Web3(Web3.IPCProvider('./lecture9Folder/data/geth.ipc'))

	
print("[http] This should return True: "+str(web3.isConnected()))
print("[http] Network id: "+str(web3.net.version))

print("[ipc] This should return True: "+str(web3.isConnected()))
print("[ipc] Network id: "+str(web3.net.version))
```

---

## Bitcoin Java Scanner

Start daemon
```shell
bitcoind -daemon
ps aux | grep bitcoind # Check
```

Download blocks
```shell
bitcoind -stopatheight=131000 -daemon
# Bitcoin Core starting
# Running in background

# Check state running the following command
tail -f ~/.bitcoin/debug.log
```

Info commands
```shell
bitcoin-cli getnetworkinfo
bitcoin-cli getblockchaininfo
bitcoin-cli getblockcount
```

Stop bitcoin
```shell
bitcoin-cli stop
```

Block files directory
```
$HOME/.bitcoin/blocks/
|-- blk00000.dat
|-- blk00001.dat
|-- blk00002.dat
|-- index
|   |-- 000005.ldb
|   |-- 000007.ldb
|   |-- 000008.log
|   |-- CURRENT
|   |-- LOCK
|   `-- MANIFEST-000006
|-- rev00000.dat
|-- rev00001.dat
|-- rev00002.dat
`-- xor.dat
```
Check block sizes
```shell
ls -lh $HOME/.bitcoin/blocks/*.dat
```

```shell
bitcoin-cli getblockhash 131030
```

Copy/Move block files
```shell
mkdir bt_chain_blocks
cp -r $HOME/.bitcoin/blocks/* bt_chain_blocks/
```

Create Java Maven project
```shell
cd project_folder
mvn archetype:generate \
	-DgroupId=com.myname.bitcoin \
    -DartifactId=offchain-scanner \
    -DarchetypeArtifactId=maven-archetype-quickstart \
    -DinteractiveMode=false
```

Create `utxo_snapshot.tsv` snapshot
```shell
mvn clean package
mvn clean compile
# java com.scanner.UtxoScanner <blocksDir> <outputSnapshot.tsv> [maxBlocks=131000]
java -jar target/offchain-scanner-1.0-SNAPSHOT-jar-with-dependencies.jar \
  ~/projects/finalproject/bt_chain_blocks \
  utxo_snapshot.tsv 131000
```

---

## Hardhat

### Install or update to latest version
```
npm install -g hardhat@latest # system
npm install --save-dev hardhat@latest # project
npx hardhat --version
``

### Create project
```shell
npx hardhat --init
```
Select Hardhat version 3 and set project path

Select project type: 
- [*] TypeScript using Node Test Runner and Viem
- [ ] TypeScript using Mocha and Ethers.js
- [ ] Minimal

### Project structure
```shell
hardhat/
├── contracts # contracts solidity source code
|   ├── Counter.sol
|   └── Counter.t.sol
├── ignition/modules # to manage contracts deployment and initial set up
├── node_modules # for npm libraries
|   └── Counter.ts
├── scripts
|   └── send-op-tx.ts
├── test # test ﬁles (ts or sol)
|   └── Counter.ts
├── hardhat.config.ts # project main conﬁg ﬁle (e.g. to set the compiler version)
├── package-lock.json
├── package.json # for npm libraries
├── README.md
└── tsconfig.json
```

### Config file
Edit `hardhat.config.ts` to set local chain

### Plugins
```shell
npm install --save-dev @nomicfoundation/hardhat-toolbox-viem
```

### Build
```shell
npx hardhat build
```
This produces a new artifacts folder with josn s for each contract containing, among other information, the ABI and bytecode.
Note: any contract not yet compiled will be compiled before a test automatically, so **no need to call build before every test**.

### Test
```shell
npx hardhat test
npx hardhat test solidity # run sol tests only and no ts
npx hardhat test ﬁle1 file2 # run only speciﬁc test ﬁles
```
Each function test is considered passed if the function does not revert (usually requires are added to test functions to revert if something unexpected happens).

Each test contract may contain a function named `setUp` that will be executed before every test function.

Can use a sort of `println` through `console.log(...)` [Console - Node.js Documentation](https://nodejs.org/dist/latest-v12.x/docs/api/console.html#console_console_log_data_args) after importing import `hardhat/console.sol`.

### Foundry
Advanced debugging functionalities in the [forge standard library](https://github.com/foundry-rs/forge-std).
```shell
npm add --save-dev 'github:foundry-rs/forge-std#v1.9.7
```
In your test contract
```ts
import { Test } from "forge-std/Test.sol";
contract ContractTest1 is Test {
```

### Coverage
Produce a coverage report in `coverage/index.html`
```shell
npx hardhat test ./contracts/CreatedTest3.t.sol --coverage
```

---