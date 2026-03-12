/**
 * Integration.fullStack.test.ts
 *
 * Full-stack integration: LoanFactory → OptimizerAdapter → ParthenonOptimizer → ParthenonPool
 *
 * Covers:
 *   - createLoan (lend offer) → idle funds route to ParthenonPool via optimizer
 *   - cancelLoan → funds + accrued yield returned to lender
 *   - takeUpLoan → funds withdrawn from optimizer, loan matched, yield surplus distributed
 *   - Deposit cap enforcement in OptimizerAdapter
 *   - Batch emergency withdraw in OptimizerAdapter
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Full-stack integration: LoanFactory → OptimizerAdapter → ParthenonPool", function () {
  async function deployFullStack() {
    const [owner, lender, borrower, user3] = await ethers.getSigners();

    // ── Tokens ───────────────────────────────────────────────────────────────
    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("1000", 8), 8
    ]);

    // ── Oracle infra ─────────────────────────────────────────────────────────
    // BTC/USD = $50,000 (8 decimals)
    const BTC_PRICE = 50_000n * 10n ** 8n;
    const mockAggregator = await ethers.deployContract("MockAggregatorV3", [8, BTC_PRICE]);

    const assetRegistry = await ethers.deployContract("AssetRegistry");
    await assetRegistry.registerAsset(await wbtc.getAddress(), "WBTC", "BTC/USD", 8);
    await assetRegistry.registerAsset(await usdc.getAddress(), "USDC", "", 6);
    await assetRegistry.setAssetSupported(await wbtc.getAddress(), true);
    await assetRegistry.setAssetSupported(await usdc.getAddress(), true);
    await assetRegistry.setPairSupported(await wbtc.getAddress(), await usdc.getAddress(), true);

    const priceOracle = await ethers.deployContract("PriceOracle", [owner.address]);
    // 400-day max staleness for tests
    await priceOracle.setFeed(await wbtc.getAddress(), await mockAggregator.getAddress(), 400 * 24 * 3600);

    // ── LoanFactory ──────────────────────────────────────────────────────────
    const loanFactory = await ethers.deployContract("LoanFactory", [
      await priceOracle.getAddress(),
      await assetRegistry.getAddress(),
      ethers.ZeroAddress, // no fee recipient
      0                   // no protocol fee
    ]);

    // ── ParthenonPool ────────────────────────────────────────────────────────
    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n); // ~5% APY
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);
    await pool.enableIrm(await irm.getAddress());
    const lltv = ethers.parseUnits("80", 16);
    await pool.enableLltv(lltv);

    // PoolOracleAdapter wraps PriceOracle → 1e36-scaled price for ParthenonPool
    const poolOracle = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);

    const usdcAddr = await usdc.getAddress();
    const wbtcAddr = await wbtc.getAddress();

    const marketParams = {
      loanToken: usdcAddr,
      collateralToken: wbtcAddr,
      oracle: await poolOracle.getAddress(),
      irm: await irm.getAddress(),
      lltv
    };
    await pool.createMarket(marketParams);

    const marketId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "uint256"],
        [usdcAddr, wbtcAddr, await poolOracle.getAddress(), await irm.getAddress(), lltv]
      )
    );

    // ── ParthenonOptimizer ───────────────────────────────────────────────────
    const optimizer = await ethers.deployContract("ParthenonOptimizer", [
      await pool.getAddress(),
      usdcAddr,
      "Parthenon Optimizer USDC",
      "poUSDC",
      owner.address
    ]);
    await optimizer.setSupplyQueue([marketId]);
    await optimizer.setWithdrawQueue([marketId]);
    // Set unlimited cap for the market
    await optimizer.setAllocationCap(marketId, ethers.parseUnits("1000000", 6));

    // ── OptimizerAdapter ─────────────────────────────────────────────────────
    const loanFactoryAddr = await loanFactory.getAddress();
    const adapter = await ethers.deployContract("OptimizerAdapter", [loanFactoryAddr]);
    await adapter.configureOptimizer(usdcAddr, await optimizer.getAddress());

    // Wire adapter into LoanFactory
    await loanFactory.setYieldAdapter(await adapter.getAddress());

    // ── Fund actors ──────────────────────────────────────────────────────────
    const LEND_AMOUNT = ethers.parseUnits("10000", 6);
    const COLLATERAL = ethers.parseUnits("1", 8); // 1 BTC

    await usdc.transfer(lender.address, LEND_AMOUNT * 3n);
    await wbtc.transfer(borrower.address, COLLATERAL * 3n);

    await usdc.connect(lender).approve(loanFactoryAddr, ethers.MaxUint256);
    await wbtc.connect(borrower).approve(loanFactoryAddr, ethers.MaxUint256);

    // Helpers for LoanFactory params
    // LoanFactory rates: index 0 = lowest rate (from contract's RATES array)
    const RATE_INDEX = 0;
    const DURATION_INDEX = 0; // shortest duration
    const INITIAL_RATIO = 15000; // 150% collateral ratio
    const LIQ_THRESHOLD = 11000; // 110%

    async function createLendOffer(signer: any, amount: bigint = LEND_AMOUNT): Promise<bigint> {
      // createLoan(_asset, _collateral, _initialCollateralRatio, _liquidationThreshold,
      //            _assetAddress, _collateralAddress, _rateIndex, _durationIndex)
      const tx = await loanFactory.connect(signer).createLoan(
        amount,        // _asset (lend amount)
        0n,            // _collateral (0 for lend offer)
        INITIAL_RATIO,
        LIQ_THRESHOLD,
        usdcAddr,
        wbtcAddr,
        RATE_INDEX,
        DURATION_INDEX
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try { return loanFactory.interface.parseLog(l)?.name === "Created"; } catch { return false; }
      });
      const parsed = loanFactory.interface.parseLog(event!);
      return parsed!.args[0] as bigint;
    }

    async function createBorrowOffer(signer: any, collateralAmt: bigint = COLLATERAL): Promise<bigint> {
      const tx = await loanFactory.connect(signer).createLoan(
        0n,             // _asset (0 for borrow offer)
        collateralAmt,  // _collateral
        INITIAL_RATIO,
        LIQ_THRESHOLD,
        usdcAddr,
        wbtcAddr,
        RATE_INDEX,
        DURATION_INDEX
      );
      const receipt = await tx.wait();
      const event = receipt!.logs.find((l: any) => {
        try { return loanFactory.interface.parseLog(l)?.name === "Created"; } catch { return false; }
      });
      const parsed = loanFactory.interface.parseLog(event!);
      return parsed!.args[0] as bigint;
    }

    return {
      loanFactory, pool, optimizer, adapter, usdc, wbtc, irm, priceOracle, mockAggregator,
      owner, lender, borrower, user3,
      usdcAddr, wbtcAddr, loanFactoryAddr, marketId, marketParams,
      LEND_AMOUNT, COLLATERAL,
      createLendOffer, createBorrowOffer
    };
  }

  // ── createLoan → idle funds route to optimizer ────────────────────────────

  describe("createLoan (lend offer) → funds deposited into ParthenonPool via optimizer", function () {
    it("Should route lend funds to optimizer after createLoan", async function () {
      const { loanFactory, adapter, optimizer, usdc, lender, usdcAddr, LEND_AMOUNT, createLendOffer } =
        await loadFixture(deployFullStack);

      const lendId = await createLendOffer(lender);

      // Adapter should hold optimizer shares for this loanId
      const shares = await adapter.sharesOf(lendId, usdcAddr);
      expect(shares).to.be.gt(0n, "Adapter should have shares for the loanId");

      // LoanFactory should hold no USDC (all deposited into optimizer)
      const lfBalance = await usdc.balanceOf(await loanFactory.getAddress());
      expect(lfBalance).to.equal(0n);

      // Optimizer's totalAssets should reflect the deposit
      const totalAssets = await optimizer.totalAssets();
      expect(totalAssets).to.be.closeTo(LEND_AMOUNT, ethers.parseUnits("1", 6));
    });

    it("Should track activePositions in adapter after deposit", async function () {
      const { adapter, usdcAddr, lender, createLendOffer } = await loadFixture(deployFullStack);

      expect(await adapter.activePositions(usdcAddr)).to.equal(0n);
      await createLendOffer(lender);
      expect(await adapter.activePositions(usdcAddr)).to.equal(1n);
    });
  });

  // ── createLoan → cancelLoan: return funds to lender ──────────────────────

  describe("createLoan → cancelLoan: idle funds returned from optimizer", function () {
    it("Should return principal to lender on cancel (no yield in same block)", async function () {
      const { loanFactory, usdc, lender, usdcAddr, LEND_AMOUNT, createLendOffer } =
        await loadFixture(deployFullStack);

      const lendId = await createLendOffer(lender);
      const balBefore = await usdc.balanceOf(lender.address);

      await loanFactory.connect(lender).cancelLoan(lendId);

      const balAfter = await usdc.balanceOf(lender.address);
      // Principal should be fully returned (yield = 0 in same block with no borrow activity)
      expect(balAfter - balBefore).to.be.gte(LEND_AMOUNT - 1n); // allow 1 wei rounding
    });

    it("Should clear shares in adapter after cancel", async function () {
      const { loanFactory, adapter, usdcAddr, lender, createLendOffer } =
        await loadFixture(deployFullStack);

      const lendId = await createLendOffer(lender);
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.be.gt(0n);

      await loanFactory.connect(lender).cancelLoan(lendId);
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.equal(0n);
      expect(await adapter.activePositions(usdcAddr)).to.equal(0n);
    });

    it("Should return yield accrued after time passes and borrow activity", async function () {
      const { loanFactory, pool, adapter, usdc, wbtc, lender, borrower, owner,
              usdcAddr, wbtcAddr, marketParams, LEND_AMOUNT, COLLATERAL,
              createLendOffer, createBorrowOffer } = await loadFixture(deployFullStack);

      const lendId = await createLendOffer(lender);

      // Have another lender supply directly to pool to enable borrows
      await usdc.transfer(owner.address, ethers.parseUnits("50000", 6));
      await usdc.connect(owner).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(owner).supply(marketParams, ethers.parseUnits("50000", 6), 0, owner.address, "0x");

      // Borrower supplies collateral and borrows
      await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(borrower).supplyCollateral(marketParams, COLLATERAL, borrower.address, "0x");
      const borrowAmt = ethers.parseUnits("20000", 6); // ~40% LTV
      await pool.connect(borrower).borrow(marketParams, borrowAmt, 0, borrower.address, borrower.address);

      // Advance time by 30 days to accrue interest
      await time.increase(30 * 24 * 3600);
      await pool.accrueInterest(marketParams);

      const balBefore = await usdc.balanceOf(lender.address);
      await loanFactory.connect(lender).cancelLoan(lendId);
      const balAfter = await usdc.balanceOf(lender.address);

      const received = balAfter - balBefore;
      // Lender should receive at least original principal (optimizer may have earned yield)
      expect(received).to.be.gte(LEND_AMOUNT - ethers.parseUnits("1", 6));
    });
  });

  // ── createLoan → takeUpLoan: match lend + borrow offers ──────────────────

  describe("createLoan → takeUpLoan: full loan match via optimizer", function () {
    it("Should match lend and borrow offers, borrower receives funds", async function () {
      const { loanFactory, usdc, wbtc, lender, borrower, usdcAddr, wbtcAddr,
              LEND_AMOUNT, createLendOffer, createBorrowOffer } = await loadFixture(deployFullStack);

      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);

      const borrowerUsdcBefore = await usdc.balanceOf(borrower.address);

      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      const borrowerUsdcAfter = await usdc.balanceOf(borrower.address);
      expect(borrowerUsdcAfter - borrowerUsdcBefore).to.equal(LEND_AMOUNT);
    });

    it("Should clear adapter shares after takeUpLoan", async function () {
      const { loanFactory, adapter, usdcAddr, lender, borrower,
              createLendOffer, createBorrowOffer } = await loadFixture(deployFullStack);

      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);

      expect(await adapter.sharesOf(lendId, usdcAddr)).to.be.gt(0n);
      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.equal(0n);
    });
  });

  // ── OptimizerAdapter: deposit cap enforcement ─────────────────────────────

  describe("OptimizerAdapter: deposit cap enforcement", function () {
    it("Should reject deposits when shares would exceed cap", async function () {
      const { loanFactory, adapter, usdc, lender, usdcAddr, LEND_AMOUNT, createLendOffer } =
        await loadFixture(deployFullStack);

      // Set a very small cap (1 share)
      await adapter.setMarketCap(usdcAddr, 1n);

      // Deposit should revert due to cap
      await expect(createLendOffer(lender)).to.be.reverted;
    });

    it("Should allow deposits up to cap", async function () {
      const { adapter, usdc, lender, usdcAddr, LEND_AMOUNT, createLendOffer } =
        await loadFixture(deployFullStack);

      // Set cap exactly to LEND_AMOUNT worth of shares (roughly 1:1 initially)
      await adapter.setMarketCap(usdcAddr, LEND_AMOUNT * 2n);

      // First deposit should succeed
      const lendId = await createLendOffer(lender);
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.be.gt(0n);
    });
  });

  // ── OptimizerAdapter: emergency withdraw ─────────────────────────────────

  describe("OptimizerAdapter: emergency withdraw", function () {
    it("Should emergency withdraw a position to owner", async function () {
      const { loanFactory, adapter, usdc, lender, owner, usdcAddr, LEND_AMOUNT, createLendOffer } =
        await loadFixture(deployFullStack);

      const lendId = await createLendOffer(lender);
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.be.gt(0n);

      const ownerBalBefore = await usdc.balanceOf(owner.address);

      await adapter.connect(owner).emergencyWithdraw(usdcAddr, lendId, owner.address);

      const ownerBalAfter = await usdc.balanceOf(owner.address);
      expect(ownerBalAfter - ownerBalBefore).to.be.closeTo(LEND_AMOUNT, ethers.parseUnits("1", 6));
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.equal(0n);
    });

    it("Should batch emergency withdraw multiple positions", async function () {
      const { loanFactory, adapter, usdc, lender, owner, usdcAddr, LEND_AMOUNT, createLendOffer } =
        await loadFixture(deployFullStack);

      // Create 3 lend offers
      const ids: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await createLendOffer(lender));
      }

      for (const id of ids) {
        expect(await adapter.sharesOf(id, usdcAddr)).to.be.gt(0n);
      }

      const ownerBalBefore = await usdc.balanceOf(owner.address);
      await adapter.connect(owner).batchEmergencyWithdraw(usdcAddr, ids, owner.address);
      const ownerBalAfter = await usdc.balanceOf(owner.address);

      expect(ownerBalAfter - ownerBalBefore).to.be.closeTo(
        LEND_AMOUNT * 3n,
        ethers.parseUnits("3", 6)
      );

      for (const id of ids) {
        expect(await adapter.sharesOf(id, usdcAddr)).to.equal(0n);
      }
    });
  });

  // ── OptimizerAdapter: pause + freeze ─────────────────────────────────────

  describe("OptimizerAdapter: pause and freeze controls", function () {
    it("Should prevent deposits when market is paused", async function () {
      const { adapter, usdcAddr, lender, createLendOffer } = await loadFixture(deployFullStack);

      await adapter.setMarketPaused(usdcAddr, true);
      await expect(createLendOffer(lender)).to.be.reverted;

      // Unpause should re-enable deposits
      await adapter.setMarketPaused(usdcAddr, false);
      await expect(createLendOffer(lender)).to.not.be.reverted;
    });

    it("Should prevent deposits when market is frozen", async function () {
      const { adapter, usdcAddr, lender, createLendOffer } = await loadFixture(deployFullStack);

      await adapter.setMarketFrozen(usdcAddr, true);
      await expect(createLendOffer(lender)).to.be.reverted;
    });
  });

  // ── Multiple positions across multiple loanIds ────────────────────────────

  describe("Multiple concurrent lend positions", function () {
    it("Should track shares correctly across multiple loanIds", async function () {
      const { adapter, usdcAddr, lender, LEND_AMOUNT, createLendOffer } =
        await loadFixture(deployFullStack);

      const id1 = await createLendOffer(lender);
      const id2 = await createLendOffer(lender);
      const id3 = await createLendOffer(lender);

      const shares1 = await adapter.sharesOf(id1, usdcAddr);
      const shares2 = await adapter.sharesOf(id2, usdcAddr);
      const shares3 = await adapter.sharesOf(id3, usdcAddr);

      expect(shares1).to.be.gt(0n);
      expect(shares2).to.be.gt(0n);
      expect(shares3).to.be.gt(0n);

      // totalShares should equal sum of individual positions
      const total = await adapter.totalShares(usdcAddr);
      expect(total).to.equal(shares1 + shares2 + shares3);

      expect(await adapter.activePositions(usdcAddr)).to.equal(3n);
      expect(await adapter.totalActivePositions()).to.equal(3n);
    });

    it("Should correctly update totalShares after cancels", async function () {
      const { loanFactory, adapter, usdcAddr, lender, LEND_AMOUNT, createLendOffer } =
        await loadFixture(deployFullStack);

      const id1 = await createLendOffer(lender);
      const id2 = await createLendOffer(lender);

      const shares1 = await adapter.sharesOf(id1, usdcAddr);
      const shares2 = await adapter.sharesOf(id2, usdcAddr);
      const totalBefore = await adapter.totalShares(usdcAddr);
      expect(totalBefore).to.equal(shares1 + shares2);

      await loanFactory.connect(lender).cancelLoan(id1);

      const totalAfter = await adapter.totalShares(usdcAddr);
      expect(totalAfter).to.equal(shares2);
      expect(await adapter.activePositions(usdcAddr)).to.equal(1n);
    });
  });

  // ── endLoan: natural maturity settlement ──────────────────────────────────

  describe("endLoan: settlement at natural maturity", function () {
    async function matchedLoanFixture() {
      const ctx = await deployFullStack();
      const { loanFactory, usdc, wbtc, lender, borrower, usdcAddr, wbtcAddr,
              LEND_AMOUNT, COLLATERAL, createLendOffer, createBorrowOffer } = ctx;

      // Match a loan: borrower takes lender's offer
      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);
      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      // After takeUpLoan, active loan is at lendId
      const activeLoanId = lendId;
      return { ...ctx, activeLoanId };
    }

    it("Should settle loan at maturity — lender gets collateral payout, borrower gets excess", async function () {
      const { loanFactory, wbtc, lender, borrower, activeLoanId, COLLATERAL } =
        await loadFixture(matchedLoanFixture);

      // Advance time past 1-day maturity (DURATION_DAYS[0] = 1)
      await time.increase(86401);

      const lenderBtcBefore = await wbtc.balanceOf(lender.address);
      const borrowerBtcBefore = await wbtc.balanceOf(borrower.address);

      await loanFactory.connect(lender).endLoan(activeLoanId);

      const lenderBtcAfter = await wbtc.balanceOf(lender.address);
      const borrowerBtcAfter = await wbtc.balanceOf(borrower.address);

      const lenderReceived = lenderBtcAfter - lenderBtcBefore;
      const borrowerReceived = borrowerBtcAfter - borrowerBtcBefore;

      // Lender must receive >0 BTC (collateral equivalent of loan repayment)
      expect(lenderReceived).to.be.gt(0n);
      // Borrower gets excess (1 BTC - lender's share). At $50k BTC and $10k loan, excess ≈ 0.8 BTC
      expect(borrowerReceived).to.be.gt(0n);
      // Total must equal COLLATERAL (conservation of collateral)
      expect(lenderReceived + borrowerReceived).to.equal(COLLATERAL);
    });

    it("Should emit Ended event on endLoan", async function () {
      const { loanFactory, lender, activeLoanId } = await loadFixture(matchedLoanFixture);

      await time.increase(86401);
      await expect(loanFactory.connect(lender).endLoan(activeLoanId))
        .to.emit(loanFactory, "Ended");
    });

    it("Should revert endLoan before maturity", async function () {
      const { loanFactory, lender, activeLoanId } = await loadFixture(matchedLoanFixture);

      // Not yet mature — 0 seconds elapsed
      await expect(loanFactory.connect(lender).endLoan(activeLoanId))
        .to.be.revertedWith("Loan has not matured yet");
    });

    it("Should revert endLoan on non-existent loan", async function () {
      const { loanFactory, lender } = await loadFixture(matchedLoanFixture);

      await time.increase(86401);
      await expect(loanFactory.connect(lender).endLoan(9999n))
        .to.be.revertedWith("Loan not found or inactive");
    });

    it("Should delete loan state after endLoan (cannot end twice)", async function () {
      const { loanFactory, lender, activeLoanId } = await loadFixture(matchedLoanFixture);

      await time.increase(86401);
      await loanFactory.connect(lender).endLoan(activeLoanId);

      // Second call should revert — loan is deleted
      await expect(loanFactory.connect(lender).endLoan(activeLoanId))
        .to.be.revertedWith("Loan not found or inactive");
    });
  });

  // ── liquidateLoan: price-crash liquidation ────────────────────────────────

  describe("liquidateLoan: under-collateralised loan seizure", function () {
    async function matchedLoanFixture() {
      const ctx = await deployFullStack();
      const { loanFactory, lender, borrower, createLendOffer, createBorrowOffer } = ctx;

      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);
      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      return { ...ctx, activeLoanId: lendId };
    }

    it("Should allow lender to liquidate when BTC price crashes below threshold", async function () {
      const { loanFactory, wbtc, lender, mockAggregator, activeLoanId, COLLATERAL } =
        await loadFixture(matchedLoanFixture);

      // Crash BTC from $50k to $10k — health ≈ (10000 * 10000) / (10000 * ~1.0) = 10000 < liquidationThreshold (11000)
      await mockAggregator.setAnswer(10_000n * 10n ** 8n);

      const lenderBtcBefore = await wbtc.balanceOf(lender.address);

      await loanFactory.connect(lender).liquidateLoan(activeLoanId);

      const lenderBtcAfter = await wbtc.balanceOf(lender.address);
      // Lender should receive all collateral
      expect(lenderBtcAfter - lenderBtcBefore).to.equal(COLLATERAL);
    });

    it("Should emit Liquidated event", async function () {
      const { loanFactory, lender, mockAggregator, activeLoanId } =
        await loadFixture(matchedLoanFixture);

      await mockAggregator.setAnswer(10_000n * 10n ** 8n);
      await expect(loanFactory.connect(lender).liquidateLoan(activeLoanId))
        .to.emit(loanFactory, "Liquidated");
    });

    it("Should revert liquidateLoan when health is above threshold", async function () {
      const { loanFactory, lender, activeLoanId } = await loadFixture(matchedLoanFixture);

      // BTC still at $50k — health ≈ 50000 bps, well above 11000
      await expect(loanFactory.connect(lender).liquidateLoan(activeLoanId))
        .to.be.revertedWith("Health above liquidation threshold");
    });

    it("Should revert liquidateLoan after loan matures (must use endLoan)", async function () {
      const { loanFactory, lender, mockAggregator, activeLoanId } =
        await loadFixture(matchedLoanFixture);

      // Crash price AND advance past maturity
      await mockAggregator.setAnswer(10_000n * 10n ** 8n);
      await time.increase(86401);

      await expect(loanFactory.connect(lender).liquidateLoan(activeLoanId))
        .to.be.revertedWith("Loan matured: use endLoan");
    });

    it("Should delete loan state after liquidation (cannot liquidate twice)", async function () {
      const { loanFactory, lender, mockAggregator, activeLoanId } =
        await loadFixture(matchedLoanFixture);

      await mockAggregator.setAnswer(10_000n * 10n ** 8n);
      await loanFactory.connect(lender).liquidateLoan(activeLoanId);

      await expect(loanFactory.connect(lender).liquidateLoan(activeLoanId))
        .to.be.revertedWith("Loan not found or inactive");
    });
  });

  // ── interruptLoan: early USDC repayment ───────────────────────────────────

  describe("interruptLoan: borrower pays early to reclaim collateral", function () {
    async function matchedLoanFixture() {
      const ctx = await deployFullStack();
      const { loanFactory, usdc, lender, borrower, createLendOffer, createBorrowOffer } = ctx;

      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);
      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      // After takeUpLoan, borrower holds LEND_AMOUNT USDC — fund a bit more for interest margin
      await usdc.transfer(borrower.address, ethers.parseUnits("100", 6));

      return { ...ctx, activeLoanId: lendId };
    }

    it("Should return full collateral to borrower on interruptLoan", async function () {
      const { loanFactory, usdc, wbtc, lender, borrower, usdcAddr, loanFactoryAddr,
              activeLoanId, COLLATERAL } = await loadFixture(matchedLoanFixture);

      // Borrower must approve USDC repayment
      await usdc.connect(borrower).approve(loanFactoryAddr, ethers.MaxUint256);

      const borrowerBtcBefore = await wbtc.balanceOf(borrower.address);
      const lenderUsdcBefore = await usdc.balanceOf(lender.address);

      await loanFactory.connect(borrower).interruptLoan(activeLoanId);

      const borrowerBtcAfter = await wbtc.balanceOf(borrower.address);
      const lenderUsdcAfter = await usdc.balanceOf(lender.address);

      // Borrower should get back all collateral
      expect(borrowerBtcAfter - borrowerBtcBefore).to.equal(COLLATERAL);

      // Lender should receive totalRepayment (principal + full-term interest)
      const repaymentReceived = lenderUsdcAfter - lenderUsdcBefore;
      expect(repaymentReceived).to.be.gte(ethers.parseUnits("10000", 6)); // at least principal
    });

    it("Should emit Interrupted event", async function () {
      const { loanFactory, usdc, lender, borrower, usdcAddr, loanFactoryAddr, activeLoanId } =
        await loadFixture(matchedLoanFixture);

      await usdc.connect(borrower).approve(loanFactoryAddr, ethers.MaxUint256);

      await expect(loanFactory.connect(borrower).interruptLoan(activeLoanId))
        .to.emit(loanFactory, "Interrupted");
    });

    it("Should revert interruptLoan after loan matures", async function () {
      const { loanFactory, usdc, borrower, usdcAddr, loanFactoryAddr, activeLoanId } =
        await loadFixture(matchedLoanFixture);

      await usdc.connect(borrower).approve(loanFactoryAddr, ethers.MaxUint256);
      await time.increase(86401); // past 1-day maturity

      await expect(loanFactory.connect(borrower).interruptLoan(activeLoanId))
        .to.be.revertedWith("Loan has already matured");
    });

    it("Should revert interruptLoan if caller is not the borrower", async function () {
      const { loanFactory, usdc, lender, user3, usdcAddr, loanFactoryAddr, activeLoanId } =
        await loadFixture(matchedLoanFixture);

      await usdc.connect(lender).approve(loanFactoryAddr, ethers.MaxUint256);

      await expect(loanFactory.connect(lender).interruptLoan(activeLoanId))
        .to.be.revertedWith("Loan not found, inactive, or unauthorized");
    });
  });
});
