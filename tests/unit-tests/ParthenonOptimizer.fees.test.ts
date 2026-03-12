import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonOptimizer fee accrual, cap enforcement, and multi-strategy tests", function () {
  async function deployFeeFixture() {
    const [owner, depositor, borrower, feeRecipient] = await ethers.getSigners();

    // Deploy mock tokens
    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("1000", 8), 8
    ]);
    const weth = await ethers.deployContract("ERC20Mock", [
      "Wrapped Ether", "WETH", owner.address, ethers.parseUnits("10000", 18), 18
    ]);

    // Deploy pool
    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    // Deploy IRMs — use rates within MAX_RATE_PER_SECOND (~10% APR max)
    const ratePerSecond = ethers.parseUnits("8", 16) / (365n * 86400n);
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);
    const irm2Rate = ethers.parseUnits("9", 16) / (365n * 86400n);
    const irm2 = await ethers.deployContract("FixedRateIrm", [owner.address, irm2Rate]);

    await pool.enableIrm(await irm.getAddress());
    await pool.enableIrm(await irm2.getAddress());
    const lltv = ethers.parseUnits("80", 16);
    await pool.enableLltv(lltv);

    const oracleBtc = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);
    const oracleEth = await ethers.deployContract("MockPoolOracle", [3000n * 10n ** 34n]);

    // Market 1: USDC/BTC
    const marketParams1 = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracleBtc.getAddress(),
      irm: await irm.getAddress(),
      lltv: lltv
    };
    await pool.createMarket(marketParams1);

    const id1 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams1.loanToken, marketParams1.collateralToken, marketParams1.oracle, marketParams1.irm, marketParams1.lltv]
    ));

    // Market 2: USDC/ETH
    const marketParams2 = {
      loanToken: await usdc.getAddress(),
      collateralToken: await weth.getAddress(),
      oracle: await oracleEth.getAddress(),
      irm: await irm2.getAddress(),
      lltv: lltv
    };
    await pool.createMarket(marketParams2);

    const id2 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams2.loanToken, marketParams2.collateralToken, marketParams2.oracle, marketParams2.irm, marketParams2.lltv]
    ));

    // Deploy optimizer
    const optimizer = await ethers.deployContract("ParthenonOptimizer", [
      await pool.getAddress(),
      await usdc.getAddress(),
      "ParthenonOptimizer USDC",
      "poUSDC",
      owner.address
    ]);

    const poolAddress = await pool.getAddress();
    const optimizerAddress = await optimizer.getAddress();

    // Set queues (both markets)
    await optimizer.setSupplyQueue([id1, id2]);
    await optimizer.setWithdrawQueue([id1, id2]);

    // Fund depositor
    await usdc.transfer(depositor.address, ethers.parseUnits("500000", 6));
    await usdc.connect(depositor).approve(optimizerAddress, ethers.MaxUint256);

    // Fund borrower with collateral
    await wbtc.transfer(borrower.address, ethers.parseUnits("10", 8));
    await wbtc.connect(borrower).approve(poolAddress, ethers.MaxUint256);
    await weth.transfer(borrower.address, ethers.parseUnits("1000", 18));
    await weth.connect(borrower).approve(poolAddress, ethers.MaxUint256);

    return {
      pool, optimizer, usdc, wbtc, weth, irm, irm2,
      oracleBtc, oracleEth, owner, depositor, borrower, feeRecipient,
      marketParams1, marketParams2, id1, id2,
      poolAddress, optimizerAddress, lltv
    };
  }

  // ── Helper: generate interest by having a borrower borrow from the pool ──

  async function generateInterest(
    fixture: Awaited<ReturnType<typeof deployFeeFixture>>,
    days: number = 30
  ) {
    const { pool, borrower, marketParams1 } = fixture;

    // Borrower supplies collateral and borrows
    const collateralAmount = ethers.parseUnits("1", 8); // 1 BTC
    await pool.connect(borrower).supplyCollateral(marketParams1, collateralAmount, borrower.address, "0x");

    // Borrow some USDC (within LTV)
    const borrowAmount = ethers.parseUnits("5000", 6);
    await pool.connect(borrower).borrow(marketParams1, borrowAmount, 0, borrower.address, borrower.address);

    // Advance time
    await time.increase(86400 * days);

    // Accrue interest in the pool
    await pool.accrueInterest(marketParams1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fee Accrual Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Fee Accrual", function () {
    it("Should mint fee shares to feeRecipient when totalAssets increases", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, depositor, feeRecipient } = fixture;

      // Configure fee: 10% (0.1e18)
      await optimizer.setFeeRecipient(feeRecipient.address);
      await optimizer.setFee(ethers.parseUnits("1", 17)); // 0.1e18 = 10%

      // Deposit into optimizer
      const depositAmount = ethers.parseUnits("50000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Generate interest via borrowing
      await generateInterest(fixture, 90);

      // Fee recipient should have 0 shares before accrual trigger
      const sharesBefore = await optimizer.balanceOf(feeRecipient.address);
      expect(sharesBefore).to.equal(0);

      // Trigger accrual via a small deposit
      await optimizer.connect(depositor).deposit(ethers.parseUnits("1", 6), depositor.address);

      // Fee recipient should now have shares
      const sharesAfter = await optimizer.balanceOf(feeRecipient.address);
      expect(sharesAfter).to.be.gt(0);
    });

    it("Should not accrue fee when fee is 0", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, depositor, feeRecipient } = fixture;

      // Set fee recipient but leave fee = 0
      await optimizer.setFeeRecipient(feeRecipient.address);

      // Deposit
      const depositAmount = ethers.parseUnits("50000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Generate interest
      await generateInterest(fixture, 90);

      // Trigger accrual
      await optimizer.connect(depositor).deposit(ethers.parseUnits("1", 6), depositor.address);

      // No fee shares minted
      const feeShares = await optimizer.balanceOf(feeRecipient.address);
      expect(feeShares).to.equal(0);
    });

    it("Should not accrue fee when feeRecipient is zero address", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, depositor } = fixture;

      // Set fee but leave feeRecipient as zero address
      await optimizer.setFee(ethers.parseUnits("1", 17)); // 10%

      // Deposit
      const depositAmount = ethers.parseUnits("50000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Generate interest
      await generateInterest(fixture, 90);

      // Trigger accrual — should not revert, just skip fee mint
      await expect(
        optimizer.connect(depositor).deposit(ethers.parseUnits("1", 6), depositor.address)
      ).to.not.be.reverted;

      // Total supply should equal depositor's shares only (no fee shares minted)
      const totalShares = await optimizer.totalSupply();
      const depositorShares = await optimizer.balanceOf(depositor.address);
      expect(totalShares).to.equal(depositorShares);
    });

    it("Should not accrue fee when totalAssets does not grow", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, depositor, feeRecipient } = fixture;

      // Configure fee
      await optimizer.setFeeRecipient(feeRecipient.address);
      await optimizer.setFee(ethers.parseUnits("1", 17)); // 10%

      // Deposit (no borrowing means no interest accrued in pool)
      const depositAmount = ethers.parseUnits("50000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Do NOT generate interest — totalAssets stays the same

      // Trigger accrual via another deposit
      await optimizer.connect(depositor).deposit(ethers.parseUnits("1", 6), depositor.address);

      // No fee shares should be minted (no interest earned)
      const feeShares = await optimizer.balanceOf(feeRecipient.address);
      expect(feeShares).to.equal(0);
    });

    it("Should trigger _accrueProtocolFee before updating fee via setFee", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, depositor, feeRecipient } = fixture;

      // Configure initial fee and recipient
      await optimizer.setFeeRecipient(feeRecipient.address);
      await optimizer.setFee(ethers.parseUnits("1", 17)); // 10%

      // Deposit
      const depositAmount = ethers.parseUnits("50000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Generate interest
      await generateInterest(fixture, 90);

      // Calling setFee should trigger accrual first, then update fee
      await optimizer.setFee(ethers.parseUnits("2", 17)); // Change to 20%

      // Fee shares should have been minted from interest at the OLD 10% rate
      const feeShares = await optimizer.balanceOf(feeRecipient.address);
      expect(feeShares).to.be.gt(0);

      // Verify fee was actually updated
      expect(await optimizer.fee()).to.equal(ethers.parseUnits("2", 17));
    });

    it("Should trigger _accrueProtocolFee before updating feeRecipient via setFeeRecipient", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, depositor, feeRecipient, owner } = fixture;

      // Configure initial fee and recipient
      await optimizer.setFeeRecipient(feeRecipient.address);
      await optimizer.setFee(ethers.parseUnits("1", 17)); // 10%

      // Deposit
      const depositAmount = ethers.parseUnits("50000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Generate interest
      await generateInterest(fixture, 90);

      // Calling setFeeRecipient should trigger accrual to OLD recipient first
      await optimizer.setFeeRecipient(owner.address);

      // OLD fee recipient should have received shares from interest accrual
      const oldRecipientShares = await optimizer.balanceOf(feeRecipient.address);
      expect(oldRecipientShares).to.be.gt(0);

      // New recipient is now set
      expect(await optimizer.feeRecipient()).to.equal(owner.address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cap Enforcement During Reallocate
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Cap Enforcement During Reallocate", function () {
    it("Should revert reallocate when supply exceeds cap", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, depositor, id1, id2 } = fixture;

      // Deposit all into market 1 (no cap on market 1, supply queue fills in order)
      const depositAmount = ethers.parseUnits("10000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Set a cap on market 2
      const cap = ethers.parseUnits("3000", 6);
      await optimizer.setAllocationCap(id2, cap);

      // Try to reallocate 5000 from market 1 to market 2 — exceeds cap of 3000
      const amount = ethers.parseUnits("5000", 6);
      await expect(
        optimizer.reallocate([id1], [amount], [id2], [amount])
      ).to.be.revertedWith("Cap exceeded");
    });

    it("Should succeed reallocate within cap", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, pool, depositor, id1, id2, optimizerAddress } = fixture;

      // Deposit all into market 1
      const depositAmount = ethers.parseUnits("10000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Set cap on market 2 at 5000
      const cap = ethers.parseUnits("5000", 6);
      await optimizer.setAllocationCap(id2, cap);

      // Reallocate 3000 from market 1 to market 2 — within cap
      const amount = ethers.parseUnits("3000", 6);
      await optimizer.reallocate([id1], [amount], [id2], [amount]);

      // Market 2 should now have supply
      const pos2 = await pool.position(id2, optimizerAddress);
      expect(pos2.supplyShares).to.be.gt(0);
    });

    it("Should treat cap = 0 as unlimited during reallocate", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, pool, depositor, id1, id2, optimizerAddress } = fixture;

      // Deposit all into market 1
      const depositAmount = ethers.parseUnits("10000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Cap on market 2 is 0 (default — unlimited)
      // Reallocate a large amount — should succeed
      const amount = ethers.parseUnits("8000", 6);
      await optimizer.reallocate([id1], [amount], [id2], [amount]);

      const pos2 = await pool.position(id2, optimizerAddress);
      expect(pos2.supplyShares).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-Strategy (2+ pool markets) Supply
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Multi-Strategy Supply", function () {
    it("Should deposit and route to 2 markets via supply queue", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, pool, depositor, id1, id2, optimizerAddress } = fixture;

      // Set cap on market 1 so deposits split across both markets
      const cap1 = ethers.parseUnits("5000", 6);
      await optimizer.setAllocationCap(id1, cap1);

      // Deposit 10000 — 5000 to market 1 (cap), 5000 to market 2
      const depositAmount = ethers.parseUnits("10000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Both markets should have supply
      const pos1 = await pool.position(id1, optimizerAddress);
      const pos2 = await pool.position(id2, optimizerAddress);
      expect(pos1.supplyShares).to.be.gt(0);
      expect(pos2.supplyShares).to.be.gt(0);

      // totalAssets should track correctly
      const total = await optimizer.totalAssets();
      expect(total).to.be.gte(depositAmount - 10n);
      expect(total).to.be.lte(depositAmount + 10n);
    });

    it("Should fill first market to cap then route remainder to second market", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, pool, depositor, id1, id2, optimizerAddress } = fixture;

      // Set cap on market 1 at 4000
      const cap1 = ethers.parseUnits("4000", 6);
      await optimizer.setAllocationCap(id1, cap1);

      // Deposit 10000 — first 4000 should go to market 1, remaining 6000 to market 2
      const depositAmount = ethers.parseUnits("10000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Market 1 should be at cap
      const pos1 = await pool.position(id1, optimizerAddress);
      const mkt1 = await pool.market(id1);
      const assets1 = pos1.supplyShares * mkt1.totalSupplyAssets / mkt1.totalSupplyShares;
      expect(assets1).to.be.gte(cap1 - 10n);
      expect(assets1).to.be.lte(cap1 + 10n);

      // Market 2 should have the remainder
      const pos2 = await pool.position(id2, optimizerAddress);
      expect(pos2.supplyShares).to.be.gt(0);
      const mkt2 = await pool.market(id2);
      const assets2 = pos2.supplyShares * mkt2.totalSupplyAssets / mkt2.totalSupplyShares;
      expect(assets2).to.be.gte(ethers.parseUnits("6000", 6) - 10n);
      expect(assets2).to.be.lte(ethers.parseUnits("6000", 6) + 10n);

      // Total should be approximately the deposit amount
      const total = await optimizer.totalAssets();
      expect(total).to.be.gte(depositAmount - 10n);
      expect(total).to.be.lte(depositAmount + 10n);
    });

    it("Should withdraw from withdraw queue in order", async function () {
      const fixture = await loadFixture(deployFeeFixture);
      const { optimizer, pool, usdc, depositor, id1, id2, optimizerAddress } = fixture;

      // Set cap on market 1 so deposits split across both markets
      const cap1 = ethers.parseUnits("5000", 6);
      await optimizer.setAllocationCap(id1, cap1);

      // Deposit 10000 — 5000 to market 1, 5000 to market 2
      const depositAmount = ethers.parseUnits("10000", 6);
      await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

      // Verify both markets have supply
      const pos1Before = await pool.position(id1, optimizerAddress);
      const pos2Before = await pool.position(id2, optimizerAddress);
      expect(pos1Before.supplyShares).to.be.gt(0);
      expect(pos2Before.supplyShares).to.be.gt(0);

      // Withdraw 3000 — should pull from market 1 first (withdraw queue order)
      const withdrawAmount = ethers.parseUnits("3000", 6);
      await optimizer.connect(depositor).withdraw(withdrawAmount, depositor.address, depositor.address);

      // Market 1 should have reduced supply
      const pos1After = await pool.position(id1, optimizerAddress);
      expect(pos1After.supplyShares).to.be.lt(pos1Before.supplyShares);

      // Market 2 should be unchanged (withdraw queue pulled from market 1 first)
      const pos2After = await pool.position(id2, optimizerAddress);
      expect(pos2After.supplyShares).to.equal(pos2Before.supplyShares);

      // Depositor should have received their USDC
      const depositorBalance = await usdc.balanceOf(depositor.address);
      // They started with 500000, deposited 10000, now withdrew 3000 => ~493000
      expect(depositorBalance).to.be.gte(ethers.parseUnits("493000", 6) - 10n);
    });
  });
});
