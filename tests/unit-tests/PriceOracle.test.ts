import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, owner, loanFactory, priceOracle, mockAggregator, MOCK_BTC_PRICE } from "../utils/deployments";
import hre from "hardhat";

// Asset decimals constant for USDC (6) — used in all oracle calls
const USDC_DECIMALS = 6;

describe("PriceOracle tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // ── getOraclePrice ────────────────────────────────────────────────────────

  it("Should return correct USDC value for 1 BTC at $50,000", async function () {
    // 1 BTC (8 dec) * $50,000 (8 dec feed) / 10^(8+8-6) = $50,000 (6 dec)
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const usdcValue = await priceOracle.getOraclePrice.staticCall(oneBtc, await btcMock.getAddress(), USDC_DECIMALS);
    expect(usdcValue).to.equal(hre.ethers.parseUnits("50000", 6));
  });

  it("Should return correct BTC amount for $50,000 USDC (inverse)", async function () {
    const usdcAmount = hre.ethers.parseUnits("50000", 6);
    const btcAmount = await priceOracle.getInverseOraclePrice.staticCall(usdcAmount, await btcMock.getAddress(), USDC_DECIMALS);
    expect(btcAmount).to.equal(hre.ethers.parseUnits("1", 8));
  });

  it("Should return correct view price (getOraclePriceView)", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const usdcValue = await priceOracle.getOraclePriceView(oneBtc, await btcMock.getAddress(), USDC_DECIMALS);
    expect(usdcValue).to.equal(hre.ethers.parseUnits("50000", 6));
  });

  // ── Staleness ─────────────────────────────────────────────────────────────

  it("Should revert on stale price (updatedAt older than maxStaleness)", async function () {
    // Deploy a fresh oracle with 3660s staleness for this test
    const freshOracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
    await freshOracle.waitForDeployment();
    await freshOracle.setFeed(await btcMock.getAddress(), await mockAggregator.getAddress(), 3660);

    // Make price stale: set updatedAt to very old timestamp
    await mockAggregator.setUpdatedAt(1000); // unix epoch near-zero

    const oneBtc = hre.ethers.parseUnits("1", 8);
    await expect(
      freshOracle.getOraclePrice.staticCall(oneBtc, await btcMock.getAddress(), USDC_DECIMALS)
    ).to.be.revertedWithCustomError(freshOracle, "StalePrice");
  });

  it("Should revert on zero/negative price", async function () {
    await mockAggregator.setAnswer(0);

    const oneBtc = hre.ethers.parseUnits("1", 8);
    await expect(
      priceOracle.getOraclePrice.staticCall(oneBtc, await btcMock.getAddress(), USDC_DECIMALS)
    ).to.be.revertedWithCustomError(priceOracle, "InvalidPrice");
  });

  it("Should revert on negative price", async function () {
    await mockAggregator.setAnswer(-1);

    const oneBtc = hre.ethers.parseUnits("1", 8);
    await expect(
      priceOracle.getOraclePrice.staticCall(oneBtc, await btcMock.getAddress(), USDC_DECIMALS)
    ).to.be.revertedWithCustomError(priceOracle, "InvalidPrice");
  });

  // ── Unconfigured feed ─────────────────────────────────────────────────────

  it("Should revert when feed is not configured for token", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    // usdcMock has no feed configured in PriceOracle
    await expect(
      priceOracle.getOraclePrice.staticCall(oneBtc, await usdcMock.getAddress(), USDC_DECIMALS)
    ).to.be.revertedWithCustomError(priceOracle, "FeedNotConfigured");
  });

  // ── Circuit breaker (deviation) ───────────────────────────────────────────

  it("Should trigger circuit breaker when price deviates too much", async function () {
    // First call to set lastGoodPrice at $50,000
    const oneBtc = hre.ethers.parseUnits("1", 8);
    await priceOracle.getOraclePrice(oneBtc, await btcMock.getAddress(), USDC_DECIMALS); // sets lastGoodPrice

    // Now drop price 60% — exceeds default 50% maxDeviationBps
    const crashedPrice = 20_000n * 10n ** 8n; // $20,000 = 60% drop
    await mockAggregator.setAnswer(crashedPrice);

    await expect(
      priceOracle.getOraclePrice.staticCall(oneBtc, await btcMock.getAddress(), USDC_DECIMALS)
    ).to.be.revertedWithCustomError(priceOracle, "PriceDeviationTooLarge");
  });

  it("Unchecked variant should bypass circuit breaker on large price drop", async function () {
    // Set lastGoodPrice at $50,000
    const oneBtc = hre.ethers.parseUnits("1", 8);
    await priceOracle.getOraclePrice(oneBtc, await btcMock.getAddress(), USDC_DECIMALS);

    // Drop price 60% — would fail circuit breaker on checked variant
    const crashedPrice = 20_000n * 10n ** 8n;
    await mockAggregator.setAnswer(crashedPrice);

    // Unchecked should succeed and return $20,000
    const usdcValue = await priceOracle.getOraclePriceUnchecked.staticCall(oneBtc, await btcMock.getAddress(), USDC_DECIMALS);
    expect(usdcValue).to.equal(hre.ethers.parseUnits("20000", 6));
  });

  it("Should NOT trigger circuit breaker on first call (no lastGoodPrice)", async function () {
    // Fresh oracle with no lastGoodPrice — deviation check is skipped
    const freshOracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
    await freshOracle.waitForDeployment();
    await freshOracle.setFeed(await btcMock.getAddress(), await mockAggregator.getAddress(), 400 * 24 * 3600);

    const oneBtc = hre.ethers.parseUnits("1", 8);
    // Should succeed — no prior price to compare against
    const usdcValue = await freshOracle.getOraclePrice.staticCall(oneBtc, await btcMock.getAddress(), USDC_DECIMALS);
    expect(usdcValue).to.equal(hre.ethers.parseUnits("50000", 6));
  });

  // ── Admin functions ───────────────────────────────────────────────────────

  it("Should allow owner to update maxDeviationBps", async function () {
    await priceOracle.setMaxDeviation(3000); // 30%
    expect(await priceOracle.maxDeviationBps()).to.equal(3000);
  });

  it("Should reject setMaxDeviation from non-owner", async function () {
    await expect(priceOracle.connect(borrower).setMaxDeviation(3000))
      .to.be.revertedWithCustomError(priceOracle, "Unauthorized");
  });

  it("Should reject setFeed from non-owner", async function () {
    await expect(
      priceOracle.connect(borrower).setFeed(await btcMock.getAddress(), await mockAggregator.getAddress(), 3660)
    ).to.be.revertedWithCustomError(priceOracle, "Unauthorized");
  });

  it("Should reject setFeed with zero token address", async function () {
    await expect(
      priceOracle.setFeed(ethers.ZeroAddress, await mockAggregator.getAddress(), 3660)
    ).to.be.revertedWithCustomError(priceOracle, "ZeroAddress");
  });

  it("Should reject setFeed with zero feed address", async function () {
    await expect(
      priceOracle.setFeed(await btcMock.getAddress(), ethers.ZeroAddress, 3660)
    ).to.be.revertedWithCustomError(priceOracle, "ZeroAddress");
  });

  // ── Two-step ownership (H-5 Fix) ─────────────────────────────────────────

  it("Should set pendingOwner on transferOwnership (not transfer yet)", async function () {
    await priceOracle.transferOwnership(lender.address);
    // Owner unchanged until accepted
    expect(await priceOracle.owner()).to.equal(owner.address);
    expect(await priceOracle.pendingOwner()).to.equal(lender.address);
  });

  it("Should complete two-step ownership transfer on acceptOwnership", async function () {
    await priceOracle.transferOwnership(lender.address);
    await priceOracle.connect(lender).acceptOwnership();
    expect(await priceOracle.owner()).to.equal(lender.address);
    expect(await priceOracle.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("Should reject acceptOwnership from non-pending address", async function () {
    await priceOracle.transferOwnership(lender.address);
    await expect(priceOracle.connect(borrower).acceptOwnership())
      .to.be.revertedWithCustomError(priceOracle, "Unauthorized");
  });

  it("Should reject transferOwnership to zero address", async function () {
    await expect(priceOracle.transferOwnership(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(priceOracle, "ZeroAddress");
  });

  it("Should reject transferOwnership from non-owner", async function () {
    await expect(priceOracle.connect(borrower).transferOwnership(lender.address))
      .to.be.revertedWithCustomError(priceOracle, "Unauthorized");
  });

  // ── Price scaling correctness ─────────────────────────────────────────────

  it("Should correctly scale different BTC amounts", async function () {
    // 0.5 BTC → $25,000
    const halfBtc = hre.ethers.parseUnits("0.5", 8);
    const value = await priceOracle.getOraclePriceView(halfBtc, await btcMock.getAddress(), USDC_DECIMALS);
    expect(value).to.equal(hre.ethers.parseUnits("25000", 6));
  });

  it("Should correctly compute inverse for different USDC amounts", async function () {
    // $25,000 → 0.5 BTC
    const usdcAmount = hre.ethers.parseUnits("25000", 6);
    const btcAmount = await priceOracle.getInverseOraclePriceView(usdcAmount, await btcMock.getAddress(), USDC_DECIMALS);
    expect(btcAmount).to.equal(hre.ethers.parseUnits("0.5", 8));
  });

  it("Should update lastGoodPrice after getOraclePrice call", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const btcAddress = await btcMock.getAddress();

    expect(await priceOracle.lastGoodPrice(btcAddress)).to.equal(0);
    await priceOracle.getOraclePrice(oneBtc, btcAddress, USDC_DECIMALS);
    expect(await priceOracle.lastGoodPrice(btcAddress)).to.equal(MOCK_BTC_PRICE);
  });
});
