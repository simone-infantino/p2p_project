// test/BitcoinOracle.test.ts
//
// Unit tests for every external operation of BitcoinOracle.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGwei, stringToHex } from "viem";
import { viem, BTC, eventsFrom } from "./helpers.js";

async function deployOracle() {
  const [owner, alice, bob] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const minFee = parseGwei("0.1") * 50_000n;
  const oracle = await viem.deployContract("BitcoinOracle", [minFee]);
  return { oracle, owner, alice, bob, publicClient, minFee };
}

describe("BitcoinOracle", () => {
  it("constructor sets owner, minimumFee and deploymentBlock", async () => {
    const { oracle, owner, minFee } = await deployOracle();
    assert.equal((await oracle.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    assert.equal(await oracle.read.minimumFee(), minFee);
    assert.ok((await oracle.read.deploymentBlock()) > 0n);
  });

  it("requestUpdate reverts when the fee is below the minimum", async () => {
    const { oracle, alice } = await deployOracle();
    await assert.rejects(
      oracle.write.requestUpdate([BTC], { account: alice.account, value: 0n }),
      /fee too low/
    );
  });

  it("requestUpdate succeeds, marks tracked, emits UpdateRequested", async () => {
    const { oracle, alice, minFee, publicClient } = await deployOracle();
    const hash = await oracle.write.requestUpdate([BTC], { account: alice.account, value: minFee });
    const logs = await eventsFrom(publicClient, oracle.abi, hash, "UpdateRequested");
    assert.equal(logs.length, 1);
    assert.equal(await oracle.read.tracked([BTC]), true);
  });

  it("pushBalance is restricted to the owner", async () => {
    const { oracle, alice } = await deployOracle();
    await assert.rejects(
      oracle.write.pushBalance([BTC, 100n], { account: alice.account }),
      /not oracle/
    );
  });

  it("pushBalance stores the balance and emits BalanceUpdated", async () => {
    const { oracle, publicClient } = await deployOracle();
    const hash = await oracle.write.pushBalance([BTC, 12_345n]);
    const logs = await eventsFrom(publicClient, oracle.abi, hash, "BalanceUpdated");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.satoshis, 12_345n);
    assert.equal(await oracle.read.getBalance([BTC]), 12_345n);
  });

  it("getBalance returns 0 for an unknown address", async () => {
    const { oracle } = await deployOracle();
    const unknown = stringToHex("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
    assert.equal(await oracle.read.getBalance([unknown]), 0n);
  });

  it("setMinimumFee is owner-only and updates the value", async () => {
    const { oracle, alice } = await deployOracle();
    await assert.rejects(oracle.write.setMinimumFee([1n], { account: alice.account }), /not oracle/);
    await oracle.write.setMinimumFee([999n]);
    assert.equal(await oracle.read.minimumFee(), 999n);
  });

  it("withdrawFees moves accumulated fees to the recipient", async () => {
    const { oracle, alice, bob, minFee, publicClient } = await deployOracle();
    await oracle.write.requestUpdate([BTC], { account: alice.account, value: minFee });
    const before = await publicClient.getBalance({ address: bob.account.address });
    await oracle.write.withdrawFees([bob.account.address]);
    const after = await publicClient.getBalance({ address: bob.account.address });
    assert.equal(after - before, minFee);
  });
});
