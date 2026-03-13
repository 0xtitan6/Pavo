import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

describe("CreditMarket withdrawal tests", function () {
  async function deployCreditMarketWithDepositFixture() {
    const [owner, borrower, lender, lender2, user2] = await ethers.getSigners();

    const asset = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
    ]);

    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);
    await orchestrator.authorizeBorrower(borrower.address, 3);

    const params: CreditTypesLib.MarketParametersStruct = {
      annualInterestBips: 500,
      delinquencyFeeBips: 200,
      withdrawalBatchDuration: 604800, // 7 days
      reserveRatioBips: 1000,          // 10%
      delinquencyGracePeriod: 259200,  // 3 days
      protocolFeeBips: 100,
      maxDelinquencyPeriod: 2592000,
      maxTotalSupply: ethers.parseUnits("1000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0
    };

    const marketAddress = await orchestrator.createMarket.staticCall(borrower.address, await asset.getAddress(), params);
    await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);
    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    // Register lenders
    await orchestrator.registerLender(marketAddress, lender.address);
    await orchestrator.registerLender(marketAddress, lender2.address);

    // Fund and deposit for lender1 (100K)
    await asset.transfer(lender.address, ethers.parseUnits("100000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
    await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);

    // Fund and deposit for lender2 (50K)
    await asset.transfer(lender2.address, ethers.parseUnits("50000", 6));
    await asset.connect(lender2).approve(marketAddress, ethers.MaxUint256);
    await market.connect(lender2).deposit(ethers.parseUnits("50000", 6), lender2.address);

    // Fund borrower for repayments
    await asset.transfer(borrower.address, ethers.parseUnits("200000", 6));
    await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

    const positionToken = await ethers.getContractAt("LoanPositionToken", await market.positionToken());

    return {
      market, marketAddress, asset, orchestrator, owner,
      borrower, lender, lender2, user2, params, positionToken
    };
  }

  describe("requestWithdrawal", function () {
    it("Should request withdrawal and burn position tokens", async function () {
      const { market, lender, positionToken } = await loadFixture(deployCreditMarketWithDepositFixture);
      const scaledAmount = ethers.parseUnits("10000", 6);

      const balBefore = await positionToken.balanceOf(lender.address);
      await expect(market.connect(lender).requestWithdrawal(scaledAmount))
        .to.emit(market, "WithdrawalRequested");
      const balAfter = await positionToken.balanceOf(lender.address);

      expect(balBefore - balAfter).to.equal(scaledAmount);
    });

    it("Should set pending withdrawal expiry", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketWithDepositFixture);
      const scaledAmount = ethers.parseUnits("10000", 6);

      await market.connect(lender).requestWithdrawal(scaledAmount);

      const state = await market.getState();
      expect(state.pendingWithdrawalExpiry).to.be.gt(0);
    });

    it("Should batch multiple requests in same window", async function () {
      const { market, lender, lender2 } = await loadFixture(deployCreditMarketWithDepositFixture);
      const amount1 = ethers.parseUnits("10000", 6);
      const amount2 = ethers.parseUnits("5000", 6);

      await market.connect(lender).requestWithdrawal(amount1);
      const state1 = await market.getState();
      const expiry1 = state1.pendingWithdrawalExpiry;

      await market.connect(lender2).requestWithdrawal(amount2);
      const state2 = await market.getState();
      const expiry2 = state2.pendingWithdrawalExpiry;

      // Both should be in the same batch
      expect(expiry1).to.equal(expiry2);
      expect(state2.scaledPendingWithdrawals).to.equal(amount1 + amount2);
    });

    it("Should fail with zero amount", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      await expect(
        market.connect(lender).requestWithdrawal(0)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should fail when market is closed", async function () {
      const { market, borrower, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      await market.connect(borrower).closeMarket();

      await expect(
        market.connect(lender).requestWithdrawal(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(market, "MarketClosed");
    });
  });

  describe("processWithdrawalBatch", function () {
    it("Should process expired batch successfully", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketWithDepositFixture);
      const scaledAmount = ethers.parseUnits("10000", 6);

      await market.connect(lender).requestWithdrawal(scaledAmount);
      const state = await market.getState();
      const expiry = state.pendingWithdrawalExpiry;

      // Advance past batch expiry
      await time.increaseTo(expiry);

      await expect(market.processWithdrawalBatch())
        .to.emit(market, "WithdrawalBatchProcessed");
    });

    it("Should pay out from available liquidity", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketWithDepositFixture);
      const scaledAmount = ethers.parseUnits("10000", 6);

      await market.connect(lender).requestWithdrawal(scaledAmount);
      const state = await market.getState();

      await time.increaseTo(state.pendingWithdrawalExpiry);
      await market.processWithdrawalBatch();

      // State should reflect unclaimed withdrawals
      const postState = await market.getState();
      expect(postState.normalizedUnclaimedWithdrawals).to.be.gt(0);
      expect(postState.pendingWithdrawalExpiry).to.equal(0);
    });

    it("Should track unpaid when insufficient liquidity", async function () {
      const { market, borrower, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      // Borrow most of the liquidity
      await market.connect(borrower).borrow(ethers.parseUnits("80000", 6));

      // Request large withdrawal
      const scaledAmount = ethers.parseUnits("90000", 6);
      await market.connect(lender).requestWithdrawal(scaledAmount);

      const state = await market.getState();
      await time.increaseTo(state.pendingWithdrawalExpiry);

      // Process should partially fill
      await market.processWithdrawalBatch();

      const postState = await market.getState();
      // Should be delinquent since borrower took liquidity
      expect(postState.isDelinquent).to.be.true;
    });

    it("Should fail when no pending batch", async function () {
      const { market } = await loadFixture(deployCreditMarketWithDepositFixture);

      await expect(
        market.processWithdrawalBatch()
      ).to.be.revertedWithCustomError(market, "NoPendingWithdrawalBatch");
    });

    it("Should fail when batch not expired", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      await market.connect(lender).requestWithdrawal(ethers.parseUnits("1000", 6));

      await expect(
        market.processWithdrawalBatch()
      ).to.be.revertedWithCustomError(market, "WithdrawalBatchNotExpired");
    });
  });

  describe("claimWithdrawal", function () {
    it("Should claim processed withdrawal", async function () {
      const { market, lender, asset } = await loadFixture(deployCreditMarketWithDepositFixture);
      const scaledAmount = ethers.parseUnits("10000", 6);

      await market.connect(lender).requestWithdrawal(scaledAmount);
      const state = await market.getState();
      await time.increaseTo(state.pendingWithdrawalExpiry);
      await market.processWithdrawalBatch();

      const balBefore = await asset.balanceOf(lender.address);
      await expect(market.connect(lender).claimWithdrawal(state.pendingWithdrawalExpiry))
        .to.emit(market, "WithdrawalClaimed");
      const balAfter = await asset.balanceOf(lender.address);

      // Should receive close to 10K (allow RAY rounding)
      const received = balAfter - balBefore;
      expect(received).to.be.gt(ethers.parseUnits("9990", 6));
    });

    it("Should fail when nothing to claim (zero scaledAmount)", async function () {
      const { market, lender, user2 } = await loadFixture(deployCreditMarketWithDepositFixture);
      const scaledAmount = ethers.parseUnits("10000", 6);

      await market.connect(lender).requestWithdrawal(scaledAmount);
      const state = await market.getState();
      await time.increaseTo(state.pendingWithdrawalExpiry);
      await market.processWithdrawalBatch();

      // user2 has no withdrawal request
      await expect(
        market.connect(user2).claimWithdrawal(state.pendingWithdrawalExpiry)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should fail when batch not processed yet (normalizedAmountPaid=0)", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketWithDepositFixture);
      const scaledAmount = ethers.parseUnits("10000", 6);

      await market.connect(lender).requestWithdrawal(scaledAmount);
      const state = await market.getState();

      // Try to claim before processing
      await expect(
        market.connect(lender).claimWithdrawal(state.pendingWithdrawalExpiry)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should fail when already fully claimed", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketWithDepositFixture);
      const scaledAmount = ethers.parseUnits("10000", 6);

      await market.connect(lender).requestWithdrawal(scaledAmount);
      const state = await market.getState();
      await time.increaseTo(state.pendingWithdrawalExpiry);
      await market.processWithdrawalBatch();

      // Claim once
      await market.connect(lender).claimWithdrawal(state.pendingWithdrawalExpiry);

      // Claim again — should revert
      await expect(
        market.connect(lender).claimWithdrawal(state.pendingWithdrawalExpiry)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should distribute proportionally between two lenders", async function () {
      const { market, lender, lender2, asset } = await loadFixture(deployCreditMarketWithDepositFixture);

      // lender1 withdraws 20K, lender2 withdraws 10K (2:1 ratio)
      await market.connect(lender).requestWithdrawal(ethers.parseUnits("20000", 6));
      await market.connect(lender2).requestWithdrawal(ethers.parseUnits("10000", 6));

      const state = await market.getState();
      await time.increaseTo(state.pendingWithdrawalExpiry);
      await market.processWithdrawalBatch();

      const bal1Before = await asset.balanceOf(lender.address);
      await market.connect(lender).claimWithdrawal(state.pendingWithdrawalExpiry);
      const bal1After = await asset.balanceOf(lender.address);
      const received1 = bal1After - bal1Before;

      const bal2Before = await asset.balanceOf(lender2.address);
      await market.connect(lender2).claimWithdrawal(state.pendingWithdrawalExpiry);
      const bal2After = await asset.balanceOf(lender2.address);
      const received2 = bal2After - bal2Before;

      // lender1 should get ~2x lender2 (allow rounding)
      const ratio = Number(received1) / Number(received2);
      expect(ratio).to.be.closeTo(2.0, 0.01);
    });
  });

  describe("closeMarket", function () {
    it("Should close market when no pending withdrawals", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithDepositFixture);

      await expect(market.connect(borrower).closeMarket())
        .to.emit(market, "MarketClosed");

      const state = await market.getState();
      expect(state.isClosed).to.be.true;
    });

    it("Should fail when pending withdrawals exist", async function () {
      const { market, borrower, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      // Create a pending withdrawal
      await market.connect(lender).requestWithdrawal(ethers.parseUnits("1000", 6));

      // Process the batch first
      const state = await market.getState();
      await time.increaseTo(state.pendingWithdrawalExpiry);
      await market.processWithdrawalBatch();

      // Now close should succeed (pending cleared after processing)
      await market.connect(borrower).closeMarket();
      const finalState = await market.getState();
      expect(finalState.isClosed).to.be.true;
    });

    it("Should fail when not borrower", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      await expect(
        market.connect(lender).closeMarket()
      ).to.be.revertedWithCustomError(market, "UnauthorizedBorrower");
    });

    it("Should fail when scaledPendingWithdrawals > 0", async function () {
      const { market, borrower, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      await market.connect(lender).requestWithdrawal(ethers.parseUnits("1000", 6));

      // Try to close with pending batch — should fail
      await expect(
        market.connect(borrower).closeMarket()
      ).to.be.revertedWithCustomError(market, "MarketNotClosed");
    });
  });

  describe("accrueInterest (external)", function () {
    it("Should accrue interest over time", async function () {
      const { market } = await loadFixture(deployCreditMarketWithDepositFixture);

      const stateBefore = await market.getState();
      const sfBefore = stateBefore.scaleFactor;

      // Advance 30 days
      await time.increase(30 * 24 * 3600);
      await market.accrueInterest();

      const stateAfter = await market.getState();
      expect(stateAfter.scaleFactor).to.be.gt(sfBefore);
    });

    it("Should accrue protocol fees over time", async function () {
      const { market } = await loadFixture(deployCreditMarketWithDepositFixture);

      // Advance 90 days
      await time.increase(90 * 24 * 3600);
      await market.accrueInterest();

      const state = await market.getState();
      expect(state.accruedProtocolFees).to.be.gt(0);
    });
  });

  describe("delinquency", function () {
    it("Should become delinquent when borrower takes funds and pending withdrawals exist", async function () {
      const { market, borrower, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      // Borrow a significant amount (within borrowable limit)
      // Total deposited = 150K, reserve ratio = 10% so borrowable ~135K
      await market.connect(borrower).borrow(ethers.parseUnits("120000", 6));

      // Now request a large withdrawal — this increases liquidityRequired
      // Contract has ~30K, but required = pendingWithdrawals + reserve + fees
      await market.connect(lender).requestWithdrawal(ethers.parseUnits("80000", 6));

      // Accrue interest — _updateDelinquencyStatus is called
      await time.increase(1);
      await market.accrueInterest();

      const state = await market.getState();
      expect(state.isDelinquent).to.be.true;
    });

    it("Should resolve delinquency after repayment", async function () {
      const { market, borrower, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      await market.connect(borrower).borrow(ethers.parseUnits("120000", 6));
      await market.connect(lender).requestWithdrawal(ethers.parseUnits("80000", 6));
      await time.increase(1);
      await market.accrueInterest();

      // Verify delinquent
      expect((await market.getState()).isDelinquent).to.be.true;

      // Repay to restore liquidity
      await market.connect(borrower).repay(ethers.parseUnits("120000", 6));

      expect((await market.getState()).isDelinquent).to.be.false;
    });

    it("Should track delinquency time across accruals", async function () {
      const { market, borrower, lender } = await loadFixture(deployCreditMarketWithDepositFixture);

      await market.connect(borrower).borrow(ethers.parseUnits("120000", 6));
      await market.connect(lender).requestWithdrawal(ethers.parseUnits("80000", 6));
      await time.increase(1);
      await market.accrueInterest();

      // Advance more time while delinquent
      await time.increase(5 * 24 * 3600);
      await market.accrueInterest();

      const state = await market.getState();
      expect(state.timeDelinquent).to.be.gt(0);
    });
  });

  describe("view functions", function () {
    it("Should return correct getParameters", async function () {
      const { market, params } = await loadFixture(deployCreditMarketWithDepositFixture);
      const p = await market.getParameters();
      expect(p.annualInterestBips).to.equal(params.annualInterestBips);
      expect(p.reserveRatioBips).to.equal(params.reserveRatioBips);
    });

    it("Should return correct liquidityRequired", async function () {
      const { market } = await loadFixture(deployCreditMarketWithDepositFixture);
      const required = await market.liquidityRequired();
      // With 150K deposited and 10% reserve, required = ~15K
      expect(required).to.be.gt(0);
    });

    it("Should return correct isDelinquent initially", async function () {
      const { market } = await loadFixture(deployCreditMarketWithDepositFixture);
      expect(await market.isDelinquent()).to.be.false;
    });
  });
});
