// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IWithdrawalQueue - Interface for FIFO withdrawal batch management
/// @notice Maps to DAML Module2.WithdrawalRequest template
interface IWithdrawalQueue {
    struct WithdrawalBatch {
        uint104 scaledTotalAmount;
        uint104 scaledAmountBurned;
        uint128 normalizedAmountPaid;
    }

    struct AccountWithdrawalStatus {
        uint104 scaledAmount;
        uint128 normalizedAmountWithdrawn;
    }

    /// @notice Get the current pending batch expiry (0 if none)
    function pendingBatchExpiry() external view returns (uint32);

    /// @notice Get withdrawal batch data for a given expiry
    function getBatch(uint32 expiry) external view returns (WithdrawalBatch memory);

    /// @notice Get account withdrawal status for a batch
    function getAccountStatus(
        uint32 expiry,
        address account
    ) external view returns (AccountWithdrawalStatus memory);

    /// @notice Get the number of unpaid batches in the FIFO queue
    function unpaidBatchCount() external view returns (uint256);
}
