import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { viem, networkHelpers, eventsFrom } from "./helpers.js";
import { stringToHex, parseEther, parseGwei } from "viem";

const BTC = stringToHex("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
const ONE_BTC = 100_000_000n;

describe("Reentrancy — the real LendingService resists the identical attack", () => {
  it("the reentrant claim cannot drain the pool (attack reverts or yields only the fair share)", async () => {
    const [admin, alice, bob, applicant] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();

    const minFee = parseGwei("0.1") * 50_000n;
    const oracle = await viem.deployContract("BitcoinOracle", [minFee]);
    // the REAL, safe contract — the only difference from Reentrancy.test.ts
    const service = await viem.deployContract("LendingService", [oracle.address]);
    const attacker = await viem.deployContract("ReentrancyAttacker", [service.address]);

    await oracle.write.pushBalance([BTC, ONE_BTC]);

    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.deposit({ account: bob.account, value: parseEther("10") });
    await attacker.write.depositToPool({ value: parseEther("10") });

    async function makeLoan(amount: bigint, rate: number, duration: bigint) {
      const id = await service.read.nextProposalId();
      await service.write.submitProposal([amount, rate, duration, BTC], { account: applicant.account });
      await service.write.vote([id, true], { account: alice.account });
      await service.write.vote([id, true], { account: bob.account });
      await attacker.write.vote([id, true]);
      await networkHelpers.mine(13);
      const h = await service.write.resolveProposal([id], { account: applicant.account });
      const ev = (await eventsFrom(pc, service.abi, h, "ProposalResolved"))[0].args as any;
      return { approved: ev.approved as boolean, loan: ev.loanContract as `0x${string}` };
    }

    // identical setup: primer funds the pool, big active loan gives the attacker
    // a large locked/deposited cushion, victim loan fails
    const primer = await makeLoan(parseEther("10"), 100, 1000n);
    assert.ok(primer.approved);
    const primerLoan = await viem.getContractAt("Loan", primer.loan);
    await primerLoan.write.repay({ account: applicant.account, value: parseEther("12") });
    const pool = await service.read.compensationPool();
    assert.ok(pool > 0n, "pool funded by primer");

    const big = await makeLoan(parseEther("15"), 10, 100000n);
    assert.ok(big.approved);

    const victim = await makeLoan(parseEther("1.5"), 10, 2n);
    assert.ok(victim.approved);
    const victimLoan = await viem.getContractAt("Loan", victim.loan);
    await networkHelpers.mine(5);
    assert.equal(await victimLoan.read.isFailed(), true);

    const owed = await victimLoan.read.remainingDue([attacker.address]);
    assert.ok(owed > 0n && owed < pool);
    const reentries = pool / owed - 1n;

    const poolBefore = await service.read.compensationPool();
    let attackReverted = false;
    try {
      await attacker.write.attack([victim.loan, reentries]);
    } catch {
      attackReverted = true;
    }
    const poolAfter = await service.read.compensationPool();

    // SAFETY: the pool is NOT drained; at most one fair claim's worth left it
    assert.ok(poolAfter >= poolBefore - owed, "pool lost at most one fair claim, not everything");
    assert.notEqual(poolAfter, 0n, "pool was NOT emptied");

    // and an honest co-contributor can still be compensated (pool survived)
    if (!attackReverted && poolAfter > 0n) {
      const aliceOwed = await victimLoan.read.remainingDue([alice.account.address]);
      if (aliceOwed > 0n) {
        await service.write.claimCompensation([victim.loan], { account: alice.account });
      }
    }

    console.log(`safe result: attackReverted=${attackReverted} poolBefore=${poolBefore} poolAfter=${poolAfter} owed=${owed}`);
  });
});
