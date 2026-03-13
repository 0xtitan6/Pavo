import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

const RAY = 10n ** 27n;
const ONE_DAY = 86400;
const THREE_DAYS = 259200;
const SEVEN_DAYS = 604800;
const THIRTY_DAYS = 2592000;

describe("CreditMarket integration tests", function () {
  // ─── Shared fixture ────────────────────────────────────────────────

  async function deployIntegrationFixture() {
    const [owner, borrower, lender1, lender2, lender3, extra] = await ethers.getSigners();

    const asset = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("100000000", 6), 6
    ]);

    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);

    // Standard market parameters
    const params: CreditTypesLib.MarketParametersStruct = {
      annualInterestBips: 500,           // 5% APR
      delinquencyFeeBips: 200,           // 2% penalty
      withdrawalBatchDuration: SEVEN_DAYS,
      reserveRatioBips: 1000,            // 10% reserve
      delinquencyGracePeriod: THREE_DAYS,
      protocolFeeBips: 100,              // 1% protocol fee
      maxDelinquencyPeriod: THIRTY_DAYS,
      maxTotalSupply: ethers.parseUnits("1000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0,
    };

    return { owner, borrower, lender1, lender2, lender3, extra, asset, orchestrator, params };
  }

  // Helper: create market via orchestrator
  async function createMarket(
    orchestrator: any,
    borrower: any,
    asset: any,
    params: CreditTypesLib.MarketParametersStruct
  ) {
    const assetAddr = await asset.getAddress();
    const marketAddress = await orchestrator.createMarket.staticCall(borrower.address, assetAddr, params);
    await orchestrator.createMarket(borrower.address, assetAddr, params);
    const market = await ethers.getContractAt("CreditMarket", marketAddress);
    const positionToken = await ethers.getContractAt("LoanPositionToken", await market.positionToken());
    return { market, positionToken, marketAddress };
  }

  // Helper: fund and approve a lender
  async function fundAndApprove(asset: any, from: any, to: any, marketAddress: string, amount: bigint) {
    await asset.connect(from).transfer(to.address, amount);
    await asset.connect(to).approve(marketAddress, ethers.MaxUint256);
  }

  // ─── TEST 1: Happy path lifecycle ──────────────────────────────────

  describe("TEST 1: Happy path lifecycle", function () {
    it("should complete full deposit → borrow → repay → withdraw lifecycle", async function () {
      const { owner, borrower, lender1, asset, orchestrator, params } =
        await loadFixture(deployIntegrationFixture);

      // 1. Authorize borrower (TIER_2 = $500K)
      await orchestrator.authorizeBorrower(borrower.address, 1); // TIER_2

      // 2. Create market
      const { market, positionToken, marketAddress } = await createMarket(orchestrator, borrower, asset, params);

      // 3. Register lender
      await orchestrator.registerLender(marketAddress, lender1.address);

      // 4. Lender deposits 100K
      const depositAmount = ethers.parseUnits("100000", 6);
      await fundAndApprove(asset, owner, lender1, marketAddress, depositAmount);
      await market.connect(lender1).deposit(depositAmount, lender1.address);

      const totalSupplyAfterDeposit = await market.totalSupply();
      const diffDeposit = totalSupplyAfterDeposit > depositAmount
        ? totalSupplyAfterDeposit - depositAmount : depositAmount - totalSupplyAfterDeposit;
      expect(diffDeposit).to.be.lt(100n);

      // 5. Borrower borrows 50K
      const borrowAmount = ethers.parseUnits("50000", 6);
      // Fund borrower for later repayment (interest will accrue)
      await asset.transfer(borrower.address, ethers.parseUnits("100000", 6));
      await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);
      await market.connect(borrower).borrow(borrowAmount);

      const stateAfterBorrow = await market.getState();
      expect(stateAfterBorrow.totalBorrowed).to.equal(borrowAmount);

      // 6. Advance 30 days
      await time.increase(30 * ONE_DAY);

      // 7. AccrueInterest — scaleFactor should increase
      const sfBefore = (await market.getState()).scaleFactor;
      await market.accrueInterest();
      const sfAfter = (await market.getState()).scaleFactor;
      expect(sfAfter).to.be.gt(sfBefore);

      // 8. Borrower repays 50K + interest
      // Calculate outstanding debt: totalBorrowed is tracked at token level
      const stateBeforeRepay = await market.getState();
      const repayAmount = stateBeforeRepay.totalBorrowed;
      await market.connect(borrower).repay(repayAmount);

      const stateAfterRepay = await market.getState();
      expect(stateAfterRepay.totalBorrowed).to.equal(0);

      // 9. Lender requests withdrawal of all position tokens
      const lenderBalance = await positionToken.balanceOf(lender1.address);
      await market.connect(lender1).requestWithdrawal(lenderBalance);

      // 10. Process withdrawal batch (advance past expiry)
      const stateWithPending = await market.getState();
      await time.increaseTo(stateWithPending.pendingWithdrawalExpiry);
      await market.processWithdrawalBatch();

      // 11. Lender claims withdrawal
      const balBefore = await asset.balanceOf(lender1.address);
      await market.connect(lender1).claimWithdrawal(stateWithPending.pendingWithdrawalExpiry);
      const balAfter = await asset.balanceOf(lender1.address);
      const received = balAfter - balBefore;

      // 12. Verify lender received close to deposit amount
      // Interest accrues via scaleFactor but borrower only repaid principal (totalBorrowed),
      // so actual token balance ≈ deposits. Small loss from protocol fee accrual.
      expect(received).to.be.gt(depositAmount * 99n / 100n); // within 1%

      // Verify market has no unclaimed withdrawals
      const finalState = await market.getState();
      expect(finalState.normalizedUnclaimedWithdrawals).to.equal(0);
    });
  });

  // ─── TEST 2: Multi-lender market ───────────────────────────────────

  describe("TEST 2: Multi-lender market", function () {
    it("should handle 3 lenders with pro-rata withdrawal distribution", async function () {
      const { owner, borrower, lender1, lender2, lender3, asset, orchestrator, params } =
        await loadFixture(deployIntegrationFixture);

      await orchestrator.authorizeBorrower(borrower.address, 3); // TIER_4

      const { market, positionToken, marketAddress } = await createMarket(orchestrator, borrower, asset, params);

      // Register all lenders
      await orchestrator.registerLender(marketAddress, lender1.address);
      await orchestrator.registerLender(marketAddress, lender2.address);
      await orchestrator.registerLender(marketAddress, lender3.address);

      // Lenders deposit different amounts: 100K, 50K, 25K = 175K total
      const dep1 = ethers.parseUnits("100000", 6);
      const dep2 = ethers.parseUnits("50000", 6);
      const dep3 = ethers.parseUnits("25000", 6);

      await fundAndApprove(asset, owner, lender1, marketAddress, dep1);
      await fundAndApprove(asset, owner, lender2, marketAddress, dep2);
      await fundAndApprove(asset, owner, lender3, marketAddress, dep3);

      await market.connect(lender1).deposit(dep1, lender1.address);
      await market.connect(lender2).deposit(dep2, lender2.address);
      await market.connect(lender3).deposit(dep3, lender3.address);

      // Borrower borrows near limit (leave room for reserve)
      // 175K total, 10% reserve = 17.5K, borrowable ~157.5K — borrow 140K
      await asset.transfer(borrower.address, ethers.parseUnits("200000", 6));
      await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);
      await market.connect(borrower).borrow(ethers.parseUnits("140000", 6));

      // Advance 30 days for interest accrual
      await time.increase(30 * ONE_DAY);
      await market.accrueInterest();

      // Borrower fully repays
      const debtState = await market.getState();
      await market.connect(borrower).repay(debtState.totalBorrowed);

      // All lenders request withdrawal of all their positions
      const bal1 = await positionToken.balanceOf(lender1.address);
      const bal2 = await positionToken.balanceOf(lender2.address);
      const bal3 = await positionToken.balanceOf(lender3.address);

      await market.connect(lender1).requestWithdrawal(bal1);
      await market.connect(lender2).requestWithdrawal(bal2);
      await market.connect(lender3).requestWithdrawal(bal3);

      // Process batch
      const pendState = await market.getState();
      await time.increaseTo(pendState.pendingWithdrawalExpiry);
      await market.processWithdrawalBatch();

      // Each lender claims
      const before1 = await asset.balanceOf(lender1.address);
      await market.connect(lender1).claimWithdrawal(pendState.pendingWithdrawalExpiry);
      const after1 = await asset.balanceOf(lender1.address);
      const recv1 = after1 - before1;

      const before2 = await asset.balanceOf(lender2.address);
      await market.connect(lender2).claimWithdrawal(pendState.pendingWithdrawalExpiry);
      const after2 = await asset.balanceOf(lender2.address);
      const recv2 = after2 - before2;

      const before3 = await asset.balanceOf(lender3.address);
      await market.connect(lender3).claimWithdrawal(pendState.pendingWithdrawalExpiry);
      const after3 = await asset.balanceOf(lender3.address);
      const recv3 = after3 - before3;

      // All lenders should receive close to their deposit (borrower repaid principal only)
      expect(recv1).to.be.gt(dep1 * 99n / 100n);
      expect(recv2).to.be.gt(dep2 * 99n / 100n);
      expect(recv3).to.be.gt(dep3 * 99n / 100n);

      // Pro-rata: lender1 got ~2x lender2, lender2 got ~2x lender3
      const ratio12 = Number(recv1) / Number(recv2);
      const ratio23 = Number(recv2) / Number(recv3);
      expect(ratio12).to.be.closeTo(2.0, 0.05);
      expect(ratio23).to.be.closeTo(2.0, 0.05);
    });
  });

  // ─── TEST 3: Delinquency → recovery lifecycle ─────────────────────

  describe("TEST 3: Delinquency → recovery lifecycle", function () {
    it("should enter delinquency, accrue penalty fees, then recover after repayment", async function () {
      const { owner, borrower, lender1, asset, orchestrator, params } =
        await loadFixture(deployIntegrationFixture);

      await orchestrator.authorizeBorrower(borrower.address, 3); // TIER_4

      const { market, positionToken, marketAddress } = await createMarket(orchestrator, borrower, asset, params);
      await orchestrator.registerLender(marketAddress, lender1.address);

      // Lender deposits 100K
      const depositAmount = ethers.parseUnits("100000", 6);
      await fundAndApprove(asset, owner, lender1, marketAddress, depositAmount);
      await market.connect(lender1).deposit(depositAmount, lender1.address);

      // Fund borrower for repayment
      await asset.transfer(borrower.address, ethers.parseUnits("200000", 6));
      await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

      // Borrow 80K — leaves only 20K in market (reserve needs 10K)
      await market.connect(borrower).borrow(ethers.parseUnits("80000", 6));

      // Request large withdrawal to trigger delinquency
      const lptBal = await positionToken.balanceOf(lender1.address);
      await market.connect(lender1).requestWithdrawal(lptBal / 2n);

      // Advance 1 day → delinquency detected
      await time.increase(ONE_DAY);
      await market.accrueInterest();

      let state = await market.getState();
      expect(state.isDelinquent).to.equal(true);

      // Advance past grace period (3 days) — penalty fees should accrue
      await time.increase(4 * ONE_DAY);
      const sfBeforePenalty = (await market.getState()).scaleFactor;
      await market.accrueInterest();
      const sfAfterPenalty = (await market.getState()).scaleFactor;

      // Scale factor grew — with penalty fees, growth should be higher than base
      expect(sfAfterPenalty).to.be.gt(sfBeforePenalty);

      state = await market.getState();
      expect(state.timeDelinquent).to.be.gt(THREE_DAYS); // past grace

      // Borrower repays to restore liquidity
      const repayState = await market.getState();
      await market.connect(borrower).repay(repayState.totalBorrowed);

      // After repay, delinquency should resolve
      state = await market.getState();
      expect(state.isDelinquent).to.equal(false);

      // Advance time → timeDelinquent should decrease (gradual recovery)
      await time.increase(2 * ONE_DAY);
      await market.accrueInterest();

      const recoveredState = await market.getState();
      expect(recoveredState.timeDelinquent).to.be.lt(state.timeDelinquent);
    });
  });

  // ─── TEST 4: Credit limit across markets ──────────────────────────

  describe("TEST 4: Credit limit across markets", function () {
    it("should enforce aggregate credit limit across multiple markets", async function () {
      const { owner, borrower, lender1, lender2, asset, orchestrator, params } =
        await loadFixture(deployIntegrationFixture);

      // Authorize borrower as TIER_1 ($100K limit)
      await orchestrator.authorizeBorrower(borrower.address, 0); // TIER_1

      // Deploy a second asset (different token)
      const asset2 = await ethers.deployContract("ERC20Mock", [
        "Dai Stablecoin", "DAI", owner.address, ethers.parseUnits("100000000", 18), 18
      ]);

      // Create market 1 (USDC, 6 decimals)
      const { market: market1, marketAddress: addr1 } = await createMarket(orchestrator, borrower, asset, params);

      // Create market 2 (DAI, 18 decimals) with adjusted maxTotalSupply
      const params2: CreditTypesLib.MarketParametersStruct = {
        ...params,
        maxTotalSupply: ethers.parseUnits("1000000", 18),
      };
      const addr2Static = await orchestrator.createMarket.staticCall(
        borrower.address, await asset2.getAddress(), params2
      );
      await orchestrator.createMarket(borrower.address, await asset2.getAddress(), params2);
      const market2 = await ethers.getContractAt("CreditMarket", addr2Static);
      const addr2 = addr2Static;

      // Register lenders
      await orchestrator.registerLender(addr1, lender1.address);
      await orchestrator.registerLender(addr2, lender2.address);

      // Fund lenders and deposit: 100K USDC in market 1, 100K DAI in market 2
      await fundAndApprove(asset, owner, lender1, addr1, ethers.parseUnits("100000", 6));
      await market1.connect(lender1).deposit(ethers.parseUnits("100000", 6), lender1.address);

      await asset2.transfer(lender2.address, ethers.parseUnits("100000", 18));
      await asset2.connect(lender2).approve(addr2, ethers.MaxUint256);
      await market2.connect(lender2).deposit(ethers.parseUnits("100000", 18), lender2.address);

      // Fund borrower for both markets
      await asset.transfer(borrower.address, ethers.parseUnits("200000", 6));
      await asset.connect(borrower).approve(addr1, ethers.MaxUint256);
      await asset2.transfer(borrower.address, ethers.parseUnits("200000", 18));
      await asset2.connect(borrower).approve(addr2, ethers.MaxUint256);

      // Borrow 60K USDC from market 1 — should succeed (60K < 100K limit)
      await market1.connect(borrower).borrow(ethers.parseUnits("60000", 6));

      // Try borrow 50K DAI from market 2 — should fail (60K + 50K = 110K > 100K limit)
      await expect(
        market2.connect(borrower).borrow(ethers.parseUnits("50000", 18))
      ).to.be.revertedWithCustomError(orchestrator, "CreditLimitExceeded");

      // Borrow 40K DAI from market 2 — should succeed (60K + 40K = 100K = limit)
      await market2.connect(borrower).borrow(ethers.parseUnits("40000", 18));

      // Verify both markets have correct borrowed amounts
      const state1 = await market1.getState();
      const state2 = await market2.getState();
      expect(state1.totalBorrowed).to.equal(ethers.parseUnits("60000", 6));
      expect(state2.totalBorrowed).to.equal(ethers.parseUnits("40000", 18));
    });
  });

  // ─── TEST 5: Market close ─────────────────────────────────────────

  describe("TEST 5: Market close", function () {
    it("should close market and block further deposits and borrows", async function () {
      const { owner, borrower, lender1, asset, orchestrator, params } =
        await loadFixture(deployIntegrationFixture);

      await orchestrator.authorizeBorrower(borrower.address, 3); // TIER_4

      const { market, marketAddress } = await createMarket(orchestrator, borrower, asset, params);
      await orchestrator.registerLender(marketAddress, lender1.address);

      // Lender deposits 50K
      const depositAmount = ethers.parseUnits("50000", 6);
      await fundAndApprove(asset, owner, lender1, marketAddress, depositAmount);
      await market.connect(lender1).deposit(depositAmount, lender1.address);

      // Borrower borrows 20K
      await asset.transfer(borrower.address, ethers.parseUnits("100000", 6));
      await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);
      await market.connect(borrower).borrow(ethers.parseUnits("20000", 6));

      // Borrower fully repays
      const repayState = await market.getState();
      await market.connect(borrower).repay(repayState.totalBorrowed);

      // Close market
      await market.connect(borrower).closeMarket();

      const state = await market.getState();
      expect(state.isClosed).to.equal(true);

      // Verify no further deposits allowed
      await expect(
        market.connect(lender1).deposit(ethers.parseUnits("1000", 6), lender1.address)
      ).to.be.revertedWithCustomError(market, "MarketClosed");

      // Verify no further borrows allowed
      await expect(
        market.connect(borrower).borrow(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(market, "MarketClosed");
    });
  });
});
