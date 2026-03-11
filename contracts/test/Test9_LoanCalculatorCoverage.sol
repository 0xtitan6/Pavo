// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";
import "../mocks/LoanCalculatorTest.sol";

/// @title Test9_LoanCalculatorCoverage
/// @notice Branch coverage tests for LoanCalculator library.
///         Targets the 65% → 90%+ branch coverage gap.
contract Test9_LoanCalculatorCoverage is TestBase {

    LoanCalculatorTest calc;

    // ── Helper: deploy calc mock + oracle env ────────────────────────────────

    struct CalcEnv {
        LoanCalculatorTest calc;
        ERC20Mock usdc;
        ERC20Mock wbtc;
        MockAggregatorV3 feed;
        AssetRegistry registry;
        PriceOracle oracle;
    }

    function _deployCalc() internal returns (CalcEnv memory c) {
        c.calc = new LoanCalculatorTest();
        c.usdc = new ERC20Mock("USD Coin",    "USDC", address(this), 10_000_000 * 1e6, 6);
        c.wbtc = new ERC20Mock("Wrapped BTC", "WBTC", address(this), 100 * 1e8,        8);
        c.feed = new MockAggregatorV3(8, BTC_PRICE); // $50,000

        c.registry = new AssetRegistry();
        c.registry.registerAsset(address(c.wbtc), "WBTC", "BTC/USD", 8);
        c.registry.registerAsset(address(c.usdc), "USDC", "",        6);
        c.registry.setAssetSupported(address(c.wbtc), true);
        c.registry.setAssetSupported(address(c.usdc), true);
        c.registry.setPairSupported(address(c.wbtc), address(c.usdc), true);

        c.oracle = new PriceOracle(address(this));
        c.oracle.setFeed(address(c.wbtc), address(c.feed), 400 days);
    }

    // =========================================================================
    // POW — branch coverage for even/odd exponents
    // =========================================================================

    /// @notice pow with odd exponent > 1 (hits exponent % 2 == 1 in loop body)
    function test_Pow_OddExponent() external {
        CalcEnv memory c = _deployCalc();
        // 2^3 = 8 (in 1e18 scale: 8e18)
        uint256 result = c.calc.testPow(2e18, 3);
        _assertEq(result, 8e18, "2^3 should equal 8 (scaled)");
    }

    /// @notice pow with even exponent (skips the odd branch on first iteration)
    function test_Pow_EvenExponent() external {
        CalcEnv memory c = _deployCalc();
        // 2^4 = 16 (in 1e18 scale: 16e18)
        uint256 result = c.calc.testPow(2e18, 4);
        _assertEq(result, 16e18, "2^4 should equal 16 (scaled)");
    }

    /// @notice pow with exponent = 1
    function test_Pow_Exponent1() external {
        CalcEnv memory c = _deployCalc();
        uint256 result = c.calc.testPow(5e18, 1);
        _assertEq(result, 5e18, "x^1 should equal x");
    }

    /// @notice pow with large exponent exercises multiple loop iterations
    function test_Pow_LargeExponent() external {
        CalcEnv memory c = _deployCalc();
        // (1.0001)^365 — realistic daily compounding
        uint256 base = 1e18 + 1e14; // 1.0001
        uint256 result = c.calc.testPow(base, 365);
        require(result > 1e18, "Compound result should exceed 1");
        require(result < 2e18, "Compound result should be less than 2");
    }

    // =========================================================================
    // HEALTH SCORE (checked) — exercises lines 184-199
    // =========================================================================

    /// @notice calculateHealthScore with loanAmount == 0 returns type(uint256).max
    function test_HealthScore_ZeroLoan() external {
        CalcEnv memory c = _deployCalc();
        uint256 health = c.calc.testCalculateHealthScore(
            1e8,              // 1 BTC collateral
            0,                // zero loan
            500,              // 5% rate
            24,               // 24 hours
            address(c.wbtc),
            6,
            c.oracle
        );
        _assertEq(health, type(uint256).max, "Zero loan should return max health");
    }

    /// @notice calculateHealthScore with non-zero loan (exercises lines 189, 192, 199)
    function test_HealthScore_NormalLoan() external {
        CalcEnv memory c = _deployCalc();
        // 1 BTC ($50k) collateral vs $1000 loan → health ~ 50x = 500000 bps
        uint256 health = c.calc.testCalculateHealthScore(
            1e8,              // 1 BTC
            1_000 * 1e6,      // $1000 loan
            500,              // 5% annual rate
            24,               // 24 hours elapsed
            address(c.wbtc),
            6,
            c.oracle
        );
        require(health > 10000, "Health should be > 100% for overcollateralized loan");
    }

    /// @notice calculateHealthScore with zero hours elapsed
    function test_HealthScore_ZeroHours() external {
        CalcEnv memory c = _deployCalc();
        uint256 health = c.calc.testCalculateHealthScore(
            1e8, 1_000 * 1e6, 500, 0, address(c.wbtc), 6, c.oracle
        );
        // At t=0, health = collateralValue / principal (no interest yet)
        require(health > 10000, "Health at t=0 should be > 100%");
    }

    // =========================================================================
    // HEALTH SCORE (unchecked) — exercises lines 280-286
    // =========================================================================

    /// @notice calculateHealthScoreUnchecked with loanAmount == 0
    function test_HealthScoreUnchecked_ZeroLoan() external {
        CalcEnv memory c = _deployCalc();
        uint256 health = c.calc.testCalculateHealthScoreUnchecked(
            1e8, 0, 500, 24, address(c.wbtc), 6, c.oracle
        );
        _assertEq(health, type(uint256).max, "Unchecked: zero loan should return max");
    }

    /// @notice calculateHealthScoreUnchecked with non-zero loan
    function test_HealthScoreUnchecked_NormalLoan() external {
        CalcEnv memory c = _deployCalc();
        uint256 health = c.calc.testCalculateHealthScoreUnchecked(
            1e8, 1_000 * 1e6, 500, 720, address(c.wbtc), 6, c.oracle
        );
        require(health > 10000, "Unchecked health should be > 100%");
    }

    // =========================================================================
    // BTC PAYOUT — branch: collateralEquivalent < collateralAmount (or not)
    // =========================================================================

    /// @notice BTCPayout when collateral exceeds debt (lender gets debt equivalent only)
    function test_BTCPayout_CollateralExceedsDebt() external {
        CalcEnv memory c = _deployCalc();
        // 1 BTC ($50k) collateral, $1k loan at 5% for 30 days
        // Debt ~ $1004, collateral equivalent ~ 0.02 BTC << 1 BTC
        uint256 payout = c.calc.testCalculateBTCPayout(
            1_000 * 1e6, 500, 30, 1e8, address(c.wbtc), 6, c.oracle
        );
        require(payout < 1e8, "Payout should be less than full collateral");
        require(payout > 0, "Payout should be non-zero");
    }

    /// @notice BTCPayout when debt exceeds collateral (lender gets all collateral)
    function test_BTCPayout_DebtExceedsCollateral() external {
        CalcEnv memory c = _deployCalc();
        // Tiny collateral: 0.0001 BTC ($5), huge loan: $10000 at 10% for 365 days
        // Debt ~ $11050 >> $5 collateral → lender gets all collateral
        uint256 payout = c.calc.testCalculateBTCPayout(
            10_000 * 1e6, 1000, 365, 10000, address(c.wbtc), 6, c.oracle
        );
        _assertEq(payout, 10000, "Payout should equal full collateral when debt > collateral value");
    }

    // =========================================================================
    // EXCESS COLLATERAL — branch: collateralAmount > collateralPayout (or 0)
    // =========================================================================

    /// @notice ExcessCollateral when collateral exceeds debt (borrower gets excess)
    function test_ExcessCollateral_HasExcess() external {
        CalcEnv memory c = _deployCalc();
        // 1 BTC ($50k) collateral, $1k loan → large excess
        uint256 excess = c.calc.testCalculateExcessCollateral(
            1_000 * 1e6, 500, 30, 1e8, address(c.wbtc), 6, c.oracle
        );
        require(excess > 0, "Should have excess collateral");
        require(excess < 1e8, "Excess should be less than full collateral");
    }

    /// @notice ExcessCollateral when debt exceeds collateral (borrower gets 0)
    function test_ExcessCollateral_NoExcess() external {
        CalcEnv memory c = _deployCalc();
        // Tiny collateral: 0.0001 BTC ($5), huge debt
        uint256 excess = c.calc.testCalculateExcessCollateral(
            10_000 * 1e6, 1000, 365, 10000, address(c.wbtc), 6, c.oracle
        );
        _assertEq(excess, 0, "No excess when debt > collateral value");
    }

    // =========================================================================
    // EXCESS COLLATERAL UNCHECKED — both branches
    // =========================================================================

    /// @notice ExcessCollateralUnchecked with excess (collateral > debt)
    function test_ExcessCollateralUnchecked_HasExcess() external {
        CalcEnv memory c = _deployCalc();
        uint256 excess = c.calc.testCalculateExcessCollateralUnchecked(
            1_000 * 1e6, 500, 30, 1e8, address(c.wbtc), 6, c.oracle
        );
        require(excess > 0, "Unchecked: should have excess");
    }

    /// @notice ExcessCollateralUnchecked with no excess (debt > collateral)
    function test_ExcessCollateralUnchecked_NoExcess() external {
        CalcEnv memory c = _deployCalc();
        uint256 excess = c.calc.testCalculateExcessCollateralUnchecked(
            10_000 * 1e6, 1000, 365, 10000, address(c.wbtc), 6, c.oracle
        );
        _assertEq(excess, 0, "Unchecked: no excess when debt > collateral");
    }

    // =========================================================================
    // ORACLE WRAPPERS — direct calls via mock
    // =========================================================================

    /// @notice getOraclePrice via mock (covers library line 56)
    function test_GetOraclePrice_Direct() external {
        CalcEnv memory c = _deployCalc();
        // 1 BTC at $50k → 50000 * 1e6 USDC
        uint256 val = c.calc.testGetOraclePrice(1e8, address(c.wbtc), 6, c.oracle);
        _assertEq(val, 50_000 * 1e6, "1 BTC should equal $50k in USDC units");
    }

    /// @notice getInverseOraclePrice via mock (covers library line 72)
    function test_GetInverseOraclePrice_Direct() external {
        CalcEnv memory c = _deployCalc();
        // $50k USDC → 1 BTC
        uint256 val = c.calc.testGetInverseOraclePrice(50_000 * 1e6, address(c.wbtc), 6, c.oracle);
        _assertEq(val, 1e8, "$50k should equal 1 BTC");
    }

    // =========================================================================
    // TOTAL REPAYMENT — edge cases
    // =========================================================================

    /// @notice Total repayment with rate = 0 (no interest)
    function test_TotalRepayment_ZeroRate() external {
        CalcEnv memory c = _deployCalc();
        uint256 result = c.calc.testCalculateTotalRepayment(1_000 * 1e6, 0, 30);
        _assertEq(result, 1_000 * 1e6, "Zero rate should return principal");
    }

    /// @notice Prorated repayment with rate = 0
    function test_ProratedRepayment_ZeroRate() external {
        CalcEnv memory c = _deployCalc();
        uint256 result = c.calc.testCalculateProratedRepaymentHourly(1_000 * 1e6, 0, 720);
        _assertEq(result, 1_000 * 1e6, "Zero rate should return principal");
    }

    /// @notice Total repayment with exponent = 1 day
    function test_TotalRepayment_OneDay() external {
        CalcEnv memory c = _deployCalc();
        uint256 result = c.calc.testCalculateTotalRepayment(1_000 * 1e6, 500, 1);
        require(result > 1_000 * 1e6, "1 day at 5% should accrue some interest");
        require(result < 1_001 * 1e6, "1 day interest should be small");
    }

    /// @notice Prorated repayment at exactly 1 hour
    function test_ProratedRepayment_OneHour() external {
        CalcEnv memory c = _deployCalc();
        uint256 result = c.calc.testCalculateProratedRepaymentHourly(1_000 * 1e6, 500, 1);
        require(result >= 1_000 * 1e6, "1 hour should accrue >= 0 interest");
    }
}
