import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

describe("LoanPositionToken", function () {
  async function deployCreditMarketFixture() {
    const [owner, borrower, lender, lender2, user3] = await ethers.getSigners();

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
      delinquencyFeeBips: 200,         // 2% penalty
      withdrawalBatchDuration: 604800, // 7 days
      reserveRatioBips: 1000,         // 10% reserve
      delinquencyGracePeriod: 259200, // 3 days
      protocolFeeBips: 100,           // 10% of interest
      maxDelinquencyPeriod: 2592000,  // 30 days max
      maxTotalSupply: ethers.parseUnits("1000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0
    };

    // Create market
    const marketAddress = await orchestrator.createMarket.staticCall(borrower.address, await asset.getAddress(), params);
    await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);

    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    // Get LPT address
    const lptAddress = await market.positionToken();
    const lpt = await ethers.getContractAt("LoanPositionToken", lptAddress);

    // Register lenders
    await orchestrator.registerLender(marketAddress, lender.address);
    await orchestrator.registerLender(marketAddress, lender2.address);

    // Fund lenders
    await asset.transfer(lender.address, ethers.parseUnits("100000", 6));
    await asset.transfer(lender2.address, ethers.parseUnits("100000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
    await asset.connect(lender2).approve(marketAddress, ethers.MaxUint256);

    return {
      market,
      lpt,
      asset,
      orchestrator,
      owner,
      borrower,
      lender,
      lender2,
      user3,
      marketAddress,
      params
    };
  }

  describe("mint", function () {
    it("Should only allow market to mint", async function () {
      const { lpt, lender } = await loadFixture(deployCreditMarketFixture);

      // Try minting from non-market should fail
      await expect(lpt.connect(lender).mint(lender.address, 1000))
        .to.be.revertedWithCustomError(lpt, "UnauthorizedLender");
    });

    it("Should mint tokens when called by market", async function () {
      const { market, lpt, lender } = await loadFixture(deployCreditMarketFixture);

      // Deposit to trigger mint
      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      // Check balance
      const balance = await lpt.balanceOf(lender.address);
      expect(balance).to.be.gt(0);
    });
  });

  describe("burn", function () {
    it("Should only allow market to burn", async function () {
      const { lpt, lender } = await loadFixture(deployCreditMarketFixture);

      // Try burning from non-market should fail
      await expect(lpt.connect(lender).burn(lender.address, 1000))
        .to.be.revertedWithCustomError(lpt, "UnauthorizedLender");
    });

    it("Should burn tokens via requestWithdrawal", async function () {
      const { market, lpt, lender } = await loadFixture(deployCreditMarketFixture);

      // Deposit first
      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      const balanceBefore = await lpt.balanceOf(lender.address);

      // Request withdrawal to trigger burn
      await market.connect(lender).requestWithdrawal(balanceBefore);

      const balanceAfter = await lpt.balanceOf(lender.address);
      expect(balanceAfter).to.equal(0);
    });
  });

  describe("transfer between known lenders", function () {
    it("Should allow transfer between known lenders", async function () {
      const { market, lpt, lender, lender2 } = await loadFixture(deployCreditMarketFixture);

      // Deposit to get LPT
      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      const balanceBefore = await lpt.balanceOf(lender.address);

      // Transfer to lender2 (known lender)
      await lpt.connect(lender).transfer(lender2.address, balanceBefore);

      expect(await lpt.balanceOf(lender.address)).to.equal(0);
      expect(await lpt.balanceOf(lender2.address)).to.equal(balanceBefore);
    });

    it("Should revert transfer to unknown lender", async function () {
      const { market, lpt, lender, user3 } = await loadFixture(deployCreditMarketFixture);

      // Deposit to get LPT
      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      const balanceBefore = await lpt.balanceOf(lender.address);

      // Try transfer to unknown user3 (not registered as lender)
      await expect(lpt.connect(lender).transfer(user3.address, balanceBefore))
        .to.be.revertedWithCustomError(lpt, "LenderNotKnown");
    });
  });

  describe("normalizedBalanceOf", function () {
    it("Should return scaled balance * scaleFactor / RAY", async function () {
      const { market, lpt, lender } = await loadFixture(deployCreditMarketFixture);

      // Deposit to get LPT
      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      const normalized = await lpt.normalizedBalanceOf(lender.address);

      // normalized should equal original deposit amount (allow tiny rounding)
      const diff = normalized > depositAmount ? normalized - depositAmount : depositAmount - normalized;
      expect(diff).to.be.lt(10n);
    });

    it("Should return 0 for address with no balance", async function () {
      const { lpt, user3 } = await loadFixture(deployCreditMarketFixture);

      const normalized = await lpt.normalizedBalanceOf(user3.address);
      expect(normalized).to.equal(0);
    });
  });

  describe("scaleFactor", function () {
    it("Should read scaleFactor from parent market", async function () {
      const { market, lpt } = await loadFixture(deployCreditMarketFixture);

      const marketScaleFactor = (await market.getState()).scaleFactor;
      const lptScaleFactor = await lpt.scaleFactor();

      expect(lptScaleFactor).to.equal(marketScaleFactor);
    });

    it("Should initially be equal to RAY (1e27)", async function () {
      const { lpt } = await loadFixture(deployCreditMarketFixture);

      const scaleFactor = await lpt.scaleFactor();
      // RAY = 1e27
      expect(scaleFactor).to.equal(ethers.parseUnits("1", 27));
    });
  });

  describe("market and orchestrator addresses", function () {
    it("Should store correct market address", async function () {
      const { lpt, marketAddress } = await loadFixture(deployCreditMarketFixture);

      expect(await lpt.market()).to.equal(marketAddress);
    });

    it("Should store correct orchestrator address", async function () {
      const { orchestrator, lpt } = await loadFixture(deployCreditMarketFixture);

      expect(await lpt.orchestratorAddr()).to.equal(await orchestrator.getAddress());
    });
  });

  describe("transferability modes", function () {
    it("Should default to KnownLendersOnly", async function () {
      const { lpt } = await loadFixture(deployCreditMarketFixture);

      // Transferability enum: 0=NonTransferable, 1=KnownLendersOnly, 2=Unrestricted
      expect(await lpt.transferability()).to.equal(1);
    });

    it("KnownLendersOnly — transfer to registered lender succeeds", async function () {
      const { market, lpt, lender, lender2 } = await loadFixture(deployCreditMarketFixture);

      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      const balance = await lpt.balanceOf(lender.address);
      await lpt.connect(lender).transfer(lender2.address, balance);

      expect(await lpt.balanceOf(lender2.address)).to.equal(balance);
    });

    it("KnownLendersOnly — transfer to unregistered address reverts", async function () {
      const { market, lpt, lender, user3 } = await loadFixture(deployCreditMarketFixture);

      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      const balance = await lpt.balanceOf(lender.address);
      await expect(lpt.connect(lender).transfer(user3.address, balance))
        .to.be.revertedWithCustomError(lpt, "LenderNotKnown");
    });

    it("NonTransferable — all transfers revert (except mint/burn)", async function () {
      const { market, lpt, lender, lender2, owner } = await loadFixture(deployCreditMarketFixture);

      // Owner sets NonTransferable
      await lpt.connect(owner).setTransferability(0); // NonTransferable

      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      const balance = await lpt.balanceOf(lender.address);

      // Transfer should revert
      await expect(lpt.connect(lender).transfer(lender2.address, balance))
        .to.be.revertedWithCustomError(lpt, "TransfersDisabled");

      // But mint (deposit) succeeded above, proving mint still works
      expect(balance).to.be.gt(0);
    });

    it("Unrestricted — transfer to any address succeeds", async function () {
      const { market, lpt, lender, user3, owner } = await loadFixture(deployCreditMarketFixture);

      // Owner sets Unrestricted
      await lpt.connect(owner).setTransferability(2); // Unrestricted

      const depositAmount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(depositAmount, lender.address);

      const balance = await lpt.balanceOf(lender.address);

      // Transfer to unregistered user3 should succeed
      await lpt.connect(lender).transfer(user3.address, balance);

      expect(await lpt.balanceOf(user3.address)).to.equal(balance);
    });

    it("Only authorized can change transferability", async function () {
      const { lpt, lender } = await loadFixture(deployCreditMarketFixture);

      // Non-authorized user should be reverted
      await expect(lpt.connect(lender).setTransferability(2))
        .to.be.revertedWithCustomError(lpt, "UnauthorizedLender");
    });

    it("Owner can change transferability", async function () {
      const { lpt, owner } = await loadFixture(deployCreditMarketFixture);

      await lpt.connect(owner).setTransferability(2); // Unrestricted
      expect(await lpt.transferability()).to.equal(2);

      await lpt.connect(owner).setTransferability(0); // NonTransferable
      expect(await lpt.transferability()).to.equal(0);
    });
  });

  describe("custodianSignature", function () {
    it("Should be settable and readable", async function () {
      const { lpt, owner } = await loadFixture(deployCreditMarketFixture);

      const sig = ethers.keccak256(ethers.toUtf8Bytes("custodian-approval-123"));
      await lpt.connect(owner).setCustodianSignature(sig);

      expect(await lpt.custodianSignature()).to.equal(sig);
    });

    it("Should default to zero", async function () {
      const { lpt } = await loadFixture(deployCreditMarketFixture);

      expect(await lpt.custodianSignature()).to.equal(ethers.ZeroHash);
    });

    it("Only authorized can set custodian signature", async function () {
      const { lpt, lender } = await loadFixture(deployCreditMarketFixture);

      const sig = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(lpt.connect(lender).setCustodianSignature(sig))
        .to.be.revertedWithCustomError(lpt, "UnauthorizedLender");
    });
  });

  describe("ERC20 metadata", function () {
    it("Should have correct name", async function () {
      const { lpt } = await loadFixture(deployCreditMarketFixture);

      const name = await lpt.name();
      // Name is "LPT-<marketId hex prefix>"
      expect(name).to.include("LPT-");
    });

    it("Should have correct symbol", async function () {
      const { lpt } = await loadFixture(deployCreditMarketFixture);

      const symbol = await lpt.symbol();
      expect(symbol).to.include("LPT");
    });
  });
});
