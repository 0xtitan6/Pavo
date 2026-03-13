// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '../libraries/CreditTypesLib.sol';

/// @title ICreditMarket - Interface for per-borrower credit market
/// @notice Maps 1:1 to DAML Module2.Market template choices
interface ICreditMarket {
    // ─── View Functions ────────────────────────────────────────────────

    function borrower() external view returns (address);
    function asset() external view returns (address);
    function marketId() external view returns (bytes32);
    function getState() external view returns (CreditTypesLib.CreditMarketState memory);
    function getParameters() external view returns (CreditTypesLib.MarketParameters memory);
    function totalSupply() external view returns (uint256);
    function borrowableAssets() external view returns (uint256);
    function liquidityRequired() external view returns (uint256);
    function isDelinquent() external view returns (bool);

    // ─── State-Changing Functions (match DAML Market choices) ──────────

    /// @notice Lender deposits assets into the market
    /// @dev Maps to DAML Market.Deposit
    function deposit(uint256 amount, address onBehalfOf) external returns (uint256 scaledAmount);

    /// @notice Borrower draws available liquidity
    /// @dev Maps to DAML Market.BorrowFunds
    function borrow(uint256 amount) external;

    /// @notice Borrower repays borrowed funds
    /// @dev Maps to DAML Market.RepayFunds
    function repay(uint256 amount) external;

    /// @notice Lender requests withdrawal (enters FIFO batch)
    /// @dev Maps to DAML Market.RequestWithdrawal
    function requestWithdrawal(uint256 scaledAmount) external;

    /// @notice Process expired withdrawal batch
    /// @dev Maps to DAML Market.ProcessWithdrawalBatch
    function processWithdrawalBatch() external;

    /// @notice Accrue interest and update scale factor
    /// @dev Maps to DAML Market.AccrueInterest
    function accrueInterest() external;

    /// @notice Borrower closes the market
    /// @dev Maps to DAML Market.CloseMarket
    function closeMarket() external;

    /// @notice Lender claims processed withdrawal
    function claimWithdrawal(uint32 batchExpiry) external returns (uint256 amount);

    // ─── Margin Call & Liquidation ──────────────────────────────────

    /// @notice Issues a margin call when borrower is delinquent past grace period
    function marginCall() external;

    /// @notice Borrower cures a margin call by restoring market health
    function cure() external;

    /// @notice Initiates liquidation after margin call deadline expires
    function liquidate() external;
}
