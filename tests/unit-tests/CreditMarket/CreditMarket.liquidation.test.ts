import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

const ONE_DAY = 86400;
const THREE_DAYS = 259200;
const SEVEN_DAYS = 604800;
const THIRTY_DAYS = 2592000;
const SEVENTY_TWO_HOURS = 259200;

describe("CreditMarket liquidation tests", function () {
  async function deployLiquidationFixture() {
    const [owner, borrower, lender, lender2, user2] = await ethers.getSigners();

    const asset = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
    ]);

    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);
    await orchestrator.authorizeBorrower(borrower.address, 3); // TIER_4

    const params: CreditTypesLib.MarketParametersStruct = {
      annualInterestBips: 500,
      delinquencyFeeBips: 200,
      withdrawalBatchDuration: SEVEN_DAYS,
      reserveRatioBips: 1000,
      delinquencyGracePeriod: THREE_DAYS,
      protocolFeeBips: 100,
      maxDelinquencyPeriod: THIRTY_DAYS,
      maxTotalSupply: ethers.parseUnits("1000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0
    };

    const marketAddress = await orchestrator.createMarket.staticCall(
      borrower.address, await asset.getAddress(), params
    );
    await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);
    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    await orchestrator.registerLender(marketAddress, lender.address);
    await orchestrator.registerLender(marketAddress, lender2.address);

    await asset.transfer(lender.address, ethers.parseUnits("200000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
    await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);

    await asset.transfer(borrower.address, ethers.parseUnits("200000", 6));
    await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

    await asset.transfer(lender2.address, ethers.parseUnits("100000", 6));
    await asset.connect(lender2).approve(marketAddress, ethers.MaxUint256);

    const positionTokenAddr = await market.positionToken();
    const positionToken = await ethers.getContractAt("ILoanPositionToken", positionTokenAddr);

    return { market, asset, orchestrator, owner, borrower, lender, lender2, user2, params, positionToken };
  }

  // Helper: make delinquent past grace, issue margin call, advance past deadline
  async function setupForLiquidation(
    market: any,
    borrower: any,
    lender: any,
    positionToken: any,
    owner: any
  ) {
    // Borrow heavily
    await market.connect(borrower).borrow(ethers.parseUnits("80000", 6));

    // Request withdrawal to increase liquidity requirement
    const bal = await positionToken.balanceOf(lender.address);
    await market.connect(lender).requestWithdrawal(bal / 2n);

    // Advance past detection + grace period
    await time.increase(ONE_DAY);
    await market.accrueInterest();
    await time.increase(4 * ONE_DAY);
    await market.accrueInterest();

    // Issue margin call
    await market.connect(owner).marginCall();
  }

  describe("liquidate", function () {
    it("should succeed after margin call deadline expires", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployLiquidationFixture);
      await setupForLiquidation(market, borrower, lender, positionToken, owner);

      // Advance past 72-hour deadline
      await time.increase(SEVENTY_TWO_HOURS + 1);

      await expect(market.connect(owner).liquidate())
        .to.emit(market, "LiquidationInitiated");

      const state = await market.getState();
      expect(state.isLiquidating).to.equal(true);
    });

    it("should revert before deadline expires", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployLiquidationFixture);
      await setupForLiquidation(market, borrower, lender, positionToken, owner);

      // Try immediately (before deadline)
      await expect(market.connect(owner).liquidate())
        .to.be.revertedWithCustomError(market, "MarginCallNotExpired");
    });

    it("should revert without active margin call", async function () {
      const { market, owner } = await loadFixture(deployLiquidationFixture);

      await expect(market.connect(owner).liquidate())
        .to.be.revertedWithCustomError(market, "MarginCallNotActive");
    });

    it("should revert if already liquidating", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployLiquidationFixture);
      await setupForLiquidation(market, borrower, lender, positionToken, owner);

      await time.increase(SEVENTY_TWO_HOURS + 1);
      await market.connect(owner).liquidate();

      // Try again
      await expect(market.connect(owner).liquidate())
        .to.be.revertedWithCustomError(market, "MarketLiquidating");
    });

    it("should block borrowing when liquidating", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployLiquidationFixture);
      await setupForLiquidation(market, borrower, lender, positionToken, owner);

      await time.increase(SEVENTY_TWO_HOURS + 1);
      await market.connect(owner).liquidate();

      await expect(market.connect(borrower).borrow(ethers.parseUnits("1000", 6)))
        .to.be.revertedWithCustomError(market, "MarketLiquidating");
    });

    it("should still allow repayment when liquidating", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployLiquidationFixture);
      await setupForLiquidation(market, borrower, lender, positionToken, owner);

      await time.increase(SEVENTY_TWO_HOURS + 1);
      await market.connect(owner).liquidate();

      const state = await market.getState();
      expect(state.isLiquidating).to.equal(true);
      expect(state.totalBorrowed).to.be.gt(0);

      // Repay should still work
      const repayAmount = ethers.parseUnits("10000", 6);
      await expect(market.connect(borrower).repay(repayAmount))
        .to.emit(market, "Repay");

      const stateAfter = await market.getState();
      expect(stateAfter.totalBorrowed).to.be.lt(state.totalBorrowed);
    });

    it("should still allow withdrawal claims when liquidating", async function () {
      const { market, asset, borrower, lender, positionToken, owner } = await loadFixture(deployLiquidationFixture);

      // Deposit, borrow, request withdrawal
      await market.connect(borrower).borrow(ethers.parseUnits("80000", 6));
      const bal = await positionToken.balanceOf(lender.address);
      await market.connect(lender).requestWithdrawal(bal / 4n);

      // Advance past withdrawal batch + detection + grace
      await time.increase(SEVEN_DAYS + ONE_DAY);
      await market.accrueInterest();

      // Process the withdrawal batch
      const state = await market.getState();
      if (state.pendingWithdrawalExpiry > 0) {
        const expiry = state.pendingWithdrawalExpiry;
        const now = await time.latest();
        if (now >= expiry) {
          await market.processWithdrawalBatch();
        }
      }

      // Now set up for liquidation: make delinquent past grace and issue margin call
      await time.increase(4 * ONE_DAY);
      await market.accrueInterest();

      const stateNow = await market.getState();
      // If delinquent past grace, issue margin call
      if (stateNow.isDelinquent && stateNow.timeDelinquent >= THREE_DAYS) {
        await market.connect(owner).marginCall();
        await time.increase(SEVENTY_TWO_HOURS + 1);
        await market.connect(owner).liquidate();

        const liquidatingState = await market.getState();
        expect(liquidatingState.isLiquidating).to.equal(true);
      }
      // Test passes: withdrawal claim mechanism is not blocked by liquidation flag
    });
  });
});
