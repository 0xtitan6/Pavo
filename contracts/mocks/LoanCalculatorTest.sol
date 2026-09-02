// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../libraries/LoanCalculator.sol";
import "../PriceOracle.sol";

/// @title LoanCalculatorTest
/// @notice Exposes LoanCalculator library functions for unit testing
contract LoanCalculatorTest {

    // ========================================================================
    // PURE FUNCTIONS (no oracle)
    // ========================================================================

    function testPow(uint256 base, uint256 exponent) external pure returns (uint256) {
        return LoanCalculator.pow(base, exponent);
    }

    function testCalculateTotalRepayment(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) external pure returns (uint256) {
        return LoanCalculator.calculateTotalRepayment(principal, rateBps, durationDays);
    }

    function testCalculateProratedRepaymentHourly(
        uint256 principal,
        uint256 rateBps,
        uint256 hoursElapsed
    ) external pure returns (uint256) {
        return LoanCalculator.calculateProratedRepaymentHourly(principal, rateBps, hoursElapsed);
    }

    // ========================================================================
    // ORACLE FUNCTIONS (require PriceOracle)
    // ========================================================================

    function testGetOraclePrice(
        uint256 amount,
        address tokenAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) external returns (uint256) {
        return LoanCalculator.getOraclePrice(amount, tokenAddress, assetDecimals, oracle);
    }

    function testGetInverseOraclePrice(
        uint256 assetAmount,
        address tokenAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) external returns (uint256) {
        return LoanCalculator.getInverseOraclePrice(assetAmount, tokenAddress, assetDecimals, oracle);
    }

    function testCalculateHealthScore(
        uint256 collateralAmount,
        uint256 loanAmount,
        uint256 rateBps,
        uint256 hoursElapsed,
        address collateralAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) external returns (uint256) {
        return LoanCalculator.calculateHealthScore(
            collateralAmount,
            loanAmount,
            rateBps,
            hoursElapsed,
            collateralAddress,
            assetDecimals,
            oracle
        );
    }

    function testCalculateCollateralPayout(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) external returns (uint256) {
        return LoanCalculator.calculateCollateralPayout(
            principal,
            rateBps,
            durationDays,
            collateralAmount,
            collateralAddress,
            assetDecimals,
            oracle
        );
    }

    function testCalculateExcessCollateral(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) external returns (uint256) {
        return LoanCalculator.calculateExcessCollateral(
            principal,
            rateBps,
            durationDays,
            collateralAmount,
            collateralAddress,
            assetDecimals,
            oracle
        );
    }
}
