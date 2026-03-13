// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ITICSBridge - Interface for TICS middleware integration
/// @notice EVM-only contract. Canton/DAML uses native event subscriptions.
interface ITICSBridge {
    /// @notice Sync market state hash to TICS middleware
    function syncMarketState(bytes32 marketId) external;

    /// @notice Receive attestation from TICS middleware
    function receiveAttestation(
        bytes32 marketId,
        bytes calldata attestation
    ) external;

    /// @notice Get keccak256 hash of current market state
    function getMarketStateHash(bytes32 marketId) external view returns (bytes32);

    /// @notice Check if a market is registered with the bridge
    function isRegistered(bytes32 marketId) external view returns (bool);

    // ─── Collateral Outbound (signal to keeper) ─────────────────────

    /// @notice Request collateral reservation from custodian
    function requestCollateralReserve(bytes32 marketId, address borrower, uint256 amount) external;

    /// @notice Signal margin call to keeper for Canton relay
    function signalMarginCall(bytes32 marketId, address borrower, uint256 deficit) external;

    /// @notice Signal liquidation instruction to keeper
    function signalLiquidation(bytes32 marketId, address borrower, uint256 amount) external;

    // ─── Keeper Confirmations (inbound from Canton) ─────────────────

    /// @notice Keeper confirms collateral reservation from custodian
    function confirmReservation(bytes32 marketId, bytes32 reservationId, uint256 amount) external;

    /// @notice Keeper confirms collateral locked by custodian
    function confirmLock(bytes32 marketId, bytes32 lockId, uint256 amount) external;

    /// @notice Keeper confirms liquidation completed
    function confirmLiquidation(bytes32 marketId, bytes32 liquidationId, uint256 proceeds) external;

    /// @notice Keeper confirms collateral released (after repayment)
    function confirmRelease(bytes32 marketId, bytes32 lockId, uint256 amount) external;
}
