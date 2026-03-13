import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

describe("CreditMarket deposit tests", function () {
  async function deployCreditMarketFixture() {
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

    // Register lender
    await orchestrator.registerLender(marketAddress, lender.address);

    // Fund lender
    await asset.transfer(lender.address, ethers.parseUnits("100000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);

    return {
      market,
      marketAddress,
      asset,
      orchestrator,
      owner,
      borrower,
      lender,
      user2,
      params
    };
  }

  describe("deposit", function () {
    it("Should deposit assets successfully", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);
      const amount = ethers.parseUnits("1000", 6);

      const scaledAmount = await market.connect(lender).deposit.staticCall(amount, lender.address);

      await expect(market.connect(lender).deposit(amount, lender.address))
        .to.emit(market, "Deposit");

      expect(scaledAmount).to.be.gt(0);
    });

    it("Should track total supply after deposit", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);
      const amount = ethers.parseUnits("1000", 6);

      await market.connect(lender).deposit(amount, lender.address);

      const totalSupply = await market.totalSupply();
      // Allow small rounding from RAY scale/normalize roundtrip
      const diff = totalSupply > amount ? totalSupply - amount : amount - totalSupply;
      expect(diff).to.be.lt(10n);
    });

    it("Should mint position tokens to depositor", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);
      const amount = ethers.parseUnits("1000", 6);

      await market.connect(lender).deposit(amount, lender.address);

      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const balance = await positionToken.balanceOf(lender.address);

      // Balance should be close to the deposited amount in scaled units
      expect(balance).to.be.gt(0);
      // At initial scale factor (1e27), scaled ≈ amount (allow 10 wei rounding)
      const diff = balance > amount ? balance - amount : amount - balance;
      expect(diff).to.be.lt(10n);
    });

    it("Should fail when deposit exceeds max supply", async function () {
      const { market, lender, asset, marketAddress } = await loadFixture(deployCreditMarketFixture);

      // Deposit 90K first (lender has 100K from fixture)
      await market.connect(lender).deposit(ethers.parseUnits("90000", 6), lender.address);

      // Fund lender with more tokens (owner has 900K left after fixture)
      await asset.transfer(lender.address, ethers.parseUnits("900000", 6));

      // Try to deposit enough to exceed maxTotalSupply (1M)
      // Already have ~90K deposited, try to deposit 920K more (total > 1M)
      const excessAmount = ethers.parseUnits("920000", 6);

      await expect(
        market.connect(lender).deposit(excessAmount, lender.address)
      ).to.be.revertedWithCustomError(market, "DepositExceedsMaxSupply");
    });

    it("Should fail when deposit amount is zero", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);

      await expect(
        market.connect(lender).deposit(0, lender.address)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should fail when market is closed", async function () {
      const { market, borrower, lender } = await loadFixture(deployCreditMarketFixture);
      const amount = ethers.parseUnits("1000", 6);

      // Close the market
      await market.connect(borrower).closeMarket();

      await expect(
        market.connect(lender).deposit(amount, lender.address)
      ).to.be.revertedWithCustomError(market, "MarketClosed");
    });

    it("Should fail when caller is not registered lender", async function () {
      const { market, asset, user2, marketAddress } = await loadFixture(deployCreditMarketFixture);
      const amount = ethers.parseUnits("1000", 6);

      await asset.transfer(user2.address, ethers.parseUnits("1000", 6));
      await asset.connect(user2).approve(marketAddress, ethers.MaxUint256);

      await expect(
        market.connect(user2).deposit(amount, user2.address)
      ).to.be.revertedWithCustomError(market, "UnauthorizedLender");
    });
  });

  describe("maturity enforcement", function () {
    async function deployMaturityMarketFixture() {
      const [owner, borrower, lender, user2] = await ethers.getSigners();

      const asset = await ethers.deployContract("ERC20Mock", [
        "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
      ]);

      const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);
      await orchestrator.authorizeBorrower(borrower.address, 3); // TIER_4

      // Get current block timestamp and set maturity 1 hour from now
      const latestBlock = await ethers.provider.getBlock("latest");
      const maturityDate = latestBlock!.timestamp + 3600; // 1 hour from now

      const params: CreditTypesLib.MarketParametersStruct = {
        annualInterestBips: 500,
        delinquencyFeeBips: 200,
        withdrawalBatchDuration: 604800,
        reserveRatioBips: 1000,
        delinquencyGracePeriod: 259200,
        protocolFeeBips: 100,
        maxDelinquencyPeriod: 2592000,
        maxTotalSupply: ethers.parseUnits("1000000", 6),
        maturityDate: maturityDate,
        gmslaRefHash: ethers.ZeroHash,
        collateralRatioBps: 0
      };

      const marketAddress = await orchestrator.createMarket.staticCall(borrower.address, await asset.getAddress(), params);
      await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);
      const market = await ethers.getContractAt("CreditMarket", marketAddress);

      await orchestrator.registerLender(marketAddress, lender.address);
      await asset.transfer(lender.address, ethers.parseUnits("100000", 6));
      await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);

      // Fund borrower for repayments
      await asset.transfer(borrower.address, ethers.parseUnits("50000", 6));
      await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

      return { market, marketAddress, asset, orchestrator, owner, borrower, lender, user2, params, maturityDate };
    }

    it("Should allow deposit before maturity", async function () {
      const { market, lender } = await loadFixture(deployMaturityMarketFixture);
      const amount = ethers.parseUnits("1000", 6);

      await expect(market.connect(lender).deposit(amount, lender.address))
        .to.emit(market, "Deposit");
    });

    it("Should revert deposit after maturity", async function () {
      const { market, lender, maturityDate } = await loadFixture(deployMaturityMarketFixture);
      const amount = ethers.parseUnits("1000", 6);

      // Advance time past maturity
      await time.increaseTo(maturityDate + 1);

      await expect(
        market.connect(lender).deposit(amount, lender.address)
      ).to.be.revertedWithCustomError(market, "MarketMatured");
    });

    it("Should revert borrow after maturity", async function () {
      const { market, lender, borrower, maturityDate } = await loadFixture(deployMaturityMarketFixture);

      // Deposit before maturity
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);

      // Advance time past maturity
      await time.increaseTo(maturityDate + 1);

      await expect(
        market.connect(borrower).borrow(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(market, "MarketMatured");
    });

    it("Should allow repay after maturity", async function () {
      const { market, lender, borrower, maturityDate } = await loadFixture(deployMaturityMarketFixture);

      // Deposit and borrow before maturity
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);
      await market.connect(borrower).borrow(ethers.parseUnits("5000", 6));

      // Advance time past maturity
      await time.increaseTo(maturityDate + 1);

      // Repay should still work
      await expect(market.connect(borrower).repay(ethers.parseUnits("5000", 6)))
        .to.emit(market, "Repay");
    });

    it("Should allow requestWithdrawal after maturity", async function () {
      const { market, lender, maturityDate } = await loadFixture(deployMaturityMarketFixture);

      // Deposit before maturity
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);

      // Advance time past maturity
      await time.increaseTo(maturityDate + 1);

      // requestWithdrawal should still work
      await expect(market.connect(lender).requestWithdrawal(ethers.parseUnits("1000", 6)))
        .to.emit(market, "WithdrawalRequested");
    });
  });
});
