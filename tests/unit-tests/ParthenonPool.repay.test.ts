import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool repay tests", function () {
  async function deployWithBorrow() {
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

    // Borrower: supply collateral + borrow
    await wbtc.transfer(borrower.address, ethers.parseUnits("1", 8));
    await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

    const borrowAmount = ethers.parseUnits("30000", 6);
    await pool.connect(borrower).borrow(marketParams, borrowAmount, 0, borrower.address, borrower.address);

    // Give borrower extra USDC for repayment (to cover interest)
    await usdc.transfer(borrower.address, ethers.parseUnits("10000", 6));
    await usdc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);

    return { pool, usdc, wbtc, irm, oracle, owner, supplier, borrower, marketParams, borrowAmount };
  }

  it("Should repay borrowed assets", async function () {
    const { pool, borrower, marketParams } = await loadFixture(deployWithBorrow);

    const repayAmount = ethers.parseUnits("10000", 6);
    await expect(pool.connect(borrower).repay(marketParams, repayAmount, 0, borrower.address, "0x"))
      .to.emit(pool, "Repay");
  });

  it("Should allow full repayment", async function () {
    const { pool, usdc, borrower, marketParams, borrowAmount } = await loadFixture(deployWithBorrow);

    // Repay slightly more than borrowed to cover rounding
    await pool.connect(borrower).repay(marketParams, borrowAmount + 1n, 0, borrower.address, "0x");
  });

  it("Should reject repay to zero address", async function () {
    const { pool, borrower, marketParams } = await loadFixture(deployWithBorrow);
    await expect(pool.connect(borrower).repay(marketParams, 1000, 0, ethers.ZeroAddress, "0x"))
      .to.be.revertedWith("zero address");
  });

  it("Should reject repay with inconsistent input", async function () {
    const { pool, borrower, marketParams } = await loadFixture(deployWithBorrow);
    await expect(pool.connect(borrower).repay(marketParams, 0, 0, borrower.address, "0x"))
      .to.be.revertedWith("inconsistent input");
  });

  it("Should allow third party to repay on behalf", async function () {
    const { pool, usdc, supplier, borrower, marketParams } = await loadFixture(deployWithBorrow);

    // Supplier needs USDC and approval (they already supplied all their USDC to the pool)
    await usdc.transfer(supplier.address, ethers.parseUnits("10000", 6));
    await usdc.connect(supplier).approve(await pool.getAddress(), ethers.MaxUint256);

    // Supplier repays on behalf of borrower
    const repayAmount = ethers.parseUnits("5000", 6);
    await expect(pool.connect(supplier).repay(marketParams, repayAmount, 0, borrower.address, "0x"))
      .to.emit(pool, "Repay");
  });
});
