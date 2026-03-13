import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool liquidate tests", function () {
  async function deployWithUnhealthyPosition() {
    const [owner, supplier, borrower, liquidator] = await ethers.getSigners();

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

    // Oracle: initially 50,000 USDC/BTC
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
    await usdc.transfer(supplier.address, ethers.parseUnits("200000", 6));
    await usdc.connect(supplier).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(supplier).supply(marketParams, ethers.parseUnits("200000", 6), 0, supplier.address, "0x");

    // Borrower: supply 1 BTC collateral, borrow 39,000 USDC (close to max = 40,000 at 80% LLTV)
    await wbtc.transfer(borrower.address, ethers.parseUnits("1", 8));
    await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");
    await pool.connect(borrower).borrow(marketParams, ethers.parseUnits("39000", 6), 0, borrower.address, borrower.address);

    // Fund liquidator with USDC for repayment
    await usdc.transfer(liquidator.address, ethers.parseUnits("100000", 6));
    await usdc.connect(liquidator).approve(await pool.getAddress(), ethers.MaxUint256);

    return { pool, usdc, wbtc, irm, oracle, owner, supplier, borrower, liquidator, marketParams };
  }

  it("Should liquidate unhealthy position after price drop", async function () {
    const { pool, oracle, borrower, liquidator, marketParams } = await loadFixture(deployWithUnhealthyPosition);

    // Drop BTC price to $40,000 — position becomes unhealthy
    // maxBorrow = 1 BTC * 40000 * 0.80 = $32,000 < $39,000 borrowed
    await oracle.setPrice(40000n * 10n ** 34n);

    const seizeAmount = ethers.parseUnits("0.5", 8); // Seize 0.5 BTC
    await expect(pool.connect(liquidator).liquidate(marketParams, borrower.address, seizeAmount, 0, "0x"))
      .to.emit(pool, "Liquidate");
  });

  it("Should reject liquidation of healthy position", async function () {
    const { pool, borrower, liquidator, marketParams } = await loadFixture(deployWithUnhealthyPosition);

    // Position is still healthy at $50,000 (maxBorrow = 40,000 > 39,000)
    const seizeAmount = ethers.parseUnits("0.1", 8);
    await expect(pool.connect(liquidator).liquidate(marketParams, borrower.address, seizeAmount, 0, "0x"))
      .to.be.revertedWith("position is healthy");
  });

  it("Should handle bad debt when collateral is fully seized", async function () {
    const { pool, oracle, borrower, liquidator, marketParams } = await loadFixture(deployWithUnhealthyPosition);

    // Crash price to $10,000 — massive undercollateralization
    await oracle.setPrice(10000n * 10n ** 34n);

    // Seize all collateral (1 BTC)
    const seizeAmount = ethers.parseUnits("1", 8);
    const tx = await pool.connect(liquidator).liquidate(marketParams, borrower.address, seizeAmount, 0, "0x");
    await expect(tx).to.emit(pool, "Liquidate");
  });
});
