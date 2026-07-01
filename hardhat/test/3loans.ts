// test/MultiLoan.test.ts
//
// Three proposals resolved together:
//   A — accepted, fully repaid LAST (after B has already failed & been compensated)
//   B — accepted, only partially repaid, then expires and is compensated
//   C — rejected because its BTC address fails the liquidity check
//
// Notes on construction:
//  * A and B use the funded BTC address; C uses a separate UNFUNDED address, so
//    its rejection is specifically the liquidity check (we also assert the pool
//    still has enough disposable for C, ruling out a pool-shortfall rejection).
//  * B funds the compensation pool itself via its partial repayment, because A
//    (the other potential funder) isn't repaid until the very end.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther, stringToHex } from "viem";
import {
  viem, deployService, eventsFrom, totalOwed, networkHelpers, BTC, ONE_BTC_SATS,
} from "./helpers.js";

describe("Multi-loan — three simultaneous proposals", () => {
  it("A repaid fully (last), B partially repaid + compensated, C rejected on BTC check", async () => {
    const ctx = await deployService();
    const { oracle, service, alice, bob, carol, applicant, publicClient } = ctx;

    // three contributors fund the pool: 10 ETH each -> 30 ETH disposable
    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.deposit({ account: bob.account, value: parseEther("10") });
    await service.write.deposit({ account: carol.account, value: parseEther("10") });

    // BTC is funded (A and B will pass liquidity); a second address stays empty (C fails)
    const BTC_EMPTY = stringToHex("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
    await oracle.write.pushBalance([BTC, ONE_BTC_SATS]);

    // ── submit all three "simultaneously" ──────────────────────────────────────
    // A (id 0): long duration so it never expires during the test
    await service.write.submitProposal([parseEther("6"), 10, 1000n, BTC], { account: applicant.account });
    // B (id 1): short duration so it expires quickly
    await service.write.submitProposal([parseEther("6"), 20, 5n, BTC], { account: applicant.account });
    // C (id 2): unfunded BTC address -> will fail the liquidity check
    await service.write.submitProposal([parseEther("6"), 10, 1000n, BTC_EMPTY], { account: applicant.account });

    // everyone approves all three
    for (const id of [0n, 1n, 2n]) {
      await service.write.vote([id, true], { account: alice.account });
      await service.write.vote([id, true], { account: bob.account });
      await service.write.vote([id, true], { account: carol.account });
    }

    // pass the voting period once for all three
    await networkHelpers.mine(13);

    // ── resolve A and B (both accepted) ────────────────────────────────────────
    const hashA = await service.write.resolveProposal([0n], { account: applicant.account });
    const hashB = await service.write.resolveProposal([1n], { account: applicant.account });
    const logsA = await eventsFrom(publicClient, service.abi, hashA, "ProposalResolved");
    const logsB = await eventsFrom(publicClient, service.abi, hashB, "ProposalResolved");

    assert.equal((logsA[0].args as any).approved, true);
    assert.equal((logsB[0].args as any).approved, true);

    const aAddr = (logsA[0].args as any).loanContract as `0x${string}`;
    const bAddr = (logsB[0].args as any).loanContract as `0x${string}`;
    const loanA = await viem.getContractAt("Loan", aAddr);
    const loanB = await viem.getContractAt("Loan", bAddr);

    // both are simultaneously active
    assert.equal(await service.read.isActiveLoan([aAddr]), true);
    assert.equal(await service.read.isActiveLoan([bAddr]), true);

    // ── prove C's rejection is the BTC check, not a pool shortfall ─────────────
    const disp = async (a: `0x${string}`) =>
      (await service.read.deposited([a])) - (await service.read.locked([a]));
    const cumDisp =
      (await disp(alice.account.address)) +
      (await disp(bob.account.address)) +
      (await disp(carol.account.address));
    assert.ok(cumDisp >= parseEther("6")); // enough disposable for C -> rejection must be liquidity

    const hashC = await service.write.resolveProposal([2n], { account: applicant.account });
    const logsC = await eventsFrom(publicClient, service.abi, hashC, "ProposalResolved");
    assert.equal((logsC[0].args as any).approved, false);
    assert.equal((logsC[0].args as any).loanContract.toLowerCase(),
      "0x0000000000000000000000000000000000000000");

    // ── B: partial repayment funds the pool, then it expires and is compensated ─
    await loanB.write.repay({ account: applicant.account, value: parseEther("1") });
    assert.ok((await service.read.compensationPool()) > 0n);

    await networkHelpers.mine(10); // past B's short duration, but not A's
    assert.equal(await loanB.read.isFailed(), true);
    assert.equal(await loanA.read.isFailed(), false); // A still active

    const owedBefore = await loanB.read.remainingDue([alice.account.address]);
    assert.ok(owedBefore > 0n);
    const claimHash = await service.write.claimCompensation([bAddr], { account: alice.account });
    const claimLogs = await eventsFrom(publicClient, service.abi, claimHash, "CompensationClaimed");
    assert.equal(claimLogs.length, 1);
    assert.equal(await loanB.read.failedMarked(), true);
    assert.ok((await loanB.read.remainingDue([alice.account.address])) < owedBefore);

    // ── A: full repayment, happening LAST ──────────────────────────────────────
    await loanA.write.repay({ account: applicant.account, value: totalOwed(parseEther("6"), 10) });
    assert.equal(await loanA.read.successful(), true);
    assert.equal(await service.read.isActiveLoan([aAddr]), false);

    // ── final state: A succeeded, B stays failed forever ───────────────────────
    assert.equal(await loanB.read.successful(), false);
    assert.equal(await loanB.read.failedMarked(), true);
  });
});
