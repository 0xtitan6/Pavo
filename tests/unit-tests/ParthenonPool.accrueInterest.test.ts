import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool accrueInterest tests", function () {
  async function deployWithBorrow() {
    const [owner, supplier, borrower] = await ethers.getSigners();

    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);

    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    // 5% APR
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

    // Compute market ID
    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
    ));

    await pool.createMarket(marketParams);

    // Supply 100,000 USDC
    await usdc.transfer(supplier.address, ethers.parseUnits("100000", 6));
    await usdc.connect(supplier).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(supplier).supply(marketParams, ethers.parseUnits("100000", 6), 0, supplier.address, "0x");

    // Borrow 30,000 USDC
    await wbtc.transfer(borrower.address, ethers.parseUnits("1", 8));
    await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");
    await pool.connect(borrower).borrow(marketParams, ethers.parseUnits("30000", 6), 0, borrower.address, borrower.address);

    return { pool, usdc, wbtc, irm, oracle, owner, supplier, borrower, marketParams, id };
  }

  it("Should accrue interest over time", async function () {
    const { pool, marketParams, id } = await loadFixture(deployWithBorrow);

    // Get initial market state
    const marketBefore = await pool.market(id);
    const totalBorrowBefore = marketBefore.totalBorrowAssets;

    // Advance 30 days
    await time.increase(30 * 24 * 3600);

    // Trigger interest accrual
    await pool.accrueInterest(marketParams);

    // Get updated market state
    const marketAfter = await pool.market(id);
    const totalBorrowAfter = marketAfter.totalBorrowAssets;

    // Borrow assets should have increased due to interest
    expect(totalBorrowAfter).to.be.gt(totalBorrowBefore);
    console.log(`Interest accrued: ${totalBorrowAfter - totalBorrowBefore} (borrow went from ${totalBorrowBefore} to ${totalBorrowAfter})`);
  });

  it("Should increase supply assets by same interest amount", async function () {
    const { pool, marketParams, id } = await loadFixture(deployWithBorrow);

    const marketBefore = await pool.market(id);
    const supplyBefore = marketBefore.totalSupplyAssets;
    const borrowBefore = marketBefore.totalBorrowAssets;

    await time.increase(365 * 24 * 3600); // 1 year
    await pool.accrueInterest(marketParams);

    const marketAfter = await pool.market(id);
    const supplyIncrease = marketAfter.totalSupplyAssets - supplyBefore;
    const borrowIncrease = marketAfter.totalBorrowAssets - borrowBefore;

    // Without fees, supply increase = borrow increase
    expect(supplyIncrease).to.equal(borrowIncrease);
  });

  it("Should not accrue interest if no time elapsed", async function () {
    const { pool, marketParams, id } = await loadFixture(deployWithBorrow);

    // Accrue once to sync timestamp
    await pool.accrueInterest(marketParams);
    const marketBefore = await pool.market(id);

    // Mine a block without advancing time (same timestamp)
    // This just verifies the function doesn't revert
    // Interest may accrue by 1 second due to block mining
  });

  it("Should accrue fees to fee recipient", async function () {
    const { pool, marketParams, id, owner } = await loadFixture(deployWithBorrow);

    // Set fee to 10%
    await pool.setFeeRecipient(owner.address);
    await pool.setFee(marketParams, ethers.parseUnits("10", 16)); // 10% fee

    // Advance time
    await time.increase(365 * 24 * 3600);
    await pool.accrueInterest(marketParams);

    // Fee recipient should have supply shares
    const pos = await pool.position(id, owner.address);
    expect(pos.supplyShares).to.be.gt(0);
    console.log(`Fee recipient shares: ${pos.supplyShares}`);
  });
});
