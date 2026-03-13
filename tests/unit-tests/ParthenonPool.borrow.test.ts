import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool borrow tests", function () {
  async function deployWithSupply() {
    const [owner, supplier, borrower] = await ethers.getSigners();

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

    // Supply liquidity
    await usdc.transfer(supplier.address, ethers.parseUnits("100000", 6));
    await usdc.connect(supplier).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(supplier).supply(marketParams, ethers.parseUnits("100000", 6), 0, supplier.address, "0x");

    // Fund borrower with collateral
    await wbtc.transfer(borrower.address, ethers.parseUnits("10", 8));
    await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);

    return { pool, usdc, wbtc, irm, oracle, owner, supplier, borrower, marketParams };
  }

  it("Should borrow after supplying collateral", async function () {
    const { pool, borrower, marketParams } = await loadFixture(deployWithSupply);

    // Supply collateral: 1 BTC (worth $50,000)
    await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

    // Borrow 30,000 USDC (within 80% LLTV of $50,000 = $40,000)
    const borrowAmount = ethers.parseUnits("30000", 6);
    await expect(pool.connect(borrower).borrow(marketParams, borrowAmount, 0, borrower.address, borrower.address))
      .to.emit(pool, "Borrow");
  });

  it("Should reject borrow exceeding LLTV", async function () {
    const { pool, borrower, marketParams } = await loadFixture(deployWithSupply);

    // Supply collateral: 1 BTC (worth $50,000)
    await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

    // Try to borrow 45,000 USDC (exceeds 80% of $50,000 = $40,000)
    const borrowAmount = ethers.parseUnits("45000", 6);
    await expect(pool.connect(borrower).borrow(marketParams, borrowAmount, 0, borrower.address, borrower.address))
      .to.be.revertedWith("insufficient collateral");
  });

  it("Should reject borrow without collateral", async function () {
    const { pool, borrower, marketParams } = await loadFixture(deployWithSupply);

    await expect(pool.connect(borrower).borrow(marketParams, ethers.parseUnits("1000", 6), 0, borrower.address, borrower.address))
      .to.be.revertedWith("insufficient collateral");
  });

  it("Should reject borrow exceeding available liquidity", async function () {
    const { pool, borrower, marketParams, wbtc, owner } = await loadFixture(deployWithSupply);

    // Supply massive collateral
    await wbtc.transfer(borrower.address, ethers.parseUnits("50", 8));
    await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("50", 8), borrower.address, "0x");

    // Try to borrow more than supplied (100,000 USDC supplied, try 200,000)
    await expect(pool.connect(borrower).borrow(marketParams, ethers.parseUnits("200000", 6), 0, borrower.address, borrower.address))
      .to.be.revertedWith("insufficient liquidity");
  });

  it("Should reject borrow to zero receiver", async function () {
    const { pool, borrower, marketParams } = await loadFixture(deployWithSupply);
    await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");
    await expect(pool.connect(borrower).borrow(marketParams, 1000, 0, borrower.address, ethers.ZeroAddress))
      .to.be.revertedWith("zero address");
  });
});
