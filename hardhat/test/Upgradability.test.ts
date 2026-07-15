import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { viem, networkHelpers, deploy_service, BTC, ONE_BTC_SATS } from "./helpers.js";
import { parseEther, parseGwei, getAddress } from "viem";

const MINI_ORACLE_REQUEST_FEE = parseGwei("0.1") * 50_000n;

describe("Upgradability & termination — LendingService", () => {
  it("set_oracle swaps the oracle the service points at", async () => {
    const { service, oracle, admin, alice, applicant, public_client } = await deploy_service();

    const oracle2 = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);
    const hash = await service.write.set_oracle([oracle2.address], { account: admin.account });

    const receipt = await public_client.waitForTransactionReceipt({ hash });
    assert.equal(getAddress(await service.read.oracle()), getAddress(oracle2.address));

    await oracle2.write.push_balance([BTC, ONE_BTC_SATS]);
    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.submit_proposal([parseEther("3"), 10, 1000n, BTC], { account: applicant.account });
    await service.write.vote([0n, true], { account: alice.account });
    await networkHelpers.mine(13);
    // resolves without reverting -> the swapped-in oracle answered the liquidity check
    await service.write.resolve_proposal([0n], { account: applicant.account });
  });

  it("set_oracle is admin-only and rejects the zero address", async () => {
    const { service, admin, alice } = await deploy_service();
    const oracle2 = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);
    // non-admin cannot swap
    await assert.rejects(
      service.write.set_oracle([oracle2.address], { account: alice.account }),
      /not admin/
    );
    // admin cannot set the zero address
    await assert.rejects(
      service.write.set_oracle(
        ["0x0000000000000000000000000000000000000000"],
        { account: admin.account }
      ),
      /zero address/
    );
  });

  it("transfer_admin/accept_admin rotates admin in two steps", async () => {
    const { service, admin, alice, bob } = await deploy_service();

    // step 1: current admin nominates alice; admin is unchanged until accepted
    await service.write.transfer_admin([alice.account.address], { account: admin.account });
    assert.equal(getAddress(await service.read.admin()), getAddress(admin.account.address));
    assert.equal(getAddress(await service.read.pending_admin()), getAddress(alice.account.address));

    // a non-pending account cannot accept
    await assert.rejects(
      service.write.accept_admin({ account: bob.account }),
      /not pending admin/
    );

    // step 2: alice accepts -> she is admin now
    await service.write.accept_admin({ account: alice.account });
    assert.equal(getAddress(await service.read.admin()), getAddress(alice.account.address));
    assert.equal(
      getAddress(await service.read.pending_admin()),
      getAddress("0x0000000000000000000000000000000000000000")
    );

    // the old admin can no longer perform admin actions; the new admin can
    await assert.rejects(
      service.write.set_successor([bob.account.address], { account: admin.account }),
      /not admin/
    );
    await service.write.set_successor([bob.account.address], { account: alice.account });
  });

  it("set_successor + terminate halts the service and migrates its balance", async () => {
    const { service, oracle, admin, alice, applicant, public_client } = await deploy_service();

    await service.write.deposit({ account: alice.account, value: parseEther("5") });

    const serviceBalanceBeforeTermination = await public_client.getBalance({ address: service.address });
    assert.ok(serviceBalanceBeforeTermination >= parseEther("5"));

    const successor = await viem.deployContract("LendingService", [oracle.address]);

    const noSucc = await deploy_service();
    await assert.rejects(
      noSucc.service.write.terminate({ account: noSucc.admin.account }),
      /no successor/
    );

    await service.write.set_successor([successor.address], { account: admin.account });

    const successorBalanceBefore = await public_client.getBalance({ address: successor.address });
    await service.write.terminate({ account: admin.account });
    const successorBalanceAfter = await public_client.getBalance({ address: successor.address });
    const serviceBalanceAfterTermination = await public_client.getBalance({ address: service.address });

    assert.equal(serviceBalanceAfterTermination, 0n, "terminated service forwarded its whole balance");
    assert.equal(successorBalanceAfter - successorBalanceBefore, serviceBalanceBeforeTermination, "successor received the migrated balance");

    assert.equal(await service.read.terminated(), true);

    await assert.rejects(
      service.write.deposit({ account: alice.account, value: parseEther("1") }),
      /terminated/
    );
    await assert.rejects(
      service.write.submit_proposal([parseEther("1"), 10, 100n, BTC], { account: applicant.account }),
      /terminated/
    );
  });

  it("terminate is blocked while loans are still active (total_locked != 0)", async () => {
    const { service, oracle, admin, alice, applicant } = await deploy_service();

    await oracle.write.push_balance([BTC, ONE_BTC_SATS]);
    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.submit_proposal([parseEther("3"), 10, 100000n, BTC], { account: applicant.account });
    await service.write.vote([0n, true], { account: alice.account });
    await networkHelpers.mine(13);
    await service.write.resolve_proposal([0n], { account: applicant.account });

    const successor = await viem.deployContract("LendingService", [oracle.address]);
    await service.write.set_successor([successor.address], { account: admin.account });

    await assert.rejects(
      service.write.terminate({ account: admin.account }),
      /loans still active/
    );
  });
});

describe("Upgradability & termination — BitcoinOracle", () => {
  it("transfer_ownership/accept_ownership rotates the owner in two steps", async () => {
    const [deployer, alice, bob] = await viem.getWalletClients();
    const oracle = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);

    // deployer is the initial owner
    assert.equal(getAddress(await oracle.read.owner()), getAddress(deployer.account.address));

    // step 1: nominate alice; owner unchanged, pendingOwner set
    await oracle.write.transfer_ownership([alice.account.address]);
    assert.equal(getAddress(await oracle.read.owner()), getAddress(deployer.account.address));
    assert.equal(getAddress(await oracle.read.new_owner()), getAddress(alice.account.address));

    // a non-pending account cannot accept
    await assert.rejects(
      oracle.write.accept_ownership({ account: bob.account }),
      /not pending owner/
    );

    // step 2: alice accepts -> she owns it
    await oracle.write.accept_ownership({ account: alice.account });
    assert.equal(getAddress(await oracle.read.owner()), getAddress(alice.account.address));

    // old owner can no longer push; new owner can
    await assert.rejects(
      oracle.write.push_balance([BTC, ONE_BTC_SATS]),   // sent by deployer (old owner)
      /not oracle/
    );
    await oracle.write.push_balance([BTC, ONE_BTC_SATS], { account: alice.account }); // new owner works
  });

  it("owner-only functions reject non-owners", async () => {
    const [deployer, alice] = await viem.getWalletClients();
    const oracle = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);
    await assert.rejects(
      oracle.write.push_balance([BTC, ONE_BTC_SATS], { account: alice.account }),
      /not oracle/
    );
    await assert.rejects(
      oracle.write.set_minimum_fee([MINI_ORACLE_REQUEST_FEE], { account: alice.account }),
      /not oracle/
    );
    await assert.rejects(
      oracle.write.withdraw_fees([alice.account.address], { account: alice.account }),
      /not oracle/
    );
  });

  it("terminate marks the oracle out of use; reads and fee withdrawal still work", async () => {
    // NOTE: assumes the added terminate() sets `terminated = true` and that
    // request_update/push_balance are guarded to revert once terminated.
    const [deployer, alice] = await viem.getWalletClients();
    const public_client = await viem.getPublicClient();
    const oracle = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);

    // seed a balance and collect a fee BEFORE termination
    await oracle.write.push_balance([BTC, ONE_BTC_SATS]);
    await oracle.write.request_update([BTC], { account: alice.account, value: MINI_ORACLE_REQUEST_FEE });
    const oracleFeeBalance = await public_client.getBalance({ address: oracle.address });
    assert.ok(oracleFeeBalance >= MINI_ORACLE_REQUEST_FEE, "oracle collected the request fee");

    await oracle.write.terminate();
    assert.equal(await oracle.read.terminated(), true);

    // active operations now revert
    await assert.rejects(
      oracle.write.push_balance([BTC, ONE_BTC_SATS]),
      /terminated|retired/
    );
    await assert.rejects(
      oracle.write.request_update([BTC], { account: alice.account, value: MINI_ORACLE_REQUEST_FEE }),
      /terminated|retired/
    );

    // reads STILL work (view is unaffected) — last-known balance is still queryable
    const bal = await oracle.read.get_balance([BTC]);
    assert.equal(bal, ONE_BTC_SATS);

    // fee withdrawal STILL works after termination (owner can recover funds)
    await oracle.write.withdraw_fees([deployer.account.address]);
    const afterWithdraw = await public_client.getBalance({ address: oracle.address });
    assert.equal(afterWithdraw, 0n, "fees fully withdrawn even after termination");
  });
});
