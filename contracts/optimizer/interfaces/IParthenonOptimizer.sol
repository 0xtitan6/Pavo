// SPDX-License-Identifier: GPL-2.0-or-later
// Inspired by MetaMorpho (https://github.com/morpho-org/metamorpho) — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {Id, MarketParams} from "../../pool/interfaces/IParthenonPool.sol";

/// @title IParthenonOptimizer
/// @notice Interface for the ParthenonOptimizer — an ERC-4626 vault that routes deposits to the best yield
///         across ParthenonPool markets and external vaults.
interface IParthenonOptimizer {
    /* TYPES */

    /// @notice Allocation target type
    enum TargetType {
        POOL_MARKET,     // ParthenonPool isolated lending market
        EXTERNAL_VAULT   // External ERC-4626 vault (e.g., ParthenonVault/BoringVault)
    }

    /// @notice Configuration for a supply queue entry
    struct MarketAllocation {
        Id id;                 // Market ID (for POOL_MARKET) or bytes32(uint256(vault address)) for EXTERNAL_VAULT
        TargetType targetType; // Type of allocation target
        address vault;         // External vault address (only for EXTERNAL_VAULT, address(0) for POOL_MARKET)
        uint256 cap;           // Maximum assets that can be allocated (0 = unlimited)
    }

    /* EVENTS */

    event SupplyQueueUpdated(address indexed caller, uint256 length);
    event WithdrawQueueUpdated(address indexed caller, uint256 length);
    event AllocationCapUpdated(Id indexed id, uint256 newCap);
    event GuardianUpdated(address indexed newGuardian);
    event TimelockUpdated(uint256 newTimelock);
    event FeeUpdated(uint256 newFee);
    event FeeRecipientUpdated(address indexed newFeeRecipient);
    event Reallocated(address indexed caller, Id[] supplyIds, uint256[] amounts);

    /* VIEWS */

    /// @notice The ParthenonPool contract address
    function pool() external view returns (address);

    /// @notice The supply queue (ordered list of market IDs to deposit into)
    function supplyQueue(uint256 index) external view returns (Id);

    /// @notice The withdraw queue (ordered list of market IDs to withdraw from)
    function withdrawQueue(uint256 index) external view returns (Id);

    /// @notice Length of the supply queue
    function supplyQueueLength() external view returns (uint256);

    /// @notice Length of the withdraw queue
    function withdrawQueueLength() external view returns (uint256);

    /// @notice The allocation cap for a given market
    function allocationCap(Id id) external view returns (uint256);

    /// @notice The fee percentage (WAD-scaled, max 50%)
    function fee() external view returns (uint256);

    /// @notice The fee recipient
    function feeRecipient() external view returns (address);

    /// @notice The guardian address (can trigger emergency actions)
    function guardian() external view returns (address);

    /* ADMIN */

    /// @notice Set the supply queue
    function setSupplyQueue(Id[] calldata newSupplyQueue) external;

    /// @notice Set the withdraw queue
    function setWithdrawQueue(Id[] calldata newWithdrawQueue) external;

    /// @notice Set allocation cap for a market
    function setAllocationCap(Id id, uint256 cap) external;

    /// @notice Set the fee
    function setFee(uint256 newFee) external;

    /// @notice Set the fee recipient
    function setFeeRecipient(address newFeeRecipient) external;

    /// @notice Set the guardian
    function setGuardian(address newGuardian) external;

    /// @notice Reallocate funds across markets (called by allocator/owner)
    function reallocate(
        Id[] calldata withdrawIds,
        uint256[] calldata withdrawAmounts,
        Id[] calldata supplyIds,
        uint256[] calldata supplyAmounts
    ) external;
}
