// test/BitcoinOracle.test.ts
//
// Unit tests for every external operation of BitcoinOracle.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGwei } from "viem";
import { viem, BTC, eventsFrom } from "./helpers.js";

async function deployOracle() {
  const [owner, alice, bob] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const minFee = parseGwei("0.1") * 50_000n;
  const oracle = await viem.deployContract("BitcoinOracle", [minFee]);
  return { oracle, owner, alice, bob, publicClient, minFee };
}

describe("BitcoinOracle", () => {
  it("constructor sets owner, minimum_fee and deployed_block", async () => {
    const { oracle, owner, minFee } = await deployOracle();
    assert.equal((await oracle.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    assert.equal(await oracle.read.minimum_fee(), minFee);
    assert.ok((await oracle.read.deployed_block()) > 0n);
  });

  it("request_update reverts when the fee is below the minimum", async () => {
    const { oracle, alice, minFee } = await deployOracle();
    await assert.rejects(
      oracle.write.request_update([BTC], { account: alice.account, value: minFee -1n}),
      /fee too low/
    );
  });

  it("request_update succeeds and emits update_requested", async () => {
    const { oracle, alice, minFee, publicClient } = await deployOracle();
    const hash = await oracle.write.request_update([BTC], { account: alice.account, value: minFee });
    const logs = await eventsFrom(publicClient, oracle.abi, hash, "update_requested");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.BTC_addr.toLowerCase(), BTC.toLowerCase());
    assert.equal(logs[0].args.fee, minFee); 
  });

  it("push_balance is restricted to the owner", async () => {
    const { oracle, alice } = await deployOracle();
    await assert.rejects(
      oracle.write.push_balance([BTC, 100n], { account: alice.account }),
      /not oracle/
    );
  });

  it("push_balance stores the balance and emits balance_updated", async () => {
    const { oracle, publicClient } = await deployOracle();
    const hash = await oracle.write.push_balance([BTC, 12_345n]);
    const logs = await eventsFrom(publicClient, oracle.abi, hash, "balance_updated");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.satoshis, 12_345n);
    assert.equal(await oracle.read.get_balance([BTC]), 12_345n);
  });

  it("get_balance returns 0 for an unknown address", async () => {
    const { oracle } = await deployOracle();
    const unknown = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
    assert.equal(await oracle.read.get_balance([unknown]), 0n);
  });

  it("set_minimum_fee is owner-only and updates the value", async () => {
    const { oracle, alice } = await deployOracle();
    await assert.rejects(oracle.write.set_minimum_fee([1n], { account: alice.account }), /not oracle/);
    await oracle.write.set_minimum_fee([999n]);
    assert.equal(await oracle.read.minimum_fee(), 999n);
  });

  it("withdraw_fees moves accumulated fees to the recipient", async () => {
    const { oracle, alice, bob, minFee, publicClient } = await deployOracle();
    await oracle.write.request_update([BTC], { account: alice.account, value: minFee });
    const before = await publicClient.getBalance({ address: bob.account.address });
    await oracle.write.withdraw_fees([bob.account.address]);
    const after = await publicClient.getBalance({ address: bob.account.address });
    assert.equal(after - before, minFee);
  });
});
