import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonOptimizer ERC-4626 compliance tests", function () {
  async function deployOptimizerFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

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

    const optimizer = await ethers.deployContract("ParthenonOptimizer", [
      await pool.getAddress(),
      await usdc.getAddress(),
      "ParthenonOptimizer USDC",
      "poUSDC",
      owner.address
    ]);

    await optimizer.setSupplyQueue([id]);
    await optimizer.setWithdrawQueue([id]);

    // Fund users
    await usdc.transfer(user1.address, ethers.parseUnits("100000", 6));
    await usdc.connect(user1).approve(await optimizer.getAddress(), ethers.MaxUint256);
    await usdc.transfer(user2.address, ethers.parseUnits("100000", 6));
    await usdc.connect(user2).approve(await optimizer.getAddress(), ethers.MaxUint256);

    return { pool, optimizer, usdc, owner, user1, user2, id };
  }

  it("Should return correct asset address", async function () {
    const { optimizer, usdc } = await loadFixture(deployOptimizerFixture);
    expect(await optimizer.asset()).to.equal(await usdc.getAddress());
  });

  it("Should support convertToShares and convertToAssets", async function () {
    const { optimizer, user1 } = await loadFixture(deployOptimizerFixture);

    // Before any deposits, 1:1 ratio
    const shares = await optimizer.convertToShares(ethers.parseUnits("1000", 6));
    const assets = await optimizer.convertToAssets(shares);
    expect(assets).to.be.gte(ethers.parseUnits("999", 6)); // Allow tiny rounding
  });

  it("Should support previewDeposit and previewMint", async function () {
    const { optimizer } = await loadFixture(deployOptimizerFixture);

    const amount = ethers.parseUnits("1000", 6);
    const sharesFromDeposit = await optimizer.previewDeposit(amount);
    expect(sharesFromDeposit).to.be.gt(0);

    const assetsForMint = await optimizer.previewMint(sharesFromDeposit);
    expect(assetsForMint).to.be.gt(0);
  });

  it("Should support previewWithdraw and previewRedeem", async function () {
    const { optimizer, user1 } = await loadFixture(deployOptimizerFixture);

    // Deposit first
    const amount = ethers.parseUnits("1000", 6);
    await optimizer.connect(user1).deposit(amount, user1.address);

    const sharesForWithdraw = await optimizer.previewWithdraw(ethers.parseUnits("500", 6));
    expect(sharesForWithdraw).to.be.gt(0);

    const shares = await optimizer.balanceOf(user1.address);
    const assetsFromRedeem = await optimizer.previewRedeem(shares / 2n);
    expect(assetsFromRedeem).to.be.gt(0);
  });

  it("Should return correct maxDeposit", async function () {
    const { optimizer, user1 } = await loadFixture(deployOptimizerFixture);
    const maxDep = await optimizer.maxDeposit(user1.address);
    expect(maxDep).to.be.gt(0);
  });

  it("Should return correct name and symbol", async function () {
    const { optimizer } = await loadFixture(deployOptimizerFixture);
    expect(await optimizer.name()).to.equal("ParthenonOptimizer USDC");
    expect(await optimizer.symbol()).to.equal("poUSDC");
  });

  it("Should allow multiple depositors", async function () {
    const { optimizer, user1, user2 } = await loadFixture(deployOptimizerFixture);

    await optimizer.connect(user1).deposit(ethers.parseUnits("5000", 6), user1.address);
    await optimizer.connect(user2).deposit(ethers.parseUnits("3000", 6), user2.address);

    expect(await optimizer.balanceOf(user1.address)).to.be.gt(0);
    expect(await optimizer.balanceOf(user2.address)).to.be.gt(0);

    const totalAssets = await optimizer.totalAssets();
    expect(totalAssets).to.be.gte(ethers.parseUnits("7990", 6)); // Allow rounding
  });
});
