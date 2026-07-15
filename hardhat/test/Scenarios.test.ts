import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther, zeroAddress } from "viem";
import { deploy_service, fund, approveLoan, total_owed, events_logs, networkHelpers, BTC, ONE_BTC_SATS } from "./helpers.js";

describe("Scenario 1 — loan accepted and fully repaid — 1 loan", () => {
  it("marks the loan successful, deactivates it, and funds the compensation pool", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { loan, loan_addr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);

    await loan!.write.repay({ account: ctx.applicant.account, value: total_owed(parseEther("5"), 10) });

    assert.equal(await loan!.read.successful(), true);
    assert.equal(await ctx.service.read.active_loan([loan_addr]), false);
    assert.ok((await ctx.service.read.compensation_pool()) > 0n);
    assert.equal(await loan!.read.remaining_due([ctx.alice.account.address]), 0n);
  });
});

describe("Scenario 2 — loan accepted but not repaid — 1 loan", () => {
  it("stays active until expiry, then reads as failed", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { loan, loan_addr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 3n });
    assert.ok(loan);

    assert.equal(await loan!.read.is_expired(), false);
    await networkHelpers.mine(5);
    assert.equal(await loan!.read.is_expired(), true);
    assert.equal(await loan!.read.is_failed(), true);
    assert.equal(await ctx.service.read.active_loan([loan_addr]), true);
  });
});

describe("Scenario 3 — loan not accepted — 0 loans", () => {
  it("rejected: insufficient disposable pool", async () => {
    const ctx = await deploy_service();
    await ctx.service.write.deposit({ account: ctx.alice.account, value: parseEther("1") });
    const { approved, loan_addr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.equal(approved, false);
    assert.equal(loan_addr.toLowerCase(), zeroAddress);
  });

  it("rejected: BTC liquidity check fails (no balance pushed)", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { approved } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n, pushBtc: false });
    assert.equal(approved, false);
  });

  it("rejected: majority reject (no approve votes cast)", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { approved } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n, votes: false });
    assert.equal(approved, false);
  });

  it("rejected: exact tie counts as reject", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    await ctx.oracle.write.push_balance([BTC, ONE_BTC_SATS]);
    await ctx.service.write.submit_proposal([parseEther("5"), 10, 100n, BTC], { account: ctx.applicant.account });
    await ctx.service.write.vote([0n, true], { account: ctx.alice.account });
    await ctx.service.write.vote([0n, false], { account: ctx.bob.account });
    await networkHelpers.mine(13);
    const hash = await ctx.service.write.resolve_proposal([0n], { account: ctx.applicant.account });
    const logs = await events_logs(ctx.public_client, ctx.service.abi, hash, "proposal_resolved");
    assert.equal(logs[0].args.approved, false);
  });

  it("reverts: resolved too early / by the wrong caller", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    await ctx.oracle.write.push_balance([BTC, ONE_BTC_SATS]);
    await ctx.service.write.submit_proposal([parseEther("5"), 10, 100n, BTC], { account: ctx.applicant.account });
    await assert.rejects(ctx.service.write.resolve_proposal([0n], { account: ctx.applicant.account }), /too early/);
    await networkHelpers.mine(13);
    await assert.rejects(ctx.service.write.resolve_proposal([0n], { account: ctx.bob.account }), /not applicant/);
  });
});

describe("Scenario 4 — repaid after expiry (failed-by-time, never compensated) — 1 loan", () => {
  it("a full repayment after expiry completes the loan because it was never failed-marked", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { loan } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 3n });
    assert.ok(loan);

    await networkHelpers.mine(5);
    assert.equal(await loan!.read.is_failed(), true);

    await loan!.write.repay({ account: ctx.applicant.account, value: total_owed(parseEther("5"), 10) });
    assert.equal(await loan!.read.successful(), true);
    assert.equal(await loan!.read.failed_marked(), false);
  });
});

describe("Scenario 5 — repaid after expiry, but a contributor already compensated — 1 loan", () => {
  it("stays failed (never becomes successful) after the late full repayment", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { loan, loan_addr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 5n });
    assert.ok(loan);

    await loan!.write.repay({ account: ctx.applicant.account, value: parseEther("1") });
    assert.ok((await ctx.service.read.compensation_pool()) > 0n);

    await networkHelpers.mine(10);
    assert.equal(await loan!.read.is_failed(), true);

    await ctx.service.write.claim_compensation([loan_addr], { account: ctx.alice.account });
    assert.equal(await loan!.read.failed_marked(), true);

    await loan!.write.repay({ account: ctx.applicant.account, value: total_owed(parseEther("5"), 10) });

    assert.equal(await loan!.read.successful(), false);
    assert.equal(await loan!.read.failed_marked(), true);
  });
});

describe("Scenario 6 — loan not repaid, contributor compensated — 2 loans (primer required)", () => {
  it("pays the contributor and marks the loan failed", async () => {
    const ctx = await deploy_service();
    await ctx.service.write.deposit({ account: ctx.alice.account, value: parseEther("10") });
    await ctx.service.write.deposit({ account: ctx.bob.account, value: parseEther("10") });

    let r = await approveLoan(ctx, { amount: parseEther("4"), rate: 50, duration: 100n, id: 0n });
    await r.loan!.write.repay({ account: ctx.applicant.account, value: total_owed(parseEther("4"), 50) });
    assert.ok((await ctx.service.read.compensation_pool()) > 0n);

    r = await approveLoan(ctx, { amount: parseEther("4"), rate: 10, duration: 2n, id: 1n });
    await networkHelpers.mine(5);
    assert.equal(await r.loan!.read.is_failed(), true);

    const owedBefore = await r.loan!.read.remaining_due([ctx.alice.account.address]);
    const claimHash = await ctx.service.write.claim_compensation([r.loan_addr], { account: ctx.alice.account });
    const claimLogs = await events_logs(ctx.public_client, ctx.service.abi, claimHash, "compensation_claimed");

    assert.equal(claimLogs.length, 1);
    assert.equal(await r.loan!.read.failed_marked(), true);
    assert.ok((await r.loan!.read.remaining_due([ctx.alice.account.address])) < owedBefore);
  });
});

describe("Scenario 7 — loan partially repaid — 1 loan", () => {
  it("a partial payment pays both base and interest and does not complete the loan", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { loan } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);

    await loan!.write.repay({ account: ctx.applicant.account, value: total_owed(parseEther("5"), 10) / 2n });

    assert.ok((await loan!.read.total_base_repaid()) > 0n);
    assert.ok((await loan!.read.total_base_repaid()) < parseEther("5"));
    assert.equal(await loan!.read.successful(), false);
    assert.ok((await ctx.service.read.compensation_pool()) > 0n);
  });
});

describe("Scenario 8 — partial repay, compensation, then late completion — 1 loan", () => {
  it("the compensated portion is forfeited: surplus routes to the pool, no double pay", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { loan, loan_addr } = await approveLoan(ctx, { amount: parseEther("4"), rate: 10, duration: 5n });
    assert.ok(loan);

    await loan!.write.repay({ account: ctx.applicant.account, value: parseEther("1") });
    assert.ok((await ctx.service.read.compensation_pool()) > 0n);

    await networkHelpers.mine(10);
    assert.equal(await loan!.read.is_failed(), true);

    const owedBeforeClaim = await loan!.read.remaining_due([ctx.alice.account.address]);
    assert.ok(owedBeforeClaim > 0n);
    await ctx.service.write.claim_compensation([loan_addr], { account: ctx.alice.account });
    assert.ok((await loan!.read.remaining_due([ctx.alice.account.address])) < owedBeforeClaim);

    const poolBefore = await ctx.service.read.compensation_pool();
    await loan!.write.repay({ account: ctx.applicant.account, value: total_owed(parseEther("4"), 10) });
    const poolAfter = await ctx.service.read.compensation_pool();

    assert.ok(poolAfter > poolBefore);
    assert.equal(await loan!.read.successful(), false);
  });
});

describe("Scenario 9 — failed loan, compensation pool insufficient — 2 loans (small primer)", () => {
  it("a small pool only partially covers the claim, leaving the contributor still owed", async () => {
    const ctx = await deploy_service();
    await ctx.service.write.deposit({ account: ctx.alice.account, value: parseEther("10") });
    await ctx.service.write.deposit({ account: ctx.bob.account, value: parseEther("10") });

    let r = await approveLoan(ctx, { amount: parseEther("2"), rate: 5, duration: 100n, id: 0n });
    await r.loan!.write.repay({ account: ctx.applicant.account, value: total_owed(parseEther("2"), 5) });
    const pool = await ctx.service.read.compensation_pool();
    assert.ok(pool > 0n);

    r = await approveLoan(ctx, { amount: parseEther("8"), rate: 10, duration: 2n, id: 1n });
    await networkHelpers.mine(5);
    const owed = await r.loan!.read.remaining_due([ctx.alice.account.address]);
    assert.ok(owed > pool);

    await ctx.service.write.claim_compensation([r.loan_addr], { account: ctx.alice.account });
    assert.equal(await ctx.service.read.compensation_pool(), 0n); 
    assert.ok((await r.loan!.read.remaining_due([ctx.alice.account.address])) > 0n);
  });
});

describe("Scenario 10 — failed loan, compensation pool sufficient — 2 loans (large primer)", () => {
  it("the contributor is fully compensated and owed nothing further", async () => {
    const ctx = await deploy_service();
    await ctx.service.write.deposit({ account: ctx.alice.account, value: parseEther("10") });
    await ctx.service.write.deposit({ account: ctx.bob.account, value: parseEther("10") });

    let r = await approveLoan(ctx, { amount: parseEther("6"), rate: 100, duration: 100n, id: 0n });
    await r.loan!.write.repay({ account: ctx.applicant.account, value: total_owed(parseEther("6"), 100) });
    const pool = await ctx.service.read.compensation_pool();

    r = await approveLoan(ctx, { amount: parseEther("2"), rate: 10, duration: 2n, id: 1n });
    await networkHelpers.mine(5);
    const owed = await r.loan!.read.remaining_due([ctx.alice.account.address]);
    assert.ok(pool >= owed);

    const claimHash = await ctx.service.write.claim_compensation([r.loan_addr], { account: ctx.alice.account });
    const claimLogs = await events_logs(ctx.public_client, ctx.service.abi, claimHash, "compensation_claimed");
    assert.equal(claimLogs.length, 1);
    assert.equal(await r.loan!.read.remaining_due([ctx.alice.account.address]), 0n);
    assert.equal(await r.loan!.read.failed_marked(), true);
  });
});

describe("Scenario 11 — failed loan, empty compensation pool — 1 loan (new)", () => {
  it("the claim reverts and the loan is NOT marked failed (the mark_failed rolls back)", async () => {
    const ctx = await deploy_service();
    await fund(ctx, parseEther("6"));
    const { loan, loan_addr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 2n });
    assert.ok(loan);

    await networkHelpers.mine(5);
    assert.equal(await loan!.read.is_failed(), true);

    assert.equal(await ctx.service.read.compensation_pool(), 0n);
    await assert.rejects(
      ctx.service.write.claim_compensation([loan_addr], { account: ctx.alice.account }),
      /compensation pool empty/
    );
    assert.equal(await loan!.read.failed_marked(), false);
  });
});

describe("Scenario 12 — repayment refunds in locked-value order (highest first)", () => {
  it("a partial repayment covering only the largest stake refunds that contributor alone", async () => {
    const ctx = await deploy_service();

    await ctx.service.write.deposit({ account: ctx.alice.account, value: parseEther("6") });
    await ctx.service.write.deposit({ account: ctx.bob.account,   value: parseEther("3") });
    await ctx.service.write.deposit({ account: ctx.carol.account, value: parseEther("1") });

    const { loan } = await approveLoan(ctx, { amount: parseEther("10"), rate: 10, duration: 1000n });
    assert.ok(loan);

    assert.equal(await loan!.read.remaining_due([ctx.alice.account.address]), parseEther("6"));
    assert.equal(await loan!.read.remaining_due([ctx.bob.account.address]),   parseEther("3"));
    assert.equal(await loan!.read.remaining_due([ctx.carol.account.address]), parseEther("1"));

    // Repay an amount whose BASE portion is exactly alice's 6 ETH and no more.
    // base = payment * 100 / (100 + rate); to get base = 6, payment = 6 * 110 / 100 = 6.6
    await loan!.write.repay({ account: ctx.applicant.account, value: parseEther("6.6") });

    assert.equal(await loan!.read.remaining_due([ctx.alice.account.address]), 0n);              // fully refunded
    assert.equal(await loan!.read.remaining_due([ctx.bob.account.address]),   parseEther("3")); // untouched
    assert.equal(await loan!.read.remaining_due([ctx.carol.account.address]), parseEther("1")); // untouched
  });

  it("a larger partial repayment spills over to the next contributor in order", async () => {
    const ctx = await deploy_service();

    await ctx.service.write.deposit({ account: ctx.alice.account, value: parseEther("6") });
    await ctx.service.write.deposit({ account: ctx.bob.account,   value: parseEther("3") });
    await ctx.service.write.deposit({ account: ctx.carol.account, value: parseEther("1") });

    const { loan } = await approveLoan(ctx, { amount: parseEther("10"), rate: 10, duration: 1000n });
    assert.ok(loan);

    // base = 7.5 -> payment = 7.5 * 110 / 100 = 8.25
    await loan!.write.repay({ account: ctx.applicant.account, value: parseEther("8.25") });

    assert.equal(await loan!.read.remaining_due([ctx.alice.account.address]), 0n);                // fully refunded
    assert.equal(await loan!.read.remaining_due([ctx.bob.account.address]),   parseEther("1.5")); // partly
    assert.equal(await loan!.read.remaining_due([ctx.carol.account.address]), parseEther("1"));   // untouched
  });
});