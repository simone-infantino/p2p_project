import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { viem, networkHelpers, deploy_service, BTC, ONE_BTC_SATS, events_logs } from "./helpers.js";
import { parseEther, parseGwei, getAddress } from "viem";

const MINI_ORACLE_REQUEST_FEE = parseGwei("0.1") * 50_000n;

describe("Upgradability & termination — LendingService", () => {
  it("set_oracle swaps the oracle the service points at", async () => {
    const { service, oracle, admin, alice, applicant, public_client } = await networkHelpers.loadFixture(deploy_service);

    const oracle2 = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);
    await oracle.write.push_balance([BTC, 1n]);                  //old: very little pushed funds
    await service.write.set_oracle([oracle2.address], { account: admin.account });
    await oracle2.write.push_balance([BTC, ONE_BTC_SATS]);       //new: enough pushed funds

    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.submit_proposal([parseEther("3"), 10, 1000n, BTC], { account: applicant.account });
    await service.write.vote([0n, true], { account: alice.account });
    await networkHelpers.mine(13);

    const hash = await service.write.resolve_proposal([0n], { account: applicant.account });
    const logs = await events_logs(public_client, service.abi, hash, "proposal_resolved");
    assert.equal(logs[0].args.approved, true);  // approved only because it read the new oracle's balance
  });

  it("set_oracle is admin-only and rejects the zero address", async () => {
    const { service, admin, alice } = await networkHelpers.loadFixture(deploy_service);
    const oracle2 = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);
    await viem.assertions.revertWith( service.write.set_oracle([oracle2.address], { account: alice.account }), "not admin" );
    await viem.assertions.revertWith( service.write.set_oracle( ["0x0000000000000000000000000000000000000000"], { account: admin.account } ), "zero address" );
  });

  it("transfer_admin/accept_admin rotates admin in two steps", async () => {
    const { service, oracle, admin, alice, bob } = await networkHelpers.loadFixture(deploy_service);

    await service.write.transfer_admin([alice.account.address], { account: admin.account });
    assert.equal(getAddress(await service.read.admin()), getAddress(admin.account.address));
    assert.equal(getAddress(await service.read.pending_admin()), getAddress(alice.account.address));

    //a non-pending account cannot accept
    await viem.assertions.revertWith( service.write.accept_admin({ account: bob.account }), "not pending admin" );

    await service.write.accept_admin({ account: alice.account });
    assert.equal(getAddress(await service.read.admin()), getAddress(alice.account.address));
    assert.equal(getAddress(await service.read.pending_admin()),getAddress("0x0000000000000000000000000000000000000000") );

    //the old admin can no longer perform admin activities
    await viem.assertions.revertWith( service.write.set_successor([bob.account.address], { account: admin.account }), "not admin" );
    const successor = await viem.deployContract("LendingService", [oracle.address]);
    await service.write.set_successor([successor.address], { account: alice.account });
  });

  it("set_successor + terminate halts the service and migrates its balances", async () => {
    const { service, oracle, admin, alice, applicant, public_client } = await networkHelpers.loadFixture(deploy_service);

    await service.write.deposit({ account: alice.account, value: parseEther("5") });

    const service_balance_before_termination = await public_client.getBalance({ address: service.address });
    assert.ok(service_balance_before_termination >= parseEther("5"));

    const alice_deposited_before = await service.read.deposited([alice.account.address]);
    const total_deposited_before = await service.read.total_deposited();
    const collateral_percent_before = await service.read.collateral_percent();

    const successor = await viem.deployContract("LendingService", [oracle.address]);

    const noSucc = await deploy_service();
    await viem.assertions.revertWith( noSucc.service.write.terminate({ account: noSucc.admin.account }), "no successor" );

    await successor.write.set_migration_source([service.address], { account: admin.account });
    await service.write.set_successor([successor.address], { account: admin.account });

    const successor_balance_before = await public_client.getBalance({ address: successor.address });
    await service.write.terminate({ account: admin.account });
    const successor_balance_after = await public_client.getBalance({ address: successor.address });
    const service_balance = await public_client.getBalance({ address: service.address });

    assert.equal(service_balance, 0n, "terminated service forwarded its whole balance");
    assert.equal(successor_balance_after - successor_balance_before, service_balance_before_termination, "successor received the migrated balance");

    assert.equal(await successor.read.deposited([alice.account.address]), alice_deposited_before, "successor imported alice's deposits");
    assert.equal(await successor.read.is_contributor([alice.account.address]), true, "successor registered alice as a contributor");
    assert.equal(await successor.read.total_deposited(), total_deposited_before, "successor imported total_deposited");
    assert.equal(await successor.read.collateral_percent(), collateral_percent_before, "successor imported collateral_percent");

    assert.equal(await service.read.terminated(), true);

    await viem.assertions.revertWith( service.write.deposit({ account: alice.account, value: parseEther("1") }), "terminated" );
    await viem.assertions.revertWith( service.write.submit_proposal([parseEther("1"), 10, 100n, BTC], { account: applicant.account }), "terminated" );
  });

  it("terminate is blocked while loans are still active (total_locked != 0)", async () => {
    const { service, oracle, admin, alice, applicant } = await networkHelpers.loadFixture(deploy_service);

    await oracle.write.push_balance([BTC, ONE_BTC_SATS]);
    await service.write.deposit({ account: alice.account, value: parseEther("10") });
    await service.write.submit_proposal([parseEther("3"), 10, 100000n, BTC], { account: applicant.account });
    await service.write.vote([0n, true], { account: alice.account });
    await networkHelpers.mine(13);
    await service.write.resolve_proposal([0n], { account: applicant.account });

    const successor = await viem.deployContract("LendingService", [oracle.address]);
    await service.write.set_successor([successor.address], { account: admin.account });

    await viem.assertions.revertWith( service.write.terminate({ account: admin.account }), "loans still active" );
  });
});

describe("Upgradability & termination — BitcoinOracle", () => {
  it("transfer_ownership/accept_ownership rotates the owner in two steps", async () => {
    const [deployer, alice, bob] = await viem.getWalletClients();
    const oracle = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);

    assert.equal(getAddress(await oracle.read.owner()), getAddress(deployer.account.address));

    await oracle.write.transfer_ownership([alice.account.address]);
    assert.equal(getAddress(await oracle.read.owner()), getAddress(deployer.account.address));
    assert.equal(getAddress(await oracle.read.new_owner()), getAddress(alice.account.address));

    await viem.assertions.revertWith( oracle.write.accept_ownership({ account: bob.account }), "not pending owner" );

    await oracle.write.accept_ownership({ account: alice.account });
    assert.equal(getAddress(await oracle.read.owner()), getAddress(alice.account.address));

    await viem.assertions.revertWith(oracle.write.push_balance([BTC, ONE_BTC_SATS]), "not oracle");
    await oracle.write.push_balance([BTC, ONE_BTC_SATS], { account: alice.account });
  });

  it("owner-only functions reject non-owners", async () => {
    const [deployer, alice] = await viem.getWalletClients();
    const oracle = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);

    await viem.assertions.revertWith( oracle.write.push_balance([BTC, ONE_BTC_SATS], { account: alice.account }), "not oracle" );
    await viem.assertions.revertWith( oracle.write.set_minimum_fee([MINI_ORACLE_REQUEST_FEE], { account: alice.account }), "not oracle" );
    await viem.assertions.revertWith( oracle.write.withdraw_fees([alice.account.address], { account: alice.account }), "not oracle" );
  });

  it("terminate marks the oracle out of use; reads and fee withdrawal still work", async () => {
    const [deployer, alice] = await viem.getWalletClients();
    const public_client = await viem.getPublicClient();
    const oracle = await viem.deployContract("BitcoinOracle", [MINI_ORACLE_REQUEST_FEE]);

    await oracle.write.push_balance([BTC, ONE_BTC_SATS]);
    await oracle.write.request_update([BTC], { account: alice.account, value: MINI_ORACLE_REQUEST_FEE });
    const oracleFeeBalance = await public_client.getBalance({ address: oracle.address });
    assert.ok(oracleFeeBalance >= MINI_ORACLE_REQUEST_FEE, "oracle collected the request fee");

    await oracle.write.terminate();
    assert.equal(await oracle.read.terminated(), true);

    await viem.assertions.revertWith( oracle.write.push_balance([BTC, ONE_BTC_SATS]), "terminated"
    );
    await viem.assertions.revertWith(
      oracle.write.request_update([BTC], { account: alice.account, value: MINI_ORACLE_REQUEST_FEE }),
      "terminated"
    );

    //we can still read data and recover the fees (from the oracle account)
    const bal = await oracle.read.get_balance([BTC]);
    assert.equal(bal, ONE_BTC_SATS);

    await oracle.write.withdraw_fees([deployer.account.address]);
    const afterWithdraw = await public_client.getBalance({ address: oracle.address });
    assert.equal(afterWithdraw, 0n, "fees fully withdrawn even after termination");
  });
});
