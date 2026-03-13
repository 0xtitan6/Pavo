// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '../libraries/CreditTypesLib.sol';

/// @title IOrchestrator - Central governance for undercollateralized lending
/// @notice Maps to DAML Module2.BorrowerAuthorization template + market creation
interface IOrchestrator {
    // ─── Borrower Management ───────────────────────────────────────────

    /// @notice Authorize a borrower with KYC verification
    /// @dev Maps to DAML BorrowerAuthorization.MarkKYCVerified
    function authorizeBorrower(
        address borrower,
        CreditTypesLib.CreditTier tier
    ) external;

    /// @notice Update a borrower's credit tier
    /// @dev Maps to DAML BorrowerAuthorization.UpdateCreditTier
    function updateCreditTier(
        address borrower,
        CreditTypesLib.CreditTier newTier
    ) external;

    /// @notice Suspend a borrower
    /// @dev Maps to DAML BorrowerAuthorization.SuspendBorrower
    function suspendBorrower(address borrower) external;

    /// @notice Reactivate a suspended borrower
    /// @dev Maps to DAML BorrowerAuthorization.ReactivateBorrower
    function reactivateBorrower(address borrower) external;

    // ─── Market Management ─────────────────────────────────────────────

    /// @notice Create a new credit market for an authorized borrower
    /// @dev Maps to DAML BorrowerAuthorization.CreateMarket. Uses CREATE2.
    function createMarket(
        address borrowerAddr,
        address assetAddr,
        CreditTypesLib.MarketParameters calldata params
    ) external returns (address market);

    // ─── Lender Management ─────────────────────────────────────────────

    /// @notice Register a known lender for a market
    function registerLender(address market, address lender) external;

    /// @notice Remove a lender from known lender list
    function removeLender(address market, address lender) external;

    // ─── Credit Limit Enforcement ──────────────────────────────────────

    /// @notice Check credit limit and record a borrow (called by CreditMarket)
    /// @dev Reverts with CreditLimitExceeded if borrow would exceed tier limit
    function checkAndRecordBorrow(address market, uint256 amount) external;

    /// @notice Record a repayment reducing borrower's outstanding balance (called by CreditMarket)
    function recordRepayment(address market, uint256 amount) external;

    // ─── View Functions ────────────────────────────────────────────────

    function getBorrowerAuth(address borrower) external view returns (CreditTypesLib.BorrowerAuth memory);
    function isKnownLender(address market, address lender) external view returns (bool);
    function getMarket(address borrower, address asset) external view returns (address);
    function protocolFeeRecipient() external view returns (address);
}
