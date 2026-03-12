import { expect } from "chai";
import hre from "hardhat";
import {
  deployContracts,
  btcMock,
  owner,
  priceOracle,
  mockAggregator,
  loanCalculatorTest,
  MOCK_BTC_PRICE,
} from "../utils/deployments";

const USDC_DECIMALS = 6;

describe("LoanCalculator — coverage gaps", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // ── calculateHealthScore with loanAmount == 0 ─────────────────────────────

  it("Should return type(uint256).max when loanAmount is 0 (checked)", async function () {
    const collateral = hre.ethers.parseUnits("1", 8);
    const result = await loanCalculatorTest.testCalculateHealthScore.staticCall(
      collateral,
      0, // loanAmount = 0
      500, // rateBps
      24, // hoursElapsed
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );
    // type(uint256).max
    expect(result).to.equal(hre.ethers.MaxUint256);
  });

  it("Should return type(uint256).max when loanAmount is 0 (unchecked)", async function () {
    const collateral = hre.ethers.parseUnits("1", 8);
    const result = await loanCalculatorTest.testCalculateHealthScoreUnchecked(
      collateral,
      0, // loanAmount = 0
      500,
      24,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );
    expect(result).to.equal(hre.ethers.MaxUint256);
  });

  // ── calculateBTCPayout: collateral < debt equivalent ──────────────────────

  it("Should cap BTC payout to collateral when debt exceeds collateral value", async function () {
    // Set price very low so debt equivalent > collateral
    // With price $50k: 0.01 BTC = $500 collateral value
    // Principal = $10000 = way more than $500 collateral
    const smallCollateral = hre.ethers.parseUnits("0.01", 8); // 0.01 BTC = $500
    const largePrincipal = hre.ethers.parseUnits("10000", 6); // $10,000 USDC

    const payout = await loanCalculatorTest.testCalculateBTCPayout.staticCall(
      largePrincipal,
      500, // 5% rate
      7, // 7 days
      smallCollateral,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );

    // Payout should equal collateral (all collateral goes to lender since debt > collateral)
    expect(payout).to.equal(smallCollateral);
  });

  it("Should return less than collateral when debt < collateral value", async function () {
    // 1 BTC = $50k collateral, principal = $1000
    const collateral = hre.ethers.parseUnits("1", 8);
    const principal = hre.ethers.parseUnits("1000", 6);

    const payout = await loanCalculatorTest.testCalculateBTCPayout.staticCall(
      principal,
      500, // 5% rate
      7,
      collateral,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );

    // Payout should be less than collateral (collateralEquivalent < collateralAmount)
    expect(payout).to.be.lt(collateral);
  });

  // ── calculateExcessCollateral: zero excess when undercollateralized ───────

  it("Should return 0 excess when collateral < debt equivalent", async function () {
    const smallCollateral = hre.ethers.parseUnits("0.01", 8);
    const largePrincipal = hre.ethers.parseUnits("10000", 6);

    const excess = await loanCalculatorTest.testCalculateExcessCollateral.staticCall(
      largePrincipal,
      500,
      7,
      smallCollateral,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );

    expect(excess).to.equal(0);
  });

  it("Should return positive excess when collateral > debt equivalent", async function () {
    const collateral = hre.ethers.parseUnits("1", 8);
    const principal = hre.ethers.parseUnits("1000", 6);

    const excess = await loanCalculatorTest.testCalculateExcessCollateral.staticCall(
      principal,
      500,
      7,
      collateral,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );

    expect(excess).to.be.gt(0);
  });

  // ── Unchecked variants: excess collateral ────────────────────────────────

  it("Should return 0 excess (unchecked) when collateral < debt", async function () {
    const smallCollateral = hre.ethers.parseUnits("0.01", 8);
    const largePrincipal = hre.ethers.parseUnits("10000", 6);

    const excess = await loanCalculatorTest.testCalculateExcessCollateralUnchecked(
      largePrincipal,
      500,
      7,
      smallCollateral,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );

    expect(excess).to.equal(0);
  });

  it("Should return positive excess (unchecked) when collateral > debt", async function () {
    const collateral = hre.ethers.parseUnits("1", 8);
    const principal = hre.ethers.parseUnits("1000", 6);

    const excess = await loanCalculatorTest.testCalculateExcessCollateralUnchecked(
      principal,
      500,
      7,
      collateral,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );

    expect(excess).to.be.gt(0);
  });

  // ── calculateTotalRepayment with durationDays == 0 ────────────────────────

  it("Should return principal when durationDays is 0", async function () {
    const principal = hre.ethers.parseUnits("1000", 6);
    const result = await loanCalculatorTest.testCalculateTotalRepayment(principal, 500, 0);
    expect(result).to.equal(principal);
  });

  // ── calculateProratedRepaymentHourly with hoursElapsed == 0 ──────────────

  it("Should return principal when hoursElapsed is 0", async function () {
    const principal = hre.ethers.parseUnits("1000", 6);
    const result = await loanCalculatorTest.testCalculateProratedRepaymentHourly(principal, 500, 0);
    expect(result).to.equal(principal);
  });

  // ── pow edge cases ───────────────────────────────────────────────────────

  it("Should return PRECISION when exponent is 0", async function () {
    const PRECISION = 10n ** 18n;
    const result = await loanCalculatorTest.testPow(2n * PRECISION, 0);
    expect(result).to.equal(PRECISION);
  });

  it("Should return base when exponent is 1", async function () {
    const PRECISION = 10n ** 18n;
    const base = 2n * PRECISION;
    const result = await loanCalculatorTest.testPow(base, 1);
    expect(result).to.equal(base);
  });

  it("Should correctly compute pow for even exponent", async function () {
    const PRECISION = 10n ** 18n;
    // 2^4 = 16
    const result = await loanCalculatorTest.testPow(2n * PRECISION, 4);
    expect(result).to.equal(16n * PRECISION);
  });

  it("Should correctly compute pow for odd exponent", async function () {
    const PRECISION = 10n ** 18n;
    // 2^3 = 8
    const result = await loanCalculatorTest.testPow(2n * PRECISION, 3);
    expect(result).to.equal(8n * PRECISION);
  });

  // ── Oracle wrapper functions via LoanCalculatorTest ──────────────────────

  it("Should call getOraclePrice through calculator", async function () {
    const oneBtc = hre.ethers.parseUnits("1", 8);
    const result = await loanCalculatorTest.testGetOraclePrice.staticCall(
      oneBtc,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );
    expect(result).to.equal(hre.ethers.parseUnits("50000", 6));
  });

  it("Should call getInverseOraclePrice through calculator", async function () {
    const usdcAmount = hre.ethers.parseUnits("50000", 6);
    const result = await loanCalculatorTest.testGetInverseOraclePrice.staticCall(
      usdcAmount,
      await btcMock.getAddress(),
      USDC_DECIMALS,
      await priceOracle.getAddress()
    );
    expect(result).to.equal(hre.ethers.parseUnits("1", 8));
  });
});
