// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Loan Calculator Library
/// @notice Pure functions for calculating loan interest and collateral health score
/// @dev Implements formulas from VeniceFi whitepaper
library LoanCalculator {
    
    uint256 constant PRECISION = 1e18;
    
    /// @notice Calculate base^exponent 
    /// @param base The base number
    /// @param exponent The exponent 
    /// @return result base^exponent
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
    
    /// @notice Get USDC value of BTC amount (ϕ_t function from whitepaper equation 23)
    /// @param amount BTC amount (with 8 decimals)
    /// @param tokenAddress The address of the collateral token
    /// @return USDC value of BTC amount (with 6 decimals)
    function getOraclePrice(uint256 amount, address tokenAddress) 
        internal pure returns (uint256) {
        // TODO: Integrate actual oracle (e.g., Chainlink)

        // Mock: 1 BTC = 50,000 USDC
        // Convert BTC (8 decimals) to USDC (6 decimals)
        return (amount * 50000) / 100;
    }
    
    /// @notice Get BTC amount for USDC value (ϕ_t^(-1) inverse function)
    /// @param usdcAmount USDC value
    /// @param tokenAddress The address of the collateral token
    /// @return BTC amount equivalent to USDC value
    function getInverseOraclePrice(uint256 usdcAmount, address tokenAddress)
        internal pure returns (uint256) {
        // Price per 1 BTC: 1 BTC = 50,000 USDC
        // Since getOraclePrice returns (amount * 50000), we need to calculate properly
        // For 1 BTC (with 8 decimals = 1e8), price is 50,000 USDC (with 6 decimals = 50e9)
        // To get BTC amount: divide USDC by 50,000
        // With proper decimal handling: (usdcAmount * 1e8) / (50000 * 1e6)
        uint256 btcPriceUSDC = 50000 * 1e6; // 50,000 USDC with 6 decimals
        return (usdcAmount * 1e8) / btcPriceUSDC; // Return BTC with 8 decimals
    }

    /// @notice Calculate total repayment: (1 + r)^d * v
    /// @dev Whitepaper equations 50-51, 54-55, 65
    /// This function converts to daily rate and applies daily compounding:
    /// r_daily = r_annual / 365
    /// Total repayment = (1 + r_daily)^durationDays * principal 
    ///
    /// @param principal The principal amount (v)
    /// @param rateBps Annual interest rate in basis points (converted to per-day rate)
    /// @param durationDays The loan duration in days (d)
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
        
        // Calculate (1 + r)^d using exponentiation
        uint256 multiplier = PRECISION + rDailyScaled; // (1 + r_daily)
        uint256 compoundFactor = pow(multiplier, durationDays);
        
        // Return (1 + r)^d * v
        return (compoundFactor * principal) / PRECISION;
    }

    /// @notice Calculate current collateral health score
    /// @dev Whitepaper equation 58 and Remark 3
    ///      Uses PRORATED loan value: ϕ_t(z) / ((1+r)^t * v)
    /// @param collateralAmount Original BTC collateral
    /// @param loanAmount Original loan principal (v)
    /// @param rateBps Interest rate in basis points (annual)
    /// @param daysElapsed Days elapsed since loan start (t) 
    /// @param collateralAddress The address of the collateral token
    /// @return healthScore The collateral health score in basis points (10000 = 100%)
    function calculateHealthScore(
        uint256 collateralAmount,
        uint256 loanAmount,
        uint256 rateBps,
        uint256 daysElapsed,
        address collateralAddress
    ) internal pure returns (uint256) {
        if (loanAmount == 0) {
            return 0;
        }
        
        // ϕ_t(z): Convert BTC collateral to USDC value
        uint256 collateralValue = getOraclePrice(collateralAmount, collateralAddress);
        
        // (1 + r)^t * v: Calculate prorated loan value using elapsed time
        uint256 proratedLoanValue = calculateTotalRepayment(
            loanAmount,
            rateBps,
            daysElapsed // Use elapsed time, not duration!
        );
        
        // [ϕ_t(z) * 10000] / [(1+r)^t * v]: Return ratio in basis points
        return (collateralValue * 10000) / proratedLoanValue;
    }

    /// @notice Calculate BTC payout for lender at loan maturity
    /// @dev Whitepaper equations 54-55: min{ϕ_d^(-1)((1+r)^d * v), z}
    /// @param principal Loan principal (v)
    /// @param rateBps Interest rate in basis points (annual)
    /// @param durationDays Full loan duration in days (d)
    /// @param collateralAmount BTC collateral (z)
    /// @param collateralAddress The address of the collateral token
    /// @return BTC amount paid to lender
    function calculateBTCPayout(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress
    ) internal pure returns (uint256) {
        // Calculate total repayment in USDC: (1 + r)^d * v
        uint256 usdcAmount = calculateTotalRepayment(
            principal,
            rateBps,
            durationDays
        );
        
        // Convert to BTC equivalent: ϕ^(-1)(totalUSDC)
        // Use getInverseOraclePrice to convert USDC to BTC
        uint256 btcEquivalent = getInverseOraclePrice(usdcAmount, collateralAddress);
        
        // Equation 54: min{ϕ^(-1)((1+r)^d * v), z}
        return btcEquivalent < collateralAmount ? btcEquivalent : collateralAmount;
    }

    /// @notice Calculate excess BTC collateral returned to borrower
    /// @dev Whitepaper equation 55: max{z - ϕ^(-1)((1+r)^d * v), 0}
    /// @param principal Loan principal (v)
    /// @param rateBps Interest rate in basis points (annual)
    /// @param durationDays Full loan duration in days (d)
    /// @param collateralAmount BTC collateral (z)
    /// @param collateralAddress The address of the collateral token
    /// @return BTC amount returned to borrower
    function calculateExcessCollateral(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateralAmount,
        address collateralAddress
    ) internal pure returns (uint256) {
        uint256 btcPayout = calculateBTCPayout(
            principal,
            rateBps,
            durationDays,
            collateralAmount,
            collateralAddress
        );
        
        // Equation 55: max{z - min{ϕ^(-1)((1+r)^d * v), z}, 0}
        // if collateralAmount greater than btcPayout
        // return difference, otherwise 0
        return collateralAmount > btcPayout ? collateralAmount - btcPayout : 0;
    }
}