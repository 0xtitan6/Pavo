// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue (https://github.com/morpho-org/morpho-blue) — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {MarketParams, Market} from "./IParthenonPool.sol";

/// @title IIrm
/// @notice Interface that Interest Rate Models (IRMs) used by ParthenonPool must implement.
interface IIrm {
    /// @notice Returns the borrow rate per second (scaled by WAD) of the market `marketParams`.
    function borrowRate(MarketParams memory marketParams, Market memory market) external returns (uint256);

    /// @notice Returns the borrow rate per second (scaled by WAD) of the market `marketParams` without modifying any
    /// storage.
    function borrowRateView(MarketParams memory marketParams, Market memory market) external view returns (uint256);
}
