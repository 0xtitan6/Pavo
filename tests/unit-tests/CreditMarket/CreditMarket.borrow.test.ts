import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

describe("CreditMarket borrow tests", function () {
  async function deployCreditMarketWithLiquidityFixture() {
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

    // Lender deposits 100k USDC (with 10% reserve, 90k available)
    await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);

    // Transfer some asset to borrower for repayments
    await asset.transfer(borrower.address, ethers.parseUnits("50000", 6));
    await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

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

  describe("borrow", function () {
    it("Should borrow assets successfully within limit", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithLiquidityFixture);
      const borrowAmount = ethers.parseUnits("50000", 6); // 50% of available

      await expect(market.connect(borrower).borrow(borrowAmount))
        .to.emit(market, "Borrow");
    });

    it("Should track borrow balance correctly", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithLiquidityFixture);
      const borrowAmount = ethers.parseUnits("50000", 6);

      await market.connect(borrower).borrow(borrowAmount);

      const state = await market.getState();
      expect(state.totalBorrowed).to.equal(borrowAmount);
    });

    it("Should fail when borrow exceeds available liquidity", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithLiquidityFixture);
      // Available is ~90k (100k - 10% reserve), try to borrow more
      const excessAmount = ethers.parseUnits("95000", 6);

      await expect(
        market.connect(borrower).borrow(excessAmount)
      ).to.be.revertedWithCustomError(market, "InsufficientBorrowableLiquidity");
    });

    it("Should fail when only borrower can borrow", async function () {
      const { market, lender, user2 } = await loadFixture(deployCreditMarketWithLiquidityFixture);
      const borrowAmount = ethers.parseUnits("1000", 6);

      await expect(
        market.connect(lender).borrow(borrowAmount)
      ).to.be.revertedWithCustomError(market, "UnauthorizedBorrower");

      await expect(
        market.connect(user2).borrow(borrowAmount)
      ).to.be.revertedWithCustomError(market, "UnauthorizedBorrower");
    });

    it("Should fail when borrow amount is zero", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithLiquidityFixture);

      await expect(
        market.connect(borrower).borrow(0)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should fail when market is closed", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithLiquidityFixture);
      const borrowAmount = ethers.parseUnits("1000", 6);

      // Close the market first
      await market.connect(borrower).closeMarket();

      await expect(
        market.connect(borrower).borrow(borrowAmount)
      ).to.be.revertedWithCustomError(market, "MarketClosed");
    });

    it("Should update borrowableAssets after borrow", async function () {
      const { market, borrower } = await loadFixture(deployCreditMarketWithLiquidityFixture);
      const borrowAmount = ethers.parseUnits("10000", 6);

      const borrowableBefore = await market.borrowableAssets();
      await market.connect(borrower).borrow(borrowAmount);
      const borrowableAfter = await market.borrowableAssets();

      // Allow small rounding tolerance from RAY math
      const diff = (borrowableBefore - borrowAmount) - borrowableAfter;
      expect(diff >= 0n ? diff : -diff).to.be.lt(100n);
    });
  });
});
