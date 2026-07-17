import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { viem, networkHelpers, events_logs, BTC, ONE_BTC_SATS } from "./helpers.js";
import { parseEther, parseGwei } from "viem";

const MIN_FEE = parseGwei("0.1") * 50_000n;

type AttackOutcome = { pool_before: bigint; pool_after: bigint; owed: bigint; attacker_gain: bigint; reverted: boolean; };


//we pass what type of contract we're testing as a parameter, the safe or the reentrancy-vulnerable one.
async function runScenario(serviceContractName: string): Promise<AttackOutcome> {
  const [alice, bob, applicant] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  const oracle = await viem.deployContract("BitcoinOracle", [MIN_FEE]);
  const service = await viem.deployContract(serviceContractName, [oracle.address]);
  const attacker = await viem.deployContract("ReentrancyAttacker", [service.address]);

  await oracle.write.push_balance([BTC, ONE_BTC_SATS]);

  await service.write.deposit({ account: alice.account, value: parseEther("10") });
  await service.write.deposit({ account: bob.account, value: parseEther("10") });
  await attacker.write.pool_deposit({ value: parseEther("10") });

  async function make_loan(amount: bigint, rate: number, duration: bigint) {
    const id = (await service.read.next_proposal_id()) as bigint;
    await service.write.submit_proposal([amount, rate, duration, BTC], { account: applicant.account });
    await service.write.vote([id, true], { account: alice.account });
    await service.write.vote([id, true], { account: bob.account });
    await attacker.write.vote([id, true]);
    await networkHelpers.mine(13);
    const receipt = await service.write.resolve_proposal([id], { account: applicant.account });
    const logs = (await events_logs(pc, service.abi, receipt, "proposal_resolved"))[0].args;
    return { approved: logs.approved as boolean, loan: logs.loan_contract as `0x${string}` };
  }

  //first loan to fund the compensation pool, fully repaid
  const funder_loan_addr = await make_loan(parseEther("10"), 100, 1000n);
  assert.ok(funder_loan_addr.approved, "funder_loan_addr approved");
  const funder_loan = await viem.getContractAt("Loan", funder_loan_addr.loan);
  await funder_loan.write.repay({ account: applicant.account, value: parseEther("20") }); //full: 10*(200/100)
  const pool = (await service.read.compensation_pool()) as bigint;
  assert.ok(pool > 0n, "pool funded by funder_loan_addr");

  //vinctim loan, the one the attacker is locked into and gets his gains from
  const victim = await make_loan(parseEther("1.5"), 10, 2n);
  assert.ok(victim.approved, "victim approved");
  const victim_loan = await viem.getContractAt("Loan", victim.loan);
  await networkHelpers.mine(5);
  assert.equal(await victim_loan.read.is_failed(), true);

  const owed = (await victim_loan.read.remaining_due([attacker.address])) as bigint;
  assert.ok(owed > 0n && owed < pool, "attacker owed a small fraction of the pool");

  //reentrancies needed to drain the pool = floor(pool/owed); reentries = frames - 1
  const reentries = pool / owed - 1n;

  const pool_before = (await service.read.compensation_pool()) as bigint;
  const attacker_balance_before = await pc.getBalance({ address: attacker.address });

  let reverted = false;
  try {
    await attacker.write.attack([victim.loan, reentries]);
  } catch {
    reverted = true;
  }

  const pool_after = (await service.read.compensation_pool()) as bigint;
  const attacker_balance_after = await pc.getBalance({ address: attacker.address });

  return {
    pool_before,
    pool_after: pool_after,
    owed,
    attacker_gain: attacker_balance_after - attacker_balance_before,
    reverted,
  };
}

describe("reentrancy scenarios: safe and vulnerable contracts", () => {
  it("vunlerable: attacker's claim_compensation drains the pool and then they profit", async () => {
    const r = await runScenario("LoanServiceVulnerable");

    assert.equal(r.reverted, false, "attack should succeed against the vulnerable contract");

    assert.ok(r.pool_before - r.pool_after > r.owed, "drained more than the attacker was owed");
    assert.ok(r.pool_after < r.owed, "pool drained below a single fair claim");

    assert.ok(r.attacker_gain > r.owed, "attacker gained more than its legitimate claim");
  });

  it("safe: the real LoanService resists the identical attack", async () => {
    const r = await runScenario("LoanService");

    assert.equal(r.reverted, true, "attack reverted against the safe contract");

    assert.ok(r.pool_after >= r.pool_before - r.owed, "pool lost at most one fair claim, not everything");
    assert.notEqual(r.pool_after, 0n, "pool was not emptied");

    assert.ok(r.attacker_gain <= r.owed, "attacker could not profit beyond a single fair claim");
  });
});
