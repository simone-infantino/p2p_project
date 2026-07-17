//helpers used by the test files.
//creates the network, deploys the oracles with their respective accounts
//deploys an applicant
//deploys 3 contributors
//deploys a public client for chain queries

import { network } from "hardhat";
import { parseGwei, parseEventLogs } from "viem";

export const { viem, networkHelpers } = await network.getOrCreate();

//genesis block address
export const BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
export const ONE_BTC_SATS = 100_000_000n;

//deployment and creation of accounts
export async function deploy_service() {
  const [admin, alice, bob, applicant, carol] = await viem.getWalletClients();
  const public_client = await viem.getPublicClient();
  const min_fee = parseGwei("0.1") * 50_000n;
  const oracle = await viem.deployContract("BitcoinOracle", [min_fee]);
  const service = await viem.deployContract("LoanService", [oracle.address]);
  return { oracle, service, admin, alice, bob, applicant, carol, public_client, min_fee };
}

//context variable that contains the return of deploy_service
export type Context = Awaited<ReturnType<typeof deploy_service>>;

//events reading
export async function events_logs( public_client: any, abi: any, hash: `0x${string}`, eventName: string ): Promise<Array<{ args: any }>> {
  const receipt = await public_client.waitForTransactionReceipt({ hash });
  return parseEventLogs({ abi, logs: receipt.logs, eventName }) as Array<{ args: any }>;
}

export async function fund(context: Context, amount: bigint) {
  await context.service.write.deposit({ account: context.alice.account, value: amount });
  await context.service.write.deposit({ account: context.bob.account, value: amount });
}

//a function that simulates a proposal/resolve loan
export async function approve_loan(
  context: Context, parameters: { amount: bigint; rate: number; duration: bigint; id?: bigint; BTC_address?: boolean; votes?: boolean; } ) {
  const { oracle, service, alice, bob, applicant, public_client } = context;
  const id = parameters.id ?? 0n;
  if (parameters.BTC_address ?? true) await oracle.write.push_balance([BTC, ONE_BTC_SATS]);
  await service.write.submit_proposal([parameters.amount, parameters.rate, parameters.duration, BTC], {
    account: applicant.account,
  });
  if (parameters.votes ?? true) {
    if ((await service.read.deposited([alice.account.address])) > 0n) {
      await service.write.vote([id, true], { account: alice.account });
    }
    if ((await service.read.deposited([bob.account.address])) > 0n) {
      await service.write.vote([id, true], { account: bob.account });
    }
  } 
  await networkHelpers.mine(13); //pass proposal voting period
  const hash = await service.write.resolve_proposal([id], { account: applicant.account });
  const logs = await events_logs(public_client, service.abi, hash, "proposal_resolved");
  const approved = logs[0].args.approved as boolean;
  const loan_addr = logs[0].args.loan_contract as `0x${string}`;
  const loan = approved ? await viem.getContractAt("Loan", loan_addr) : null;
  return { approved, loan_addr, loan };
}

export function total_owed(principal: bigint, rate: number): bigint {
  return (principal * BigInt(100 + rate)) / 100n;
}
