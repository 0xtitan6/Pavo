// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IYieldAdapter
/// @notice Generic interface for yield adapters that earn on idle offer funds
/// @dev Implemented by MorphoAdapter, future vault adapters, and any other yield source.
///      LoanFactory calls deposit() when an offer is created and withdraw() when it is
///      cancelled or matched. The adapter routes funds to/from the underlying yield source.
interface IYieldAdapter {
    /// @notice Deposit idle offer funds into the yield source
    /// @param token  The ERC-20 token being deposited
    /// @param amount The amount of tokens to deposit
    /// @param loanId The loan offer ID — used to track the position for later withdrawal
    function deposit(address token, uint256 amount, uint256 loanId) external;

    /// @notice Withdraw offer funds (+ accrued yield) from the yield source
    /// @param token  The ERC-20 token to withdraw
    /// @param loanId The loan offer ID whose position is being redeemed
    /// @param to     Recipient of the withdrawn funds
    /// @return assets The actual amount of tokens withdrawn (principal + yield)
    function withdraw(address token, uint256 loanId, address to) external returns (uint256 assets);

    /// @notice Check whether this adapter supports a given token
    /// @param token The token address to check
    /// @return True if the adapter can accept deposits for this token
    function hasMarket(address token) external view returns (bool);

    /// @notice Get the shares/position balance for a loan's token
    /// @param loanId The loan offer ID
    /// @param token  The token address
    /// @return The shares or position units held
    function sharesOf(uint256 loanId, address token) external view returns (uint256);

    /// @notice Get the total number of active positions across all tokens
    /// @return The total active position count
    function totalActivePositions() external view returns (uint256);
}
