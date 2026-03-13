import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

describe("CreditMarket repay tests", function () {
  async function deployCreditMarketWithDebtFixture() {
    const [owner, borrower, lender, user2] = await ethers.getSigners();

    // Deploy mock asset (ERC20)
    const asset = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);

    // Deploy Orchestrator
    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);

    // Approve borrower (TIER_4 = max credit)
    await orchestrator.authorizeBorrower(borrower.address, 3); // TIER_4

    // Set market parameters
    const params: CreditTypesLib.MarketParametersStruct = {
      annualInterestBips: 500,        // 5% APR
      delinquencyFeeBips: 200,       // 2% penalty
      withdrawalBatchDuration: 604800, // 7 days
      reserveRatioBips: 1000,        // 10% reserve
      delinquencyGracePeriod: 259200, // 3 days
      protocolFeeBips: 100,          // 10% of interest
      maxDelinquencyPeriod: 2592000, // 30 days max
      maxTotalSupply: ethers.parseUnits("1000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0
    };

    // Create market
    const marketAddress = await orchestrator.createMarket.staticCall(borrower.address, await asset.getAddress(), params);
    await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);

    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    // Register lender and deposit
    await orchestrator.registerLender(marketAddress, lender.address);
    await asset.transfer(lender.address, ethers.parseUnits("100000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);

    // Lender deposits 100k USDC
    await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);

    // Transfer asset to borrower for repayments
    await asset.transfer(borrower.address, ethers.parseUnits("50000", 6));
    await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

    // Borrower borrows 50k
    await market.connect(borrower).borrow(ethers.parseUnits("50000", 6));

    return {
      market,
      asset,
      orchestrator,
      owner,
      borrower,
      lender,
      user2,
      params
    };
  }

  describe("repay", function () {
    it("Should repay debt successfully", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithDebtFixture);
      const repayAmount = ethers.parseUnits("10000", 6);

      const stateBefore = await market.getState();
      const borrowedBefore = stateBefore.totalBorrowed;

      await expect(market.connect(borrower).repay(repayAmount))
        .to.emit(market, "Repay");

      const stateAfter = await market.getState();
      expect(stateAfter.totalBorrowed).to.equal(borrowedBefore - repayAmount);
    });

    it("Should fully repay debt", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithDebtFixture);
      const stateBefore = await market.getState();
      const fullDebt = stateBefore.totalBorrowed;

      await market.connect(borrower).repay(fullDebt);

      const stateAfter = await market.getState();
      expect(stateAfter.totalBorrowed).to.equal(0n);
    });

    it("Should fail when repay exceeds debt", async function () {
      const { market, borrower, asset } = await loadFixture(deployCreditMarketWithDebtFixture);
      const state = await market.getState();
      const excessRepay = state.totalBorrowed + ethers.parseUnits("1000", 6);

      // Give borrower more tokens to attempt excess repay
      await asset.transfer(borrower.address, ethers.parseUnits("100000", 6));

      await expect(
        market.connect(borrower).repay(excessRepay)
      ).to.be.revertedWithCustomError(market, "RepayExceedsDebt");
    });

    it("Should fail when repay amount is zero", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithDebtFixture);

      await expect(
        market.connect(borrower).repay(0)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should allow non-borrower to repay on behalf", async function () {
      const { market, lender, asset } = await loadFixture(deployCreditMarketWithDebtFixture);
      const repayAmount = ethers.parseUnits("1000", 6);

      // Fund lender for repay
      await asset.transfer(lender.address, repayAmount);
      const marketAddr = await market.getAddress();
      await asset.connect(lender).approve(marketAddr, ethers.MaxUint256);

      const stateBefore = await market.getState();
      await market.connect(lender).repay(repayAmount);
      const stateAfter = await market.getState();

      expect(stateAfter.totalBorrowed).to.equal(stateBefore.totalBorrowed - repayAmount);
    });

    it("Should resolve delinquency after full repay", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithDebtFixture);

      // Check delinquent status before repay
      const isDelinquentBefore = await market.isDelinquent();

      // Full repay
      const state = await market.getState();
      await market.connect(borrower).repay(state.totalBorrowed);

      const isDelinquentAfter = await market.isDelinquent();

      expect(isDelinquentBefore).to.be.false;
      expect(isDelinquentAfter).to.be.false;
    });

    it("Should update borrowable assets after repay", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithDebtFixture);
      const repayAmount = ethers.parseUnits("10000", 6);

      const borrowableBefore = await market.borrowableAssets();
      await market.connect(borrower).repay(repayAmount);
      const borrowableAfter = await market.borrowableAssets();

      // Borrowable should increase by repay amount (allow small rounding)
      const diff = borrowableAfter - borrowableBefore - repayAmount;
      expect(diff >= 0n ? diff : -diff).to.be.lt(100n);
    });
  });
});
