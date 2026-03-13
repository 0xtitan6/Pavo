// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ScaleFactorLib} from "../libraries/ScaleFactorLib.sol";

/// @title ScaleFactorLibHarness - Exposes ScaleFactorLib internal functions for testing
contract ScaleFactorLibHarness {
    using ScaleFactorLib for uint256;

    function RAY() external pure returns (uint256) {
        return ScaleFactorLib.RAY;
    }

    function BIP() external pure returns (uint256) {
        return ScaleFactorLib.BIP;
    }

    function rayMul(uint256 a, uint256 b) external pure returns (uint256) {
        return ScaleFactorLib.rayMul(a, b);
    }

    function rayDiv(uint256 a, uint256 b) external pure returns (uint256) {
        return ScaleFactorLib.rayDiv(a, b);
    }

    function bipToRay(uint256 bips) external pure returns (uint256) {
        return ScaleFactorLib.bipToRay(bips);
    }

    function bipMul(uint256 a, uint256 b) external pure returns (uint256) {
        return ScaleFactorLib.bipMul(a, b);
    }

    function scaleAmount(uint256 amount, uint256 scaleFactor) external pure returns (uint256) {
        return ScaleFactorLib.scaleAmount(amount, scaleFactor);
    }

    function normalizeAmount(uint256 scaledAmount, uint256 scaleFactor) external pure returns (uint256) {
        return ScaleFactorLib.normalizeAmount(scaledAmount, scaleFactor);
    }

    function calculateLinearInterestFromBips(
        uint256 rateBip,
        uint256 timeDelta
    ) external pure returns (uint256) {
        return ScaleFactorLib.calculateLinearInterestFromBips(rateBip, timeDelta);
    }

    function applyInterestToScaleFactor(
        uint256 currentScaleFactor,
        uint256 interestRay
    ) external pure returns (uint256) {
        return ScaleFactorLib.applyInterestToScaleFactor(currentScaleFactor, interestRay);
    }

    function updateTimeDelinquentAndGetPenaltyTime(
        bool isDelinquent,
        uint256 previousTimeDelinquent,
        uint256 delinquencyGracePeriod,
        uint256 timeDelta
    ) external pure returns (uint256 timeWithPenalty, uint256 newTimeDelinquent) {
        return ScaleFactorLib.updateTimeDelinquentAndGetPenaltyTime(
            isDelinquent, previousTimeDelinquent, delinquencyGracePeriod, timeDelta
        );
    }

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
        external
        pure
        returns (
            uint256 newScaleFactor,
            uint256 baseInterestRay,
            uint256 delinquencyFeeRay,
            uint256 protocolFee,
            uint256 newTimeDelinquent
        )
    {
        return ScaleFactorLib.updateScaleFactorAndFees(
            scaleFactor,
            annualInterestBips,
            delinquencyFeeBips,
            protocolFeeBips,
            scaledTotalSupply,
            isDelinquent,
            timeDelinquent,
            delinquencyGracePeriod,
            maxDelinquencyPeriod,
            timeDelta
        );
    }

    function liquidityRequired(
        uint256 scaledTotalSupply,
        uint256 scaledPendingWithdrawals,
        uint256 normalizedUnclaimedWithdrawals,
        uint256 accruedProtocolFees,
        uint256 reserveRatioBips,
        uint256 scaleFactor
    ) external pure returns (uint256) {
        return ScaleFactorLib.liquidityRequired(
            scaledTotalSupply,
            scaledPendingWithdrawals,
            normalizedUnclaimedWithdrawals,
            accruedProtocolFees,
            reserveRatioBips,
            scaleFactor
        );
    }

    function satSub(uint256 a, uint256 b) external pure returns (uint256) {
        return ScaleFactorLib.satSub(a, b);
    }

    function min(uint256 a, uint256 b) external pure returns (uint256) {
        return ScaleFactorLib.min(a, b);
    }

    function max(uint256 a, uint256 b) external pure returns (uint256) {
        return ScaleFactorLib.max(a, b);
    }

    function toUint112(uint256 x) external pure returns (uint112) {
        return ScaleFactorLib.toUint112(x);
    }

    function toUint128(uint256 x) external pure returns (uint128) {
        return ScaleFactorLib.toUint128(x);
    }

    function toUint104(uint256 x) external pure returns (uint104) {
        return ScaleFactorLib.toUint104(x);
    }

    function toUint32(uint256 x) external pure returns (uint32) {
        return ScaleFactorLib.toUint32(x);
    }
}
