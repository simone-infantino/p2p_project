// scripts/measure_oracle_fee.ts
//
// Computes the Bitcoin liquidity oracle minimum fee exactly as the spec defines:
//   minimumFee = gasCost(pushBalance) * 0.1 gwei
//
// Deploys the oracle with a placeholder fee, measures the gas of the
// "update operation" (pushBalance), computes the fee, and writes it back via
// setMinimumFee.
//
// Run on the in-process network:   npx hardhat run scripts/measure_oracle_fee.ts
// Run against your geth node:      npx hardhat run scripts/measure_oracle_fee.ts --network local
//
// (Compile first so the contract artifact/types exist:  npx hardhat compile)

import { network } from "hardhat";
import { stringToHex, parseGwei, formatEther } from "viem";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  // 1. deploy with a temporary placeholder fee (overwritten below)
  const oracle = await viem.deployContract("BitcoinOracle", [1n]);
  console.log("oracle deployed at", oracle.address);

  // 2. measure the gas cost of the update operation (pushBalance).
  //    We write to a brand-new address (cold storage slot) — the worst case,
  //    and therefore a safe/conservative basis for the fee.
  //    stringToHex turns the canonical address string into the ASCII 0x-bytes
  //    the contract keys on (matches the scanner's address.toString()).
  const btcAddr = stringToHex("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
  const sats = 5_000_000_000n; // 50 BTC, arbitrary representative value

  const hash = await oracle.write.pushBalance([btcAddr, sats]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const gasUsed = receipt.gasUsed;

  // 3. fee = gasUsed * 0.1 gwei   (parseGwei("0.1") = 1e8 wei)
  const tenthGwei = parseGwei("0.1");
  const minimumFee = gasUsed * tenthGwei;

  console.log("---------------------------------------------");
  console.log("pushBalance gas used .......", gasUsed.toString());
  console.log("0.1 gwei (wei) ............ ", tenthGwei.toString());
  console.log("minimum fee (wei) ......... ", minimumFee.toString());
  console.log("minimum fee (ETH) ......... ", formatEther(minimumFee));
  console.log("---------------------------------------------");

  // 4. write the computed fee back into the contract
  const setHash = await oracle.write.setMinimumFee([minimumFee]);
  await publicClient.waitForTransactionReceipt({ hash: setHash });
  const onchain = await oracle.read.minimumFee();
  console.log("on-chain minimumFee now", onchain.toString(), "wei");

  // For your setup.py: deploy the oracle with this value directly, or call
  // setMinimumFee after deployment. Either path yields the spec-required fee.
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});