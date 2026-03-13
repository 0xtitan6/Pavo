// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CreditEvents - Events for Module 2 undercollateralized lending
library CreditEvents {
    // ─── Market Lifecycle ──────────────────────────────────────────────
    event MarketCreated(
        address indexed market,
        address indexed borrower,
        address indexed asset,
        uint16 annualInterestBips,
        uint16 reserveRatioBips
    );
    event MarketClosed(address indexed market, address indexed borrower, uint256 finalScaleFactor);

    // ─── Deposit / Withdraw ────────────────────────────────────────────
    event Deposit(
        address indexed market,
        address indexed lender,
        uint256 amount,
        uint256 scaledAmount
    );
    event WithdrawalRequested(
        address indexed market,
        address indexed lender,
        uint256 amount,
        uint32 batchExpiry
    );
    event WithdrawalBatchProcessed(
        address indexed market,
        uint32 batchExpiry,
        uint256 amountPaid,
        uint256 amountUnpaid
    );
    event WithdrawalClaimed(address indexed market, address indexed lender, uint256 amount);
    event WithdrawalAutoRefunded(
        address indexed market,
        address indexed lender,
        uint256 scaledAmount
    );

    // ─── Borrow / Repay ───────────────────────────────────────────────
    event Borrow(address indexed market, address indexed borrower, uint256 amount);
    event Repay(address indexed market, address indexed borrower, uint256 amount);

    // ─── Interest & Fees ───────────────────────────────────────────────
    event InterestAccrued(
        address indexed market,
        uint256 baseInterestRay,
        uint256 delinquencyFeeRay,
        uint256 protocolFee,
        uint256 newScaleFactor
    );
    event DelinquencyStatusChanged(address indexed market, bool isDelinquent, uint32 timeDelinquent);
    event ProtocolFeesWithdrawn(address indexed market, address indexed recipient, uint256 amount);

    // ─── Authorization ─────────────────────────────────────────────────
    event BorrowerAuthorized(address indexed borrower, uint8 creditTier);
    event BorrowerSuspended(address indexed borrower, string reason);
    event BorrowerReactivated(address indexed borrower);
    event CreditTierUpdated(address indexed borrower, uint8 oldTier, uint8 newTier);
    event LenderRegistered(address indexed market, address indexed lender);
    event LenderRemoved(address indexed market, address indexed lender);

    // ─── Margin Call & Liquidation ──────────────────────────────────────
    event MarginCallIssued(address indexed market, address indexed borrower, uint256 deficit, uint32 deadline);
    event MarginCallCured(address indexed market, address indexed borrower);
    event LiquidationInitiated(address indexed market, address indexed borrower, uint256 totalDebt);

    // ─── TICS Bridge ───────────────────────────────────────────────────
    event MarketStateUpdated(bytes32 indexed marketId, bytes32 stateHash);
    event AttestationReceived(bytes32 indexed marketId, bytes32 attestationHash);
}
