// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Market parameters that uniquely identify a Morpho Blue market
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @title IMorpho
/// @notice Minimal interface for Morpho Blue supply/withdraw
interface IMorpho {
    /// @notice Supply assets to a Morpho Blue market on behalf of `onBehalf`
    /// @param marketParams The market to supply into
    /// @param assets The amount of assets to supply (0 if supplying by shares)
    /// @param shares The amount of shares to mint (0 if supplying by assets)
    /// @param onBehalf The address that will own the position
    /// @param data Arbitrary data passed to the `onMorphoSupply` callback (pass "" if unused)
    /// @return assetsSupplied The actual assets supplied
    /// @return sharesSupplied The shares minted
    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied);

    /// @notice Withdraw assets from a Morpho Blue market
    /// @param marketParams The market to withdraw from
    /// @param assets The amount of assets to withdraw (0 if withdrawing by shares)
    /// @param shares The amount of shares to burn (0 if withdrawing by assets)
    /// @param onBehalf The address whose position is being withdrawn from
    /// @param receiver The address that receives the withdrawn assets
    /// @return assetsWithdrawn The actual assets withdrawn
    /// @return sharesWithdrawn The shares burned
    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);

    /// @notice Preview how many assets would be received for redeeming shares
    /// @dev Read-only equivalent of withdraw-by-shares. Enables frontends to display
    ///      current position value (principal + accrued yield) without executing a tx.
    ///      Inspired by ERC-4626 previewRedeem and Morpho optimizer's RatesLens pattern.
    /// @param marketParams The market to query
    /// @param shares The number of shares to preview redeeming
    /// @return assets The estimated assets that would be received
    function previewRedeem(
        MarketParams memory marketParams,
        uint256 shares
    ) external view returns (uint256 assets);
}
