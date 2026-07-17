import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { anyValue } from "@nomicfoundation/hardhat-viem-assertions/predicates";
import { viem, networkHelpers, BTC, deploy_service } from "./helpers.js";

describe("BitcoinOracle", () => {
  it("constructor sets owner, minimum_fee and deployed_block", async () => {
    const { oracle, admin, min_fee } = await networkHelpers.loadFixture(deploy_service);
    assert.equal((await oracle.read.owner()).toLowerCase(), admin.account.address.toLowerCase());
    assert.equal(await oracle.read.minimum_fee(), min_fee);
    assert.ok((await oracle.read.deployed_block()) > 0n);
  });

  it("request_update reverts when the fee is below the minimum", async () => {
    const { oracle, alice, min_fee } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.revertWith(oracle.write.request_update([BTC], { account: alice.account, value: min_fee - 1n }), "fee too low"); });

  it("request_update succeeds and emits update_requested", async () => {
    const { oracle, alice, min_fee } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.emitWithArgs( oracle.write.request_update([BTC], { account: alice.account, value: min_fee }), oracle, "update_requested", [BTC, anyValue, min_fee] );
  });

  it("push_balance is restricted to the owner", async () => {
    const { oracle, alice } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.revertWith( oracle.write.push_balance([BTC, 100n], { account: alice.account }), "not oracle" );
  });

  it("push_balance stores the balance and emits balance_updated", async () => {
    const { oracle } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.emitWithArgs( oracle.write.push_balance([BTC, 12_345n]), oracle, "balance_updated", [BTC, 12_345n] );
    assert.equal(await oracle.read.get_balance([BTC]), 12_345n);
  });

  it("get_balance returns 0 for an unknown address", async () => {
    const { oracle } = await networkHelpers.loadFixture(deploy_service);
    const unknown = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
    assert.equal(await oracle.read.get_balance([unknown]), 0n);
  });

  it("set_minimum_fee is owner-only and updates the value", async () => {
    const { oracle, alice } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.revertWith(oracle.write.set_minimum_fee([1n], { account: alice.account }), "not oracle");
    await oracle.write.set_minimum_fee([999n]);
    assert.equal(await oracle.read.minimum_fee(), 999n);
  });

  it("withdraw_fees moves accumulated fees to the recipient", async () => {
    const { oracle, alice, bob, min_fee, public_client } = await networkHelpers.loadFixture(deploy_service);
    await oracle.write.request_update([BTC], { account: alice.account, value: min_fee });
    const before = await public_client.getBalance({ address: bob.account.address });
    await oracle.write.withdraw_fees([bob.account.address]);
    const after = await public_client.getBalance({ address: bob.account.address });
    assert.equal(after - before, min_fee);
  });
});
