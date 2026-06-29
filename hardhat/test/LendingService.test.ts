// test/LendingService.test.ts
//
// Unit tests for LendingService's own operations: funding pool, proposals,
// voting, the resolveProposal branches, and admin/termination.
// (Loan-specific behaviour and multi-step stories live in Loan.test.ts and
// Scenarios.test.ts.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther, zeroAddress } from "viem";
import { deployService, fund, approveLoan, eventsFrom, networkHelpers, BTC } from "./helpers.js";

describe("LendingService — funding pool", () => {
  it("deposit reverts below the minimum deposit", async () => {
    const { service, alice } = await deployService();
    await assert.rejects(service.write.deposit({ account: alice.account, value: 99_999n }), /below min deposit/);
  });

  it("deposit records the value and registers the contributor", async () => {
    const { service, alice, publicClient } = await deployService();
    const hash = await service.write.deposit({ account: alice.account, value: parseEther("1") });
    const logs = await eventsFrom(publicClient, service.abi, hash, "Deposited");
    assert.equal(logs.length, 1);
    assert.equal(await service.read.deposited([alice.account.address]), parseEther("1"));
  });

  it("withdraw returns disposable value and reverts past it", async () => {
    const { service, alice } = await deployService();
    await service.write.deposit({ account: alice.account, value: parseEther("2") });
    await service.write.withdraw([parseEther("1")], { account: alice.account });
    assert.equal(await service.read.deposited([alice.account.address]), parseEther("1"));
    await assert.rejects(service.write.withdraw([parseEther("5")], { account: alice.account }), /exceeds disposable/);
  });

  it("withdrawing the entire balance deregisters the contributor", async () => {
    const { service, alice } = await deployService();
    await service.write.deposit({ account: alice.account, value: parseEther("2") });
    await service.write.withdraw([parseEther("2")], { account: alice.account });
    assert.equal(await service.read.isContributor([alice.account.address]), false);
  });
});

describe("LendingService — proposals & voting", () => {
  it("submitProposal stores the proposal and emits ProposalSubmitted", async () => {
    const { service, applicant, publicClient } = await deployService();
    const hash = await service.write.submitProposal([parseEther("1"), 10, 100n, BTC], { account: applicant.account });
    const logs = await eventsFrom(publicClient, service.abi, hash, "ProposalSubmitted");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.applicant.toLowerCase(), applicant.account.address.toLowerCase());
  });

  it("submitProposal rejects an out-of-range interest rate", async () => {
    const { service, applicant } = await deployService();
    await assert.rejects(service.write.submitProposal([parseEther("1"), 0, 100n, BTC], { account: applicant.account }), /rate out of range/);
    await assert.rejects(service.write.submitProposal([parseEther("1"), 101, 100n, BTC], { account: applicant.account }), /rate out of range/);
  });

  it("vote records a contributor's vote", async () => {
    const { service, alice, applicant, publicClient } = await deployService();
    await service.write.deposit({ account: alice.account, value: parseEther("1") });
    await service.write.submitProposal([parseEther("0.5"), 10, 100n, BTC], { account: applicant.account });
    const hash = await service.write.vote([0n, true], { account: alice.account });
    const logs = await eventsFrom(publicClient, service.abi, hash, "Voted");
    assert.equal(logs.length, 1);
  });

  it("vote reverts for a non-contributor", async () => {
    const { service, bob, applicant } = await deployService();
    await service.write.submitProposal([parseEther("0.5"), 10, 100n, BTC], { account: applicant.account });
    await assert.rejects(service.write.vote([0n, true], { account: bob.account }), /not a contributor/);
  });

  it("vote reverts once the voting window has closed", async () => {
    const { service, alice, applicant } = await deployService();
    await service.write.deposit({ account: alice.account, value: parseEther("1") });
    await service.write.submitProposal([parseEther("0.5"), 10, 100n, BTC], { account: applicant.account });
    await networkHelpers.mine(13);
    await assert.rejects(service.write.vote([0n, true], { account: alice.account }), /voting window closed/);
  });
});

describe("LendingService — resolveProposal branches", () => {
  it("reverts when resolved too early", async () => {
    const { service, applicant } = await deployService();
    await service.write.submitProposal([parseEther("1"), 10, 100n, BTC], { account: applicant.account });
    await assert.rejects(service.write.resolveProposal([0n], { account: applicant.account }), /too early/);
  });

  it("reverts when the caller is not the applicant", async () => {
    const { service, applicant, bob } = await deployService();
    await service.write.submitProposal([parseEther("1"), 10, 100n, BTC], { account: applicant.account });
    await networkHelpers.mine(13);
    await assert.rejects(service.write.resolveProposal([0n], { account: bob.account }), /not applicant/);
  });

  it("rejects when disposable pool is insufficient", async () => {
    const ctx = await deployService();
    await ctx.service.write.deposit({ account: ctx.alice.account, value: parseEther("1") });
    const { approved, loanAddr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.equal(approved, false);
    assert.equal(loanAddr.toLowerCase(), zeroAddress);
  });

  it("rejects when the BTC liquidity check fails", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { approved } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n, pushBtc: false });
    assert.equal(approved, false);
  });

  it("rejects on an implicit-reject majority (no approve votes)", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { approved } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n, votes: false });
    assert.equal(approved, false);
  });

  it("approves and deploys a Loan when all checks pass", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { approved, loanAddr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.equal(approved, true);
    assert.equal(await ctx.service.read.isActiveLoan([loanAddr]), true);
  });
});

describe("LendingService — admin & termination", () => {
  it("only the admin can set the successor", async () => {
    const { service, alice, bob } = await deployService();
    await assert.rejects(service.write.setSuccessor([bob.account.address], { account: alice.account }), /not admin/);
  });

  it("admin can set a successor and terminate when no value is locked", async () => {
    const { service, admin, bob } = await deployService();
    await service.write.setSuccessor([bob.account.address], { account: admin.account });
    await service.write.terminate({ account: admin.account });
    assert.equal(await service.read.terminated(), true);
  });

  it("terminate reverts without a successor", async () => {
    const { service, admin } = await deployService();
    await assert.rejects(service.write.terminate({ account: admin.account }), /no successor/);
  });
});
