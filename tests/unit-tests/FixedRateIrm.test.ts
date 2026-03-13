import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("FixedRateIrm tests", function () {
  async function deployIrm() {
    const [owner, user1] = await ethers.getSigners();

    // 5% APR = 5e16 / (365.25 * 86400) ≈ 1_585_489_599
    const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);

    return { irm, owner, user1, ratePerSecond };
  }

  it("Should return configured rate from borrowRate()", async function () {
    const { irm, ratePerSecond } = await loadFixture(deployIrm);

    // Create dummy market params and market structs
    const dummyParams = {
      loanToken: ethers.ZeroAddress,
      collateralToken: ethers.ZeroAddress,
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: 0
    };
    const dummyMarket = {
      totalSupplyAssets: 0,
      totalSupplyShares: 0,
      totalBorrowAssets: 0,
      totalBorrowShares: 0,
      lastUpdate: 0,
      fee: 0
    };

    const rate = await irm.borrowRate.staticCall(dummyParams, dummyMarket);
    expect(rate).to.equal(ratePerSecond);
  });

  it("Should return same rate from borrowRateView()", async function () {
    const { irm, ratePerSecond } = await loadFixture(deployIrm);

    const dummyParams = {
      loanToken: ethers.ZeroAddress,
      collateralToken: ethers.ZeroAddress,
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: 0
    };
    const dummyMarket = {
      totalSupplyAssets: 0,
      totalSupplyShares: 0,
      totalBorrowAssets: 0,
      totalBorrowShares: 0,
      lastUpdate: 0,
      fee: 0
    };

    const rate = await irm.borrowRateView(dummyParams, dummyMarket);
    expect(rate).to.equal(ratePerSecond);
  });

  it("Should allow owner to update rate", async function () {
    const { irm, owner } = await loadFixture(deployIrm);

    const newRate = ethers.parseUnits("10", 16) / (365n * 86400n); // 10% APR
    await expect(irm.setRate(newRate))
      .to.emit(irm, "RateUpdated");

    expect(await irm.ratePerSecond()).to.equal(newRate);
  });

  it("Should reject rate update from non-owner", async function () {
    const { irm, user1 } = await loadFixture(deployIrm);

    await expect(irm.connect(user1).setRate(0))
      .to.be.revertedWith("not owner");
  });

  it("Should allow ownership transfer", async function () {
    const { irm, owner, user1 } = await loadFixture(deployIrm);

    await irm.setOwner(user1.address);
    expect(await irm.owner()).to.equal(user1.address);

    // New owner can set rate
    await irm.connect(user1).setRate(0);
    expect(await irm.ratePerSecond()).to.equal(0);
  });

  it("Should reject zero address owner transfer", async function () {
    const { irm } = await loadFixture(deployIrm);
    await expect(irm.setOwner(ethers.ZeroAddress))
      .to.be.revertedWith("zero owner");
  });

  it("Should reject zero address in constructor", async function () {
    await expect(ethers.deployContract("FixedRateIrm", [ethers.ZeroAddress, 0]))
      .to.be.revertedWith("zero owner");
  });
});
