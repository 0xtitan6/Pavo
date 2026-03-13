// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ScaleFactorLib - RAY (1e27) fixed-point arithmetic for scale factor interest accrual
/// @notice Adapted from Wildcat Finance MathUtils.sol + FeeMath.sol (Apache-2.0)
/// @dev Must produce identical results to DAML ScaleMath.daml (which uses RAY=1e9)
///      Formulas are identical; only the RAY constant differs.
///      See test-vectors/module2-math.json for cross-platform parity assertions.
library ScaleFactorLib {
    // ─── Constants ─────────────────────────────────────────────────────

    uint256 internal constant RAY = 1e27;
    uint256 internal constant HALF_RAY = 0.5e27;

    uint256 internal constant BIP = 1e4;
    uint256 internal constant HALF_BIP = 0.5e4;
    uint256 internal constant BIP_RAY_RATIO = 1e23;

    uint256 internal constant SECONDS_IN_365_DAYS = 365 days;

    // ─── Errors ────────────────────────────────────────────────────────

    error MulDivFailed();
    error DivisionByZero();
    error Overflow();

    // ─── RAY Arithmetic ────────────────────────────────────────────────

    /// @notice Multiply two RAY values: (a * b + HALF_RAY) / RAY
    /// @dev Matches DAML ScaleMath.rayMul
    function rayMul(uint256 a, uint256 b) internal pure returns (uint256 c) {
        assembly {
            if iszero(or(iszero(b), iszero(gt(a, div(sub(not(0), HALF_RAY), b))))) {
                mstore(0x00, 0x35278d12) // Overflow()
                revert(0x1c, 0x04)
            }
            c := div(add(mul(a, b), HALF_RAY), RAY)
        }
    }

    /// @notice Divide two RAY values: (a * RAY + b/2) / b
    /// @dev Matches DAML ScaleMath.rayDiv
    function rayDiv(uint256 a, uint256 b) internal pure returns (uint256 c) {
        assembly {
            if or(iszero(b), gt(a, div(sub(not(0), div(b, 2)), RAY))) {
                mstore(0x00, 0x35278d12) // Overflow()
                revert(0x1c, 0x04)
            }
            c := div(add(mul(a, RAY), div(b, 2)), b)
        }
    }

    /// @notice Convert basis points to RAY: bips * 1e23
    /// @dev Matches DAML ScaleMath.bipsToRay
    function bipToRay(uint256 bips) internal pure returns (uint256 b) {
        assembly {
            b := mul(bips, BIP_RAY_RATIO)
            if iszero(eq(div(b, BIP_RAY_RATIO), bips)) {
                mstore(0x00, 0x35278d12) // Overflow()
                revert(0x1c, 0x04)
            }
        }
    }

    /// @notice Multiply two BIP values: (a * b + HALF_BIP) / BIP
    function bipMul(uint256 a, uint256 b) internal pure returns (uint256 c) {
        assembly {
            if iszero(or(iszero(b), iszero(gt(a, div(sub(not(0), HALF_BIP), b))))) {
                mstore(0x00, 0x35278d12) // Overflow()
                revert(0x1c, 0x04)
            }
            c := div(add(mul(a, b), HALF_BIP), BIP)
        }
    }

    // ─── Scale Conversions (match DAML ScaleMath.scaleUp/scaleDown) ───

    /// @notice Convert normalized amount to scaled balance: amount * RAY / scaleFactor
    /// @dev Matches DAML ScaleMath.scaleUp (aka `scale`)
    function scaleAmount(uint256 amount, uint256 scaleFactor) internal pure returns (uint256) {
        return rayDiv(amount, scaleFactor);
    }

    /// @notice Convert scaled balance to normalized amount: scaledAmount * scaleFactor / RAY
    /// @dev Matches DAML ScaleMath.scaleDown (aka `normalize`)
    function normalizeAmount(uint256 scaledAmount, uint256 scaleFactor) internal pure returns (uint256) {
        return rayMul(scaledAmount, scaleFactor);
    }

    // ─── Interest Calculations ─────────────────────────────────────────

    /// @notice Calculate linear interest rate in RAY for a given time period
    /// @param rateBip Annual interest rate in basis points
    /// @param timeDelta Seconds elapsed since last accrual
    /// @return interestRay Interest accumulated in RAY units
    /// @dev Matches DAML ScaleMath.calculateLinearInterestRay
    ///      Formula: (rateBip * 1e23) * timeDelta / SECONDS_IN_365_DAYS
    function calculateLinearInterestFromBips(
        uint256 rateBip,
        uint256 timeDelta
    ) internal pure returns (uint256 interestRay) {
        uint256 rate = bipToRay(rateBip);
        uint256 accumulatedInterestRay = rate * timeDelta;
        unchecked {
            return accumulatedInterestRay / SECONDS_IN_365_DAYS;
        }
    }

    /// @notice Apply interest to scale factor: newSF = oldSF + oldSF * interestRay / RAY
    /// @dev Matches DAML ScaleMath.applyInterestToScaleFactor
    function applyInterestToScaleFactor(
        uint256 currentScaleFactor,
        uint256 interestRay
    ) internal pure returns (uint256) {
        uint256 increase = rayMul(currentScaleFactor, interestRay);
        return currentScaleFactor + increase;
    }

    // ─── Delinquency Fee Calculation ───────────────────────────────────

    /// @notice Calculate penalty time accounting for grace period
    /// @param isDelinquent Whether market is currently delinquent
    /// @param previousTimeDelinquent Total seconds previously delinquent
    /// @param delinquencyGracePeriod Grace period before penalties apply
    /// @param timeDelta Seconds since last update
    /// @return timeWithPenalty Seconds subject to penalty fees
    /// @return newTimeDelinquent Updated total delinquent time
    /// @dev Matches Wildcat FeeMath.updateTimeDelinquentAndGetPenaltyTime
    function updateTimeDelinquentAndGetPenaltyTime(
        bool isDelinquent,
        uint256 previousTimeDelinquent,
        uint256 delinquencyGracePeriod,
        uint256 timeDelta
    ) internal pure returns (uint256 timeWithPenalty, uint256 newTimeDelinquent) {
        if (isDelinquent) {
            newTimeDelinquent = previousTimeDelinquent + timeDelta;
            uint256 secondsRemainingWithoutPenalty = satSub(delinquencyGracePeriod, previousTimeDelinquent);
            timeWithPenalty = satSub(timeDelta, secondsRemainingWithoutPenalty);
        } else {
            newTimeDelinquent = satSub(previousTimeDelinquent, timeDelta);
            uint256 secondsRemainingWithPenalty = satSub(previousTimeDelinquent, delinquencyGracePeriod);
            timeWithPenalty = min(secondsRemainingWithPenalty, timeDelta);
        }
    }

    // ─── Full Scale Factor Update ──────────────────────────────────────

    /// @notice Calculate interest, delinquency fees, and protocol fees; update scale factor
    /// @dev Matches Wildcat FeeMath.updateScaleFactorAndFees + DAML Market.AccrueInterest
    /// @param scaleFactor Current scale factor
    /// @param annualInterestBips Annual interest in bips
    /// @param delinquencyFeeBips Penalty fee in bips
    /// @param protocolFeeBips Protocol fee in bips
    /// @param scaledTotalSupply Current scaled supply
    /// @param isDelinquent Whether market is delinquent
    /// @param timeDelinquent Total seconds delinquent
    /// @param delinquencyGracePeriod Grace period in seconds
    /// @param maxDelinquencyPeriod Max penalty accrual in seconds
    /// @param timeDelta Seconds since last accrual
    function updateScaleFactorAndFees(
        uint256 scaleFactor,
        uint256 annualInterestBips,
        uint256 delinquencyFeeBips,
        uint256 protocolFeeBips,
        uint256 scaledTotalSupply,
        bool isDelinquent,
        uint256 timeDelinquent,
        uint256 delinquencyGracePeriod,
        uint256 maxDelinquencyPeriod,
        uint256 timeDelta
    )
        internal
        pure
        returns (
            uint256 newScaleFactor,
            uint256 baseInterestRay,
            uint256 delinquencyFeeRay,
            uint256 protocolFee,
            uint256 newTimeDelinquent
        )
    {
        // 1. Base interest
        baseInterestRay = calculateLinearInterestFromBips(annualInterestBips, timeDelta);

        // 2. Protocol fee (charged on base interest)
        if (protocolFeeBips > 0) {
            uint256 protocolFeeRay = bipMul(protocolFeeBips, baseInterestRay);
            protocolFee = normalizeAmount(scaledTotalSupply, rayMul(scaleFactor, protocolFeeRay));
        }

        // 3. Delinquency fee
        if (delinquencyFeeBips > 0 && isDelinquent) {
            // Cap at maxDelinquencyPeriod
            uint256 cappedTimeDelta = timeDelta;
            if (timeDelinquent + timeDelta > maxDelinquencyPeriod) {
                cappedTimeDelta = satSub(maxDelinquencyPeriod, timeDelinquent);
            }

            uint256 timeWithPenalty;
            (timeWithPenalty, newTimeDelinquent) = updateTimeDelinquentAndGetPenaltyTime(
                isDelinquent,
                timeDelinquent,
                delinquencyGracePeriod,
                cappedTimeDelta
            );

            if (timeWithPenalty > 0) {
                delinquencyFeeRay = calculateLinearInterestFromBips(delinquencyFeeBips, timeWithPenalty);
            }
        } else if (!isDelinquent) {
            // Recovery: reduce timeDelinquent
            (, newTimeDelinquent) = updateTimeDelinquentAndGetPenaltyTime(
                false,
                timeDelinquent,
                delinquencyGracePeriod,
                timeDelta
            );
        } else {
            newTimeDelinquent = timeDelinquent;
        }

        // 4. Apply to scale factor
        uint256 scaleFactorDelta = rayMul(scaleFactor, baseInterestRay + delinquencyFeeRay);
        newScaleFactor = scaleFactor + scaleFactorDelta;
    }

    // ─── Liquidity Requirement ─────────────────────────────────────────

    /// @notice Calculate minimum assets borrower must maintain
    /// @dev Matches DAML ScaleMath.calculateLiquidityRequired
    function liquidityRequired(
        uint256 scaledTotalSupply,
        uint256 scaledPendingWithdrawals,
        uint256 normalizedUnclaimedWithdrawals,
        uint256 accruedProtocolFees,
        uint256 reserveRatioBips,
        uint256 scaleFactor
    ) internal pure returns (uint256) {
        uint256 scaledRequiredReserves = bipMul(
            scaledTotalSupply - scaledPendingWithdrawals,
            reserveRatioBips
        ) + scaledPendingWithdrawals;

        return normalizeAmount(scaledRequiredReserves, scaleFactor)
            + accruedProtocolFees
            + normalizedUnclaimedWithdrawals;
    }

    // ─── Utility Functions ─────────────────────────────────────────────

    /// @notice Saturation subtraction: max(a - b, 0)
    function satSub(uint256 a, uint256 b) internal pure returns (uint256 c) {
        assembly {
            c := mul(gt(a, b), sub(a, b))
        }
    }

    /// @notice Return the smaller of a and b
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Return the larger of a and b
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /// @notice Safe downcast to uint112
    function toUint112(uint256 x) internal pure returns (uint112) {
        if (x > type(uint112).max) revert Overflow();
        return uint112(x);
    }

    /// @notice Safe downcast to uint128
    function toUint128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert Overflow();
        return uint128(x);
    }

    /// @notice Safe downcast to uint104
    function toUint104(uint256 x) internal pure returns (uint104) {
        if (x > type(uint104).max) revert Overflow();
        return uint104(x);
    }

    /// @notice Safe downcast to uint32
    function toUint32(uint256 x) internal pure returns (uint32) {
        if (x > type(uint32).max) revert Overflow();
        return uint32(x);
    }
}
