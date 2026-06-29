// test/Loan.test.ts
//
// Tests for Loan behaviour, exercised through the real flow (LendingService
// deploys the Loan and the Loan calls back into it). Multi-loan stories live
// in Scenarios.test.ts; this file focuses on a single loan's mechanics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { deployService, fund, approveLoan, totalOwed, networkHelpers } from "./helpers.js";

describe("Loan", () => {
  it("stores its terms and forwards the principal to the applicant", async () => {
    const ctx = await deployService();
    const { applicant, publicClient } = ctx;
    await fund(ctx, parseEther("6"));

    const before = await publicClient.getBalance({ address: applicant.account.address });
    const { loan } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    const after = await publicClient.getBalance({ address: applicant.account.address });

    assert.ok(loan);
    assert.equal((await loan!.read.applicant()).toLowerCase(), applicant.account.address.toLowerCase());
    assert.equal(await loan!.read.principal(), parseEther("5"));
    assert.equal(await loan!.read.interestRate(), 10);
    assert.ok(after > before); // received ~5 ETH, dwarfs the resolve gas
  });

  it("full repayment marks the loan successful and funds the compensation pool", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { loan, loanAddr } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);

    await loan!.write.repay({ account: ctx.applicant.account, value: totalOwed(parseEther("5"), 10) });

    assert.equal(await loan!.read.successful(), true);
    assert.equal(await ctx.service.read.isActiveLoan([loanAddr]), false);
    assert.ok((await ctx.service.read.compensationPool()) > 0n);
  });

  it("a partial repayment pays base and interest without completing the loan", async () => {
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

  it("becomes failed after expiration without full repayment", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { loan } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 2n });
    assert.ok(loan);

    await networkHelpers.mine(5);
    assert.equal(await loan!.read.isExpired(), true);
    assert.equal(await loan!.read.isFailed(), true);
  });

  it("only the applicant may repay", async () => {
    const ctx = await deployService();
    await fund(ctx, parseEther("6"));
    const { loan } = await approveLoan(ctx, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);
    await assert.rejects(
      loan!.write.repay({ account: ctx.bob.account, value: parseEther("1") }),
      /only applicant/
    );
  });
});
