// test/Scenarios.test.ts
//
// End-to-end scenario tests. Each describe block is a complete story.
// Shared setup lives in helpers.ts.
//
// LOAN-COUNT PRINCIPLE: the compensation pool can only be funded by a loan
// repayment (interest collateral, or principal overflow). So a scenario needs a
// second "primer" loan ONLY when its subject loan is never repaid (and therefore
// can't fund its own pool). Scenarios whose subject loan is repaid — even just
// partially before failing — fund the pool themselves and use a single loan.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther, zeroAddress } from "viem";
import {
  deployService, fund, approveLoan, totalOwed, eventsFrom,
  networkHelpers, BTC, ONE_BTC_SATS,
} from "./helpers.js";

// ── 1. accepted and repaid correctly — 1 loan ─────────────────────────────────
describe("Scenario 1 — loan accepted and fully repaid", () => {
  it("marks the loan successful, deactivates it, and funds the compensation pool", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { loan, loanAddr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);

    await loan!.write.repay({ account: ctx.applicant.account, value: totalOwed(parseEther("5"), 10) });

    assert.equal(await loan!.read.successful(), true);
    assert.equal(await ctx.service.read.isActiveLoan([loanAddr]), false);
    assert.ok((await ctx.service.read.compensationPool()) > 0n);
    assert.equal(await loan!.read.remainingDue([ctx.alice.account.address]), 0n);
  });
});

// ── 2. accepted but never repaid — 1 loan ─────────────────────────────────────
describe("Scenario 2 — loan accepted but not repaid", () => {
  it("stays active until expiry, then reads as failed", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { loan, loanAddr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 3n });
    assert.ok(loan);

    assert.equal(await loan!.read.isExpired(), false);
    await networkHelpers.mine(5);
    assert.equal(await loan!.read.isExpired(), true);
    assert.equal(await loan!.read.isFailed(), true);
    assert.equal(await ctx.service.read.isActiveLoan([loanAddr]), true); // active until claimed
  });
});

// ── 3. not accepted — 0 loans (every rejection reason) ────────────────────────
describe("Scenario 3 — loan not accepted", () => {
  it("rejected: insufficient disposable pool", async () => {
    const ctx = await deployService();
    await ctx.service.write.deposit({ account: ctx.alice.account, value: parseEther("1") });
    const { approved, loanAddr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.equal(approved, false);
    assert.equal(loanAddr.toLowerCase(), zeroAddress);
  });

  it("rejected: BTC liquidity check fails (no balance pushed)", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { approved } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n, pushBtc: false });
    assert.equal(approved, false);
  });

  it("rejected: majority reject (no approve votes cast)", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { approved } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n, votes: false });
    assert.equal(approved, false);
  });

  it("rejected: exact tie counts as reject", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    await ctx.oracle.write.pushBalance([BTC, ONE_BTC_SATS]);
    await ctx.service.write.submitProposal([parseEther("5"), 10, 100n, BTC], { account: ctx.applicant.account });
    await ctx.service.write.vote([0n, true], { account: ctx.alice.account });
    await ctx.service.write.vote([0n, false], { account: ctx.bob.account });
    await networkHelpers.mine(13);
    const hash = await ctx.service.write.resolveProposal([0n], { account: ctx.applicant.account });
    const logs = await eventsFrom(ctx.publicClient, ctx.service.abi, hash, "ProposalResolved");
    assert.equal(logs[0].args.approved, false);
  });

  it("reverts: resolved too early / by the wrong caller", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    await ctx.oracle.write.pushBalance([BTC, ONE_BTC_SATS]);
    await ctx.service.write.submitProposal([parseEther("5"), 10, 100n, BTC], { account: ctx.applicant.account });
    await assert.rejects(ctx.service.write.resolveProposal([0n], { account: ctx.applicant.account }), /too early/);
    await networkHelpers.mine(13);
    await assert.rejects(ctx.service.write.resolveProposal([0n], { account: ctx.bob.account }), /not applicant/);
  });
});

// ── 4. repaid after expiry, no compensation — 1 loan ──────────────────────────
describe("Scenario 4 — repaid after expiry (failed-by-time, never compensated)", () => {
  it("a full repayment after expiry completes the loan because it was never failed-marked", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { loan } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 3n });
    assert.ok(loan);

    await networkHelpers.mine(5);
    assert.equal(await loan!.read.isFailed(), true); // expired & unpaid

    await loan!.write.repay({ account: ctx.applicant.account, value: totalOwed(parseEther("5"), 10) });
    assert.equal(await loan!.read.successful(), true);
    assert.equal(await loan!.read.failedMarked(), false);
  });
});

// ── 5. repaid after expiry, AFTER a compensation claim — 1 loan ────────────────
describe("Scenario 5 — repaid after expiry, but a contributor already compensated", () => {
  it("stays failed (never becomes successful) after the late full repayment", async () => {
    const ctx = await deployService();
    const { service, alice, applicant } = ctx;
    await fund(ctx, parseEther("6"));
    const { loan, loanAddr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 5n });
    assert.ok(loan);

    // ONE loan only. It must fund its own pool so the compensation claim can
    // succeed, so the applicant makes a small partial payment BEFORE expiry —
    // the collateral share of that payment's interest is what fills the pool.
    await loan!.write.repay({ account: applicant.account, value: parseEther("1") });
    assert.ok((await service.read.compensationPool()) > 0n);

    // let it expire as a failed loan
    await networkHelpers.mine(10);
    assert.equal(await loan!.read.isFailed(), true);

    // contributor claims compensation -> markFailed
    await service.write.claimCompensation([loanAddr], { account: alice.account });
    assert.equal(await loan!.read.failedMarked(), true);

    // applicant now repays the rest in full AFTER it was marked failed
    await loan!.write.repay({ account: applicant.account, value: totalOwed(parseEther("5"), 10) });

    // spec: a failed loan can NOT later become successful
    assert.equal(await loan!.read.successful(), false);
    assert.equal(await loan!.read.failedMarked(), true);
  });
});

// ── 6. not repaid, contributor compensated — 2 loans (primer required) ─────────
describe("Scenario 6 — loan not repaid, contributor claims compensation", () => {
  it("pays the contributor and marks the loan failed", async () => {
    // The subject loan is NEVER repaid, so it cannot fund its own pool; a primer
    // loan (fully repaid) is the minimum needed to put value in the pool.
    const ctx = await deployService();
    const { service, alice, bob, applicant, publicClient } = ctx;
    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.deposit({ account: bob.account, value: parseEther("10") });

    // primer (loan 0): fully repaid -> funds the pool
    let r = await approveLoan(ctx, { amount: parseEther("4"), rate: 50, duration: 100n, id: 0n });
    await r.loan!.write.repay({ account: applicant.account, value: totalOwed(parseEther("4"), 50) });
    assert.ok((await service.read.compensationPool()) > 0n);

    // subject (loan 1): never repaid -> fails
    r = await approveLoan(ctx, { amount: parseEther("4"), rate: 10, duration: 2n, id: 1n });
    await networkHelpers.mine(5);
    assert.equal(await r.loan!.read.isFailed(), true);

    const owedBefore = await r.loan!.read.remainingDue([alice.account.address]);
    const claimHash = await service.write.claimCompensation([r.loanAddr], { account: alice.account });
    const claimLogs = await eventsFrom(publicClient, service.abi, claimHash, "CompensationClaimed");
    assert.equal(claimLogs.length, 1);
    assert.equal(await r.loan!.read.failedMarked(), true);
    assert.ok((await r.loan!.read.remainingDue([alice.account.address])) < owedBefore);
  });
});

// ── 7. partial repayment — 1 loan ─────────────────────────────────────────────
describe("Scenario 7 — loan partially repaid", () => {
  it("a partial payment pays both base and interest and does not complete the loan", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { loan } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);

    await loan!.write.repay({ account: ctx.applicant.account, value: totalOwed(parseEther("5"), 10) / 2n });

    assert.ok((await loan!.read.totalBaseRepaid()) > 0n);
    assert.ok((await loan!.read.totalBaseRepaid()) < parseEther("5"));
    assert.equal(await loan!.read.successful(), false);
    assert.ok((await ctx.service.read.compensationPool()) > 0n);
  });
});

// ── 8. partial repay, compensation, then finish — 1 loan ──────────────────────
describe("Scenario 8 — partial repay, compensation, then late completion", () => {
  it("the compensated portion is forfeited: surplus routes to the pool, no double pay", async () => {
    // Single loan: its own partial repayment funds the pool.
    const ctx = await deployService();
    const { service, alice, applicant } = ctx;
    await fund(ctx, parseEther("6"));
    const { loan, loanAddr } = await approveLoan(ctx, { amount: parseEther("4"), rate: 10, duration: 5n });
    assert.ok(loan);

    // partial repayment before expiry (pays some base + interest -> funds pool)
    await loan!.write.repay({ account: applicant.account, value: parseEther("1") });
    assert.ok((await service.read.compensationPool()) > 0n);

    await networkHelpers.mine(10);
    assert.equal(await loan!.read.isFailed(), true);

    const owedBeforeClaim = await loan!.read.remainingDue([alice.account.address]);
    assert.ok(owedBeforeClaim > 0n);
    await service.write.claimCompensation([loanAddr], { account: alice.account });
    assert.ok((await loan!.read.remainingDue([alice.account.address])) < owedBeforeClaim); // forfeit

    const poolBefore = await service.read.compensationPool();
    await loan!.write.repay({ account: applicant.account, value: totalOwed(parseEther("4"), 10) });
    const poolAfter = await service.read.compensationPool();

    assert.ok(poolAfter > poolBefore);                 // forfeited surplus routed to pool
    assert.equal(await loan!.read.successful(), false); // never flips (was failed-marked)
  });
});

// ── 9. failed loan, pool NOT enough — 2 loans (small primer) ──────────────────
describe("Scenario 9 — failed loan, compensation pool insufficient", () => {
  it("a small pool only partially covers the claim, leaving the contributor still owed", async () => {
    // Subject loan is never repaid (it "expires"), so a primer funds the pool.
    // The primer is deliberately SMALL so the pool < what the contributor is owed.
    const ctx = await deployService();
    const { service, alice, bob, applicant } = ctx;
    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.deposit({ account: bob.account, value: parseEther("10") });

    // small primer -> small pool
    let r = await approveLoan(ctx, { amount: parseEther("2"), rate: 5, duration: 100n, id: 0n });
    await r.loan!.write.repay({ account: applicant.account, value: totalOwed(parseEther("2"), 5) });
    const pool = await service.read.compensationPool();
    assert.ok(pool > 0n);

    // large failing subject loan -> owed exceeds the pool
    r = await approveLoan(ctx, { amount: parseEther("8"), rate: 10, duration: 2n, id: 1n });
    await networkHelpers.mine(5);
    const owed = await r.loan!.read.remainingDue([alice.account.address]);
    assert.ok(owed > pool); // not enough

    await service.write.claimCompensation([r.loanAddr], { account: alice.account });
    assert.equal(await service.read.compensationPool(), 0n);                                  // pool drained
    assert.ok((await r.loan!.read.remainingDue([alice.account.address])) > 0n);               // still owed
  });
});

// ── 10. failed loan, pool ENOUGH — 2 loans (large primer) ─────────────────────
describe("Scenario 10 — failed loan, compensation pool sufficient", () => {
  it("the contributor is fully compensated and owed nothing further", async () => {
    // Subject loan never repaid -> primer funds the pool. Primer is LARGE
    // (high interest) so the pool comfortably covers what the contributor is owed.
    const ctx = await deployService();
    const { service, alice, bob, applicant, publicClient } = ctx;
    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.deposit({ account: bob.account, value: parseEther("10") });

    // large primer -> large pool
    let r = await approveLoan(ctx, { amount: parseEther("6"), rate: 100, duration: 100n, id: 0n });
    await r.loan!.write.repay({ account: applicant.account, value: totalOwed(parseEther("6"), 100) });
    const pool = await service.read.compensationPool();

    // small failing subject loan -> pool covers it fully
    r = await approveLoan(ctx, { amount: parseEther("2"), rate: 10, duration: 2n, id: 1n });
    await networkHelpers.mine(5);
    const owed = await r.loan!.read.remainingDue([alice.account.address]);
    assert.ok(pool >= owed); // enough

    const claimHash = await service.write.claimCompensation([r.loanAddr], { account: alice.account });
    const claimLogs = await eventsFrom(publicClient, service.abi, claimHash, "CompensationClaimed");
    assert.equal(claimLogs.length, 1);
    assert.equal(await r.loan!.read.remainingDue([alice.account.address]), 0n); // fully compensated
    assert.equal(await r.loan!.read.failedMarked(), true);
  });
});

// ── 11. failed loan, EMPTY pool — 1 loan (new) ────────────────────────────────
describe("Scenario 11 — failed loan, empty compensation pool", () => {
  it("the claim reverts and the loan is NOT marked failed (the markFailed rolls back)", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { loan, loanAddr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 2n });
    assert.ok(loan);

    await networkHelpers.mine(5);
    assert.equal(await loan!.read.isFailed(), true);

    // nothing was ever repaid anywhere -> pool is empty
    assert.equal(await ctx.service.read.compensationPool(), 0n);
    await assert.rejects(
      ctx.service.write.claimCompensation([loanAddr], { account: ctx.alice.account }),
      /compensation pool empty/
    );
    // because the whole claim reverted, the markFailed inside it rolled back too
    assert.equal(await loan!.read.failedMarked(), false);
  });
});

// ── 12. locked-value-order repayment: highest-locked contributor refunded first ───
describe("Scenario 12 — repayment refunds in locked-value order (highest first)", () => {
  it("a partial repayment covering only the largest stake refunds that contributor alone", async () => {
    const ctx = await deployService();
    const { service, alice, bob, carol, applicant } = ctx;

    // UNEQUAL deposits -> unequal locked amounts -> a deterministic refund order.
    // alice has the largest stake, then bob, then carol.
    await service.write.deposit({ account: alice.account, value: parseEther("6") });
    await service.write.deposit({ account: bob.account,   value: parseEther("3") });
    await service.write.deposit({ account: carol.account, value: parseEther("1") });
    // cumulative disposable = 10 ETH

    const { loan } = await approveLoan(ctx, { amount: parseEther("10"), rate: 10, duration: 1000n });
    assert.ok(loan);

    // proportional locks for a 10 ETH loan over 10 ETH disposable: each locks their full disposable
    //   alice 6, bob 3, carol 1
    assert.equal(await loan!.read.remainingDue([alice.account.address]), parseEther("6"));
    assert.equal(await loan!.read.remainingDue([bob.account.address]),   parseEther("3"));
    assert.equal(await loan!.read.remainingDue([carol.account.address]), parseEther("1"));

    // Repay an amount whose BASE portion is exactly alice's 6 ETH and no more.
    // base = payment * 100 / (100 + rate); to get base = 6, payment = 6 * 110 / 100 = 6.6
    await loan!.write.repay({ account: applicant.account, value: parseEther("6.6") });

    // alice (largest) is fully refunded; bob and carol are untouched
    assert.equal(await loan!.read.remainingDue([alice.account.address]), 0n);
    assert.equal(await loan!.read.remainingDue([bob.account.address]),   parseEther("3"));
    assert.equal(await loan!.read.remainingDue([carol.account.address]), parseEther("1"));
  });

  it("a larger partial repayment spills over to the next contributor in order", async () => {
    const ctx = await deployService();
    const { service, alice, bob, carol, applicant } = ctx;

    await service.write.deposit({ account: alice.account, value: parseEther("6") });
    await service.write.deposit({ account: bob.account,   value: parseEther("3") });
    await service.write.deposit({ account: carol.account, value: parseEther("1") });

    const { loan } = await approveLoan(ctx, { amount: parseEther("10"), rate: 10, duration: 1000n });
    assert.ok(loan);

    // base = 7.5 -> covers alice's 6 fully, then 1.5 of bob's 3; carol still untouched
    // payment = 7.5 * 110 / 100 = 8.25
    await loan!.write.repay({ account: applicant.account, value: parseEther("8.25") });

    assert.equal(await loan!.read.remainingDue([alice.account.address]), 0n);             // fully refunded
    assert.equal(await loan!.read.remainingDue([bob.account.address]),   parseEther("1.5")); // partly
    assert.equal(await loan!.read.remainingDue([carol.account.address]), parseEther("1"));   // untouched
  });
});
