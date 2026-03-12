/**
 * CoverageGaps.test.ts
 *
 * Targets uncovered branches across all core contracts to push coverage >=90%.
 * Focuses on negative paths (reverts), admin edge cases, and guard conditions
 * that TS-only coverage doesn't reach via existing tests.
 *
 * Contracts covered:
 *   - PriceOracle: constructor, setFeed, ownership, staleness, invalidPrice, deviation
 *   - MorphoAdapter: freeze, bulk pause/freeze, deposit guards, withdraw guards
 *   - LoanFactory: constructor, createLoan validation, cancelLoan/takeUpLoan guards,
 *                  MEDIUM-7 post-withdrawal re-validation, endLoan edge cases
 *   - LoanCalculator: hoursElapsed=0, loanAmount=0
 */
import hre from "hardhat";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployContracts,
  loanFactory,
  usdcMock,
  btcMock,
  owner,
  lender,
  borrower,
  priceOracle,
  mockAggregator,
  assetRegistry,
  loanCalculatorTest,
  MOCK_BTC_PRICE,
} from "../utils/deployments";
import {
  createLoanAndGetId,
  createLendOfferParams,
  createBorrowOfferParams,
  fastForwardTime,
} from "../utils/loanHelpers";

// ═══════════════════════════════════════════════════════════════════════════
// PRICE ORACLE — Branch Coverage
// ═══════════════════════════════════════════════════════════════════════════

describe("PriceOracle — branch coverage gaps", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // ── setFeed zero address reverts ────────────────────────────────────
  describe("setFeed validation", function () {
    it("Should revert ZeroAddress when token is zero", async function () {
      await expect(
        priceOracle.setFeed(ethers.ZeroAddress, await mockAggregator.getAddress(), 3600)
      ).to.be.revertedWithCustomError(priceOracle, "ZeroAddress");
    });

    it("Should revert ZeroAddress when feed is zero", async function () {
      await expect(
        priceOracle.setFeed(await btcMock.getAddress(), ethers.ZeroAddress, 3600)
      ).to.be.revertedWithCustomError(priceOracle, "ZeroAddress");
    });

    it("Should revert Unauthorized when non-owner calls setFeed", async function () {
      await expect(
        priceOracle.connect(lender).setFeed(await btcMock.getAddress(), await mockAggregator.getAddress(), 3600)
      ).to.be.revertedWithCustomError(priceOracle, "Unauthorized");
    });
  });

  // ── transferOwnership zero address ──────────────────────────────────
  describe("Ownership validation", function () {
    it("Should revert ZeroAddress when transferring to zero", async function () {
      await expect(
        priceOracle.transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(priceOracle, "ZeroAddress");
    });

    it("Should revert Unauthorized when non-owner calls transferOwnership", async function () {
      await expect(
        priceOracle.connect(lender).transferOwnership(lender.address)
      ).to.be.revertedWithCustomError(priceOracle, "Unauthorized");
    });

    it("Should revert Unauthorized when non-pendingOwner calls acceptOwnership", async function () {
      await priceOracle.transferOwnership(lender.address);
      await expect(
        priceOracle.connect(borrower).acceptOwnership()
      ).to.be.revertedWithCustomError(priceOracle, "Unauthorized");
    });

    it("Should revert Unauthorized when non-owner calls setMaxDeviation", async function () {
      await expect(
        priceOracle.connect(lender).setMaxDeviation(3000)
      ).to.be.revertedWithCustomError(priceOracle, "Unauthorized");
    });
  });

  // ── InvalidPrice (answer <= 0) ──────────────────────────────────────
  describe("InvalidPrice revert", function () {
    it("Should revert InvalidPrice when price is zero", async function () {
      await mockAggregator.setAnswer(0);
      const oneBtc = hre.ethers.parseUnits("1", 8);
      await expect(
        priceOracle.getOraclePrice(oneBtc, await btcMock.getAddress(), 6)
      ).to.be.revertedWithCustomError(priceOracle, "InvalidPrice");
    });

    it("Should revert InvalidPrice when price is negative", async function () {
      await mockAggregator.setAnswer(-1);
      const oneBtc = hre.ethers.parseUnits("1", 8);
      await expect(
        priceOracle.getOraclePrice(oneBtc, await btcMock.getAddress(), 6)
      ).to.be.revertedWithCustomError(priceOracle, "InvalidPrice");
    });
  });

  // ── StalePrice (timestamp staleness) ────────────────────────────────
  describe("StalePrice revert (timestamp)", function () {
    it("Should revert StalePrice when feed is stale", async function () {
      // Deploy oracle with tight staleness (60 seconds)
      const tightOracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
      await tightOracle.waitForDeployment();
      await tightOracle.setFeed(
        await btcMock.getAddress(),
        await mockAggregator.getAddress(),
        60 // 60 seconds staleness
      );

      // Advance time 120 seconds
      await hre.network.provider.send("evm_increaseTime", [120]);
      await hre.network.provider.send("evm_mine", []);

      const oneBtc = hre.ethers.parseUnits("1", 8);
      await expect(
        tightOracle.getOraclePrice(oneBtc, await btcMock.getAddress(), 6)
      ).to.be.revertedWithCustomError(tightOracle, "StalePrice");
    });
  });

  // ── FeedNotConfigured on checked getOraclePrice ─────────────────────
  describe("FeedNotConfigured on checked functions", function () {
    it("Should revert FeedNotConfigured on getOraclePrice for unknown token", async function () {
      const oneBtc = hre.ethers.parseUnits("1", 8);
      await expect(
        priceOracle.getOraclePrice(oneBtc, await usdcMock.getAddress(), 6)
      ).to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured");
    });

    it("Should revert FeedNotConfigured on getInverseOraclePrice for unknown token", async function () {
      await expect(
        priceOracle.getInverseOraclePrice(1000n, await usdcMock.getAddress(), 6)
      ).to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MORPHO ADAPTER — Branch Coverage
// ═══════════════════════════════════════════════════════════════════════════

describe("MorphoAdapter — branch coverage gaps", function () {
  let mockMorpho: any;
  let adapter: any;
  let callerSigner: any; // acts as LoanFactory
  let usdcAddress: string;
  let btcAddress: string;

  const DUMMY_ADDR = "0x0000000000000000000000000000000000000001";
  const makeMarketParams = (loanToken: string) => ({
    loanToken,
    collateralToken: DUMMY_ADDR,
    oracle: DUMMY_ADDR,
    irm: DUMMY_ADDR,
    lltv: 1n,
  });

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();

    const signers = await hre.ethers.getSigners();
    callerSigner = signers[5];

    mockMorpho = await hre.ethers.deployContract("MockMorpho");
    await mockMorpho.waitForDeployment();

    adapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      callerSigner.address,
    ]);
    await adapter.waitForDeployment();

    await adapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
    await adapter.connect(owner).configureMarket(btcAddress, makeMarketParams(btcAddress));

    // Fund caller and approve
    await usdcMock.connect(owner).transfer(callerSigner.address, hre.ethers.parseUnits("100000", 6));
    await usdcMock.connect(callerSigner).approve(await adapter.getAddress(), hre.ethers.MaxUint256);

    // Fund MockMorpho for withdrawals
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("100000", 6));
  });

  // ── Bulk pause/freeze ──────────────────────────────────────────────
  describe("setPauseStatusForAllMarkets", function () {
    it("Should pause all markets", async function () {
      await expect(adapter.connect(owner).setPauseStatusForAllMarkets(true))
        .to.emit(adapter, "AllMarketsPauseToggled")
        .withArgs(true);
      expect(await adapter.isMarketPaused(usdcAddress)).to.be.true;
      expect(await adapter.isMarketPaused(btcAddress)).to.be.true;
    });

    it("Should unpause all markets", async function () {
      await adapter.connect(owner).setPauseStatusForAllMarkets(true);
      await adapter.connect(owner).setPauseStatusForAllMarkets(false);
      expect(await adapter.isMarketPaused(usdcAddress)).to.be.false;
      expect(await adapter.isMarketPaused(btcAddress)).to.be.false;
    });

    it("Should reject from non-owner", async function () {
      await expect(
        adapter.connect(callerSigner).setPauseStatusForAllMarkets(true)
      ).to.be.reverted;
    });
  });

  describe("setFreezeStatusForAllMarkets", function () {
    it("Should freeze all markets", async function () {
      await expect(adapter.connect(owner).setFreezeStatusForAllMarkets(true))
        .to.emit(adapter, "AllMarketsFreezeToggled")
        .withArgs(true);
      expect(await adapter.marketFrozen(usdcAddress)).to.be.true;
      expect(await adapter.marketFrozen(btcAddress)).to.be.true;
    });

    it("Should unfreeze all markets", async function () {
      await adapter.connect(owner).setFreezeStatusForAllMarkets(true);
      await adapter.connect(owner).setFreezeStatusForAllMarkets(false);
      expect(await adapter.marketFrozen(usdcAddress)).to.be.false;
    });
  });

  // ── setMarketFrozen with unconfigured token ────────────────────────
  describe("setMarketFrozen validation", function () {
    it("Should revert for unconfigured token", async function () {
      const fakeToken = "0x0000000000000000000000000000000000000099";
      await expect(
        adapter.connect(owner).setMarketFrozen(fakeToken, true)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should emit MarketFreezeToggled", async function () {
      await expect(adapter.connect(owner).setMarketFrozen(usdcAddress, true))
        .to.emit(adapter, "MarketFreezeToggled")
        .withArgs(usdcAddress, true);
    });
  });

  // ── deposit guards ─────────────────────────────────────────────────
  describe("deposit guards", function () {
    it("Should revert when market is frozen", async function () {
      await adapter.connect(owner).setMarketFrozen(usdcAddress, true);
      await expect(
        adapter.connect(callerSigner).deposit(usdcAddress, 1000n, 1n)
      ).to.be.revertedWith("Market frozen");
    });

    it("Should revert when amount is zero", async function () {
      await expect(
        adapter.connect(callerSigner).deposit(usdcAddress, 0n, 1n)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should revert for unconfigured market", async function () {
      const fakeToken = "0x0000000000000000000000000000000000000099";
      await expect(
        adapter.connect(callerSigner).deposit(fakeToken, 1000n, 1n)
      ).to.be.revertedWith("No Morpho market for token");
    });
  });

  // ── withdraw guards ────────────────────────────────────────────────
  describe("withdraw guards", function () {
    it("Should revert when recipient is zero address", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(callerSigner).deposit(usdcAddress, amount, 1n);
      await expect(
        adapter.connect(callerSigner).withdraw(usdcAddress, 1n, ethers.ZeroAddress)
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should revert when market is frozen", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(callerSigner).deposit(usdcAddress, amount, 1n);
      await adapter.connect(owner).setMarketFrozen(usdcAddress, true);
      await expect(
        adapter.connect(callerSigner).withdraw(usdcAddress, 1n, callerSigner.address)
      ).to.be.revertedWith("Market frozen");
    });

    it("Should revert when no position exists", async function () {
      await expect(
        adapter.connect(callerSigner).withdraw(usdcAddress, 99n, callerSigner.address)
      ).to.be.revertedWith("No position for loan");
    });
  });

  // ── emergencyWithdraw guards ───────────────────────────────────────
  describe("emergencyWithdraw guards", function () {
    it("Should revert when recipient is zero address", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(callerSigner).deposit(usdcAddress, amount, 1n);
      await expect(
        adapter.connect(owner).emergencyWithdraw(usdcAddress, 1n, ethers.ZeroAddress)
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should revert when no position exists", async function () {
      await expect(
        adapter.connect(owner).emergencyWithdraw(usdcAddress, 99n, owner.address)
      ).to.be.revertedWith("No position for loan");
    });
  });

  // ── batchEmergencyWithdraw zero address ────────────────────────────
  describe("batchEmergencyWithdraw guards", function () {
    it("Should revert when recipient is zero address", async function () {
      await expect(
        adapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [1n], ethers.ZeroAddress)
      ).to.be.revertedWith("Recipient cannot be zero");
    });
  });

  // ── configureMarket reconfiguration guard ──────────────────────────
  describe("configureMarket guards", function () {
    it("Should reject reconfiguration when active positions exist", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(callerSigner).deposit(usdcAddress, amount, 1n);
      await expect(
        adapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress))
      ).to.be.revertedWith("Active positions exist for token");
    });

    it("Should reject zero token address", async function () {
      await expect(
        adapter.connect(owner).configureMarket(ethers.ZeroAddress, makeMarketParams(ethers.ZeroAddress))
      ).to.be.revertedWith("Token cannot be zero");
    });

    it("Should reject mismatched token/loanToken", async function () {
      // token is btcAddress but loanToken is usdcAddress
      await expect(
        adapter.connect(owner).configureMarket(
          "0x0000000000000000000000000000000000000099",
          makeMarketParams(usdcAddress)
        )
      ).to.be.revertedWith("Token must match market loanToken");
    });
  });

  // ── getMarketParams for unconfigured token ─────────────────────────
  describe("getMarketParams guard", function () {
    it("Should revert for unconfigured token", async function () {
      const fakeToken = "0x0000000000000000000000000000000000000099";
      await expect(
        adapter.getMarketParams(fakeToken)
      ).to.be.revertedWith("No Morpho market for token");
    });
  });

  // ── constructor guards ─────────────────────────────────────────────
  describe("constructor guards", function () {
    it("Should revert when morpho is zero", async function () {
      const MorphoAdapter = await hre.ethers.getContractFactory("MorphoAdapter");
      await expect(
        MorphoAdapter.deploy(ethers.ZeroAddress, callerSigner.address)
      ).to.be.revertedWith("Morpho address cannot be zero");
    });

    it("Should revert when loanFactory is zero", async function () {
      const MorphoAdapter = await hre.ethers.getContractFactory("MorphoAdapter");
      await expect(
        MorphoAdapter.deploy(await mockMorpho.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("LoanFactory address cannot be zero");
    });
  });

  // ── view helpers ───────────────────────────────────────────────────
  describe("View functions", function () {
    it("getCreatedMarkets should return all configured tokens", async function () {
      const markets = await adapter.getCreatedMarkets();
      expect(markets.length).to.equal(2);
    });

    it("getMarketCount should return correct count", async function () {
      expect(await adapter.getMarketCount()).to.equal(2);
    });

    it("getPositionCount should return 0 for empty market", async function () {
      expect(await adapter.getPositionCount(usdcAddress)).to.equal(0);
    });

    it("getPositionInfo should return inactive for non-existent position", async function () {
      const info = await adapter.getPositionInfo(99n, usdcAddress);
      expect(info.isActive).to.be.false;
      expect(info.shares).to.equal(0);
    });

    it("getBatchPositionInfo should return zeros for non-existent positions", async function () {
      const [shares, deposited] = await adapter.getBatchPositionInfo(usdcAddress, [99n, 100n]);
      expect(shares[0]).to.equal(0);
      expect(deposited[0]).to.equal(0);
    });

    it("getAllMarketsInfo should return info for all markets", async function () {
      const info = await adapter.getAllMarketsInfo();
      expect(info.tokens.length).to.equal(2);
    });

    it("getPositionsByToken should return active positions", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(callerSigner).deposit(usdcAddress, amount, 42n);
      const positions = await adapter.getPositionsByToken(usdcAddress);
      expect(positions.length).to.equal(1);
      expect(positions[0]).to.equal(42n);
    });

    it("hasMarket should return false for unconfigured token", async function () {
      expect(await adapter.hasMarket("0x0000000000000000000000000000000000000099")).to.be.false;
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOAN FACTORY — Branch Coverage
// ═══════════════════════════════════════════════════════════════════════════

describe("LoanFactory — branch coverage gaps", function () {
  const LEND_ASSET = hre.ethers.parseUnits("10000", 6);
  const BORROW_COLLATERAL = hre.ethers.parseUnits("1", 8);
  const RATE_INDEX = 0;
  const DURATION_INDEX = 2;
  const INITIAL_RATIO = 15000;
  const LIQ_THRESHOLD = 11000;
  let usdcAddress: string;
  let btcAddress: string;

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
  });

  // ── Constructor guards ─────────────────────────────────────────────
  describe("Constructor validation", function () {
    it("Should revert when oracle is zero", async function () {
      const LoanFactory = await hre.ethers.getContractFactory("LoanFactory");
      await expect(
        LoanFactory.deploy(ethers.ZeroAddress, await assetRegistry.getAddress(), ethers.ZeroAddress, 0)
      ).to.be.revertedWith("Oracle address cannot be zero");
    });

    it("Should revert when assetRegistry is zero", async function () {
      const LoanFactory = await hre.ethers.getContractFactory("LoanFactory");
      await expect(
        LoanFactory.deploy(await priceOracle.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress, 0)
      ).to.be.revertedWith("AssetRegistry address cannot be zero");
    });

    it("Should revert when fee exceeds maximum", async function () {
      const LoanFactory = await hre.ethers.getContractFactory("LoanFactory");
      await expect(
        LoanFactory.deploy(
          await priceOracle.getAddress(),
          await assetRegistry.getAddress(),
          ethers.ZeroAddress,
          600 // exceeds MAX_PROTOCOL_FEE_BPS=500
        )
      ).to.be.revertedWith("Fee exceeds maximum");
    });
  });

  // ── createLoan validation ──────────────────────────────────────────
  describe("createLoan validation", function () {
    it("Should revert on invalid duration index", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      await expect(
        loanFactory.connect(lender).createLoan(
          LEND_ASSET, 0, INITIAL_RATIO, LIQ_THRESHOLD,
          usdcAddress, btcAddress, RATE_INDEX, 6 // invalid: max is 5
        )
      ).to.be.revertedWith("Invalid duration index");
    });

    it("Should revert on invalid rate index", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      await expect(
        loanFactory.connect(lender).createLoan(
          LEND_ASSET, 0, INITIAL_RATIO, LIQ_THRESHOLD,
          usdcAddress, btcAddress, 8, DURATION_INDEX // invalid: max is 7
        )
      ).to.be.revertedWith("Invalid interest rate index");
    });

    it("Should revert when both asset and collateral are non-zero", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      await btcMock.connect(owner).transfer(lender.address, BORROW_COLLATERAL);
      await btcMock.connect(lender).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
      await expect(
        loanFactory.connect(lender).createLoan(
          LEND_ASSET, BORROW_COLLATERAL, INITIAL_RATIO, LIQ_THRESHOLD,
          usdcAddress, btcAddress, RATE_INDEX, DURATION_INDEX
        )
      ).to.be.revertedWith("Invalid offer parameters");
    });

    it("Should revert on invalid liquidation threshold (too low)", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      await expect(
        loanFactory.connect(lender).createLoan(
          LEND_ASSET, 0, INITIAL_RATIO, 9000, // below MIN_LIQUIDATION_THRESHOLD_BPS=10000
          usdcAddress, btcAddress, RATE_INDEX, DURATION_INDEX
        )
      ).to.be.revertedWith("Invalid liquidation threshold");
    });

    it("Should revert on initial collateral ratio below minimum", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      await expect(
        loanFactory.connect(lender).createLoan(
          LEND_ASSET, 0, 10000, LIQ_THRESHOLD, // below MIN_INITIAL_COLLATERAL_RATIO_BPS=11000
          usdcAddress, btcAddress, RATE_INDEX, DURATION_INDEX
        )
      ).to.be.revertedWith("Invalid initial collateral ratio");
    });

    it("Should revert when initial ratio <= liquidation threshold", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      await expect(
        loanFactory.connect(lender).createLoan(
          LEND_ASSET, 0, 11000, 11000, // equal — must be strictly greater
          usdcAddress, btcAddress, RATE_INDEX, DURATION_INDEX
        )
      ).to.be.revertedWith("Initial collateral ratio must exceed liquidation threshold");
    });

    it("Should revert on unsupported pair", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      // Use reversed pair (USDC as collateral, BTC as asset) — not supported
      await expect(
        loanFactory.connect(lender).createLoan(
          LEND_ASSET, 0, INITIAL_RATIO, LIQ_THRESHOLD,
          btcAddress, usdcAddress, // wrong pair direction
          RATE_INDEX, DURATION_INDEX
        )
      ).to.be.revertedWith("Unsupported collateral/asset pair");
    });

    it("Should revert when lend asset below minimum", async function () {
      const tinyAmount = 1n; // way below MIN_ASSET_UNITS * 10^6
      await usdcMock.connect(owner).transfer(lender.address, tinyAmount);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), tinyAmount);
      await expect(
        loanFactory.connect(lender).createLoan(
          tinyAmount, 0, INITIAL_RATIO, LIQ_THRESHOLD,
          usdcAddress, btcAddress, RATE_INDEX, DURATION_INDEX
        )
      ).to.be.revertedWith("Invalid offer parameters");
    });
  });

  // ── cancelLoan guards ──────────────────────────────────────────────
  describe("cancelLoan guards", function () {
    it("Should revert for non-existent loan", async function () {
      await expect(
        loanFactory.connect(lender).cancelLoan(999n)
      ).to.be.revertedWith("Loan does not exist");
    });

    it("Should revert for loan ID 0", async function () {
      await expect(
        loanFactory.connect(lender).cancelLoan(0n)
      ).to.be.revertedWith("Loan does not exist");
    });

    it("Should revert when caller is not creator", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const params = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [loanId] = await createLoanAndGetId(lender, params);
      await expect(
        loanFactory.connect(borrower).cancelLoan(loanId)
      ).to.be.revertedWith("Only loan creator can cancel");
    });
  });

  // ── cancelLoan with adapter but no shares (else branch) ───────────
  describe("cancelLoan — adapter configured but no shares for token", function () {
    it("Should cancel borrow offer via direct transfer when adapter has no market for collateral", async function () {
      // Deploy MorphoAdapter but only configure USDC market (NOT BTC)
      const mockMorpho = await hre.ethers.deployContract("MockMorpho");
      const morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        await loanFactory.getAddress(),
      ]);
      const DUMMY = "0x0000000000000000000000000000000000000001";
      await morphoAdapter.connect(owner).configureMarket(usdcAddress, {
        loanToken: usdcAddress,
        collateralToken: DUMMY,
        oracle: DUMMY,
        irm: DUMMY,
        lltv: 1n,
      });
      // Set adapter on LoanFactory (USDC market only, no BTC market)
      await loanFactory.connect(owner).setMorphoAdapter(await morphoAdapter.getAddress());

      // Create borrow offer — collateral (BTC) NOT routed to adapter (no BTC market)
      await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
      await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
      const params = await createBorrowOfferParams(
        BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
        INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
      );
      const [borrowId] = await createLoanAndGetId(borrower, params);

      // Cancel — adapter exists but sharesOf(id, BTC) == 0 → else branch (direct transfer)
      const balBefore = await btcMock.balanceOf(borrower.address);
      await loanFactory.connect(borrower).cancelLoan(borrowId);
      const balAfter = await btcMock.balanceOf(borrower.address);
      expect(balAfter).to.be.gt(balBefore);
    });

    it("Should cancel lend offer via direct transfer when adapter has no market for asset", async function () {
      // Deploy MorphoAdapter but only configure BTC market (NOT USDC)
      const mockMorpho = await hre.ethers.deployContract("MockMorpho");
      const morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        await loanFactory.getAddress(),
      ]);
      const DUMMY = "0x0000000000000000000000000000000000000001";
      await morphoAdapter.connect(owner).configureMarket(btcAddress, {
        loanToken: btcAddress,
        collateralToken: DUMMY,
        oracle: DUMMY,
        irm: DUMMY,
        lltv: 1n,
      });
      await loanFactory.connect(owner).setMorphoAdapter(await morphoAdapter.getAddress());

      // Create lend offer — asset (USDC) NOT routed to adapter (no USDC market)
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const params = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [lendId] = await createLoanAndGetId(lender, params);

      // Cancel — adapter exists but sharesOf(id, USDC) == 0 → else branch (direct transfer)
      const balBefore = await usdcMock.balanceOf(lender.address);
      await loanFactory.connect(lender).cancelLoan(lendId);
      const balAfter = await usdcMock.balanceOf(lender.address);
      expect(balAfter).to.be.gt(balBefore);
    });
  });

  // ── takeUpLoan guards ──────────────────────────────────────────────
  describe("takeUpLoan guards", function () {
    it("Should revert when IDs are the same", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const params = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [loanId] = await createLoanAndGetId(lender, params);
      await expect(
        loanFactory.connect(lender).takeUpLoan(loanId, loanId)
      ).to.be.revertedWith("IDs must differ");
    });

    it("Should revert when takeUpId does not exist", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const params = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [loanId] = await createLoanAndGetId(lender, params);
      await expect(
        loanFactory.connect(lender).takeUpLoan(999n, loanId)
      ).to.be.revertedWith("TakeUp does not exist");
    });

    it("Should revert when offerId does not exist", async function () {
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const params = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [loanId] = await createLoanAndGetId(lender, params);

      // Create borrow offer for the caller
      await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
      await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
      const bParams = await createBorrowOfferParams(
        BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
        INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
      );
      const [borrowId] = await createLoanAndGetId(borrower, bParams);

      await expect(
        loanFactory.connect(borrower).takeUpLoan(borrowId, 999n)
      ).to.be.revertedWith("Offer does not exist");
    });

    it("Should revert on unauthorized caller (neither borrower nor lender)", async function () {
      // Create two offers
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const lParams = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [lendId] = await createLoanAndGetId(lender, lParams);

      await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
      await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
      const bParams = await createBorrowOfferParams(
        BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
        INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
      );
      const [borrowId] = await createLoanAndGetId(borrower, bParams);

      // Third party (owner) tries to take up — neither lender nor borrower of these offers
      await expect(
        loanFactory.connect(owner).takeUpLoan(lendId, borrowId)
      ).to.be.revertedWith("Unauthorized caller");
    });
  });

  // ── setMorphoAdapter alias ─────────────────────────────────────────
  describe("setMorphoAdapter alias", function () {
    it("Should work as alias for setYieldAdapter", async function () {
      const mockAdapter = await hre.ethers.deployContract("MockYieldAdapter");
      await mockAdapter.waitForDeployment();
      await loanFactory.connect(owner).setMorphoAdapter(await mockAdapter.getAddress());
      expect(await loanFactory.yieldAdapter()).to.equal(await mockAdapter.getAddress());
    });
  });

  // ── setYieldAdapter direct swap guard ──────────────────────────────
  describe("setYieldAdapter guards", function () {
    it("Should reject direct swap (must clear first)", async function () {
      const adapter1 = await hre.ethers.deployContract("MockYieldAdapter");
      const adapter2 = await hre.ethers.deployContract("MockYieldAdapter");
      await adapter1.waitForDeployment();
      await adapter2.waitForDeployment();

      await loanFactory.connect(owner).setYieldAdapter(await adapter1.getAddress());
      await expect(
        loanFactory.connect(owner).setYieldAdapter(await adapter2.getAddress())
      ).to.be.revertedWith("Clear existing adapter first");
    });
  });

  // ── topUp zero amount ──────────────────────────────────────────────
  describe("topUp guards", function () {
    it("Should revert when additional collateral is zero", async function () {
      // First create a matched loan
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const lParams = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [lendId] = await createLoanAndGetId(lender, lParams);

      await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
      await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
      const bParams = await createBorrowOfferParams(
        BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
        INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
      );
      const [borrowId] = await createLoanAndGetId(borrower, bParams);

      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);
      // lendId is now the active loan (offerId becomes s3)

      await expect(
        loanFactory.connect(borrower).topUp(lendId, 0)
      ).to.be.revertedWith("Additional collateral must be > 0");
    });
  });

  // ── liquidateLoan guards ───────────────────────────────────────────
  describe("liquidateLoan guards", function () {
    it("Should revert for non-existent loan", async function () {
      await expect(
        loanFactory.connect(owner).liquidateLoan(999n)
      ).to.be.revertedWith("Loan not found or inactive");
    });
  });

  // ── endLoan guards ─────────────────────────────────────────────────
  describe("endLoan guards", function () {
    it("Should revert for non-existent loan", async function () {
      await expect(
        loanFactory.connect(owner).endLoan(999n)
      ).to.be.revertedWith("Loan not found or inactive");
    });
  });

  // ── interruptLoan guards ───────────────────────────────────────────
  describe("interruptLoan guards", function () {
    it("Should revert for non-existent loan", async function () {
      await expect(
        loanFactory.connect(owner).interruptLoan(999n)
      ).to.be.revertedWith("Loan not found, inactive, or unauthorized");
    });
  });

  // ── pause/unpause ──────────────────────────────────────────────────
  describe("Pause functionality", function () {
    it("Should block createLoan when paused", async function () {
      await loanFactory.connect(owner).pause();
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      await expect(
        loanFactory.connect(lender).createLoan(
          LEND_ASSET, 0, INITIAL_RATIO, LIQ_THRESHOLD,
          usdcAddress, btcAddress, RATE_INDEX, DURATION_INDEX
        )
      ).to.be.revertedWithCustomError(loanFactory, "EnforcedPause");
    });

    it("Should block takeUpLoan when paused", async function () {
      // Create offers first
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const lParams = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [lendId] = await createLoanAndGetId(lender, lParams);

      await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
      await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
      const bParams = await createBorrowOfferParams(
        BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
        INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
      );
      const [borrowId] = await createLoanAndGetId(borrower, bParams);

      // Pause
      await loanFactory.connect(owner).pause();

      await expect(
        loanFactory.connect(borrower).takeUpLoan(borrowId, lendId)
      ).to.be.revertedWithCustomError(loanFactory, "EnforcedPause");
    });
  });

  // ── setProtocolFee guards ──────────────────────────────────────────
  describe("setProtocolFee guards", function () {
    it("Should revert when fee exceeds maximum", async function () {
      await expect(
        loanFactory.connect(owner).setProtocolFee(600) // > MAX_PROTOCOL_FEE_BPS=500
      ).to.be.revertedWith("Fee exceeds maximum");
    });

    it("Should emit ProtocolFeeUpdated", async function () {
      await expect(loanFactory.connect(owner).setProtocolFee(100))
        .to.emit(loanFactory, "ProtocolFeeUpdated")
        .withArgs(0, 100);
    });
  });

  // ── setFeeRecipient ────────────────────────────────────────────────
  describe("setFeeRecipient", function () {
    it("Should emit FeeRecipientUpdated", async function () {
      await expect(loanFactory.connect(owner).setFeeRecipient(lender.address))
        .to.emit(loanFactory, "FeeRecipientUpdated")
        .withArgs(ethers.ZeroAddress, lender.address);
    });
  });

  // ── MEDIUM-7: Post-withdrawal collateral re-validation ─────────────
  describe("MEDIUM-7: Post-withdrawal collateral re-validation", function () {
    it("Should revert when negative yield makes collateral insufficient (borrower takes lend)", async function () {
      // Set up negative yield adapter that returns very little (-90%)
      const negAdapter = await hre.ethers.deployContract("MockYieldAdapter");
      await negAdapter.waitForDeployment();
      await loanFactory.connect(owner).setYieldAdapter(await negAdapter.getAddress());

      await negAdapter.setSupported(usdcAddress, true);
      await negAdapter.setSupported(btcAddress, true);
      await negAdapter.setYieldBps(1000); // Only 10% returned! -90% yield

      // Fund adapter
      await usdcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("100000", 6));
      await btcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("10", 8));

      // Create lend offer
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const lParams = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [lendId] = await createLoanAndGetId(lender, lParams);

      // Create borrow offer (minimal collateral, just barely meeting requirements)
      // At $50k/BTC and 10000 USDC loan: 150% = 15000 USDC collateral = 0.3 BTC
      // Use exactly 0.31 BTC to barely pass — after -90% yield, only 0.031 BTC remains → fail
      const minCollateral = hre.ethers.parseUnits("0.31", 8);
      await btcMock.connect(owner).transfer(borrower.address, minCollateral);
      await btcMock.connect(borrower).approve(await loanFactory.getAddress(), minCollateral);
      const bParams = await createBorrowOfferParams(
        minCollateral, RATE_INDEX, DURATION_INDEX,
        INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
      );
      const [borrowId] = await createLoanAndGetId(borrower, bParams);

      await expect(
        loanFactory.connect(borrower).takeUpLoan(borrowId, lendId)
      ).to.be.revertedWith("Post-withdrawal collateral insufficient");
    });

    it("Should revert when negative yield makes collateral insufficient (lender takes borrow)", async function () {
      const negAdapter = await hre.ethers.deployContract("MockYieldAdapter");
      await negAdapter.waitForDeployment();
      await loanFactory.connect(owner).setYieldAdapter(await negAdapter.getAddress());

      await negAdapter.setSupported(usdcAddress, true);
      await negAdapter.setSupported(btcAddress, true);
      await negAdapter.setYieldBps(1000); // -90%

      await usdcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("100000", 6));
      await btcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("10", 8));

      // Create lend offer first
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const lParams = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [lendId] = await createLoanAndGetId(lender, lParams);

      // Create borrow offer with minimal collateral
      const minCollateral = hre.ethers.parseUnits("0.31", 8);
      await btcMock.connect(owner).transfer(borrower.address, minCollateral);
      await btcMock.connect(borrower).approve(await loanFactory.getAddress(), minCollateral);
      const bParams = await createBorrowOfferParams(
        minCollateral, RATE_INDEX, DURATION_INDEX,
        INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
      );
      const [borrowId] = await createLoanAndGetId(borrower, bParams);

      // Lender takes borrow offer
      await expect(
        loanFactory.connect(lender).takeUpLoan(lendId, borrowId)
      ).to.be.revertedWith("Post-withdrawal collateral insufficient");
    });
  });

  // ── takeUpLoan asset/collateral mismatch ───────────────────────────
  describe("takeUpLoan asset/collateral mismatch", function () {
    it("Should revert when asset tokens differ (borrower takes lend)", async function () {
      // We need a second asset token to test mismatch
      const usdc2 = await hre.ethers.deployContract("ERC20Mock", [
        "DAI", "DAI", owner.address, hre.ethers.parseUnits("1000000", 18), 18
      ]);
      await usdc2.waitForDeployment();
      const usdc2Addr = await usdc2.getAddress();

      // Register DAI
      await assetRegistry.registerAsset(usdc2Addr, "DAI", "DAI/USD", 18);
      await assetRegistry.setAssetSupported(usdc2Addr, true);
      await assetRegistry.setPairSupported(btcAddress, usdc2Addr, true);

      // Deploy mock feed for DAI
      const daiFeed = await hre.ethers.deployContract("MockAggregatorV3", [8, MOCK_BTC_PRICE]);
      await daiFeed.waitForDeployment();

      // Create lend offer with USDC
      await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
      await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
      const lParams = await createLendOfferParams(
        LEND_ASSET, RATE_INDEX, DURATION_INDEX,
        usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
      );
      const [lendId] = await createLoanAndGetId(lender, lParams);

      // Create borrow offer with DAI (different asset)
      const dai_amount = hre.ethers.parseUnits("0", 18);
      await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
      await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
      const bParams = await createBorrowOfferParams(
        BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
        INITIAL_RATIO, LIQ_THRESHOLD, usdc2Addr, btcAddress
      );
      const [borrowId] = await createLoanAndGetId(borrower, bParams);

      await expect(
        loanFactory.connect(borrower).takeUpLoan(borrowId, lendId)
      ).to.be.revertedWith("Offers must use the same asset token");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOAN CALCULATOR — Branch Coverage (via LoanCalculatorTest contract)
// ═══════════════════════════════════════════════════════════════════════════

describe("LoanCalculator — branch coverage gaps", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("calculateTotalRepayment with durationDays=0 should return principal", async function () {
    const principal = hre.ethers.parseUnits("10000", 6);
    const result = await loanCalculatorTest.testCalculateTotalRepayment(principal, 500, 0);
    expect(result).to.equal(principal);
  });

  it("calculateProratedRepaymentHourly with hoursElapsed=0 should return principal", async function () {
    const principal = hre.ethers.parseUnits("10000", 6);
    const result = await loanCalculatorTest.testCalculateProratedRepaymentHourly(principal, 500, 0);
    expect(result).to.equal(principal);
  });

  it("calculateHealthScore with loanAmount=0 should return max uint256", async function () {
    const btcAddr = await btcMock.getAddress();
    const oracleAddr = await priceOracle.getAddress();
    const result = await loanCalculatorTest.testCalculateHealthScore.staticCall(
      hre.ethers.parseUnits("1", 8), // collateral
      0, // loanAmount = 0
      500,
      24,
      btcAddr,
      6,
      oracleAddr
    );
    expect(result).to.equal(hre.ethers.MaxUint256);
  });
});
