import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("OptimizerAdapter tests", function () {
  async function deployAdapterFixture() {
    const [owner, loanFactorySigner, user1] = await ethers.getSigners();

    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);

    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);

    await pool.enableIrm(await irm.getAddress());
    const lltv = ethers.parseUnits("80", 16);
    await pool.enableLltv(lltv);

    const oracle = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);

    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracle.getAddress(),
      irm: await irm.getAddress(),
      lltv: lltv
    };

    await pool.createMarket(marketParams);

    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
    ));

    // Deploy optimizer
    const optimizer = await ethers.deployContract("ParthenonOptimizer", [
      await pool.getAddress(),
      await usdc.getAddress(),
      "ParthenonOptimizer USDC",
      "poUSDC",
      owner.address
    ]);

    await optimizer.setSupplyQueue([id]);
    await optimizer.setWithdrawQueue([id]);

    // Deploy adapter with loanFactory = loanFactorySigner address
    const adapter = await ethers.deployContract("OptimizerAdapter", [loanFactorySigner.address]);

    // Configure optimizer for USDC
    await adapter.configureOptimizer(await usdc.getAddress(), await optimizer.getAddress());

    // Fund loanFactory signer with USDC
    await usdc.transfer(loanFactorySigner.address, ethers.parseUnits("100000", 6));
    await usdc.connect(loanFactorySigner).approve(await adapter.getAddress(), ethers.MaxUint256);

    return { pool, optimizer, adapter, usdc, wbtc, owner, loanFactorySigner, user1, id };
  }

  it("Should deposit from loanFactory", async function () {
    const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);

    await expect(adapter.connect(loanFactorySigner).deposit(
      await usdc.getAddress(),
      ethers.parseUnits("1000", 6),
      1 // loanId
    )).to.emit(adapter, "Deposited");
  });

  it("Should track shares per loanId", async function () {
    const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
    const usdcAddr = await usdc.getAddress();

    await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);
    await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("2000", 6), 2);

    const shares1 = await adapter.sharesOf(1, usdcAddr);
    const shares2 = await adapter.sharesOf(2, usdcAddr);
    expect(shares1).to.be.gt(0);
    expect(shares2).to.be.gt(shares1);
  });

  it("Should withdraw to specified recipient", async function () {
    const { adapter, usdc, loanFactorySigner, user1 } = await loadFixture(deployAdapterFixture);
    const usdcAddr = await usdc.getAddress();

    await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);

    const balanceBefore = await usdc.balanceOf(user1.address);
    await adapter.connect(loanFactorySigner).withdraw(usdcAddr, 1, user1.address);
    const balanceAfter = await usdc.balanceOf(user1.address);

    expect(balanceAfter - balanceBefore).to.be.gte(ethers.parseUnits("999", 6)); // Allow tiny rounding
  });

  it("Should reject deposit from non-loanFactory", async function () {
    const { adapter, usdc, user1 } = await loadFixture(deployAdapterFixture);
    await expect(adapter.connect(user1).deposit(await usdc.getAddress(), 1000, 1))
      .to.be.revertedWith("Only LoanFactory");
  });

  it("Should reject withdraw from non-loanFactory", async function () {
    const { adapter, usdc, user1 } = await loadFixture(deployAdapterFixture);
    await expect(adapter.connect(user1).withdraw(await usdc.getAddress(), 1, user1.address))
      .to.be.revertedWith("Only LoanFactory");
  });

  it("Should report hasMarket correctly", async function () {
    const { adapter, usdc, wbtc } = await loadFixture(deployAdapterFixture);
    expect(await adapter.hasMarket(await usdc.getAddress())).to.be.true;
    expect(await adapter.hasMarket(await wbtc.getAddress())).to.be.false;
  });

  it("Should track totalActivePositions", async function () {
    const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
    const usdcAddr = await usdc.getAddress();

    expect(await adapter.totalActivePositions()).to.equal(0);

    await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);
    expect(await adapter.totalActivePositions()).to.equal(1);

    await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 2);
    expect(await adapter.totalActivePositions()).to.equal(2);

    await adapter.connect(loanFactorySigner).withdraw(usdcAddr, 1, loanFactorySigner.address);
    expect(await adapter.totalActivePositions()).to.equal(1);
  });

  it("Should pause and unpause deposits", async function () {
    const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
    const usdcAddr = await usdc.getAddress();

    await adapter.setMarketPaused(usdcAddr, true);
    await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, 1000, 1))
      .to.be.revertedWith("Market deposits paused");

    await adapter.setMarketPaused(usdcAddr, false);
    await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1))
      .to.not.be.reverted;
  });

  it("Should freeze and unfreeze market", async function () {
    const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
    const usdcAddr = await usdc.getAddress();

    await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);

    await adapter.setMarketFrozen(usdcAddr, true);

    // Both deposit and withdraw should fail when frozen
    await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, 1000, 2))
      .to.be.revertedWith("Market frozen");
    await expect(adapter.connect(loanFactorySigner).withdraw(usdcAddr, 1, loanFactorySigner.address))
      .to.be.revertedWith("Market frozen");
  });

  it("Should emergency withdraw by owner", async function () {
    const { adapter, usdc, loanFactorySigner, user1, owner } = await loadFixture(deployAdapterFixture);
    const usdcAddr = await usdc.getAddress();

    await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);

    // Owner emergency withdraw
    await adapter.emergencyWithdraw(usdcAddr, 1, user1.address);
    expect(await usdc.balanceOf(user1.address)).to.be.gte(ethers.parseUnits("999", 6));
    expect(await adapter.totalActivePositions()).to.equal(0);
  });
});
