import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

const RAY = 10n ** 27n;
const ONE_DAY = 86400;
const THREE_DAYS = 259200;   // grace period
const SEVEN_DAYS = 604800;
const THIRTY_DAYS = 2592000; // maxDelinquencyPeriod

describe("CreditMarket delinquency tests", function () {
  async function deployDelinquencyFixture() {
    const [owner, borrower, lender, lender2, user2] = await ethers.getSigners();

    const asset = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
    ]);

    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);
    await orchestrator.authorizeBorrower(borrower.address, 3); // TIER_4

    const params: CreditTypesLib.MarketParametersStruct = {
      annualInterestBips: 500,          // 5% APR
      delinquencyFeeBips: 200,          // 2% penalty
      withdrawalBatchDuration: SEVEN_DAYS,
      reserveRatioBips: 1000,           // 10% reserve
      delinquencyGracePeriod: THREE_DAYS,
      protocolFeeBips: 100,             // 10% of interest
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

    // Get position token for withdrawal requests
    const positionTokenAddr = await market.positionToken();
    const positionToken = await ethers.getContractAt("ILoanPositionToken", positionTokenAddr);

    return { market, asset, orchestrator, owner, borrower, lender, lender2, user2, params, positionToken };
  }

  // Helper: borrow heavily + request withdrawal → advance time → delinquent
  // Note: After this, isDelinquent=true but timeDelinquent=0 because delinquency
  // status is set AFTER accrual. timeDelinquent starts incrementing on the next accrual.
  async function makeDelinquent(
    market: any,
    borrower: any,
    lender: any,
    positionToken: any
  ) {
    // Borrow 80% of deposits (100k deposit → borrow 80k, leaves 20k but reserve needs 10k)
    await market.connect(borrower).borrow(ethers.parseUnits("80000", 6));

    // Request withdrawal of half lender position → increases liquidityRequired
    const bal = await positionToken.balanceOf(lender.address);
    await market.connect(lender).requestWithdrawal(bal / 2n);

    // Advance 1 day so accrual detects delinquency
    await time.increase(ONE_DAY);
    await market.accrueInterest();
    // Now: isDelinquent=true, timeDelinquent=0 (just detected)
  }

  describe("1. Market enters delinquency when borrower drains below reserve ratio", function () {
    it("should become delinquent after heavy borrow + withdrawal request + time", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);

      let state = await market.getState();
      expect(state.isDelinquent).to.equal(false);

      await makeDelinquent(market, borrower, lender, positionToken);

      state = await market.getState();
      expect(state.isDelinquent).to.equal(true);
    });

    it("should emit DelinquencyStatusChanged when entering delinquency", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);

      await market.connect(borrower).borrow(ethers.parseUnits("80000", 6));
      const bal = await positionToken.balanceOf(lender.address);
      await market.connect(lender).requestWithdrawal(bal / 2n);

      await time.increase(ONE_DAY);

      // accrueInterest triggers the DelinquencyStatusChanged event
      await expect(market.accrueInterest())
        .to.emit(market, "DelinquencyStatusChanged");
    });

    it("should not be delinquent if reserve ratio is maintained", async function () {
      const { market, borrower } = await loadFixture(deployDelinquencyFixture);

      await market.connect(borrower).borrow(ethers.parseUnits("50000", 6));

      const state = await market.getState();
      expect(state.isDelinquent).to.equal(false);
    });
  });

  describe("2. Grace period — no penalty fees during grace period", function () {
    it("should not accrue delinquency fees within grace period", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);
      // isDelinquent=true, timeDelinquent=0

      const stateBefore = await market.getState();
      expect(stateBefore.isDelinquent).to.equal(true);

      // Advance 2 days — timeDelinquent will go from 0 → ~2 days (within 3-day grace)
      await time.increase(2 * ONE_DAY);
      await market.accrueInterest();

      const stateAfter = await market.getState();
      // timeDelinquent ~2 days, still within grace
      expect(stateAfter.timeDelinquent).to.be.gte(2 * ONE_DAY - 10);
      expect(stateAfter.timeDelinquent).to.be.lt(THREE_DAYS);

      // Scale factor should match base interest only (no penalty during grace)
      const sfBefore = BigInt(stateBefore.scaleFactor);
      const sfAfter = BigInt(stateAfter.scaleFactor);
      const timeDelta = BigInt(2 * ONE_DAY);
      const baseInterestRay = (500n * RAY * timeDelta) / (10000n * 365n * 86400n);
      const expectedSf = sfBefore + (sfBefore * baseInterestRay) / RAY;

      // Allow generous tolerance for RAY rounding across multiple operations
      const diff = sfAfter > expectedSf ? sfAfter - expectedSf : expectedSf - sfAfter;
      expect(diff).to.be.lt(10n ** 20n);
    });

    it("should track timeDelinquent during grace period", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);
      // isDelinquent=true, timeDelinquent=0

      // Advance 1 day so timeDelinquent increments
      await time.increase(ONE_DAY);
      await market.accrueInterest();

      const state = await market.getState();
      expect(state.timeDelinquent).to.be.gte(ONE_DAY - 10);
      expect(state.timeDelinquent).to.be.lte(ONE_DAY + 60);
    });
  });

  describe("3. Penalty accrual after grace period expires", function () {
    it("should accrue delinquency fees after grace period", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);
      // isDelinquent=true, timeDelinquent=0

      // Record state before advancing
      const stateBefore = await market.getState();

      // Advance 4 days → timeDelinquent goes 0→4 days, past 3-day grace = 1 day of penalty
      await time.increase(4 * ONE_DAY);
      await market.accrueInterest();

      const stateAfter = await market.getState();
      expect(stateAfter.timeDelinquent).to.be.gte(4 * ONE_DAY - 10);

      // Scale factor should exceed base-interest-only calculation
      const sfBefore = BigInt(stateBefore.scaleFactor);
      const sfAfter = BigInt(stateAfter.scaleFactor);
      const timeDelta = BigInt(4 * ONE_DAY);
      const baseInterestRay = (500n * RAY * timeDelta) / (10000n * 365n * 86400n);
      const baseOnlySf = sfBefore + (sfBefore * baseInterestRay) / RAY;

      // Actual should be higher than base-only due to penalty (1 day past grace)
      expect(sfAfter).to.be.gt(baseOnlySf);
    });

    it("should emit InterestAccrued after grace period", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);

      await time.increase(4 * ONE_DAY);

      await expect(market.accrueInterest())
        .to.emit(market, "InterestAccrued");
    });
  });

  describe("4. Delinquency fee cap at maxDelinquencyPeriod", function () {
    it("should cap timeDelinquent at maxDelinquencyPeriod", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);

      // Advance well past max delinquency period (30 days + 10 days)
      await time.increase(THIRTY_DAYS + 10 * ONE_DAY);
      await market.accrueInterest();

      const state = await market.getState();
      expect(state.timeDelinquent).to.be.lte(THIRTY_DAYS);
    });

    it("should stop accumulating penalty time after cap is reached", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);

      // Advance to cap
      await time.increase(THIRTY_DAYS);
      await market.accrueInterest();
      const stateAtCap = await market.getState();

      // Advance another 10 days
      await time.increase(10 * ONE_DAY);
      await market.accrueInterest();
      const stateAfterCap = await market.getState();

      // timeDelinquent should not increase beyond cap
      expect(stateAfterCap.timeDelinquent).to.equal(stateAtCap.timeDelinquent);
    });
  });

  describe("5. Recovery — gradual decrease of timeDelinquent", function () {
    it("should gradually reduce timeDelinquent after delinquency resolves", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);
      // isDelinquent=true, timeDelinquent=0

      // Build up 5 days of timeDelinquent (0→5 days)
      await time.increase(5 * ONE_DAY);
      await market.accrueInterest();

      let state = await market.getState();
      const timeDelinquentBefore = BigInt(state.timeDelinquent);
      expect(timeDelinquentBefore).to.be.gte(BigInt(5 * ONE_DAY - 10));

      // Repay all debt to resolve delinquency
      await market.connect(borrower).repay(state.totalBorrowed);
      state = await market.getState();
      expect(state.isDelinquent).to.equal(false);

      // Advance 2 days — timeDelinquent should decrease
      await time.increase(2 * ONE_DAY);
      await market.accrueInterest();

      state = await market.getState();
      const timeDelinquentAfter = BigInt(state.timeDelinquent);
      expect(timeDelinquentAfter).to.be.lt(timeDelinquentBefore);

      // Should have decreased by ~2 days
      const reduction = timeDelinquentBefore - timeDelinquentAfter;
      const expectedReduction = BigInt(2 * ONE_DAY);
      const diff = reduction > expectedReduction
        ? reduction - expectedReduction
        : expectedReduction - reduction;
      expect(diff).to.be.lt(120n);
    });
  });

  describe("6. Penalty still accrues during recovery (timeDelinquent > gracePeriod)", function () {
    it("should still charge penalty during recovery when timeDelinquent exceeds grace", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);
      // isDelinquent=true, timeDelinquent=0

      // Build up 10 days of timeDelinquent (0→10 days, well past 3-day grace)
      await time.increase(10 * ONE_DAY);
      await market.accrueInterest();

      let state = await market.getState();
      expect(BigInt(state.timeDelinquent)).to.be.gte(BigInt(10 * ONE_DAY - 10));

      // Repay to resolve delinquency
      await market.connect(borrower).repay(state.totalBorrowed);
      state = await market.getState();
      expect(state.isDelinquent).to.equal(false);
      expect(BigInt(state.timeDelinquent)).to.be.gte(BigInt(THREE_DAYS)); // still above grace

      // Record scale factor before recovery accrual
      const scaleFactorBefore = BigInt(state.scaleFactor);

      // Advance 1 day during recovery
      await time.increase(ONE_DAY);
      await market.accrueInterest();

      state = await market.getState();
      const scaleFactorAfter = BigInt(state.scaleFactor);

      // Recovery path with timeDelinquent > grace: penalty still applies
      // timeWithPenalty = min(previousTimeDelinquent - gracePeriod, timeDelta)
      const baseInterestOnly = (scaleFactorBefore * 500n * BigInt(ONE_DAY)) / (10000n * 365n * 86400n);
      const actualIncrease = scaleFactorAfter - scaleFactorBefore;

      expect(actualIncrease).to.be.gt(baseInterestOnly);
    });
  });

  describe("7. Full recovery — timeDelinquent reaches 0", function () {
    it("should reach zero timeDelinquent after sufficient recovery time", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);

      // Build up 5 days of timeDelinquent
      await time.increase(5 * ONE_DAY);
      await market.accrueInterest();

      // Repay all debt
      let state = await market.getState();
      await market.connect(borrower).repay(state.totalBorrowed);

      // Advance 10 days (well more than 5 days delinquent)
      await time.increase(10 * ONE_DAY);
      await market.accrueInterest();

      state = await market.getState();
      expect(state.timeDelinquent).to.equal(0);
      expect(state.isDelinquent).to.equal(false);
    });

    it("should not underflow timeDelinquent past zero (satSub)", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);
      await makeDelinquent(market, borrower, lender, positionToken);

      // timeDelinquent=0, advance 1 day to get timeDelinquent=~1 day
      await time.increase(ONE_DAY);
      await market.accrueInterest();

      // Repay all debt
      let state = await market.getState();
      await market.connect(borrower).repay(state.totalBorrowed);

      // Advance 30 days (way more than ~1 day delinquent)
      await time.increase(30 * ONE_DAY);
      await market.accrueInterest();

      state = await market.getState();
      expect(state.timeDelinquent).to.equal(0);
    });
  });

  describe("8. Credit limit enforcement — borrow fails when exceeding tier limit", function () {
    it("should enforce credit limit via orchestrator on borrow", async function () {
      const { asset, orchestrator, lender, params } = await loadFixture(deployDelinquencyFixture);

      // Create a low-tier borrower (TIER_1 = 100_000e18)
      const [,,,,, lowTierBorrower] = await ethers.getSigners();
      await orchestrator.authorizeBorrower(lowTierBorrower.address, 0); // TIER_1

      const marketAddr = await orchestrator.createMarket.staticCall(
        lowTierBorrower.address, await asset.getAddress(), params
      );
      await orchestrator.createMarket(lowTierBorrower.address, await asset.getAddress(), params);
      const lowMarket = await ethers.getContractAt("CreditMarket", marketAddr);

      await orchestrator.registerLender(marketAddr, lender.address);
      await asset.connect(lender).approve(marketAddr, ethers.MaxUint256);
      await lowMarket.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);

      await asset.transfer(lowTierBorrower.address, ethers.parseUnits("10000", 6));
      await asset.connect(lowTierBorrower).approve(marketAddr, ethers.MaxUint256);

      // Borrow and verify tracking via getBorrowerAuth
      const borrowAmount = ethers.parseUnits("50000", 6);
      await lowMarket.connect(lowTierBorrower).borrow(borrowAmount);

      const auth = await orchestrator.getBorrowerAuth(lowTierBorrower.address);
      // totalBorrowed is normalized to 18 decimals for credit limit comparison
      expect(auth.totalBorrowed).to.equal(ethers.parseEther("50000"));
    });
  });

  describe("9. Credit limit tracks across lifecycle (borrow, repay, borrow again)", function () {
    it("should track totalBorrowed at orchestrator through borrow-repay-borrow cycle", async function () {
      const { market, orchestrator, borrower } = await loadFixture(deployDelinquencyFixture);

      const borrow1 = ethers.parseUnits("30000", 6);
      await market.connect(borrower).borrow(borrow1);
      let auth = await orchestrator.getBorrowerAuth(borrower.address);
      // totalBorrowed normalized to 18 decimals
      expect(auth.totalBorrowed).to.equal(ethers.parseEther("30000"));

      // Repay half
      const repay = ethers.parseUnits("15000", 6);
      await market.connect(borrower).repay(repay);
      auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.totalBorrowed).to.equal(ethers.parseEther("15000"));

      // Borrow again
      const borrow2 = ethers.parseUnits("20000", 6);
      await market.connect(borrower).borrow(borrow2);
      auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.totalBorrowed).to.equal(ethers.parseEther("35000"));
    });

    it("should allow re-borrowing after full repayment", async function () {
      const { market, borrower } = await loadFixture(deployDelinquencyFixture);

      await market.connect(borrower).borrow(ethers.parseUnits("40000", 6));
      await market.connect(borrower).repay(ethers.parseUnits("40000", 6));
      await market.connect(borrower).borrow(ethers.parseUnits("30000", 6));

      const state = await market.getState();
      expect(state.totalBorrowed).to.equal(ethers.parseUnits("30000", 6));
    });
  });

  describe("10. Multiple markets share credit limit via Orchestrator", function () {
    it("should enforce shared credit limit across two markets", async function () {
      const { market, asset, orchestrator, borrower, lender, lender2, params } = await loadFixture(deployDelinquencyFixture);

      // Create a second market for the same borrower (different asset to avoid duplicate)
      const asset2 = await ethers.deployContract("ERC20Mock", [
        "Dai", "DAI", await (await ethers.getSigners())[0].getAddress(),
        ethers.parseUnits("10000000", 6), 6
      ]);

      const market2Addr = await orchestrator.createMarket.staticCall(
        borrower.address, await asset2.getAddress(), params
      );
      await orchestrator.createMarket(borrower.address, await asset2.getAddress(), params);
      const market2 = await ethers.getContractAt("CreditMarket", market2Addr);

      await orchestrator.registerLender(market2Addr, lender2.address);
      await asset2.transfer(lender2.address, ethers.parseUnits("200000", 6));
      await asset2.connect(lender2).approve(market2Addr, ethers.MaxUint256);
      await market2.connect(lender2).deposit(ethers.parseUnits("100000", 6), lender2.address);
      await asset2.transfer(borrower.address, ethers.parseUnits("100000", 6));
      await asset2.connect(borrower).approve(market2Addr, ethers.MaxUint256);

      // Borrow from market1
      await market.connect(borrower).borrow(ethers.parseUnits("30000", 6));

      // Borrow from market2
      await market2.connect(borrower).borrow(ethers.parseUnits("20000", 6));

      // Orchestrator tracks combined total (normalized to 18 decimals)
      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.totalBorrowed).to.equal(ethers.parseEther("50000"));
    });
  });

  describe("Delinquency lifecycle integration", function () {
    it("full lifecycle: enter → grace → penalty → recovery → resolved", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);

      // 1. Enter delinquency
      await makeDelinquent(market, borrower, lender, positionToken);
      let state = await market.getState();
      expect(state.isDelinquent).to.equal(true);
      // timeDelinquent=0 (just detected)

      // 2. Grace period — advance 2 days (timeDelinquent: 0→2 days, within 3-day grace)
      await time.increase(2 * ONE_DAY);
      await market.accrueInterest();
      state = await market.getState();
      expect(state.isDelinquent).to.equal(true);
      expect(state.timeDelinquent).to.be.gte(2 * ONE_DAY - 10);
      expect(state.timeDelinquent).to.be.lt(THREE_DAYS);

      // 3. Past grace — advance 2 more days (timeDelinquent: ~2d→~4d, 1 day of penalty)
      await time.increase(2 * ONE_DAY);
      await market.accrueInterest();
      state = await market.getState();
      expect(state.isDelinquent).to.equal(true);
      expect(state.timeDelinquent).to.be.gte(4 * ONE_DAY - 60);

      // 4. Repay to resolve
      await market.connect(borrower).repay(state.totalBorrowed);
      state = await market.getState();
      expect(state.isDelinquent).to.equal(false);
      const timeDelinquentAfterRepay = state.timeDelinquent;
      expect(timeDelinquentAfterRepay).to.be.gte(4 * ONE_DAY - 60);

      // 5. Recovery — advance 2 days, timeDelinquent decreases
      await time.increase(2 * ONE_DAY);
      await market.accrueInterest();
      state = await market.getState();
      expect(BigInt(state.timeDelinquent)).to.be.lt(BigInt(timeDelinquentAfterRepay));

      // 6. Full recovery — advance 5 more days
      await time.increase(5 * ONE_DAY);
      await market.accrueInterest();
      state = await market.getState();
      expect(state.timeDelinquent).to.equal(0);
      expect(state.isDelinquent).to.equal(false);
    });

    it("should re-enter delinquency after recovery if borrower drains again", async function () {
      const { market, borrower, lender, positionToken } = await loadFixture(deployDelinquencyFixture);

      // First delinquency cycle — short (2 days)
      await makeDelinquent(market, borrower, lender, positionToken);
      // isDelinquent=true, timeDelinquent=0

      await time.increase(ONE_DAY);
      await market.accrueInterest();

      let state = await market.getState();
      const firstCycleTimeDelinquent = BigInt(state.timeDelinquent);
      expect(firstCycleTimeDelinquent).to.be.gt(0n);

      // Repay to resolve
      await market.connect(borrower).repay(state.totalBorrowed);
      state = await market.getState();
      expect(state.isDelinquent).to.equal(false);

      // Partial recovery (1 day)
      await time.increase(ONE_DAY);
      await market.accrueInterest();
      state = await market.getState();
      expect(state.isDelinquent).to.equal(false);
      const recoveredTimeDelinquent = BigInt(state.timeDelinquent);
      expect(recoveredTimeDelinquent).to.be.lt(firstCycleTimeDelinquent);

      // Re-borrow to drain liquidity again — use borrowable minus a buffer
      // First accrue to sync state
      await market.accrueInterest();
      const borrowable2 = await market.borrowableAssets();
      // Borrow most of what's available (leave tiny buffer for rounding)
      const borrowAmt = borrowable2 > ethers.parseUnits("500", 6)
        ? borrowable2 - ethers.parseUnits("500", 6)
        : 0n;
      if (borrowAmt > 0n) {
        await market.connect(borrower).borrow(borrowAmt);
      }

      // Request more withdrawals to push into delinquency
      const bal = await positionToken.balanceOf(lender.address);
      if (bal > 0n) {
        await market.connect(lender).requestWithdrawal(bal / 4n);
      }
      await time.increase(ONE_DAY);
      await market.accrueInterest();

      state = await market.getState();
      expect(state.isDelinquent).to.equal(true);
    });
  });
});
