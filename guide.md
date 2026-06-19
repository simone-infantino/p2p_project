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
geth --datadir $CHAINDATA_DIR \
  --http \
  --http.addr $CHAIN_HOST \
  --http.port $CHAIN_PORT \
  --http.api eth,net,web3,clique,personal \
  --allow-insecure-unlock \
  --unlock $ACCOUNT_PUB_ADDR \
  --mine
```

`PROF_COMMAND`
```shell
geth --datadir ./data \
  --networkid 20269 \
  --unlock 0x9cD353F9E3Cfe91bEE50F50F039ccC5bA10EeecD \
  --password psw.txt \
  --mine \
  --miner.etherbase=0x9cD353F9E3Cfe91bEE50F50F039ccC5bA10EeecD \
  --allow-insecure-unlock \
  --http \
  --http.corsdomain="https://remix.ethereum.org,http://127.0.0.1:8000" \
  --http.api "web3,eth,debug,personal,net"
```

`PROF_COMMAND` formatted to use variables and without Remix URL
```shell
geth --datadir "${CHAINDATA_DIR}" \
  --networkid "${CHAIN_NET_ID}" \
  --unlock "0x${ACCOUNT_PUB_ADDR}" \
  --password "/a/keystore/psw-1.txt" \
  --mine \
  --miner.etherbase="0x${ACCOUNT_PUB_ADDR}" \
  --allow-insecure-unlock \
  --http \
  --http.corsdomain="${CHAIN_URL}" \
  --http.api "web3,eth,debug,personal,net"
```

### Check block production (another terminal)
Attach to the Geth console and verify that blocks are being produced:
```shell
geth attach $CHAIN_URL
eth.blockNumber
```

### Chain file tree
```shell
.
└── chain
    ├── 0xd278d247A52C550508ea2b2C9321d816238fb523psw.txt
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
    │       ├── UTC--2026-05-05T14-09-10.723312492Z--d278d247a52c550508ea2b2c9321d816238fb523
    │       └── psw-1.txt
    └── project2526genesis.json
```

### PrivateEtherExplorer-master

```shell
wget https://github.com/adeshshukla/PrivateEtherExplorer/archive/refs/heads/master.zip
```

edit `serverConfig.js` to set:
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
