// test/lending.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LendingService", function () {
  let oracle, service, owner, alice, bob, applicant;
  beforeEach(async () => {
    [owner, alice, bob, applicant] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("BitcoinOracle");
    oracle = await Oracle.deploy(ethers.parseUnits("1", "gwei") / 10n);
    const Service = await ethers.getContractFactory("LendingService");
    service = await Service.deploy(await oracle.getAddress());
  });
  
  it("accepts deposits above the minimum", async () => {
    await expect(service.connect(alice).deposit({ value: 100_000 })).to.emit(service, "Deposited");
    await expect(service.connect(bob).deposit({ value: 99_999 })).to.be.revertedWith("below min deposit");
  });
  
  it("rejects a proposal that fails the BTC liquidity check", async () => {
    await service.connect(alice).deposit({ value: ethers.parseEther("100") });
    const btc = "0x" + "11".repeat(20);
    await service.connect(applicant).submitProposal(ethers.parseEther("10"), 10, 50, btc);
    // do NOT push a balance to the oracle -> getBalance returns 0
    for (let i = 0; i < 13; i++) await ethers.provider.send("evm_mine"); // pass voting period
    await expect(service.connect(applicant).resolveProposal(0))
      .to.emit(service, "ProposalResolved").withArgs(0, false, ethers.ZeroAddress);
  });
});