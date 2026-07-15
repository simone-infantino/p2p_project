import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { deploy_service, fund, approve_loan, total_owed, networkHelpers } from "./helpers.js";

describe("Loan", () => {
  it("stores its terms and forwards the value to the applicant", async () => {
    const context = await deploy_service();
    const { applicant, public_client } = context;
    await fund(context, parseEther("6"));

    const borrower_balance_before = await public_client.getBalance({ address: applicant.account.address });
    const { loan } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 100n });
    const borrower_balance_after = await public_client.getBalance({ address: applicant.account.address });

    assert.ok(loan);
    assert.equal((await loan!.read.applicant()).toLowerCase(), applicant.account.address.toLowerCase());
    assert.equal(await loan!.read.lent_amount(), parseEther("5"));
    assert.equal(await loan!.read.interest_rate(), 10);
    assert.ok(borrower_balance_after > borrower_balance_before); // received ~5 ETH, dwarfs the resolve gas
  });

  it("full repayment marks the loan successful and funds the compensation pool", async () => {
    const context = await deploy_service();
    await fund(context, parseEther("6"));
    const { loan, loan_addr } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);

    await loan!.write.repay({ account: context.applicant.account, value: total_owed(parseEther("5"), 10) });

    assert.equal(await loan!.read.successful(), true);
    assert.equal(await context.service.read.active_loan([loan_addr]), false);
    assert.ok((await context.service.read.compensation_pool()) > 0n);
  });

  it("a partial repayment pays base and interest without completing the loan", async () => {
    const context = await deploy_service();
    await fund(context, parseEther("6"));
    const { loan } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);

    await loan!.write.repay({ account: context.applicant.account, value: total_owed(parseEther("5"), 10) / 2n });

    assert.ok((await loan!.read.total_base_repaid()) > 0n);
    assert.ok((await loan!.read.total_base_repaid()) < parseEther("5"));
    assert.equal(await loan!.read.successful(), false);
    assert.ok((await context.service.read.compensation_pool()) > 0n);
  });

  it("becomes failed after expiration without full repayment", async () => {
    const context = await deploy_service();
    await fund(context, parseEther("6"));
    const { loan } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 2n });
    assert.ok(loan);

    await networkHelpers.mine(5);
    assert.equal(await loan!.read.is_expired(), true);
    assert.equal(await loan!.read.is_failed(), true);
  });

  it("only the applicant may repay", async () => {
    const context = await deploy_service();
    await fund(context, parseEther("6"));
    const { loan } = await approve_loan(context, { amount: parseEther("5"), rate: 10, duration: 100n });
    assert.ok(loan);
    await assert.rejects(
      loan!.write.repay({ account: context.bob.account, value: parseEther("1") }),
      /only applicant/
    );
  });
});
