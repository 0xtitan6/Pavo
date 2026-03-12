// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue (https://github.com/morpho-org/morpho-blue) — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {MathLib} from "./MathLib.sol";

/// @title SharesMathLib
/// @notice Shares management library using OpenZeppelin's virtual shares method.
library SharesMathLib {
    using MathLib for uint256;

    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    /// @dev Calculates the value of `assets` quoted in shares, rounding down.
    /// @param assets The amount of assets to convert.
    /// @param totalAssets The total amount of assets in the pool.
    /// @param totalShares The total amount of shares in the pool.
    /// @return The equivalent number of shares, rounded down.
    function toSharesDown(uint256 assets, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return assets.mulDivDown(totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    /// @dev Calculates the value of `shares` quoted in assets, rounding down.
    /// @param shares The amount of shares to convert.
    /// @param totalAssets The total amount of assets in the pool.
    /// @param totalShares The total amount of shares in the pool.
    /// @return The equivalent amount of assets, rounded down.
    function toAssetsDown(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return shares.mulDivDown(totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    /// @dev Calculates the value of `assets` quoted in shares, rounding up.
    /// @param assets The amount of assets to convert.
    /// @param totalAssets The total amount of assets in the pool.
    /// @param totalShares The total amount of shares in the pool.
    /// @return The equivalent number of shares, rounded up.
    function toSharesUp(uint256 assets, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return assets.mulDivUp(totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    /// @dev Calculates the value of `shares` quoted in assets, rounding up.
    /// @param shares The amount of shares to convert.
    /// @param totalAssets The total amount of assets in the pool.
    /// @param totalShares The total amount of shares in the pool.
    /// @return The equivalent amount of assets, rounded up.
    function toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return shares.mulDivUp(totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }
}
