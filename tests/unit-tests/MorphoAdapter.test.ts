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
  const makeMarketParams = (loanToken: string) => ({
    loanToken,
    collateralToken: hre.ethers.ZeroAddress,
    oracle: hre.ethers.ZeroAddress,
    irm: hre.ethers.ZeroAddress,
    lltv: 0n,
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
});
