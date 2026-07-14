import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { viem, networkHelpers, events_logs, BTC, ONE_BTC_SATS } from "./helpers.js";
import { parseEther, parseGwei } from "viem";

const MIN_FEE = parseGwei("0.1") * 50_000n;

type AttackOutcome = {
  poolBefore: bigint;
  poolAfter: bigint;
  owed: bigint;
  attackerGain: bigint; // net ETH change of the attacker CONTRACT across the attack
  reverted: boolean;
};


async function runScenario(serviceContractName: string): Promise<AttackOutcome> {
  const [alice, bob, applicant] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  const oracle = await viem.deployContract("BitcoinOracle", [MIN_FEE]);
  const service = await viem.deployContract(serviceContractName, [oracle.address]);
  const attacker = await viem.deployContract("ReentrancyAttacker", [service.address]);

  await oracle.write.push_balance([BTC, ONE_BTC_SATS]);

  // equal deposits keep the loan splits symmetric
  await service.write.deposit({ account: alice.account, value: parseEther("10") });
  await service.write.deposit({ account: bob.account, value: parseEther("10") });
  await attacker.write.pool_deposit({ value: parseEther("10") });

  async function makeLoan(amount: bigint, rate: number, duration: bigint) {
    const id = (await service.read.next_proposal_id()) as bigint;
    await service.write.submit_proposal([amount, rate, duration, BTC], { account: applicant.account });
    await service.write.vote([id, true], { account: alice.account });
    await service.write.vote([id, true], { account: bob.account });
    await attacker.write.vote([id, true]);
    await networkHelpers.mine(13);
    const h = await service.write.resolve_proposal([id], { account: applicant.account });
    const ev = (await events_logs(pc, service.abi, h, "proposal_resolved"))[0].args as any;
    return { approved: ev.approved as boolean, loan: ev.loan_contract as `0x${string}` };
  }

  // 1) primer loan — fully repaid, funds the compensation pool
  const primer = await makeLoan(parseEther("10"), 100, 1000n);
  assert.ok(primer.approved, "primer approved");
  const primerLoan = await viem.getContractAt("Loan", primer.loan);
  await primerLoan.write.repay({ account: applicant.account, value: parseEther("20") }); // full: 10*(200/100)
  const pool = (await service.read.compensation_pool()) as bigint;
  assert.ok(pool > 0n, "pool funded by primer");

  // 2) victim loan the attacker is locked into; it fails quickly -> attacker is owed
  const victim = await makeLoan(parseEther("1.5"), 10, 2n);
  assert.ok(victim.approved, "victim approved");
  const victimLoan = await viem.getContractAt("Loan", victim.loan);
  await networkHelpers.mine(5);
  assert.equal(await victimLoan.read.is_failed(), true);

  const owed = (await victimLoan.read.remaining_due([attacker.address])) as bigint;
  assert.ok(owed > 0n && owed < pool, "attacker owed a small fraction of the pool");

  // frames to drain the pool = floor(pool/owed); reentries = frames - 1
  const reentries = pool / owed - 1n;

  const poolBefore = (await service.read.compensation_pool()) as bigint;
  const attackerBalBefore = await pc.getBalance({ address: attacker.address });

  let reverted = false;
  try {
    await attacker.write.attack([victim.loan, reentries]);
  } catch {
    reverted = true;
  }

  const poolAfter = (await service.read.compensation_pool()) as bigint;
  const attackerBalAfter = await pc.getBalance({ address: attacker.address });

  return {
    poolBefore,
    poolAfter,
    owed,
    attackerGain: attackerBalAfter - attackerBalBefore,
    reverted,
  };
}

describe("Reentrancy — vulnerable service is drained, real service resists", () => {
  it("VULNERABLE: reentrant claim_compensation drains the pool and the attacker profits", async () => {
    const r = await runScenario("LendingServiceVulnerable");

    // the attack goes through (no revert)
    assert.equal(r.reverted, false, "attack should succeed against the vulnerable contract");

    // the pool is drained far below one fair claim (effectively emptied; leftover may remain)
    assert.ok(r.poolBefore - r.poolAfter > r.owed, "drained more than the attacker was owed");
    assert.ok(r.poolAfter < r.owed, "pool drained below a single fair claim");

    // and the attacker NETS A PROFIT: it pulled multiple `compensation`s out of the pool with
    // no offsetting deduction to its own balance, so its ETH went UP by well over `owed`
    assert.ok(r.attackerGain > r.owed, "attacker gained more than its legitimate claim");
  });

  it("SAFE: the real LendingService resists the identical attack — pool intact", async () => {
    const r = await runScenario("LendingService");

    // Against the safe contract the reentrant claim reverts (remaining_due/pool already
    // updated before the transfer), which reverts the whole attack. The pool is NOT
    // drained; at most a single fair claim's worth could ever leave.
    assert.ok(r.poolAfter >= r.poolBefore - r.owed, "pool lost at most one fair claim, not everything");
    assert.notEqual(r.poolAfter, 0n, "pool was NOT emptied");

    // the attacker does NOT profit: either the attack reverted (gain ~0, minus gas) or it
    // received only its single legitimate claim. It never nets more than `owed`.
    assert.ok(r.attackerGain <= r.owed, "attacker could not profit beyond a single fair claim");
  });
});
