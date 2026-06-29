// test/helpers.ts
//
// Shared setup and utilities for all test files. Importing these keeps each
// test file focused on assertions rather than boilerplate, and avoids the
// duplicated deploy/approve logic that was copied across suites.

import { network } from "hardhat";
import { parseEther, parseGwei, stringToHex, parseEventLogs } from "viem";

// A single shared in-process chain for the whole test run. Each test deploys
// fresh contracts, so state never leaks between tests.
export const { viem, networkHelpers } = await network.getOrCreate();

// Canonical BTC address -> ASCII 0x-bytes, the key the scanner/oracle agree on.
export const BTC = stringToHex("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");

// 1 BTC in satoshis -> 30 ETH equivalent; clears the liquidity check at our amounts.
export const ONE_BTC_SATS = 100_000_000n;

export type Ctx = Awaited<ReturnType<typeof deployService>>;

/** Deploy a fresh oracle + service and grab the standard set of signers. */
export async function deployService() {
  const [admin, alice, bob, applicant, carol] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const minFee = parseGwei("0.1") * 50_000n;
  const oracle = await viem.deployContract("BitcoinOracle", [minFee]);
  const service = await viem.deployContract("LendingService", [oracle.address]);
  return { oracle, service, admin, alice, bob, applicant, carol, publicClient, minFee };
}

/** Decode events of a given name from a transaction's receipt. */
export async function eventsFrom(
  publicClient: any,
  abi: any,
  hash: `0x${string}`,
  eventName: string
): Promise<Array<{ args: any }>> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return parseEventLogs({ abi, logs: receipt.logs, eventName }) as Array<{ args: any }>;
}

/** Two contributors (alice, bob) each deposit `amount`. */
export async function fund(ctx: Ctx, amount: bigint) {
  await ctx.service.write.deposit({ account: ctx.alice.account, value: amount });
  await ctx.service.write.deposit({ account: ctx.bob.account, value: amount });
}

/**
 * Submit a proposal, optionally push BTC liquidity and cast approve votes,
 * mine past the voting period, and resolve. Returns whether it was approved
 * and (if so) the deployed Loan contract.
 */
export async function approveLoan(
  ctx: Ctx,
  opts: {
    amount: bigint;
    rate: number;
    duration: bigint;
    id?: bigint;
    pushBtc?: boolean;
    votes?: boolean;
  }
) {
  const { oracle, service, alice, bob, applicant, publicClient } = ctx;
  const id = opts.id ?? 0n;
  if (opts.pushBtc ?? true) await oracle.write.pushBalance([BTC, ONE_BTC_SATS]);
  await service.write.submitProposal([opts.amount, opts.rate, opts.duration, BTC], {
    account: applicant.account,
  });
  if (opts.votes ?? true) {
    if ((await service.read.deposited([alice.account.address])) > 0n) {
      await service.write.vote([id, true], { account: alice.account });
    }
    if ((await service.read.deposited([bob.account.address])) > 0n) {
      await service.write.vote([id, true], { account: bob.account });
    }
  } 
  await networkHelpers.mine(13); // pass PROPOSAL_VOTING_PERIOD (12)
  const hash = await service.write.resolveProposal([id], { account: applicant.account });
  const logs = await eventsFrom(publicClient, service.abi, hash, "ProposalResolved");
  const approved = logs[0].args.approved as boolean;
  const loanAddr = logs[0].args.loanContract as `0x${string}`;
  const loan = approved ? await viem.getContractAt("Loan", loanAddr) : null;
  return { approved, loanAddr, loan };
}

/** Total owed on a loan under the proportional split = principal * (100 + rate) / 100. */
export function totalOwed(principal: bigint, rate: number): bigint {
  return (principal * BigInt(100 + rate)) / 100n;
}
