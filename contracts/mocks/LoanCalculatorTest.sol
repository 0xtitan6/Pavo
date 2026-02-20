// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../libraries/LoanCalculator.sol";

/// @title LoanCalculatorTest
/// @notice Test contract to expose LoanCalculator library functions for testing
contract LoanCalculatorTest {
    
    /// @notice Test wrapper for pow function
    function testPow(uint256 base, uint256 exponent) external pure returns (uint256) {
        return LoanCalculator.pow(base, exponent);
    }
    
    /// @notice Test wrapper for getOraclePrice function
    function testGetOraclePrice(uint256 amount, address tokenAddress) external pure returns (uint256) {
        return LoanCalculator.getOraclePrice(amount, tokenAddress);
    }
    
    /// @notice Test wrapper for getInverseOraclePrice function
    function testGetInverseOraclePrice(uint256 usdcAmount, address tokenAddress) external pure returns (uint256) {
        return LoanCalculator.getInverseOraclePrice(usdcAmount, tokenAddress);
    }
    
    /// @notice Test wrapper for calculateTotalRepayment function
    function testCalculateTotalRepayment(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) external pure returns (uint256) {
        return LoanCalculator.calculateTotalRepayment(principal, rateBps, durationDays);
    }
    
    /// @notice Test wrapper for calculateHealthScore function
    function testCalculateHealthScore(
        uint256 collateralAmount,
        uint256 loanAmount,
        uint256 rateBps,
        uint256 daysElapsed,
        address collateralAddress
    ) external pure returns (uint256) {
        return LoanCalculator.calculateHealthScore(
            collateralAmount,
            loanAmount,
            rateBps,
            daysElapsed,
            collateralAddress
        );
    }
    
    /// @notice Test wrapper for calculateBTCPayout function
    function testCalculateBTCPayout(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress
    ) external pure returns (uint256) {
        return LoanCalculator.calculateBTCPayout(
            principal,
            rateBps,
            durationDays,
            collateralAmount,
            collateralAddress
        );
    }
    
    /// @notice Test wrapper for calculateExcessCollateral function
    function testCalculateExcessCollateral(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress
    ) external pure returns (uint256) {
        return LoanCalculator.calculateExcessCollateral(
            principal,
            rateBps,
            durationDays,
            collateralAmount,
            collateralAddress
        );
    }
}
