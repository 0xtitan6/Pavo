import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

const ONE_DAY = 86400;
const THREE_DAYS = 259200;   // grace period
const SEVEN_DAYS = 604800;
const THIRTY_DAYS = 2592000;
const SEVENTY_TWO_HOURS = 259200; // cure period

describe("CreditMarket margin call tests", function () {
  async function deployMarginCallFixture() {
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
      reserveRatioBips: 1000,           // 10% reserve
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

    // Register lenders
    await orchestrator.registerLender(marketAddress, lender.address);
    await orchestrator.registerLender(marketAddress, lender2.address);

    // Fund lender and deposit 100k
    await asset.transfer(lender.address, ethers.parseUnits("200000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
    await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);

    // Fund borrower for repayments
    await asset.transfer(borrower.address, ethers.parseUnits("200000", 6));
    await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

    // Fund lender2
    await asset.transfer(lender2.address, ethers.parseUnits("100000", 6));
    await asset.connect(lender2).approve(marketAddress, ethers.MaxUint256);

    // Get position token
    const positionTokenAddr = await market.positionToken();
    const positionToken = await ethers.getContractAt("ILoanPositionToken", positionTokenAddr);

    return { market, asset, orchestrator, owner, borrower, lender, lender2, user2, params, positionToken };
  }

  // Helper: make market delinquent and advance past grace period
  async function makeDelinquentPastGrace(
    market: any,
    borrower: any,
    lender: any,
    positionToken: any
  ) {
    // Borrow 80% of deposits
    await market.connect(borrower).borrow(ethers.parseUnits("80000", 6));

    // Request withdrawal of half lender position -> increases liquidityRequired
    const bal = await positionToken.balanceOf(lender.address);
    await market.connect(lender).requestWithdrawal(bal / 2n);

    // Advance 1 day so accrual detects delinquency
    await time.increase(ONE_DAY);
    await market.accrueInterest();
    // Now: isDelinquent=true, timeDelinquent=0

    // Advance past grace period (3 days) + 1 day buffer
    // Need timeDelinquent >= grace period, so advance 4 more days
    await time.increase(4 * ONE_DAY);
    await market.accrueInterest();
    // Now: isDelinquent=true, timeDelinquent >= 4 days > 3-day grace
  }

  // Helper: just make delinquent (within grace period)
  async function makeDelinquent(
    market: any,
    borrower: any,
    lender: any,
    positionToken: any
  ) {
    await market.connect(borrower).borrow(ethers.parseUnits("80000", 6));
    const bal = await positionToken.balanceOf(lender.address);
    await market.connect(lender).requestWithdrawal(bal / 2n);
    await time.increase(ONE_DAY);
    await market.accrueInterest();
    // isDelinquent=true, timeDelinquent=0
  }

  describe("marginCall", function () {
    it("should succeed when delinquent past grace period", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployMarginCallFixture);
      await makeDelinquentPastGrace(market, borrower, lender, positionToken);

      const state = await market.getState();
      expect(state.isDelinquent).to.equal(true);
      expect(state.timeDelinquent).to.be.gte(THREE_DAYS);

      await expect(market.connect(owner).marginCall())
        .to.emit(market, "MarginCallIssued");

      const stateAfter = await market.getState();
      expect(stateAfter.marginCallTimestamp).to.be.gt(0);
      expect(stateAfter.marginCallDeadline).to.be.gt(stateAfter.marginCallTimestamp);
    });

    it("should revert when not delinquent", async function () {
      const { market, owner } = await loadFixture(deployMarginCallFixture);

      await expect(market.connect(owner).marginCall())
        .to.be.revertedWithCustomError(market, "NotDelinquent");
    });

    it("should revert when delinquent but within grace period", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployMarginCallFixture);
      await makeDelinquent(market, borrower, lender, positionToken);

      // timeDelinquent=0, within grace period
      const state = await market.getState();
      expect(state.isDelinquent).to.equal(true);
      expect(state.timeDelinquent).to.be.lt(THREE_DAYS);

      await expect(market.connect(owner).marginCall())
        .to.be.revertedWithCustomError(market, "NotDelinquent");
    });

    it("should revert when already liquidating", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployMarginCallFixture);
      await makeDelinquentPastGrace(market, borrower, lender, positionToken);

      // Issue margin call
      await market.connect(owner).marginCall();

      // Advance past deadline
      await time.increase(SEVENTY_TWO_HOURS + 1);

      // Liquidate
      await market.connect(owner).liquidate();

      // Try to issue another margin call
      await expect(market.connect(owner).marginCall())
        .to.be.revertedWithCustomError(market, "MarketLiquidating");
    });

    it("should emit MarginCallIssued with correct deadline", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployMarginCallFixture);
      await makeDelinquentPastGrace(market, borrower, lender, positionToken);

      const tx = await market.connect(owner).marginCall();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const stateAfter = await market.getState();
      expect(stateAfter.marginCallDeadline).to.equal(block!.timestamp + SEVENTY_TWO_HOURS);
    });
  });

  describe("cure", function () {
    it("should succeed when borrower restores health", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployMarginCallFixture);
      await makeDelinquentPastGrace(market, borrower, lender, positionToken);

      // Issue margin call
      await market.connect(owner).marginCall();

      const stateBefore = await market.getState();
      expect(stateBefore.marginCallTimestamp).to.be.gt(0);

      // Borrower repays debt to resolve delinquency
      await market.connect(borrower).repay(stateBefore.totalBorrowed);

      // Verify no longer delinquent
      const stateAfterRepay = await market.getState();
      expect(stateAfterRepay.isDelinquent).to.equal(false);

      // Cure
      await expect(market.connect(borrower).cure())
        .to.emit(market, "MarginCallCured");

      const stateAfterCure = await market.getState();
      expect(stateAfterCure.marginCallTimestamp).to.equal(0);
      expect(stateAfterCure.marginCallDeadline).to.equal(0);
    });

    it("should revert when no margin call active", async function () {
      const { market, borrower } = await loadFixture(deployMarginCallFixture);

      await expect(market.connect(borrower).cure())
        .to.be.revertedWithCustomError(market, "MarginCallNotActive");
    });

    it("should revert when still delinquent", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployMarginCallFixture);
      await makeDelinquentPastGrace(market, borrower, lender, positionToken);

      // Issue margin call
      await market.connect(owner).marginCall();

      // Try cure without repaying (still delinquent)
      await expect(market.connect(borrower).cure())
        .to.be.revertedWithCustomError(market, "NotDelinquent");
    });

    it("should only be callable by borrower", async function () {
      const { market, borrower, lender, positionToken, owner } = await loadFixture(deployMarginCallFixture);
      await makeDelinquentPastGrace(market, borrower, lender, positionToken);

      await market.connect(owner).marginCall();

      // Repay debt to resolve delinquency
      const state = await market.getState();
      await market.connect(borrower).repay(state.totalBorrowed);

      // Non-borrower tries to cure
      await expect(market.connect(owner).cure())
        .to.be.revertedWithCustomError(market, "UnauthorizedBorrower");

      await expect(market.connect(lender).cure())
        .to.be.revertedWithCustomError(market, "UnauthorizedBorrower");
    });
  });
});
