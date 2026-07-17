//three proposals "active" simultaneously
//A — accepted, fully repaid last (after B has already failed and compensated)
//B — accepted, only partially repaid, then expires and is compensated
//C — rejected because of failed bitcoin liquidity check

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { viem, deploy_service, events_logs, total_owed, networkHelpers, BTC, ONE_BTC_SATS } from "./helpers.js";

describe("three simultaneous proposals", () => {
  it("A repaid fully (last), B partially repaid + compensated, C rejected on liquidity check", async () => {
    const { oracle, service, alice, bob, carol, applicant, public_client } = await networkHelpers.loadFixture(deploy_service);

    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.deposit({ account: bob.account, value: parseEther("10") });
    await service.write.deposit({ account: carol.account, value: parseEther("10") });

    //faux bitcoin address to make C fail the check
    const BTC_EMPTY = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
    await oracle.write.push_balance([BTC, ONE_BTC_SATS]);

    //first and last loans have a deliberate long duration so that they don't expire during the test
    await service.write.submit_proposal([parseEther("6"), 10, 1000n, BTC], { account: applicant.account });
    await service.write.submit_proposal([parseEther("6"), 20, 5n, BTC], { account: applicant.account });
    await service.write.submit_proposal([parseEther("6"), 10, 1000n, BTC_EMPTY], { account: applicant.account });

    for (const id of [0n, 1n, 2n]) {
      await service.write.vote([id, true], { account: alice.account });
      await service.write.vote([id, true], { account: bob.account });
      await service.write.vote([id, true], { account: carol.account });
    }

    await networkHelpers.mine(13);

    const receipt_A = await service.write.resolve_proposal([0n], { account: applicant.account });
    const receipt_B = await service.write.resolve_proposal([1n], { account: applicant.account });
    const logs_A = await events_logs(public_client, service.abi, receipt_A, "proposal_resolved");
    const logs_B = await events_logs(public_client, service.abi, receipt_B, "proposal_resolved");

    assert.equal(logs_A[0].args.approved, true);
    assert.equal(logs_B[0].args.approved, true);

    const a_addr = logs_A[0].args.loan_contract;
    const b_addr = logs_B[0].args.loan_contract;
    const loan_A = await viem.getContractAt("Loan", a_addr);
    const loan_B = await viem.getContractAt("Loan", b_addr);

    //check if they're both active
    assert.equal(await service.read.active_loan([a_addr]), true);
    assert.equal(await service.read.active_loan([b_addr]), true);

    //prove that C's rejection is due to failed bitcoin liquiditi check
    const disp = async (a: `0x${string}`) => (await service.read.deposited([a])) - (await service.read.locked([a]));
    const cum_disp = (await disp(alice.account.address)) + (await disp(bob.account.address)) + (await disp(carol.account.address));
    //enough disposable check and contributors have all voted approve, so the only rejection reason can be the liquidity check 
    assert.ok(cum_disp >= parseEther("6"));

    const receipt_C = await service.write.resolve_proposal([2n], { account: applicant.account });
    const logs_C = await events_logs(public_client, service.abi, receipt_C, "proposal_resolved");
    assert.equal(logs_C[0].args.approved, false);
    assert.equal(logs_C[0].args.loan_contract.toLowerCase(), "0x0000000000000000000000000000000000000000");

    await loan_B.write.repay({ account: applicant.account, value: parseEther("1") });
    assert.ok((await service.read.compensation_pool()) > 0n);

    //we make loan B expire
    await networkHelpers.mine(10);
    assert.equal(await loan_B.read.is_failed(), true);
    assert.equal(await loan_A.read.is_failed(), false);

    const owed_before = await loan_B.read.remaining_due([alice.account.address]);
    assert.ok(owed_before > 0n);
    const claim_receipt = await service.write.claim_compensation([b_addr], { account: alice.account });
    const claim_logs = await events_logs(public_client, service.abi, claim_receipt, "compensation_claimed");
    assert.equal(claim_logs.length, 1);
    assert.equal(await loan_B.read.failed_marked(), true);
    assert.ok((await loan_B.read.remaining_due([alice.account.address])) < owed_before);

    await loan_A.write.repay({ account: applicant.account, value: total_owed(parseEther("6"), 10) });
    assert.equal(await loan_A.read.successful(), true);
    assert.equal(await service.read.active_loan([a_addr]), false);

    //finally, we check that B is still failed
    assert.equal(await loan_B.read.successful(), false);
    assert.equal(await loan_B.read.failed_marked(), true);
  });
});
