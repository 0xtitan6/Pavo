// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";
import "../mocks/LoanCalculatorTest.sol";

/// @title Test10_PrecisionFuzz
/// @notice Precision and edge-case tests for LoanCalculator after mulDiv refactor.
///         Verifies that calculateTotalRepayment and pow produce correct results
///         across a wide range of inputs (rates, durations, principals).
contract Test10_PrecisionFuzz is TestBase {

    LoanCalculatorTest calc;

    function _deploy10() internal returns (LoanCalculatorTest) {
        return new LoanCalculatorTest();
    }

    // =========================================================================
    // POW — precision with mulDiv
    // =========================================================================

    /// @notice pow(1e18, N) == 1e18 for any N (identity base)
    function test_Pow_IdentityBase() external {
        calc = _deploy10();
        _assertEq(calc.testPow(1e18, 0),   1e18, "1^0 = 1");
        _assertEq(calc.testPow(1e18, 1),   1e18, "1^1 = 1");
        _assertEq(calc.testPow(1e18, 365), 1e18, "1^365 = 1");
        _assertEq(calc.testPow(1e18, 8760), 1e18, "1^8760 = 1");
    }

    /// @notice pow with base = 0 returns 0 for exponent > 0
    function test_Pow_ZeroBase() external {
        calc = _deploy10();
        _assertEq(calc.testPow(0, 1), 0, "0^1 = 0");
        _assertEq(calc.testPow(0, 100), 0, "0^100 = 0");
    }

    /// @notice pow(base, 0) == 1e18 for any base
    function test_Pow_ZeroExponent() external {
        calc = _deploy10();
        _assertEq(calc.testPow(0, 0), 1e18, "0^0 = 1");
        _assertEq(calc.testPow(5e18, 0), 1e18, "5^0 = 1");
        _assertEq(calc.testPow(1e36, 0), 1e18, "1e18^0 = 1");
    }

    /// @notice pow precision: (1.0001)^365 should be close to e^0.0365 ≈ 1.03717
    function test_Pow_DailyCompounding_Precision() external {
        calc = _deploy10();
        uint256 base = 1e18 + 1e14; // 1.0001
        uint256 result = calc.testPow(base, 365);
        // Expected: ~1.037170e18 (within 0.01%)
        _assertGt(result, 1_037_000e12, "Should be > 1.037");
        require(result < 1_038_000e12, "Should be < 1.038");
    }

    // =========================================================================
    // TOTAL REPAYMENT — precision sweep
    // =========================================================================

    /// @notice Zero duration returns principal unchanged
    function test_TotalRepayment_ZeroDuration() external {
        calc = _deploy10();
        _assertEq(calc.testCalculateTotalRepayment(1_000_000e6, 500, 0), 1_000_000e6, "0 days = principal");
    }

    /// @notice Zero rate returns principal unchanged regardless of duration
    function test_TotalRepayment_ZeroRate_AnyDuration() external {
        calc = _deploy10();
        _assertEq(calc.testCalculateTotalRepayment(500e6, 0, 1), 500e6, "0% 1d");
        _assertEq(calc.testCalculateTotalRepayment(500e6, 0, 30), 500e6, "0% 30d");
        _assertEq(calc.testCalculateTotalRepayment(500e6, 0, 365), 500e6, "0% 365d");
    }

    /// @notice Monotonicity: higher rate → higher repayment (same principal/duration)
    function test_TotalRepayment_MonotonicInRate() external {
        calc = _deploy10();
        uint256 principal = 10_000e6;
        uint256 r400  = calc.testCalculateTotalRepayment(principal, 400, 365);
        uint256 r600  = calc.testCalculateTotalRepayment(principal, 600, 365);
        uint256 r1000 = calc.testCalculateTotalRepayment(principal, 1000, 365);
        uint256 r1100 = calc.testCalculateTotalRepayment(principal, 1100, 365);
        require(r400 < r600, "4% < 6%");
        require(r600 < r1000, "6% < 10%");
        require(r1000 < r1100, "10% < 11%");
    }

    /// @notice Monotonicity: longer duration → higher repayment (same rate)
    function test_TotalRepayment_MonotonicInDuration() external {
        calc = _deploy10();
        uint256 principal = 10_000e6;
        uint256 d1   = calc.testCalculateTotalRepayment(principal, 500, 1);
        uint256 d30  = calc.testCalculateTotalRepayment(principal, 500, 30);
        uint256 d180 = calc.testCalculateTotalRepayment(principal, 500, 180);
        uint256 d365 = calc.testCalculateTotalRepayment(principal, 500, 365);
        require(d1 < d30, "1d < 30d");
        require(d30 < d180, "30d < 180d");
        require(d180 < d365, "180d < 365d");
    }

    /// @notice Linearity: repayment scales linearly with principal (at same rate/duration)
    function test_TotalRepayment_LinearInPrincipal() external {
        calc = _deploy10();
        uint256 r1 = calc.testCalculateTotalRepayment(1_000e6, 500, 365);
        uint256 r2 = calc.testCalculateTotalRepayment(2_000e6, 500, 365);
        uint256 r10 = calc.testCalculateTotalRepayment(10_000e6, 500, 365);
        // r2 should be exactly 2*r1 (mulDiv preserves this)
        _assertEq(r2, 2 * r1, "2x principal = 2x repayment");
        _assertEq(r10, 10 * r1, "10x principal = 10x repayment");
    }

    /// @notice Large principal: no overflow with 1B USDC at max rate for max duration
    function test_TotalRepayment_LargePrincipal() external {
        calc = _deploy10();
        uint256 principal = 1_000_000_000e6; // 1 billion USDC
        uint256 result = calc.testCalculateTotalRepayment(principal, 1100, 365);
        // 11% for 365 days → ~1.1161x
        require(result > principal, "Should accrue interest");
        require(result < 2 * principal, "Should not double in 1 year at 11%");
    }

    /// @notice Small principal: 100 USDC (min loan) precision check
    function test_TotalRepayment_SmallPrincipal() external {
        calc = _deploy10();
        uint256 principal = 100e6; // 100 USDC = 1e8
        uint256 result = calc.testCalculateTotalRepayment(principal, 500, 365);
        // 5% for 1 year: 100 * 1.05127 ≈ 105.127 USDC
        require(result > 105e6, "Should be > 105 USDC");
        require(result < 106e6, "Should be < 106 USDC");
    }

    /// @notice Sweep all protocol rate/duration combos for reference principal
    function test_TotalRepayment_AllRateDurationCombos() external {
        calc = _deploy10();
        uint256 principal = 10_000e6;
        uint256[8] memory rates = [uint256(400), 500, 600, 700, 800, 900, 1000, 1100];
        uint256[6] memory durations = [uint256(1), 7, 30, 90, 180, 365];

        for (uint256 r = 0; r < 8; r++) {
            for (uint256 d = 0; d < 6; d++) {
                uint256 result = calc.testCalculateTotalRepayment(principal, rates[r], durations[d]);
                // Basic invariant: result >= principal (no negative interest)
                require(result >= principal, "Repayment must be >= principal");
                // Interest should be bounded: at most rateBps/10000 * principal per year
                // For sub-year, even less. Conservative upper bound: principal * 1.15
                require(result <= principal * 115 / 100, "Repayment too high for bounded rates");
            }
        }
    }

    // =========================================================================
    // PRORATED HOURLY — precision
    // =========================================================================

    /// @notice Hourly and daily compounding should agree at 24-hour boundaries
    function test_Hourly_MatchesDaily_At24h() external {
        calc = _deploy10();
        uint256 principal = 10_000e6;
        uint256 rateBps = 500;

        uint256 daily1 = calc.testCalculateTotalRepayment(principal, rateBps, 1);
        uint256 hourly24 = calc.testCalculateProratedRepaymentHourly(principal, rateBps, 24);

        // They use different compounding frequencies so won't be exact,
        // but should be very close (within 1 USDC unit = 1e6)
        uint256 diff = daily1 > hourly24 ? daily1 - hourly24 : hourly24 - daily1;
        require(diff < 1e6, "Daily and hourly should agree within 1 USDC at 24h");
    }

    /// @notice Monotonicity: more hours → higher repayment
    function test_ProratedHourly_Monotonic() external {
        calc = _deploy10();
        uint256 principal = 10_000e6;
        uint256 h1 = calc.testCalculateProratedRepaymentHourly(principal, 500, 1);
        uint256 h24 = calc.testCalculateProratedRepaymentHourly(principal, 500, 24);
        uint256 h720 = calc.testCalculateProratedRepaymentHourly(principal, 500, 720);
        uint256 h8760 = calc.testCalculateProratedRepaymentHourly(principal, 500, 8760);
        require(h1 <= h24, "1h <= 24h");
        require(h24 < h720, "24h < 720h");
        require(h720 < h8760, "720h < 8760h");
    }
}
