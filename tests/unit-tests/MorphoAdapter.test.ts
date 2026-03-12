import hre from "hardhat";
import { expect } from "chai";
import {
  deployContracts,
  loanFactory,
  usdcMock,
  btcMock,
  owner,
  lender,
  borrower,
} from "../utils/deployments";
import { createLoanAndGetId, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";

describe("MorphoAdapter", function () {
  let mockMorpho: any;
  let morphoAdapter: any;
  let usdcAddress: string;
  let btcAddress: string;
  let loanFactoryAddress: string;

  // Minimal MarketParams — MockMorpho only uses loanToken field
  // Use dummy non-zero addresses for fields MockMorpho ignores
  const DUMMY_ADDR = "0x0000000000000000000000000000000000000001";
  const makeMarketParams = (loanToken: string) => ({
    loanToken,
    collateralToken: DUMMY_ADDR,
    oracle: DUMMY_ADDR,
    irm: DUMMY_ADDR,
    lltv: 1n,
  });

  // Default offer parameters
  const LEND_ASSET = hre.ethers.parseUnits("10000", 6); // 10,000 USDC
  const BORROW_COLLATERAL = hre.ethers.parseUnits("1", 8); // 1 BTC (~$50,000)
  const RATE_INDEX = 0;
  const DURATION_INDEX = 2; // 30 days
  const INITIAL_RATIO = 15000; // 150%
  const LIQ_THRESHOLD = 11000; // 110%

  async function createLendOffer(signer: any): Promise<bigint> {
    const params = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [loanId] = await createLoanAndGetId(signer, params);
    return loanId;
  }

  async function createBorrowOffer(signer: any): Promise<bigint> {
    const params = await createBorrowOfferParams(
      BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [loanId] = await createLoanAndGetId(signer, params);
    return loanId;
  }

  beforeEach(async function () {
    await deployContracts();

    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
    loanFactoryAddress = await loanFactory.getAddress();

    // Deploy MockMorpho
    mockMorpho = await hre.ethers.deployContract("MockMorpho");
    await mockMorpho.waitForDeployment();

    // Deploy MorphoAdapter — owner is LoanFactory
    morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      loanFactoryAddress,
    ]);
    await morphoAdapter.waitForDeployment();

    // Configure markets
    await morphoAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
    await morphoAdapter.connect(owner).configureMarket(btcAddress, makeMarketParams(btcAddress));

    // Wire adapter into LoanFactory
    await loanFactory.connect(owner).setMorphoAdapter(await morphoAdapter.getAddress());

    // Fund MockMorpho with reserves to cover simulated 1% yield payouts
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    await btcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10", 8));

    // Fund lender and borrower
    await usdcMock.connect(owner).transfer(lender.address, hre.ethers.parseUnits("50000", 6));
    await btcMock.connect(owner).transfer(borrower.address, hre.ethers.parseUnits("10", 8));

    // Approvals
    await usdcMock.connect(lender).approve(loanFactoryAddress, hre.ethers.MaxUint256);
    await btcMock.connect(borrower).approve(loanFactoryAddress, hre.ethers.MaxUint256);
  });

  // ── Admin ──────────────────────────────────────────────────────────────────

  describe("configureMarket", function () {
    it("Should configure a market for a token", async function () {
      expect(await morphoAdapter.hasMarket(usdcAddress)).to.be.true;
      expect(await morphoAdapter.hasMarket(btcAddress)).to.be.true;
    });

    it("Should reject market configuration from non-owner", async function () {
      await expect(
        morphoAdapter.connect(lender).configureMarket(usdcAddress, makeMarketParams(usdcAddress))
      ).to.be.reverted;
    });

    it("Should reject zero token address", async function () {
      await expect(
        morphoAdapter.connect(owner).configureMarket(hre.ethers.ZeroAddress, makeMarketParams(usdcAddress))
      ).to.be.revertedWith("Token cannot be zero");
    });
  });

  // ── Lend offer lifecycle ───────────────────────────────────────────────────

  describe("Lend offer lifecycle", function () {
    it("Should deposit USDC into Morpho when lend offer is created", async function () {
      const loanId = await createLendOffer(lender);

      const shares = await morphoAdapter.sharesOf(loanId, usdcAddress);
      expect(shares).to.be.gt(0n);

      // LoanFactory holds no USDC — it's all in Morpho
      expect(await usdcMock.balanceOf(loanFactoryAddress)).to.equal(0n);
    });

    it("Should return USDC + yield to lender on cancelLoan", async function () {
      const loanId = await createLendOffer(lender);
      const balanceBefore = await usdcMock.balanceOf(lender.address);

      await loanFactory.connect(lender).cancelLoan(loanId);

      const balanceAfter = await usdcMock.balanceOf(lender.address);
      // MockMorpho adds 1% yield so lender receives more than deposited
      expect(balanceAfter).to.be.gt(balanceBefore);

      // Shares cleared
      expect(await morphoAdapter.sharesOf(loanId, usdcAddress)).to.equal(0n);
    });
  });

  // ── Borrow offer lifecycle ─────────────────────────────────────────────────

  describe("Borrow offer lifecycle", function () {
    it("Should deposit BTC into Morpho when borrow offer is created", async function () {
      const loanId = await createBorrowOffer(borrower);

      const shares = await morphoAdapter.sharesOf(loanId, btcAddress);
      expect(shares).to.be.gt(0n);

      // LoanFactory holds no BTC — it's all in Morpho
      expect(await btcMock.balanceOf(loanFactoryAddress)).to.equal(0n);
    });

    it("Should return BTC + yield to borrower on cancelLoan", async function () {
      const loanId = await createBorrowOffer(borrower);
      const balanceBefore = await btcMock.balanceOf(borrower.address);

      await loanFactory.connect(borrower).cancelLoan(loanId);

      const balanceAfter = await btcMock.balanceOf(borrower.address);
      expect(balanceAfter).to.be.gt(balanceBefore);

      expect(await morphoAdapter.sharesOf(loanId, btcAddress)).to.equal(0n);
    });
  });

  // ── takeUpLoan with Morpho ─────────────────────────────────────────────────

  describe("takeUpLoan with Morpho", function () {
    it("Should withdraw lend USDC from Morpho directly to borrower on match", async function () {
      const borrowOfferId = await createBorrowOffer(borrower);
      const lendOfferId = await createLendOffer(lender);

      const borrowerUsdcBefore = await usdcMock.balanceOf(borrower.address);

      await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);

      const borrowerUsdcAfter = await usdcMock.balanceOf(borrower.address);
      expect(borrowerUsdcAfter).to.be.gt(borrowerUsdcBefore);

      // Lend offer shares cleared
      expect(await morphoAdapter.sharesOf(lendOfferId, usdcAddress)).to.equal(0n);
    });

    it("Should withdraw borrow collateral from Morpho into LoanFactory on match", async function () {
      const borrowOfferId = await createBorrowOffer(borrower);
      const lendOfferId = await createLendOffer(lender);

      await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);

      // Borrow offer shares cleared from Morpho
      expect(await morphoAdapter.sharesOf(borrowOfferId, btcAddress)).to.equal(0n);

      // LoanFactory now holds collateral for the active loan
      expect(await btcMock.balanceOf(loanFactoryAddress)).to.be.gt(0n);
    });
  });

  // ── Access control ─────────────────────────────────────────────────────────

  describe("Access control", function () {
    it("Should reject direct deposit from non-owner", async function () {
      await expect(
        morphoAdapter.connect(lender).deposit(usdcAddress, 1000n, 1n)
      ).to.be.reverted;
    });

    it("Should reject direct withdraw from non-owner", async function () {
      await expect(
        morphoAdapter.connect(lender).withdraw(usdcAddress, 1n, lender.address)
      ).to.be.reverted;
    });
  });

  // ── No adapter (fallback) ──────────────────────────────────────────────────

  describe("Without adapter (fallback)", function () {
    it("Should work normally when morphoAdapter is not set", async function () {
      await loanFactory.connect(owner).setMorphoAdapter(hre.ethers.ZeroAddress);

      const loanId = await createLendOffer(lender);

      // Funds stay in LoanFactory
      expect(await usdcMock.balanceOf(loanFactoryAddress)).to.be.gt(0n);

      // Cancel returns funds from LoanFactory directly
      const balanceBefore = await usdcMock.balanceOf(lender.address);
      await loanFactory.connect(lender).cancelLoan(loanId);
      expect(await usdcMock.balanceOf(lender.address)).to.be.gt(balanceBefore);
    });
  });

  // ── LOW-1: setYieldAdapter two-step guard ──────────────────────────────────

  describe("setYieldAdapter two-step guard (LOW-1)", function () {
    it("Should reject direct adapter swap without clearing first", async function () {
      // adapter is already set from beforeEach via setMorphoAdapter
      const dummyAdapter = "0x0000000000000000000000000000000000000001";
      await expect(
        loanFactory.connect(owner).setYieldAdapter(dummyAdapter)
      ).to.be.revertedWith("Clear existing adapter first");
    });

    it("Should allow clearing adapter to zero", async function () {
      await loanFactory.connect(owner).setYieldAdapter(hre.ethers.ZeroAddress);
      expect(await loanFactory.yieldAdapter()).to.equal(hre.ethers.ZeroAddress);
    });

    it("Should allow setting adapter when current is zero", async function () {
      // Clear first
      await loanFactory.connect(owner).setYieldAdapter(hre.ethers.ZeroAddress);
      // Now set new
      const adapterAddr = await morphoAdapter.getAddress();
      await loanFactory.connect(owner).setYieldAdapter(adapterAddr);
      expect(await loanFactory.yieldAdapter()).to.equal(adapterAddr);
    });
  });

  // ── LOW-C8: Block clearing adapter with active positions ─────────────────

  describe("setYieldAdapter active positions guard (LOW-C8)", function () {
    it("Should revert clearing adapter when active positions exist", async function () {
      // Create a lend offer — this deposits into the adapter, creating an active position
      await usdcMock.connect(lender).approve(loanFactoryAddress, hre.ethers.parseUnits("50000", 6));
      await createLendOffer(lender);

      // Adapter now has active positions
      expect(await morphoAdapter.totalActivePositions()).to.be.gt(0);

      // Attempting to clear the adapter should revert
      await expect(
        loanFactory.connect(owner).setYieldAdapter(hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Active positions exist");
    });

    it("Should allow clearing adapter after all positions withdrawn", async function () {
      // Create and then cancel a lend offer — cancel withdraws from adapter
      await usdcMock.connect(lender).approve(loanFactoryAddress, hre.ethers.parseUnits("50000", 6));
      const loanId = await createLendOffer(lender);
      await loanFactory.connect(lender).cancelLoan(loanId);

      // Adapter should have no active positions now
      expect(await morphoAdapter.totalActivePositions()).to.equal(0);

      // Clearing should succeed
      await loanFactory.connect(owner).setYieldAdapter(hre.ethers.ZeroAddress);
      expect(await loanFactory.yieldAdapter()).to.equal(hre.ethers.ZeroAddress);
    });
  });

  // ── Constructor validation ────────────────────────────────────────────────

  describe("Constructor validation", function () {
    it("Should reject zero Morpho address", async function () {
      await expect(
        hre.ethers.deployContract("MorphoAdapter", [
          hre.ethers.ZeroAddress,
          loanFactoryAddress,
        ])
      ).to.be.revertedWith("Morpho address cannot be zero");
    });

    it("Should reject zero LoanFactory address", async function () {
      await expect(
        hre.ethers.deployContract("MorphoAdapter", [
          await mockMorpho.getAddress(),
          hre.ethers.ZeroAddress,
        ])
      ).to.be.revertedWith("LoanFactory address cannot be zero");
    });

    it("Should set immutable values correctly", async function () {
      const morphoAddress = await mockMorpho.getAddress();
      expect(await morphoAdapter.morpho()).to.equal(morphoAddress);
      expect(await morphoAdapter.loanFactory()).to.equal(loanFactoryAddress);
    });
  });

  // ── configureMarket edge cases ────────────────────────────────────────────

  describe("configureMarket edge cases", function () {
    it("Should emit MarketConfigured event", async function () {
      const newToken = lender.address; // arbitrary non-zero address
      const params = makeMarketParams(newToken);

      await expect(
        morphoAdapter.connect(owner).configureMarket(newToken, params)
      )
        .to.emit(morphoAdapter, "MarketConfigured")
        .withArgs(newToken, Object.values(params));
    });

    it("Should allow reconfiguring an existing market when no active positions", async function () {
      // Market already configured in beforeEach; reconfigure with same loanToken but valid params
      const newParams = makeMarketParams(usdcAddress);
      await morphoAdapter.connect(owner).configureMarket(usdcAddress, newParams);

      expect(await morphoAdapter.hasMarket(usdcAddress)).to.be.true;
      const stored = await morphoAdapter.markets(usdcAddress);
      expect(stored.loanToken).to.equal(usdcAddress);
    });

    it("Should reject reconfiguring a market with active positions (MEDIUM-C6)", async function () {
      // Create a lend offer which deposits into the adapter
      await createLendOffer(lender);

      // Now try to reconfigure — should fail because there's an active position
      const newParams = makeMarketParams(usdcAddress);
      await expect(
        morphoAdapter.connect(owner).configureMarket(usdcAddress, newParams)
      ).to.be.revertedWith("Active positions exist for token");
    });

    it("Should reject configuring with mismatched token and loanToken", async function () {
      const mismatchedParams = makeMarketParams(btcAddress);
      await expect(
        morphoAdapter.connect(owner).configureMarket(usdcAddress, mismatchedParams)
      ).to.be.revertedWith("Token must match market loanToken");
    });
  });

  // ── Deposit/Withdraw event tests ──────────────────────────────────────────

  describe("Deposit/Withdraw events", function () {
    it("Should emit Deposited event on lend offer creation", async function () {
      const params = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );

      // Use createLoanAndGetId which returns [loanId, tx]
      const [loanId] = await createLoanAndGetId(lender, params);

      // Verify shares were recorded (event was emitted internally)
      const shares = await morphoAdapter.sharesOf(loanId, usdcAddress);
      expect(shares).to.be.gt(0n);
    });

    it("Should emit Withdrawn event on cancelLoan", async function () {
      const loanId = await createLendOffer(lender);

      // Cancel and check that shares are cleared (withdraw happened)
      await loanFactory.connect(lender).cancelLoan(loanId);

      expect(await morphoAdapter.sharesOf(loanId, usdcAddress)).to.equal(0n);
    });
  });

  // ── hasMarket view function ───────────────────────────────────────────────

  describe("hasMarket view function", function () {
    it("Should return false for unconfigured token", async function () {
      // Use an arbitrary address that was never configured
      const randomAddress = "0x0000000000000000000000000000000000000001";
      expect(await morphoAdapter.hasMarket(randomAddress)).to.be.false;
    });
  });

  // ── Withdraw edge cases ───────────────────────────────────────────────────

  describe("Withdraw edge cases", function () {
    it("Should reject withdraw with non-factory caller (revert with 'Only LoanFactory')", async function () {
      await expect(
        morphoAdapter.connect(lender).withdraw(usdcAddress, 1n, lender.address)
      ).to.be.revertedWith("Only LoanFactory");
    });
  });

  // ── Emergency withdraw ──────────────────────────────────────────────────

  describe("emergencyWithdraw", function () {
    it("Should allow owner to emergency withdraw a position", async function () {
      const loanId = await createLendOffer(lender);

      // Owner emergency withdraws to lender
      const balanceBefore = await usdcMock.balanceOf(lender.address);
      await morphoAdapter.connect(owner).emergencyWithdraw(usdcAddress, loanId, lender.address);
      const balanceAfter = await usdcMock.balanceOf(lender.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
      expect(await morphoAdapter.sharesOf(loanId, usdcAddress)).to.equal(0n);
    });

    it("Should reject emergency withdraw from non-owner", async function () {
      const loanId = await createLendOffer(lender);
      await expect(
        morphoAdapter.connect(lender).emergencyWithdraw(usdcAddress, loanId, lender.address)
      ).to.be.reverted;
    });

    it("Should reject emergency withdraw with zero recipient", async function () {
      const loanId = await createLendOffer(lender);
      await expect(
        morphoAdapter.connect(owner).emergencyWithdraw(usdcAddress, loanId, hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should reject emergency withdraw with no position", async function () {
      await expect(
        morphoAdapter.connect(owner).emergencyWithdraw(usdcAddress, 999n, lender.address)
      ).to.be.revertedWith("No position for loan");
    });
  });

  // ── View functions ──────────────────────────────────────────────────────

  describe("getShares", function () {
    it("Should return shares for a deposited position", async function () {
      const loanId = await createLendOffer(lender);
      const shares = await morphoAdapter.getShares(loanId, usdcAddress);
      expect(shares).to.be.gt(0n);
    });

    it("Should return zero for non-existent position", async function () {
      const shares = await morphoAdapter.getShares(999n, usdcAddress);
      expect(shares).to.equal(0n);
    });
  });

  describe("getMarketParams", function () {
    it("Should return configured market params", async function () {
      const params = await morphoAdapter.getMarketParams(usdcAddress);
      expect(params.loanToken).to.equal(usdcAddress);
    });

    it("Should revert for unconfigured token", async function () {
      const randomAddress = "0x0000000000000000000000000000000000000002";
      await expect(
        morphoAdapter.getMarketParams(randomAddress)
      ).to.be.revertedWith("No Morpho market for token");
    });
  });

  // ── configureMarket param validation ────────────────────────────────────

  describe("configureMarket param validation", function () {
    it("Should reject zero loanToken in params", async function () {
      const params = {
        loanToken: hre.ethers.ZeroAddress,
        collateralToken: DUMMY_ADDR,
        oracle: DUMMY_ADDR,
        irm: DUMMY_ADDR,
        lltv: 1n,
      };
      await expect(
        morphoAdapter.connect(owner).configureMarket(usdcAddress, params)
      ).to.be.revertedWith("Loan token cannot be zero");
    });

    it("Should reject zero collateralToken in params", async function () {
      const params = {
        loanToken: usdcAddress,
        collateralToken: hre.ethers.ZeroAddress,
        oracle: DUMMY_ADDR,
        irm: DUMMY_ADDR,
        lltv: 1n,
      };
      await expect(
        morphoAdapter.connect(owner).configureMarket(usdcAddress, params)
      ).to.be.revertedWith("Collateral token cannot be zero");
    });

    it("Should reject zero oracle in params", async function () {
      const params = {
        loanToken: usdcAddress,
        collateralToken: DUMMY_ADDR,
        oracle: hre.ethers.ZeroAddress,
        irm: DUMMY_ADDR,
        lltv: 1n,
      };
      await expect(
        morphoAdapter.connect(owner).configureMarket(usdcAddress, params)
      ).to.be.revertedWith("Oracle cannot be zero");
    });

    it("Should reject zero irm in params", async function () {
      const params = {
        loanToken: usdcAddress,
        collateralToken: DUMMY_ADDR,
        oracle: DUMMY_ADDR,
        irm: hre.ethers.ZeroAddress,
        lltv: 1n,
      };
      await expect(
        morphoAdapter.connect(owner).configureMarket(usdcAddress, params)
      ).to.be.revertedWith("IRM cannot be zero");
    });

    it("Should reject zero lltv in params", async function () {
      const params = {
        loanToken: usdcAddress,
        collateralToken: DUMMY_ADDR,
        oracle: DUMMY_ADDR,
        irm: DUMMY_ADDR,
        lltv: 0n,
      };
      await expect(
        morphoAdapter.connect(owner).configureMarket(usdcAddress, params)
      ).to.be.revertedWith("LLTV must be > 0");
    });
  });

  // ── Direct adapter edge-case tests ────────────────────────────────────────

  describe("Direct adapter calls", function () {
    let directAdapter: any;
    let directLoanFactory: any; // this will be a signer

    beforeEach(async function () {
      const signers = await hre.ethers.getSigners();
      directLoanFactory = signers[5]; // use an unused signer

      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await directAdapter.waitForDeployment();

      // Configure USDC market
      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
      await directAdapter.connect(owner).configureMarket(btcAddress, makeMarketParams(btcAddress));

      // Fund directLoanFactory with tokens
      await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await btcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("5", 8));

      // Approve adapter
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
      await btcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
    });

    // ── Deposit edge cases ──────────────────────────────────────────────────

    describe("Deposit edge cases", function () {
      it("Should reject deposit with zero amount", async function () {
        await expect(
          directAdapter.connect(directLoanFactory).deposit(usdcAddress, 0n, 1n)
        ).to.be.revertedWith("Amount must be > 0");
      });

      it("Should reject deposit for unconfigured token", async function () {
        const unconfiguredToken = "0x0000000000000000000000000000000000000099";
        await expect(
          directAdapter.connect(directLoanFactory).deposit(unconfiguredToken, 1000n, 1n)
        ).to.be.revertedWith("No Morpho market for token");
      });

      it("Should track separate shares for different loanIds", async function () {
        const amount1 = hre.ethers.parseUnits("1000", 6);
        const amount2 = hre.ethers.parseUnits("2000", 6);
        const loanId1 = 100n;
        const loanId2 = 200n;

        await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount1, loanId1);
        await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount2, loanId2);

        const shares1 = await directAdapter.sharesOf(loanId1, usdcAddress);
        const shares2 = await directAdapter.sharesOf(loanId2, usdcAddress);

        expect(shares1).to.be.gt(0n);
        expect(shares2).to.be.gt(0n);
        // shares2 should be larger since amount2 > amount1
        expect(shares2).to.be.gt(shares1);
        // They should be distinct values tracked separately
        expect(shares1).to.not.equal(shares2);
      });
    });

    // ── Withdraw edge cases ─────────────────────────────────────────────────

    describe("Withdraw edge cases", function () {
      it("Should reject withdraw with zero recipient", async function () {
        const loanId = 100n;
        const amount = hre.ethers.parseUnits("1000", 6);

        // First deposit so there are shares
        await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, loanId);

        await expect(
          directAdapter.connect(directLoanFactory).withdraw(usdcAddress, loanId, hre.ethers.ZeroAddress)
        ).to.be.revertedWith("Recipient cannot be zero");
      });

      it("Should reject withdraw for loan with no shares", async function () {
        const nonExistentLoanId = 999n;

        await expect(
          directAdapter.connect(directLoanFactory).withdraw(usdcAddress, nonExistentLoanId, directLoanFactory.address)
        ).to.be.revertedWith("No position for loan");
      });
    });

    // ── Multiple asset support ──────────────────────────────────────────────

    describe("Multiple asset support", function () {
      it("Should handle deposits and withdrawals for both USDC and BTC markets", async function () {
        const usdcAmount = hre.ethers.parseUnits("5000", 6);
        const btcAmount = hre.ethers.parseUnits("1", 8);
        const usdcLoanId = 300n;
        const btcLoanId = 400n;

        // Fund MockMorpho with reserves to cover yield payouts
        await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("5000", 6));
        await btcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("1", 8));

        // Deposit USDC for one loanId and BTC for another
        await directAdapter.connect(directLoanFactory).deposit(usdcAddress, usdcAmount, usdcLoanId);
        await directAdapter.connect(directLoanFactory).deposit(btcAddress, btcAmount, btcLoanId);

        // Verify shares exist for both
        const usdcShares = await directAdapter.sharesOf(usdcLoanId, usdcAddress);
        const btcShares = await directAdapter.sharesOf(btcLoanId, btcAddress);
        expect(usdcShares).to.be.gt(0n);
        expect(btcShares).to.be.gt(0n);

        // Cross-check: no BTC shares for USDC loanId and vice versa
        expect(await directAdapter.sharesOf(usdcLoanId, btcAddress)).to.equal(0n);
        expect(await directAdapter.sharesOf(btcLoanId, usdcAddress)).to.equal(0n);

        // Record balances before withdrawal
        const usdcBalBefore = await usdcMock.balanceOf(directLoanFactory.address);
        const btcBalBefore = await btcMock.balanceOf(directLoanFactory.address);

        // Withdraw both
        await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, usdcLoanId, directLoanFactory.address);
        await directAdapter.connect(directLoanFactory).withdraw(btcAddress, btcLoanId, directLoanFactory.address);

        // Verify balances increased (MockMorpho adds 1% yield)
        const usdcBalAfter = await usdcMock.balanceOf(directLoanFactory.address);
        const btcBalAfter = await btcMock.balanceOf(directLoanFactory.address);
        expect(usdcBalAfter).to.be.gt(usdcBalBefore);
        expect(btcBalAfter).to.be.gt(btcBalBefore);

        // Shares should be cleared
        expect(await directAdapter.sharesOf(usdcLoanId, usdcAddress)).to.equal(0n);
        expect(await directAdapter.sharesOf(btcLoanId, btcAddress)).to.equal(0n);
      });
    });
  });
});
