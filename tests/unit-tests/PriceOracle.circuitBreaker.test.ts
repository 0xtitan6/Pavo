/**
 * PriceOracle.circuitBreaker.test.ts
 *
 * Tests for circuit breaker deadlock scenarios:
 * 1. Price deviation blocks getOraclePrice -> verify getOraclePriceUnchecked still works (liquidation safety)
 * 2. Simultaneous staleness + deviation -> verify correct error priority
 * 3. Circuit breaker blocks, price returns to normal -> verify unblocked
 *
 * Run: npx hardhat test --grep "circuit breaker"
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployContracts,
  usdcMock,
  btcMock,
  owner,
  priceOracle,
  mockAggregator,
  MOCK_BTC_PRICE,
} from "../utils/deployments";
import hre from "hardhat";

const USDC_DECIMALS = 6;

describe("PriceOracle circuit breaker edge cases", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("circuit breaker blocks getOraclePrice but getOraclePriceUnchecked still works for liquidation", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const btcAddress = await btcMock.getAddress();

    // Set baseline lastGoodPrice
    await priceOracle.getOraclePrice(oneBtc, btcAddress, USDC_DECIMALS);

    // Drop price 60% (exceeds 50% threshold)
    const crashedPrice = 20_000n * 10n ** 8n;
    await mockAggregator.setAnswer(crashedPrice);

    // Checked variant should revert
    await expect(
      priceOracle.getOraclePrice.staticCall(oneBtc, btcAddress, USDC_DECIMALS)
    ).to.be.revertedWithCustomError(priceOracle, "PriceDeviationTooLarge");

    // Unchecked variant should succeed (liquidation can proceed)
    const value = await priceOracle.getOraclePriceUnchecked.staticCall(
      oneBtc,
      btcAddress,
      USDC_DECIMALS
    );
    expect(value).to.equal(hre.ethers.parseUnits("20000", 6));

    // Inverse unchecked should also work
    const usdcAmount = hre.ethers.parseUnits("20000", 6);
    const btcAmount =
      await priceOracle.getInverseOraclePriceUnchecked.staticCall(
        usdcAmount,
        btcAddress,
        USDC_DECIMALS
      );
    expect(btcAmount).to.equal(hre.ethers.parseUnits("1", 8));
  });

  it("staleness takes priority over circuit breaker deviation", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const btcAddress = await btcMock.getAddress();

    // Set baseline
    await priceOracle.getOraclePrice(oneBtc, btcAddress, USDC_DECIMALS);

    // Make price BOTH stale AND deviated
    const crashedPrice = 20_000n * 10n ** 8n;
    await mockAggregator.setAnswer(crashedPrice);
    await mockAggregator.setUpdatedAt(1000); // very old timestamp

    // Should revert with StalePrice (validation happens before circuit breaker)
    await expect(
      priceOracle.getOraclePrice.staticCall(oneBtc, btcAddress, USDC_DECIMALS)
    ).to.be.revertedWithCustomError(priceOracle, "StalePrice");

    // Unchecked should also revert with StalePrice (staleness is checked in both paths)
    await expect(
      priceOracle.getOraclePriceUnchecked.staticCall(
        oneBtc,
        btcAddress,
        USDC_DECIMALS
      )
    ).to.be.revertedWithCustomError(priceOracle, "StalePrice");
  });

  it("circuit breaker unblocks when price returns to normal range", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const btcAddress = await btcMock.getAddress();

    // Set baseline at $50,000
    await priceOracle.getOraclePrice(oneBtc, btcAddress, USDC_DECIMALS);
    expect(await priceOracle.lastGoodPrice(btcAddress)).to.equal(
      MOCK_BTC_PRICE
    );

    // Crash price 60% -> circuit breaker blocks
    const crashedPrice = 20_000n * 10n ** 8n;
    await mockAggregator.setAnswer(crashedPrice);
    await expect(
      priceOracle.getOraclePrice.staticCall(oneBtc, btcAddress, USDC_DECIMALS)
    ).to.be.revertedWithCustomError(priceOracle, "PriceDeviationTooLarge");

    // Price recovers to $48,000 (within 50% of $50,000 baseline)
    const recoveredPrice = 48_000n * 10n ** 8n;
    await mockAggregator.setAnswer(recoveredPrice);

    // Should succeed -- deviation is only 4% from lastGoodPrice
    const value = await priceOracle.getOraclePrice.staticCall(
      oneBtc,
      btcAddress,
      USDC_DECIMALS
    );
    expect(value).to.equal(hre.ethers.parseUnits("48000", 6));
  });

  it("circuit breaker threshold can be tightened and still blocks appropriately", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const btcAddress = await btcMock.getAddress();

    // Set baseline
    await priceOracle.getOraclePrice(oneBtc, btcAddress, USDC_DECIMALS);

    // Tighten threshold to 10%
    await priceOracle.setMaxDeviation(1000); // 10%

    // 15% drop should now trigger circuit breaker
    const droppedPrice = 42_500n * 10n ** 8n; // $42,500 = 15% drop
    await mockAggregator.setAnswer(droppedPrice);

    await expect(
      priceOracle.getOraclePrice.staticCall(oneBtc, btcAddress, USDC_DECIMALS)
    ).to.be.revertedWithCustomError(priceOracle, "PriceDeviationTooLarge");

    // But unchecked should still work
    const value = await priceOracle.getOraclePriceUnchecked.staticCall(
      oneBtc,
      btcAddress,
      USDC_DECIMALS
    );
    expect(value).to.equal(hre.ethers.parseUnits("42500", 6));
  });

  it("view function does not trigger circuit breaker and does not update lastGoodPrice", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const btcAddress = await btcMock.getAddress();

    // Set baseline
    await priceOracle.getOraclePrice(oneBtc, btcAddress, USDC_DECIMALS);
    const baselinePrice = await priceOracle.lastGoodPrice(btcAddress);

    // Change price significantly
    const newPrice = 30_000n * 10n ** 8n; // $30,000 = 40% drop (within 50% threshold)
    await mockAggregator.setAnswer(newPrice);

    // View should return the new price without updating lastGoodPrice
    const viewValue = await priceOracle.getOraclePriceView(
      oneBtc,
      btcAddress,
      USDC_DECIMALS
    );
    expect(viewValue).to.equal(hre.ethers.parseUnits("30000", 6));

    // lastGoodPrice should be unchanged (view doesn't update it)
    expect(await priceOracle.lastGoodPrice(btcAddress)).to.equal(
      baselinePrice
    );
  });
});
