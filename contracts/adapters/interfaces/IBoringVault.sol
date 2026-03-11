// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBoringVault
/// @notice Minimal interface for the Boring Vault (parthenonfi-vaults BoringVault.sol)
/// @dev The vault mints shares on enter() and burns on exit(). Uses ERC20 internally.
interface IBoringVault {
    /// @notice Deposit assets and mint shares
    /// @param from    Address to pull assets from
    /// @param asset   The ERC-20 token to deposit
    /// @param amount  Amount of assets to deposit
    /// @param to      Address to mint shares to
    /// @param shares  Amount of shares to mint
    function enter(address from, address asset, uint256 amount, address to, uint256 shares) external;

    /// @notice Burn shares and withdraw assets
    /// @param to      Address to send assets to
    /// @param asset   The ERC-20 token to withdraw
    /// @param amount  Amount of assets to withdraw
    /// @param from    Address to burn shares from
    /// @param shares  Amount of shares to burn
    function exit(address to, address asset, uint256 amount, address from, uint256 shares) external;

    /// @notice Get the total supply of vault shares
    function totalSupply() external view returns (uint256);

    /// @notice Get the share balance of an address
    function balanceOf(address account) external view returns (uint256);
}

/// @title ITeller
/// @notice Minimal interface for TellerWithMultiAssetSupport
/// @dev The Teller is the user-facing deposit/withdraw entrypoint for Boring Vaults.
///      bulkDeposit/bulkWithdraw require SOLVER_ROLE on the vault's RolesAuthority.
interface ITeller {
    /// @notice Deposit assets into the vault via the Teller
    /// @param depositAsset  The ERC-20 token to deposit
    /// @param depositAmount Amount of assets to deposit
    /// @param minimumMint   Minimum shares to receive (slippage protection)
    /// @param to            Address to mint shares to
    /// @return shares       The vault shares minted
    function bulkDeposit(address depositAsset, uint256 depositAmount, uint256 minimumMint, address to)
        external
        returns (uint256 shares);

    /// @notice Withdraw assets from the vault via the Teller
    /// @param withdrawAsset The ERC-20 token to withdraw
    /// @param shareAmount   Amount of shares to burn
    /// @param minimumAssets Minimum assets to receive (slippage protection)
    /// @param to            Address to send assets to
    /// @return assetsOut    The actual assets withdrawn
    function bulkWithdraw(address withdrawAsset, uint256 shareAmount, uint256 minimumAssets, address to)
        external
        returns (uint256 assetsOut);

    /// @notice The BoringVault this Teller serves
    function vault() external view returns (address);

    /// @notice The AccountantWithRateProviders this Teller uses for pricing
    function accountant() external view returns (address);
}

/// @title IAccountant
/// @notice Minimal interface for AccountantWithRateProviders
/// @dev Provides exchange rate between vault shares and underlying assets.
interface IAccountant {
    /// @notice Get the exchange rate of vault shares in the base asset
    /// @return rate The exchange rate (18-decimal fixed point)
    function getRate() external view returns (uint256 rate);

    /// @notice Get the exchange rate in terms of a specific quote asset
    /// @param quote The quote asset address
    /// @return rateInQuote The exchange rate in quote asset terms
    function getRateInQuote(address quote) external view returns (uint256 rateInQuote);

    /// @notice Get the exchange rate, reverting if paused
    /// @return rate The exchange rate (18-decimal fixed point)
    function getRateSafe() external view returns (uint256 rate);

    /// @notice Checkpoint accrued interest and fees so the rate is current
    /// @dev Should be called before reading rates to ensure accuracy.
    ///      Reverts if caller lacks AUTH role — the adapter must hold it.
    function checkpoint() external;
}
