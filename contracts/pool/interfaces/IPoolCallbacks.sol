// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue (https://github.com/morpho-org/morpho-blue) — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

/// @title IPoolLiquidateCallback
/// @notice Interface that liquidators willing to use `liquidate`'s callback must implement.
interface IPoolLiquidateCallback {
    /// @notice Callback called when a liquidation occurs.
    /// @param repaidAssets The amount of repaid assets.
    /// @param data Arbitrary data passed to the `liquidate` function.
    function onPoolLiquidate(uint256 repaidAssets, bytes calldata data) external;
}

/// @title IPoolRepayCallback
/// @notice Interface that users willing to use `repay`'s callback must implement.
interface IPoolRepayCallback {
    /// @notice Callback called when a repayment occurs.
    /// @param assets The amount of repaid assets.
    /// @param data Arbitrary data passed to the `repay` function.
    function onPoolRepay(uint256 assets, bytes calldata data) external;
}

/// @title IPoolSupplyCallback
/// @notice Interface that users willing to use `supply`'s callback must implement.
interface IPoolSupplyCallback {
    /// @notice Callback called when a supply occurs.
    /// @param assets The amount of supplied assets.
    /// @param data Arbitrary data passed to the `supply` function.
    function onPoolSupply(uint256 assets, bytes calldata data) external;
}

/// @title IPoolSupplyCollateralCallback
/// @notice Interface that users willing to use `supplyCollateral`'s callback must implement.
interface IPoolSupplyCollateralCallback {
    /// @notice Callback called when a supply of collateral occurs.
    /// @param assets The amount of supplied collateral.
    /// @param data Arbitrary data passed to the `supplyCollateral` function.
    function onPoolSupplyCollateral(uint256 assets, bytes calldata data) external;
}

/// @title IPoolFlashLoanCallback
/// @notice Interface that users willing to use `flashLoan`'s callback must implement.
interface IPoolFlashLoanCallback {
    /// @notice Callback called when a flash loan occurs.
    /// @param assets The amount of assets that was flash loaned.
    /// @param data Arbitrary data passed to the `flashLoan` function.
    function onPoolFlashLoan(uint256 assets, bytes calldata data) external;
}
