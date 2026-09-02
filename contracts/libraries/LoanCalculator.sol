// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../PriceOracle.sol";

/// @title Loan Calculator Library
/// @notice Pure/view functions for calculating loan interest and collateral health score
/// @dev Implements formulas from Pavo whitepaper
///      Now uses PriceOracle for live Chainlink prices instead of hardcoded values
library LoanCalculator {
    
    uint256 constant PRECISION = 1e18;

    // ========================================================================
    // EXPONENTIATION
    // ========================================================================
    
    /// @notice Calculate base^exponent using binary exponentiation with 1e18 precision
    /// @param base The base number (1e18 scale)
    /// @param exponent The exponent (integer)
    /// @return result base^exponent (1e18 scale)
    function pow(uint256 base, uint256 exponent) internal pure returns (uint256) {
        if (exponent == 0) return PRECISION;
        
        uint256 result = PRECISION;
        uint256 currentBase = base;
        
        while (exponent > 0) {
            if (exponent % 2 == 1) {
                result = (result * currentBase) / PRECISION;
            }
            currentBase = (currentBase * currentBase) / PRECISION;
            exponent /= 2;
        }
        
        return result;
    }

    // ========================================================================
    // ORACLE WRAPPERS — ϕ_t(z) and ϕ_t^(-1)(v)
    // ========================================================================

    /// @notice Get asset-denominated value of collateral amount: ϕ_t(z)
    /// @dev Whitepaper equation 23: ϕ_t(H_t, v) valuation process
    /// @param amount Collateral token amount
    /// @param tokenAddress The collateral token address
    /// @param assetDecimals Decimals of the asset (lent) token
    /// @param oracle The PriceOracle contract instance
    /// @return Asset-denominated value of the collateral
    function getOraclePrice(
        uint256 amount,
        address tokenAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256) {
        return oracle.getOraclePrice(amount, tokenAddress, assetDecimals);
    }

    /// @notice Get collateral amount for an asset value: ϕ_t^(-1)(v)
    /// @dev Inverse valuation function
    /// @param assetAmount Asset (stablecoin) amount in asset decimal units
    /// @param tokenAddress The collateral token address
    /// @param assetDecimals Decimals of the asset (lent) token
    /// @param oracle The PriceOracle contract instance
    /// @return Collateral token amount
    function getInverseOraclePrice(
        uint256 assetAmount,
        address tokenAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256) {
        return oracle.getInverseOraclePrice(assetAmount, tokenAddress, assetDecimals);
    }

    /// @notice Get collateral value in asset units, bypassing the circuit breaker
    /// @dev Use for liquidations/settlement — circuit breaker must not block these
    function getOraclePriceUnchecked(
        uint256 amount,
        address tokenAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256) {
        return oracle.getOraclePriceUnchecked(amount, tokenAddress, assetDecimals);
    }

    /// @notice Get collateral amount for an asset value, bypassing the circuit breaker
    /// @dev Use for liquidations/settlement — circuit breaker must not block these
    function getInverseOraclePriceUnchecked(
        uint256 assetAmount,
        address tokenAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256) {
        return oracle.getInverseOraclePriceUnchecked(assetAmount, tokenAddress, assetDecimals);
    }

    // ========================================================================
    // INTEREST CALCULATIONS — (1 + r)^d * v
    // ========================================================================


    /// @notice Calculate total repayment: (1 + r)^d * v
    /// @dev Whitepaper equations 50-51, 54-55, 65
    ///      Converts annual rate to daily rate and applies daily compounding:
    ///      r_daily = r_annual / 365
    ///      Total repayment = (1 + r_daily)^durationDays * principal 
    /// @param principal The principal amount v (USDC, 6 decimals)
    /// @param rateBps Annual interest rate in basis points
    /// @param durationDays The loan duration in days d
    /// @return totalRepayment The total amount to be repaid at maturity
    function calculateTotalRepayment(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) internal pure returns (uint256) {
        if (durationDays == 0) {
            return principal;
        }
        
        // Convert annual rate to daily rate: r_daily = r_annual / 365
        // rateBps is in basis points, so divide by 10000 for decimal, then by 365 for daily
        uint256 rDailyScaled = (rateBps * PRECISION) / (10000 * 365);
        
        // Calculate (1 + r_daily)^d using binary exponentiation
        uint256 multiplier = PRECISION + rDailyScaled;
        uint256 compoundFactor = pow(multiplier, durationDays);
        
        // Return (1 + r)^d * v
        return (compoundFactor * principal) / PRECISION;
    }

    /// @notice Calculate prorated repayment using hourly compounding
    /// @dev Used by liquidation health checks for finer granularity than daily
    ///      r_hourly = r_annual / (365 * 24)
    ///      Prorated value = (1 + r_hourly)^hoursElapsed * principal
    /// @param principal The principal amount v (USDC, 6 decimals)
    /// @param rateBps Annual interest rate in basis points
    /// @param hoursElapsed Hours elapsed since loan start
    /// @return proratedValue The prorated loan value at the given hour
    function calculateProratedRepaymentHourly(
        uint256 principal,
        uint256 rateBps,
        uint256 hoursElapsed
    ) internal pure returns (uint256) {
        if (hoursElapsed == 0) {
            return principal;
        }

        // Convert annual rate to hourly: r_hourly = r_annual / (365 * 24)
        uint256 rHourlyScaled = (rateBps * PRECISION) / (10000 * 365 * 24);

        // Calculate (1 + r_hourly)^hoursElapsed
        uint256 multiplier = PRECISION + rHourlyScaled;
        uint256 compoundFactor = pow(multiplier, hoursElapsed);

        return (compoundFactor * principal) / PRECISION;
    }

    // ========================================================================
    // HEALTH SCORE — ϕ_t(z) / ((1+r)^t * v)
    // ========================================================================

    /// @notice Calculate current collateral health score (hourly precision)
    /// @dev Whitepaper equation 58 and Remark 3 (prorated health factor)
    ///      Health = ϕ_t(z) / ((1+r)^t * v) expressed in basis points
    ///      Uses hourly compounding for smooth health decay instead of daily steps
    /// @param collateralAmount Collateral token amount z
    /// @param loanAmount Loan principal v (in asset decimal units)
    /// @param rateBps Interest rate in basis points (annual)
    /// @param hoursElapsed Hours elapsed since loan start
    /// @param collateralAddress The collateral token address
    /// @param assetDecimals Decimals of the asset (lent) token
    /// @param oracle The PriceOracle contract instance
    /// @return healthScore The collateral health score in basis points (10000 = 100%)
    function calculateHealthScore(
        uint256 collateralAmount,
        uint256 loanAmount,
        uint256 rateBps,
        uint256 hoursElapsed,
        address collateralAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256) {
        if (loanAmount == 0) {
            return type(uint256).max; // Infinite health if no loan
        }

        // ϕ_t(z): Get asset-denominated value of collateral via Chainlink
        uint256 collateralValue = getOraclePrice(collateralAmount, collateralAddress, assetDecimals, oracle);

        // (1 + r)^t * v: Calculate prorated loan value using hourly compounding
        uint256 proratedLoanValue = calculateProratedRepaymentHourly(
            loanAmount,
            rateBps,
            hoursElapsed
        );

        // [ϕ_t(z) * 10000] / [(1+r)^t * v]: Return ratio in basis points
        return (collateralValue * 10000) / proratedLoanValue;
    }

    // ========================================================================
    // LOAN SETTLEMENT — min/max BTC payouts
    // ========================================================================

    /// @notice Calculate collateral payout to lender at loan maturity
    /// @dev Whitepaper equation 54: min{ϕ^(-1)((1+r)^d * v), z}
    ///      Lender gets the lesser of: collateral equivalent of debt, or all collateral
    /// @param principal Loan principal v (in asset decimal units)
    /// @param rateBps Interest rate in basis points (annual)
    /// @param durationDays Full loan duration d
    /// @param collateralAmount Collateral token amount z
    /// @param collateralAddress The collateral token address
    /// @param assetDecimals Decimals of the asset (lent) token
    /// @param oracle The PriceOracle contract instance
    /// @return collateralPayout Collateral token amount paid to lender
    function calculateBTCPayout(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256 collateralPayout) {
        // Calculate total repayment in asset units: (1 + r)^d * v
        uint256 assetAmount = calculateTotalRepayment(principal, rateBps, durationDays);

        // Convert to collateral equivalent: ϕ^(-1)((1+r)^d * v)
        uint256 collateralEquivalent = getInverseOraclePrice(assetAmount, collateralAddress, assetDecimals, oracle);

        // Equation 54: min{ϕ^(-1)((1+r)^d * v), z}
        collateralPayout = collateralEquivalent < collateralAmount ? collateralEquivalent : collateralAmount;
    }

    /// @notice Calculate excess collateral returned to borrower
    /// @dev Whitepaper equation 55: max{z - ϕ^(-1)((1+r)^d * v), 0}
    ///      Borrower gets back whatever collateral exceeds the debt
    /// @param principal Loan principal v (in asset decimal units)
    /// @param rateBps Interest rate in basis points (annual)
    /// @param durationDays Full loan duration d
    /// @param collateralAmount Collateral token amount z
    /// @param collateralAddress The collateral token address
    /// @param assetDecimals Decimals of the asset (lent) token
    /// @param oracle The PriceOracle contract instance
    /// @return excessCollateral Collateral token amount returned to borrower
    function calculateExcessCollateral(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256 excessCollateral) {
        uint256 collateralPayout = calculateBTCPayout(
            principal, rateBps, durationDays,
            collateralAmount, collateralAddress, assetDecimals, oracle
        );

        // Equation 55: max{z - collateralPayout, 0}
        excessCollateral = collateralAmount > collateralPayout ? collateralAmount - collateralPayout : 0;
    }

    // ========================================================================
    // UNCHECKED VARIANTS — bypass circuit breaker for liquidation/settlement
    // ========================================================================

    /// @notice Health score bypassing the circuit breaker
    /// @dev Use in liquidateLoan — a crash must not block liquidations
    function calculateHealthScoreUnchecked(
        uint256 collateralAmount,
        uint256 loanAmount,
        uint256 rateBps,
        uint256 hoursElapsed,
        address collateralAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256) {
        if (loanAmount == 0) return type(uint256).max;

        uint256 collateralValue = getOraclePriceUnchecked(collateralAmount, collateralAddress, assetDecimals, oracle);
        uint256 proratedLoanValue = calculateProratedRepaymentHourly(loanAmount, rateBps, hoursElapsed);

        return (collateralValue * 10000) / proratedLoanValue;
    }

    /// @notice Excess collateral bypassing the circuit breaker
    /// @dev Use in endLoan — matured loans must always be settleable
    function calculateExcessCollateralUnchecked(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress,
        uint8 assetDecimals,
        PriceOracle oracle
    ) internal returns (uint256 excessCollateral) {
        uint256 assetAmount = calculateTotalRepayment(principal, rateBps, durationDays);
        uint256 collateralEquivalent = getInverseOraclePriceUnchecked(assetAmount, collateralAddress, assetDecimals, oracle);
        uint256 collateralPayout = collateralEquivalent < collateralAmount ? collateralEquivalent : collateralAmount;
        excessCollateral = collateralAmount > collateralPayout ? collateralAmount - collateralPayout : 0;
    }
}
