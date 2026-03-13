// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CreditErrors - Custom errors for Module 2 undercollateralized lending
library CreditErrors {
    // ─── Market Lifecycle ──────────────────────────────────────────────
    error MarketClosed();
    error MarketNotClosed();
    error MarketAlreadyExists();

    // ─── Deposit / Withdraw ────────────────────────────────────────────
    error ZeroAmount();
    error DepositExceedsMaxSupply();
    error InsufficientBorrowableLiquidity();
    error InsufficientBalance();
    error RepayExceedsDebt();
    error WithdrawalBatchNotExpired();
    error NoPendingWithdrawalBatch();

    // ─── Authorization ─────────────────────────────────────────────────
    error UnauthorizedBorrower();
    error UnauthorizedLender();
    error BorrowerNotApproved();
    error BorrowerSuspended();
    error LenderNotKnown();
    error CreditLimitExceeded();

    // ─── Credit Tiers ──────────────────────────────────────────────────
    error InvalidCreditTier();
    error TierDowngradeNotAllowed();

    // ─── Interest & Fees ───────────────────────────────────────────────
    error InvalidInterestRate();
    error InvalidReserveRatio();
    error InvalidDelinquencyFee();
    error InvalidProtocolFee();
    error InvalidGracePeriod();
    error InvalidBatchDuration();
    error InvalidMaxDelinquencyPeriod();

    // ─── Maturity & Collateral ──────────────────────────────────────────
    error InvalidMaturityDate();
    error InvalidCollateralRatio();
    error MarketMatured();

    // ─── TICS Bridge ───────────────────────────────────────────────────
    error InvalidAttestation();
    error StaleAttestation();
    error BridgeNotRegistered();

    // ─── Sanctions ──────────────────────────────────────────────────────
    error AddressSanctioned();

    // ─── Margin Call & Liquidation ──────────────────────────────────
    error MarginCallNotActive();
    error MarginCallNotExpired();
    error MarketLiquidating();
    error NotDelinquent();
    error CurePeriodNotSet();

    // ─── Transfer Restrictions ──────────────────────────────────────
    error TransfersDisabled();

    // ─── General ───────────────────────────────────────────────────────
    error ZeroAddress();
    error AlreadyInitialized();
}
