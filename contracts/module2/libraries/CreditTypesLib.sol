// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CreditTypesLib - Shared types for Module 2 undercollateralized lending
/// @notice Credit market type definitions — maps 1:1 to DAML shared types
library CreditTypesLib {
    // ─── Enums (match DAML types exactly) ───────────────────────────────

    /// @notice Market operational status
    enum MarketStatus {
        Active,       // Accepting deposits and borrows
        Delinquent,   // Below reserve requirement
        Closed        // No new activity allowed
    }

    /// @notice Withdrawal request lifecycle
    enum WithdrawalStatus {
        Pending,       // Queued, waiting for batch expiry
        Expired,       // Batch expired, awaiting processing
        Processed,     // Borrower has paid
        Claimed,       // Lender has claimed payment
        Unpaid,        // Batch processed, insufficient funds
        ExpiryReached  // Max retries exhausted, auto-refunded
    }

    /// @notice Borrower credit tier — determines max credit limit
    /// @dev Maps to DAML: Tier1=$100K, Tier2=$500K, Tier3=$2M, Tier4=$10M
    enum CreditTier {
        TIER_1,  // Emerging: $100,000
        TIER_2,  // Established: $500,000
        TIER_3,  // Strong: $2,000,000
        TIER_4   // Premium: $10,000,000
    }

    /// @notice Controls LPT transfer permissions
    enum Transferability {
        NonTransferable,    // Only mint/burn allowed, no transfers
        KnownLendersOnly,   // Only registered lenders can receive
        Unrestricted        // Any address can receive
    }

    /// @notice Borrower authorization status
    enum BorrowerStatus {
        PendingKYC,  // KYC in progress
        Approved,    // Can borrow
        Suspended    // Compliance issue
    }

    // ─── Structs ───────────────────────────────────────────────────────

    /// @notice Immutable market configuration parameters
    /// @dev Matches DAML MarketParameters record
    struct MarketParameters {
        uint16 annualInterestBips;      // Annual interest rate (bips). 500 = 5% APR
        uint16 delinquencyFeeBips;      // Penalty fee rate (bips). Applied after grace period
        uint32 withdrawalBatchDuration; // Seconds per withdrawal batch (e.g., 604800 = 7 days)
        uint16 reserveRatioBips;        // Required reserve % (bips). 2000 = 20%
        uint32 delinquencyGracePeriod;  // Seconds before penalty fees apply
        uint16 protocolFeeBips;         // Protocol's cut of interest (bips)
        uint32 maxDelinquencyPeriod;    // Max seconds of delinquency fee accrual (cap)
        uint128 maxTotalSupply;         // Maximum deposits allowed
        uint32 maturityDate;            // Unix timestamp. 0 = no maturity (perpetual)
        bytes32 gmslaRefHash;           // keccak256 of GMSLA reference. bytes32(0) = none
        uint16 collateralRatioBps;      // Required collateral ratio. 0 = fully unsecured, 15000 = 150%
    }

    /// @notice Current accounting state of a credit market
    /// @dev Tightly packed to minimize storage slots. Matches DAML MarketState.
    struct CreditMarketState {
        bool isClosed;                          // slot 0
        bool isDelinquent;
        uint112 scaleFactor;                    // RAY-based (starts at 1e27)
        uint32 lastInterestAccruedTimestamp;

        uint104 scaledTotalSupply;              // slot 1
        uint104 scaledPendingWithdrawals;
        uint32 pendingWithdrawalExpiry;
        uint16 _reserved;

        uint128 normalizedUnclaimedWithdrawals; // slot 2
        uint128 accruedProtocolFees;

        uint32 timeDelinquent;                  // slot 3
        uint16 annualInterestBips;
        uint16 delinquencyFeeBips;
        uint16 reserveRatioBips;
        uint16 protocolFeeBips;
        uint32 delinquencyGracePeriod;
        uint32 maxDelinquencyPeriod;
        uint128 maxTotalSupply;                 // slot 4
        uint128 totalBorrowed;                  // slot 4 (packs with maxTotalSupply)

        bool isMatured;                         // slot 5: True after maturity enforcement
        bool isLiquidating;                     // slot 5: True when liquidation is in progress
        uint32 marginCallTimestamp;             // slot 5: When margin call was issued (0 = no active call)
        uint32 marginCallDeadline;              // slot 5: When cure period expires (0 = no active call)
    }

    /// @notice Borrower authorization record
    struct BorrowerAuth {
        BorrowerStatus status;
        CreditTier tier;
        uint128 creditLimit;      // Max total borrow amount (USD with 18 decimals)
        uint128 totalBorrowed;    // Current outstanding borrow
        uint64 kycVerifiedAt;     // Timestamp of KYC approval
        uint64 kycExpiresAt;      // KYC expiry (0 = never)
    }

    // ─── Helper Functions ──────────────────────────────────────────────

    /// @notice Get credit limit for a tier (matches DAML tierToLimit)
    function tierToLimit(CreditTier tier) internal pure returns (uint128) {
        if (tier == CreditTier.TIER_1) return 100_000e18;
        if (tier == CreditTier.TIER_2) return 500_000e18;
        if (tier == CreditTier.TIER_3) return 2_000_000e18;
        if (tier == CreditTier.TIER_4) return 10_000_000e18;
        return 0;
    }
}
