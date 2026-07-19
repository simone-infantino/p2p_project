import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { anyValue } from "@nomicfoundation/hardhat-viem-assertions/predicates";
import { viem, networkHelpers, deploy_service, fund, approve_loan, BTC } from "./helpers.js";

describe("funding pool", () => {
  it("deposit reverts below the minimum deposit", async () => {
    const { service, alice } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.revertWith(service.write.deposit({ account: alice.account, value: 99_999n }), "below min deposit");
  });

  it("deposit records the value and registers the contributor", async () => {
    const { service, alice } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.emit(
      service.write.deposit({ account: alice.account, value: parseEther("1") }),
      service,
      "Deposited"
    );
    assert.equal(await service.read.deposited([alice.account.address]), parseEther("1"));
  });

  it("withdraw returns disposable value and reverts past it", async () => {
    const { service, alice } = await networkHelpers.loadFixture(deploy_service);
    await service.write.deposit({ account: alice.account, value: parseEther("2") });
    await service.write.withdraw([parseEther("1")], { account: alice.account });
    assert.equal(await service.read.deposited([alice.account.address]), parseEther("1"));
    await viem.assertions.revertWith(service.write.withdraw([parseEther("5")], { account: alice.account }), "exceeds disposable");
  });

  it("withdrawing the entire balance deregisters the contributor", async () => {
    const { service, alice } = await networkHelpers.loadFixture(deploy_service);
    await service.write.deposit({ account: alice.account, value: parseEther("2") });
    await service.write.withdraw([parseEther("2")], { account: alice.account });
    assert.equal(await service.read.is_contributor([alice.account.address]), false);
  });
});

describe("proposals and voting", () => {
  it("submit_proposal stores the proposal and emits proposal_submitted", async () => {
    const { service, applicant } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.emitWithArgs(
      service.write.submit_proposal([parseEther("1"), 10, 100n, BTC], { account: applicant.account }),
      service,
      "proposal_submitted",
      [anyValue, applicant.account.address, anyValue, anyValue, anyValue, anyValue]
    );
  });

  it("submit_proposal rejects an out-of-range interest rate", async () => {
    const { service, applicant } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.revertWith(service.write.submit_proposal([parseEther("1"), 0, 100n, BTC], { account: applicant.account }), "rate out of range");
    await viem.assertions.revertWith(service.write.submit_proposal([parseEther("1"), 101, 100n, BTC], { account: applicant.account }), "rate out of range");
  });

  it("vote records a contributor's vote", async () => {
    const { service, alice, applicant } = await networkHelpers.loadFixture(deploy_service);
    await service.write.deposit({ account: alice.account, value: parseEther("1") });
    await service.write.submit_proposal([parseEther("0.5"), 10, 100n, BTC], { account: applicant.account });
    await viem.assertions.emit(
      service.write.vote([0n, true], { account: alice.account }),
      service,
      "Voted"
    );
  });

  it("vote reverts for a non-contributor", async () => {
    const { service, bob, applicant } = await networkHelpers.loadFixture(deploy_service);
    await service.write.submit_proposal([parseEther("0.5"), 10, 100n, BTC], { account: applicant.account });
    await viem.assertions.revertWith(service.write.vote([0n, true], { account: bob.account }), "not a contributor");
  });

  it("vote reverts once the voting window has closed", async () => {
    const { service, alice, applicant } = await networkHelpers.loadFixture(deploy_service);
    await service.write.deposit({ account: alice.account, value: parseEther("1") });
    await service.write.submit_proposal([parseEther("0.5"), 10, 100n, BTC], { account: applicant.account });
    await networkHelpers.mine(13);
    await viem.assertions.revertWith(service.write.vote([0n, true], { account: alice.account }), "voting window closed");
  });
});

describe("resolve_proposal cases", () => {
  it("reverts when resolved too early", async () => {
    const { service, applicant } = await networkHelpers.loadFixture(deploy_service);
    await service.write.submit_proposal([parseEther("1"), 10, 100n, BTC], { account: applicant.account });
    await viem.assertions.revertWith(service.write.resolve_proposal([0n], { account: applicant.account }), "too early");
  });

  it("reverts when the caller is not the applicant", async () => {
    const { service, applicant, bob } = await networkHelpers.loadFixture(deploy_service);
    await service.write.submit_proposal([parseEther("1"), 10, 100n, BTC], { account: applicant.account });
    await networkHelpers.mine(13);
    await viem.assertions.revertWith(service.write.resolve_proposal([0n], { account: bob.account }), "not applicant");
  });

  it("rejects when disposable pool is insufficient", async () => {
    const context = await networkHelpers.loadFixture(deploy_service);
    await context.service.write.deposit({ account: context.alice.account, value: parseEther("1") });
    const { approved } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.equal(approved, false);
  });

  it("rejects when the BTC liquidity check fails", async () => {
    const context = await networkHelpers.loadFixture(deploy_service);
    await fund(context, parseEther("6"));
    const { approved } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 100n, BTC_address: false });
    assert.equal(approved, false);
  });

  it("rejects on an implicit-reject majority (no approve votes)", async () => {
    const context = await networkHelpers.loadFixture(deploy_service);
    await fund(context, parseEther("6"));
    const { approved } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 100n, votes: false });
    assert.equal(approved, false);
  });

  it("approves and deploys a Loan when all checks pass", async () => {
    const context = await networkHelpers.loadFixture(deploy_service);
    await fund(context, parseEther("6"));
    const { approved, loan_addr } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.equal(approved, true);
    assert.equal(await context.service.read.active_loan([loan_addr]), true);
  });
});

describe("admin & termination", () => {
  it("only the admin can set the successor", async () => {
    const { service, alice, bob } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.revertWith(service.write.set_successor([bob.account.address], { account: alice.account }), "not admin");
  });

  it("admin can set a successor and terminate when no value is locked", async () => {
    const { service, oracle, admin } = await networkHelpers.loadFixture(deploy_service);
    const successor = await viem.deployContract("LoanService", [oracle.address]);
    await successor.write.set_migration_source([service.address], { account: admin.account });
    await service.write.set_successor([successor.address], { account: admin.account });
    await service.write.terminate({ account: admin.account });
    assert.equal(await service.read.terminated(), true);
  });

  it("terminate reverts without a successor", async () => {
    const { service, admin } = await networkHelpers.loadFixture(deploy_service);
    await viem.assertions.revertWith(service.write.terminate({ account: admin.account }), "no successor");
  });
});
