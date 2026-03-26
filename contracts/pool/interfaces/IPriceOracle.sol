// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/// @title IPriceOracle
/// @notice Minimal interface for PriceOracle used by PoolOracleAdapter
interface IPriceOracle {
    function getOraclePriceView(
        uint256 amount,
        address tokenAddress,
        uint8 assetDecimals
    ) external view returns (uint256 assetValue);
}
