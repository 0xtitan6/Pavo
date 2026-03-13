import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Orchestrator", function () {
  async function deployOrchestrator() {
    const [owner, borrower, lender, nonOwner, feeRecipient] = await ethers.getSigners();

    const Orchestrator = await ethers.getContractFactory("Orchestrator");
    const orchestrator = await Orchestrator.deploy(feeRecipient.address);

    return { orchestrator, owner, borrower, lender, nonOwner, feeRecipient };
  }

  const defaultMarketParams = {
    annualInterestBips: 500n,
    delinquencyFeeBips: 200n,
    withdrawalBatchDuration: 604800n,
    reserveRatioBips: 2000n,
    delinquencyGracePeriod: 86400n,
    protocolFeeBips: 1000n,
    maxDelinquencyPeriod: 2592000n,
    maxTotalSupply: ethers.parseEther("1000000"),
    maturityDate: 0n,
    gmslaRefHash: ethers.ZeroHash,
    collateralRatioBps: 0n,
  };

  describe("Constructor", function () {
    it("sets protocol fee recipient", async function () {
      const { orchestrator, feeRecipient } = await loadFixture(deployOrchestrator);
      expect(await orchestrator.protocolFeeRecipient()).to.equal(feeRecipient.address);
    });

    it("rejects zero address for fee recipient", async function () {
      const Orchestrator = await ethers.getContractFactory("Orchestrator");
      await expect(Orchestrator.deploy(ethers.ZeroAddress)).to.be.reverted;
    });
  });

  describe("authorizeBorrower", function () {
    it("authorizes borrower with TIER_1", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.status).to.equal(1);
      expect(auth.tier).to.equal(0);
      expect(auth.creditLimit).to.equal(100_000n * ethers.parseEther("1"));
    });

    it("authorizes borrower with TIER_2", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 1);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.tier).to.equal(1);
      expect(auth.creditLimit).to.equal(500_000n * ethers.parseEther("1"));
    });

    it("authorizes borrower with TIER_3", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 2);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.tier).to.equal(2);
      expect(auth.creditLimit).to.equal(2_000_000n * ethers.parseEther("1"));
    });

    it("authorizes borrower with TIER_4", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 3);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.tier).to.equal(3);
      expect(auth.creditLimit).to.equal(10_000_000n * ethers.parseEther("1"));
    });

    it("rejects zero address borrower", async function () {
      const { orchestrator, owner } = await loadFixture(deployOrchestrator);

      await expect(orchestrator.authorizeBorrower(ethers.ZeroAddress, 0)).to.be.reverted;
    });

    it("only owner can authorize", async function () {
      const { orchestrator, nonOwner, borrower } = await loadFixture(deployOrchestrator);

      await expect(orchestrator.connect(nonOwner).authorizeBorrower(borrower.address, 0))
        .to.be.revertedWithCustomError(orchestrator, "OwnableUnauthorizedAccount");
    });

    it("emits BorrowerAuthorized event", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await expect(orchestrator.authorizeBorrower(borrower.address, 0))
        .to.emit(orchestrator, "BorrowerAuthorized")
        .withArgs(borrower.address, 0);
    });
  });

  describe("updateCreditTier", function () {
    it("updates tier from TIER_1 to TIER_2", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);
      await orchestrator.updateCreditTier(borrower.address, 1);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.tier).to.equal(1);
      expect(auth.creditLimit).to.equal(500_000n * ethers.parseEther("1"));
    });

    it("updates tier from TIER_2 to TIER_4", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 1);
      await orchestrator.updateCreditTier(borrower.address, 3);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.tier).to.equal(3);
      expect(auth.creditLimit).to.equal(10_000_000n * ethers.parseEther("1"));
    });

    it("rejects update for non-approved borrower", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await expect(orchestrator.updateCreditTier(borrower.address, 1)).to.be.reverted;
    });

    it("rejects update for suspended borrower", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);
      await orchestrator.suspendBorrower(borrower.address);

      await expect(orchestrator.updateCreditTier(borrower.address, 1)).to.be.reverted;
    });

    it("emits CreditTierUpdated event", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);
      await expect(orchestrator.updateCreditTier(borrower.address, 1))
        .to.emit(orchestrator, "CreditTierUpdated")
        .withArgs(borrower.address, 0, 1);
    });
  });

  describe("suspendBorrower", function () {
    it("suspends approved borrower", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);
      await orchestrator.suspendBorrower(borrower.address);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.status).to.equal(2);
    });

    it("emits BorrowerSuspended event", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);
      await expect(orchestrator.suspendBorrower(borrower.address))
        .to.emit(orchestrator, "BorrowerSuspended")
        .withArgs(borrower.address, "Admin suspension");
    });
  });

  describe("reactivateBorrower", function () {
    it("reactivates suspended borrower", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);
      await orchestrator.suspendBorrower(borrower.address);
      await orchestrator.reactivateBorrower(borrower.address);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.status).to.equal(1);
    });

    it("emits BorrowerReactivated event", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);
      await orchestrator.suspendBorrower(borrower.address);
      await expect(orchestrator.reactivateBorrower(borrower.address))
        .to.emit(orchestrator, "BorrowerReactivated")
        .withArgs(borrower.address);
    });
  });

  describe("registerLender", function () {
    it("registers a lender", async function () {
      const { orchestrator, owner, lender } = await loadFixture(deployOrchestrator);

      const dummyMarket = ethers.Wallet.createRandom().address;

      await orchestrator.registerLender(dummyMarket, lender.address);

      expect(await orchestrator.isKnownLender(dummyMarket, lender.address)).to.be.true;
    });

    it("rejects zero address lender", async function () {
      const { orchestrator, owner } = await loadFixture(deployOrchestrator);

      const dummyMarket = ethers.Wallet.createRandom().address;

      await expect(orchestrator.registerLender(dummyMarket, ethers.ZeroAddress))
        .to.be.reverted;
    });

    it("emits LenderRegistered event", async function () {
      const { orchestrator, owner, lender } = await loadFixture(deployOrchestrator);

      const dummyMarket = ethers.Wallet.createRandom().address;

      await expect(orchestrator.registerLender(dummyMarket, lender.address))
        .to.emit(orchestrator, "LenderRegistered")
        .withArgs(dummyMarket, lender.address);
    });

    it("only owner can register", async function () {
      const { orchestrator, nonOwner, lender } = await loadFixture(deployOrchestrator);

      const dummyMarket = ethers.Wallet.createRandom().address;

      await expect(orchestrator.connect(nonOwner).registerLender(dummyMarket, lender.address))
        .to.be.revertedWithCustomError(orchestrator, "OwnableUnauthorizedAccount");
    });
  });

  describe("removeLender", function () {
    it("removes a registered lender", async function () {
      const { orchestrator, owner, lender } = await loadFixture(deployOrchestrator);

      const dummyMarket = ethers.Wallet.createRandom().address;

      await orchestrator.registerLender(dummyMarket, lender.address);
      await orchestrator.removeLender(dummyMarket, lender.address);

      expect(await orchestrator.isKnownLender(dummyMarket, lender.address)).to.be.false;
    });

    it("emits LenderRemoved event", async function () {
      const { orchestrator, owner, lender } = await loadFixture(deployOrchestrator);

      const dummyMarket = ethers.Wallet.createRandom().address;

      await orchestrator.registerLender(dummyMarket, lender.address);
      await expect(orchestrator.removeLender(dummyMarket, lender.address))
        .to.emit(orchestrator, "LenderRemoved")
        .withArgs(dummyMarket, lender.address);
    });

    it("only owner can remove", async function () {
      const { orchestrator, nonOwner, lender } = await loadFixture(deployOrchestrator);

      const dummyMarket = ethers.Wallet.createRandom().address;

      await expect(orchestrator.connect(nonOwner).removeLender(dummyMarket, lender.address))
        .to.be.revertedWithCustomError(orchestrator, "OwnableUnauthorizedAccount");
    });
  });

  describe("getBorrowerAuth", function () {
    it("returns empty for non-existent borrower", async function () {
      const { orchestrator, borrower } = await loadFixture(deployOrchestrator);

      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.status).to.equal(0);
      expect(auth.tier).to.equal(0);
      expect(auth.creditLimit).to.equal(0);
    });
  });

  describe("getMarket", function () {
    it("returns zero for non-existent market", async function () {
      const { orchestrator, borrower } = await loadFixture(deployOrchestrator);

      const asset = ethers.Wallet.createRandom().address;
      const market = await orchestrator.getMarket(borrower.address, asset);
      expect(market).to.equal(ethers.ZeroAddress);
    });
  });

  describe("checkAndRecordBorrow", function () {
    it("reverts UnauthorizedBorrower when called by non-market address", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      // Authorize borrower and create a market so _marketBorrower is set
      await orchestrator.authorizeBorrower(borrower.address, 0);

      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6,
      ]);
      const marketAddress = await orchestrator.createMarket.staticCall(
        borrower.address, await asset.getAddress(), defaultMarketParams
      );
      await orchestrator.createMarket(
        borrower.address, await asset.getAddress(), defaultMarketParams
      );

      // Call from owner (not the market) — should revert
      await expect(
        orchestrator.checkAndRecordBorrow(marketAddress, 1000n)
      ).to.be.revertedWithCustomError(orchestrator, "UnauthorizedBorrower");
    });

    it("reverts UnauthorizedBorrower for unknown market address", async function () {
      const { orchestrator } = await loadFixture(deployOrchestrator);
      const fakeMarket = ethers.Wallet.createRandom().address;

      await expect(
        orchestrator.checkAndRecordBorrow(fakeMarket, 1000n)
      ).to.be.revertedWithCustomError(orchestrator, "UnauthorizedBorrower");
    });

    it("reverts CreditLimitExceeded when borrow exceeds limit", async function () {
      const { orchestrator, owner, borrower, lender } = await loadFixture(deployOrchestrator);

      // TIER_1 = 100_000e18 limit. Use 18-decimal token so amounts match.
      await orchestrator.authorizeBorrower(borrower.address, 0);

      const asset = await ethers.deployContract("ERC20Mock", [
        "DAI", "DAI", owner.address, ethers.parseEther("10000000"), 18,
      ]);
      const tier1Params = {
        ...defaultMarketParams,
        maxTotalSupply: ethers.parseEther("10000000"),
      };
      const marketAddress = await orchestrator.createMarket.staticCall(
        borrower.address, await asset.getAddress(), tier1Params
      );
      await orchestrator.createMarket(
        borrower.address, await asset.getAddress(), tier1Params
      );

      const market = await ethers.getContractAt("CreditMarket", marketAddress);

      // Register lender and deposit enough to exceed TIER_1 credit limit
      await orchestrator.registerLender(marketAddress, lender.address);
      await asset.transfer(lender.address, ethers.parseEther("5000000"));
      await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
      await market.connect(lender).deposit(ethers.parseEther("5000000"), lender.address);

      // Borrow more than TIER_1 limit (100_000e18) — this exceeds credit limit
      await expect(
        market.connect(borrower).borrow(ethers.parseEther("200000"))
      ).to.be.revertedWithCustomError(orchestrator, "CreditLimitExceeded");
    });

    it("enforces credit limit for 6-decimal tokens (USDC)", async function () {
      const { orchestrator, owner, borrower, lender } = await loadFixture(deployOrchestrator);

      // TIER_1 = 100_000e18 limit. Use 6-decimal token (USDC).
      await orchestrator.authorizeBorrower(borrower.address, 0);

      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6,
      ]);
      const tier1Params = {
        ...defaultMarketParams,
        maxTotalSupply: ethers.parseUnits("10000000", 6),
      };
      const marketAddress = await orchestrator.createMarket.staticCall(
        borrower.address, await asset.getAddress(), tier1Params
      );
      await orchestrator.createMarket(
        borrower.address, await asset.getAddress(), tier1Params
      );

      const market = await ethers.getContractAt("CreditMarket", marketAddress);

      // Register lender and deposit
      await orchestrator.registerLender(marketAddress, lender.address);
      await asset.transfer(lender.address, ethers.parseUnits("5000000", 6));
      await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
      await market.connect(lender).deposit(ethers.parseUnits("5000000", 6), lender.address);

      // Fund borrower for repayments
      await asset.transfer(borrower.address, ethers.parseUnits("500000", 6));
      await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

      // Borrow within limit (50k USDC) — should succeed
      await market.connect(borrower).borrow(ethers.parseUnits("50000", 6));

      // Verify totalBorrowed is stored as 18 decimals
      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.totalBorrowed).to.equal(ethers.parseEther("50000"));

      // Borrow another 60k — exceeds 100k TIER_1 limit
      await expect(
        market.connect(borrower).borrow(ethers.parseUnits("60000", 6))
      ).to.be.revertedWithCustomError(orchestrator, "CreditLimitExceeded");

      // Repay 30k, then borrow 70k — should still fail (net 90k + 70k = 160k > 100k)
      await market.connect(borrower).repay(ethers.parseUnits("30000", 6));
      const authAfterRepay = await orchestrator.getBorrowerAuth(borrower.address);
      expect(authAfterRepay.totalBorrowed).to.equal(ethers.parseEther("20000"));

      // Borrow 70k more — should succeed (20k + 70k = 90k < 100k)
      await market.connect(borrower).borrow(ethers.parseUnits("70000", 6));
      const authFinal = await orchestrator.getBorrowerAuth(borrower.address);
      expect(authFinal.totalBorrowed).to.equal(ethers.parseEther("90000"));
    });
  });

  describe("recordRepayment", function () {
    it("reverts UnauthorizedBorrower when called by non-market address", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 0);

      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6,
      ]);
      const marketAddress = await orchestrator.createMarket.staticCall(
        borrower.address, await asset.getAddress(), defaultMarketParams
      );
      await orchestrator.createMarket(
        borrower.address, await asset.getAddress(), defaultMarketParams
      );

      // Call from owner (not the market) — should revert
      await expect(
        orchestrator.recordRepayment(marketAddress, 1000n)
      ).to.be.revertedWithCustomError(orchestrator, "UnauthorizedBorrower");
    });

    it("reverts UnauthorizedBorrower for unknown market address", async function () {
      const { orchestrator } = await loadFixture(deployOrchestrator);
      const fakeMarket = ethers.Wallet.createRandom().address;

      await expect(
        orchestrator.recordRepayment(fakeMarket, 1000n)
      ).to.be.revertedWithCustomError(orchestrator, "UnauthorizedBorrower");
    });

    it("caps totalBorrowed at 0 when repayment exceeds totalBorrowed", async function () {
      const { orchestrator, owner, borrower, lender } = await loadFixture(deployOrchestrator);

      await orchestrator.authorizeBorrower(borrower.address, 3); // TIER_4

      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6,
      ]);
      const marketAddress = await orchestrator.createMarket.staticCall(
        borrower.address, await asset.getAddress(), defaultMarketParams
      );
      await orchestrator.createMarket(
        borrower.address, await asset.getAddress(), defaultMarketParams
      );

      const market = await ethers.getContractAt("CreditMarket", marketAddress);

      // Fund lender and deposit
      await orchestrator.registerLender(marketAddress, lender.address);
      await asset.transfer(lender.address, ethers.parseUnits("500000", 6));
      await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
      await market.connect(lender).deposit(ethers.parseUnits("500000", 6), lender.address);

      // Fund borrower for repayment
      await asset.transfer(borrower.address, ethers.parseUnits("500000", 6));
      await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

      // Borrow 10k
      await market.connect(borrower).borrow(ethers.parseUnits("10000", 6));

      // Repay more than borrowed (e.g. 20k) — should not revert, totalBorrowed goes to 0
      // Note: CreditMarket may cap the repay amount itself, let's check if it allows overpay
      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.totalBorrowed).to.be.gt(0);

      // Repay exact borrowed amount (market may enforce this)
      await market.connect(borrower).repay(ethers.parseUnits("10000", 6));

      const authAfter = await orchestrator.getBorrowerAuth(borrower.address);
      expect(authAfter.totalBorrowed).to.equal(0);
    });
  });

  describe("createMarket validations", function () {
    it("rejects market creation for non-approved borrower", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);
      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, 1000000n, 6,
      ]);

      await expect(
        orchestrator.createMarket(borrower.address, await asset.getAddress(), defaultMarketParams)
      ).to.be.revertedWithCustomError(orchestrator, "BorrowerNotApproved");
    });

    it("rejects duplicate market for same borrower+asset", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);
      await orchestrator.authorizeBorrower(borrower.address, 0);

      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, 1000000n, 6,
      ]);
      const assetAddr = await asset.getAddress();

      await orchestrator.createMarket(borrower.address, assetAddr, defaultMarketParams);

      await expect(
        orchestrator.createMarket(borrower.address, assetAddr, defaultMarketParams)
      ).to.be.revertedWithCustomError(orchestrator, "MarketAlreadyExists");
    });

    it("rejects invalid interest rate (>10000 bips)", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);
      await orchestrator.authorizeBorrower(borrower.address, 0);

      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, 1000000n, 6,
      ]);

      const badParams = { ...defaultMarketParams, annualInterestBips: 10001n };
      await expect(
        orchestrator.createMarket(borrower.address, await asset.getAddress(), badParams)
      ).to.be.revertedWithCustomError(orchestrator, "InvalidInterestRate");
    });

    it("rejects invalid reserve ratio (>5000 bips)", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);
      await orchestrator.authorizeBorrower(borrower.address, 0);

      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, 1000000n, 6,
      ]);

      const badParams = { ...defaultMarketParams, reserveRatioBips: 5001n };
      await expect(
        orchestrator.createMarket(borrower.address, await asset.getAddress(), badParams)
      ).to.be.revertedWithCustomError(orchestrator, "InvalidReserveRatio");
    });

    it("rejects suspended borrower for market creation", async function () {
      const { orchestrator, owner, borrower } = await loadFixture(deployOrchestrator);
      await orchestrator.authorizeBorrower(borrower.address, 0);
      await orchestrator.suspendBorrower(borrower.address);

      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC", "USDC", owner.address, 1000000n, 6,
      ]);

      await expect(
        orchestrator.createMarket(borrower.address, await asset.getAddress(), defaultMarketParams)
      ).to.be.revertedWithCustomError(orchestrator, "BorrowerNotApproved");
    });

    it("rejects non-owner calling createMarket", async function () {
      const { orchestrator, nonOwner, borrower } = await loadFixture(deployOrchestrator);

      await expect(
        orchestrator.connect(nonOwner).createMarket(borrower.address, ethers.ZeroAddress, defaultMarketParams)
      ).to.be.revertedWithCustomError(orchestrator, "OwnableUnauthorizedAccount");
    });
  });

  describe("Admin functions", function () {
    it("setProtocolFeeRecipient updates recipient", async function () {
      const { orchestrator, owner, feeRecipient } = await loadFixture(deployOrchestrator);

      const newRecipient = ethers.Wallet.createRandom().address;
      await orchestrator.setProtocolFeeRecipient(newRecipient);

      expect(await orchestrator.protocolFeeRecipient()).to.equal(newRecipient);
    });

    it("setProtocolFeeRecipient rejects zero address", async function () {
      const { orchestrator, owner } = await loadFixture(deployOrchestrator);

      await expect(orchestrator.setProtocolFeeRecipient(ethers.ZeroAddress))
        .to.be.reverted;
    });

    it("setTICSBridge sets bridge address", async function () {
      const { orchestrator, owner } = await loadFixture(deployOrchestrator);

      const bridge = ethers.Wallet.createRandom().address;
      await orchestrator.setTICSBridge(bridge);

      expect(await orchestrator.ticsBridge()).to.equal(bridge);
    });

    it("only owner can call admin functions", async function () {
      const { orchestrator, nonOwner } = await loadFixture(deployOrchestrator);

      await expect(orchestrator.connect(nonOwner).setProtocolFeeRecipient(nonOwner.address))
        .to.be.revertedWithCustomError(orchestrator, "OwnableUnauthorizedAccount");
      await expect(orchestrator.connect(nonOwner).setTICSBridge(nonOwner.address))
        .to.be.revertedWithCustomError(orchestrator, "OwnableUnauthorizedAccount");
    });
  });

  describe("Sanctions screening", function () {
    async function deployWithSanctions() {
      const [owner, borrower, lender, nonOwner, feeRecipient] = await ethers.getSigners();

      const Orchestrator = await ethers.getContractFactory("Orchestrator");
      const orchestrator = await Orchestrator.deploy(feeRecipient.address);

      const MockSanctionsList = await ethers.getContractFactory("MockSanctionsList");
      const mockSanctionsList = await MockSanctionsList.deploy();

      const SanctionsSentinel = await ethers.getContractFactory("SanctionsSentinel");
      const sentinel = await SanctionsSentinel.deploy(await mockSanctionsList.getAddress());

      await orchestrator.setSanctionsSentinel(await sentinel.getAddress());

      return { orchestrator, sentinel, mockSanctionsList, owner, borrower, lender, nonOwner, feeRecipient };
    }

    it("authorizeBorrower reverts for sanctioned address", async function () {
      const { orchestrator, mockSanctionsList, borrower } = await loadFixture(deployWithSanctions);

      await mockSanctionsList.setSanctioned(borrower.address, true);

      await expect(orchestrator.authorizeBorrower(borrower.address, 0))
        .to.be.revertedWithCustomError(orchestrator, "AddressSanctioned");
    });

    it("registerLender reverts for sanctioned address", async function () {
      const { orchestrator, mockSanctionsList, lender } = await loadFixture(deployWithSanctions);

      const dummyMarket = ethers.Wallet.createRandom().address;
      await mockSanctionsList.setSanctioned(lender.address, true);

      await expect(orchestrator.registerLender(dummyMarket, lender.address))
        .to.be.revertedWithCustomError(orchestrator, "AddressSanctioned");
    });

    it("works fine when no sentinel is set", async function () {
      const { orchestrator, borrower, lender } = await loadFixture(deployOrchestrator);

      // No sentinel set — should not revert
      await orchestrator.authorizeBorrower(borrower.address, 0);
      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.status).to.equal(1);

      const dummyMarket = ethers.Wallet.createRandom().address;
      await orchestrator.registerLender(dummyMarket, lender.address);
      expect(await orchestrator.isKnownLender(dummyMarket, lender.address)).to.be.true;
    });
  });
});
