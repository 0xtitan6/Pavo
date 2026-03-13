import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool collateral tests", function () {
  async function deployWithSupply() {
    const [owner, supplier, borrower, anotherBorrower] = await ethers.getSigners();

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

    // Fund borrowers with collateral
    await wbtc.transfer(borrower.address, ethers.parseUnits("10", 8));
    await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);
    
    await wbtc.transfer(anotherBorrower.address, ethers.parseUnits("5", 8));
    await wbtc.connect(anotherBorrower).approve(await pool.getAddress(), ethers.MaxUint256);

    return { pool, usdc, wbtc, irm, oracle, owner, supplier, borrower, anotherBorrower, marketParams };
  }

  describe("supplyCollateral", function () {
    it("Should supply collateral successfully", async function () {
      const { pool, borrower, wbtc, marketParams } = await loadFixture(deployWithSupply);

      const collateralAmount = ethers.parseUnits("1", 8);
      await expect(pool.connect(borrower).supplyCollateral(marketParams, collateralAmount, borrower.address, "0x"))
        .to.emit(pool, "SupplyCollateral");
    });

    it("Should handle multiple collateral deposits", async function () {
      const { pool, borrower, wbtc, marketParams } = await loadFixture(deployWithSupply);

      const amount1 = ethers.parseUnits("0.5", 8);
      const amount2 = ethers.parseUnits("0.5", 8);

      await pool.connect(borrower).supplyCollateral(marketParams, amount1, borrower.address, "0x");
      await expect(pool.connect(borrower).supplyCollateral(marketParams, amount2, borrower.address, "0x"))
        .to.emit(pool, "SupplyCollateral");
    });

    it("Should allow supplying collateral for another user", async function () {
      const { pool, borrower, anotherBorrower, wbtc, marketParams } = await loadFixture(deployWithSupply);

      const collateralAmount = ethers.parseUnits("1", 8);
      await expect(pool.connect(borrower).supplyCollateral(marketParams, collateralAmount, anotherBorrower.address, "0x"))
        .to.emit(pool, "SupplyCollateral");
    });
  });

  describe("withdrawCollateral", function () {
    it("Should withdraw collateral successfully", async function () {
      const { pool, borrower, wbtc, marketParams } = await loadFixture(deployWithSupply);

      // Supply collateral
      const collateralAmount = ethers.parseUnits("1", 8);
      await pool.connect(borrower).supplyCollateral(marketParams, collateralAmount, borrower.address, "0x");

      // Withdraw some collateral
      const withdrawAmount = ethers.parseUnits("0.5", 8);
      await expect(pool.connect(borrower).withdrawCollateral(marketParams, withdrawAmount, borrower.address, borrower.address))
        .to.emit(pool, "WithdrawCollateral");
    });

    it("Should fail withdrawal if undercollateralized", async function () {
      const { pool, borrower, wbtc, marketParams } = await loadFixture(deployWithSupply);

      // Supply collateral: 1 BTC ($50,000)
      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      // Borrow: 35,000 USDC (70% of $50,000 - still safe)
      const borrowAmount = ethers.parseUnits("35000", 6);
      await pool.connect(borrower).borrow(marketParams, borrowAmount, 0, borrower.address, borrower.address);

      // Try to withdraw all collateral - should fail because it'd be undercollateralized
      await expect(pool.connect(borrower).withdrawCollateral(marketParams, ethers.parseUnits("0.9", 8), borrower.address, borrower.address))
        .to.be.revertedWith("insufficient collateral");
    });

    it("Should allow withdrawal within safe bounds", async function () {
      const { pool, borrower, wbtc, marketParams } = await loadFixture(deployWithSupply);

      // Supply collateral: 1 BTC ($50,000)
      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      // Borrow less to stay well collateralized: $20,000 (40%)
      await pool.connect(borrower).borrow(marketParams, ethers.parseUnits("20000", 6), 0, borrower.address, borrower.address);

      // Should be able to withdraw some collateral (staying well under 80% LLTV)
      // Withdraw 0.3 BTC: remaining 0.7 BTC * $50,000 = $35,000; borrow $20,000 => 57% < 80%
      await expect(pool.connect(borrower).withdrawCollateral(marketParams, ethers.parseUnits("0.3", 8), borrower.address, borrower.address))
        .to.emit(pool, "WithdrawCollateral");
    });
  });

  describe("repay with collateral", function () {
    it("Should allow repay with collateral balance", async function () {
      const { pool, borrower, usdc, marketParams } = await loadFixture(deployWithSupply);

      // Supply collateral
      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("2", 8), borrower.address, "0x");

      // Borrow
      await pool.connect(borrower).borrow(marketParams, ethers.parseUnits("10000", 6), 0, borrower.address, borrower.address);

      // Repay the borrowed amount
      await usdc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);
      await expect(pool.connect(borrower).repay(marketParams, ethers.parseUnits("10000", 6), 0, borrower.address, "0x"))
        .to.emit(pool, "Repay");
    });
  });
});
