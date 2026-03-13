// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/access/Ownable2Step.sol';
import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import '@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol';

import './interfaces/ITICSBridge.sol';

/// @title TICSBridge - EVM-Canton state synchronization bridge
/// @notice Stores market state hashes and Canton attestations for cross-platform parity
/// @dev Uses ECDSA signature verification to authenticate Canton attestations.
///      Canton side uses native Ledger API subscriptions (no bridge contract needed).
///      An off-chain relayer reads EVM events, submits DAML choices, then calls
///      syncMarketState() to record the latest Canton-attested state.
contract TICSBridge is ITICSBridge, Ownable2Step, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    // ─── State ─────────────────────────────────────────────────────────

    /// @notice Market ID => registered market contract address
    mapping(bytes32 => address) internal _marketAddresses;

    /// @notice Market ID => latest state hash (keccak256 of encoded market state)
    mapping(bytes32 => bytes32) internal _stateHashes;

    /// @notice Market ID => latest Canton attestation hash
    mapping(bytes32 => bytes32) internal _attestationHashes;

    /// @notice Market ID => attestation timestamp
    mapping(bytes32 => uint64) internal _attestationTimestamps;

    /// @notice Authorized relayer address
    address public relayer;

    /// @notice Trusted attester address for ECDSA signature verification
    address public trustedAttester;

    /// @notice Maximum age (in seconds) for a Canton attestation timestamp
    uint64 public constant MAX_ATTESTATION_AGE = 3600;

    // ─── Collateral State ─────────────────────────────────────────────

    /// @notice Collateral lifecycle status
    enum CollateralStatus {
        None,         // No collateral action
        Reserved,     // Reservation requested, awaiting lock
        Locked,       // Collateral locked by custodian
        Liquidating,  // Liquidation in progress
        Released      // Collateral released
    }

    /// @notice Collateral state per market
    struct CollateralState {
        CollateralStatus status;
        bytes32 lockId;
        uint256 amount;
        uint32 lastUpdated;
    }

    /// @notice Market collateral states
    mapping(bytes32 => CollateralState) public collateralStates;

    // ─── Events ────────────────────────────────────────────────────────

    event MarketRegistered(bytes32 indexed marketId, address indexed market);
    event StateSynced(bytes32 indexed marketId, bytes32 stateHash, uint256 timestamp);
    event AttestationReceived(bytes32 indexed marketId, bytes32 attestationHash, uint256 timestamp);
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    event TrustedAttesterUpdated(address indexed oldAttester, address indexed newAttester);

    event CollateralReserveRequested(bytes32 indexed marketId, address indexed borrower, uint256 amount);
    event CollateralLockConfirmed(bytes32 indexed marketId, bytes32 lockId, uint256 amount);
    event MarginCallTriggered(bytes32 indexed marketId, address indexed borrower, uint256 deficit);
    event LiquidationInstructed(bytes32 indexed marketId, address indexed borrower, uint256 amount);
    event CollateralReleased(bytes32 indexed marketId, bytes32 lockId, uint256 amount);

    // ─── Errors ────────────────────────────────────────────────────────

    error MarketNotRegistered();
    error MarketAlreadyRegistered();
    error UnauthorizedRelayer();
    error ZeroAddress();
    error InvalidAttestationSignature();
    error StaleAttestation();
    error InvalidCollateralState();

    // ─── Modifiers ─────────────────────────────────────────────────────

    modifier onlyRelayerOrOwner() {
        if (msg.sender != relayer && msg.sender != owner()) {
            revert UnauthorizedRelayer();
        }
        _;
    }

    // ─── Constructor ───────────────────────────────────────────────────

    constructor(address _relayer, address _attester) Ownable(msg.sender) {
        if (_relayer == address(0)) revert ZeroAddress();
        if (_attester == address(0)) revert ZeroAddress();
        relayer = _relayer;
        trustedAttester = _attester;
        emit RelayerUpdated(address(0), _relayer);
        emit TrustedAttesterUpdated(address(0), _attester);
    }

    // ─── Market Registration ───────────────────────────────────────────

    /// @notice Register a market with the bridge
    /// @param marketId The market identifier (keccak256 of borrower + asset)
    /// @param marketAddr The deployed CreditMarket contract address
    function registerMarket(bytes32 marketId, address marketAddr) external onlyOwner {
        if (marketAddr == address(0)) revert ZeroAddress();
        if (_marketAddresses[marketId] != address(0)) revert MarketAlreadyRegistered();

        _marketAddresses[marketId] = marketAddr;
        emit MarketRegistered(marketId, marketAddr);
    }

    // ─── ITICSBridge Implementation ────────────────────────────────────

    /// @inheritdoc ITICSBridge
    function syncMarketState(bytes32 marketId) external override nonReentrant onlyRelayerOrOwner {
        address market = _marketAddresses[marketId];
        if (market == address(0)) revert MarketNotRegistered();

        // Compute state hash from market's current on-chain state
        // Uses staticcall to read without modifying state
        bytes32 stateHash = _computeMarketStateHash(market);

        _stateHashes[marketId] = stateHash;
        emit StateSynced(marketId, stateHash, block.timestamp);
    }

    /// @inheritdoc ITICSBridge
    function receiveAttestation(
        bytes32 marketId,
        bytes calldata attestation
    ) external override nonReentrant onlyRelayerOrOwner {
        if (_marketAddresses[marketId] == address(0)) revert MarketNotRegistered();

        // Decode attestation: stateHash, Canton timestamp, ECDSA signature
        (bytes32 stateHash, uint64 cantonTimestamp, bytes memory signature) = abi.decode(
            attestation,
            (bytes32, uint64, bytes)
        );

        // Check staleness
        if (block.timestamp > cantonTimestamp + MAX_ATTESTATION_AGE) revert StaleAttestation();

        // Compute message hash and recover signer
        bytes32 msgHash = keccak256(abi.encodePacked(marketId, stateHash, cantonTimestamp));
        address signer = ECDSA.recover(
            MessageHashUtils.toEthSignedMessageHash(msgHash),
            signature
        );

        // Verify signer is trusted attester or relayer
        if (signer != trustedAttester && signer != relayer) revert InvalidAttestationSignature();

        // Store the Canton state hash and timestamp
        _attestationHashes[marketId] = stateHash;
        _attestationTimestamps[marketId] = cantonTimestamp;

        emit AttestationReceived(marketId, stateHash, cantonTimestamp);
    }

    /// @inheritdoc ITICSBridge
    function getMarketStateHash(bytes32 marketId) external view override returns (bytes32) {
        return _stateHashes[marketId];
    }

    /// @inheritdoc ITICSBridge
    function isRegistered(bytes32 marketId) external view override returns (bool) {
        return _marketAddresses[marketId] != address(0);
    }

    // ─── Collateral Outbound (signal to keeper) ────────────────────────

    /// @notice Request collateral reservation from custodian
    /// @param marketId The market requesting collateral
    /// @param borrower The borrower address
    /// @param amount The collateral amount to reserve
    function requestCollateralReserve(bytes32 marketId, address borrower, uint256 amount) external onlyRelayerOrOwner {
        if (_marketAddresses[marketId] == address(0)) revert MarketNotRegistered();
        CollateralState storage cs = collateralStates[marketId];
        if (cs.status != CollateralStatus.None && cs.status != CollateralStatus.Released) revert InvalidCollateralState();

        cs.status = CollateralStatus.Reserved;
        cs.amount = amount;
        cs.lastUpdated = uint32(block.timestamp);

        emit CollateralReserveRequested(marketId, borrower, amount);
    }

    /// @notice Signal margin call to keeper for Canton relay
    /// @param marketId The market identifier
    /// @param borrower The borrower address
    /// @param deficit The margin deficit amount
    function signalMarginCall(bytes32 marketId, address borrower, uint256 deficit) external onlyRelayerOrOwner {
        if (_marketAddresses[marketId] == address(0)) revert MarketNotRegistered();
        emit MarginCallTriggered(marketId, borrower, deficit);
    }

    /// @notice Signal liquidation instruction to keeper
    /// @param marketId The market identifier
    /// @param borrower The borrower address
    /// @param amount The liquidation amount
    function signalLiquidation(bytes32 marketId, address borrower, uint256 amount) external onlyRelayerOrOwner {
        if (_marketAddresses[marketId] == address(0)) revert MarketNotRegistered();
        CollateralState storage cs = collateralStates[marketId];
        cs.status = CollateralStatus.Liquidating;
        cs.lastUpdated = uint32(block.timestamp);
        emit LiquidationInstructed(marketId, borrower, amount);
    }

    // ─── Keeper Confirmations (inbound from Canton) ──────────────────

    /// @notice Keeper confirms collateral reservation from custodian
    /// @param marketId The market identifier
    /// @param reservationId The reservation identifier
    /// @param amount The reserved amount
    function confirmReservation(bytes32 marketId, bytes32 reservationId, uint256 amount) external onlyRelayerOrOwner {
        if (_marketAddresses[marketId] == address(0)) revert MarketNotRegistered();
        CollateralState storage cs = collateralStates[marketId];
        if (cs.status != CollateralStatus.Reserved) revert InvalidCollateralState();

        cs.lockId = reservationId;
        cs.amount = amount;
        cs.lastUpdated = uint32(block.timestamp);
    }

    /// @notice Keeper confirms collateral locked by custodian
    /// @param marketId The market identifier
    /// @param lockId The lock identifier
    /// @param amount The locked amount
    function confirmLock(bytes32 marketId, bytes32 lockId, uint256 amount) external onlyRelayerOrOwner {
        if (_marketAddresses[marketId] == address(0)) revert MarketNotRegistered();
        CollateralState storage cs = collateralStates[marketId];
        if (cs.status != CollateralStatus.Reserved) revert InvalidCollateralState();

        cs.status = CollateralStatus.Locked;
        cs.lockId = lockId;
        cs.amount = amount;
        cs.lastUpdated = uint32(block.timestamp);

        emit CollateralLockConfirmed(marketId, lockId, amount);
    }

    /// @notice Keeper confirms liquidation completed
    /// @param marketId The market identifier
    /// @param liquidationId The liquidation identifier
    /// @param proceeds The liquidation proceeds
    function confirmLiquidation(bytes32 marketId, bytes32 liquidationId, uint256 proceeds) external onlyRelayerOrOwner {
        if (_marketAddresses[marketId] == address(0)) revert MarketNotRegistered();
        CollateralState storage cs = collateralStates[marketId];
        if (cs.status != CollateralStatus.Liquidating) revert InvalidCollateralState();

        cs.status = CollateralStatus.Released;
        cs.amount = 0;
        cs.lastUpdated = uint32(block.timestamp);

        emit CollateralReleased(marketId, liquidationId, proceeds);
    }

    /// @notice Keeper confirms collateral released (after repayment)
    /// @param marketId The market identifier
    /// @param lockId The lock identifier
    /// @param amount The released amount
    function confirmRelease(bytes32 marketId, bytes32 lockId, uint256 amount) external onlyRelayerOrOwner {
        if (_marketAddresses[marketId] == address(0)) revert MarketNotRegistered();
        CollateralState storage cs = collateralStates[marketId];
        if (cs.status != CollateralStatus.Locked) revert InvalidCollateralState();

        cs.status = CollateralStatus.Released;
        cs.amount = 0;
        cs.lastUpdated = uint32(block.timestamp);

        emit CollateralReleased(marketId, lockId, amount);
    }

    // ─── View Functions ────────────────────────────────────────────────

    /// @notice Returns the attestation hash for a market
    /// @param marketId The market identifier
    /// @return The latest attestation hash
    function getAttestationHash(bytes32 marketId) external view returns (bytes32) {
        return _attestationHashes[marketId];
    }

    /// @notice Returns the attestation timestamp for a market
    /// @param marketId The market identifier
    /// @return The timestamp of the latest attestation
    function getAttestationTimestamp(bytes32 marketId) external view returns (uint64) {
        return _attestationTimestamps[marketId];
    }

    /// @notice Returns the registered market address
    /// @param marketId The market identifier
    /// @return The CreditMarket contract address
    function getMarketAddress(bytes32 marketId) external view returns (address) {
        return _marketAddresses[marketId];
    }

    /// @notice Get collateral state for a market
    /// @param marketId The market identifier
    /// @return The collateral state struct
    function getCollateralState(bytes32 marketId) external view returns (CollateralState memory) {
        return collateralStates[marketId];
    }

    /// @notice Checks if EVM state and Canton attestation are in sync
    /// @param marketId The market identifier
    /// @return True if both hashes exist and match
    function isInSync(bytes32 marketId) external view returns (bool) {
        bytes32 stateHash = _stateHashes[marketId];
        bytes32 attestHash = _attestationHashes[marketId];
        return stateHash != bytes32(0) && stateHash == attestHash;
    }

    // ─── Admin ─────────────────────────────────────────────────────────

    /// @notice Update the authorized relayer address
    /// @param newRelayer The new relayer address
    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert ZeroAddress();
        address old = relayer;
        relayer = newRelayer;
        emit RelayerUpdated(old, newRelayer);
    }

    /// @notice Update the trusted attester address for signature verification
    /// @param _attester The new attester address
    function setTrustedAttester(address _attester) external onlyOwner {
        if (_attester == address(0)) revert ZeroAddress();
        address old = trustedAttester;
        trustedAttester = _attester;
        emit TrustedAttesterUpdated(old, _attester);
    }

    // ─── Internal ──────────────────────────────────────────────────────

    /// @dev Computes keccak256 hash of market's key state fields
    function _computeMarketStateHash(address market) internal view returns (bytes32) {
        // Read key state from CreditMarket via its public getters
        // This encodes: scaleFactor, totalSupply, totalBorrowed, isDelinquent, isClosed
        (bool success, bytes memory data) = market.staticcall(
            abi.encodeWithSignature("getState()")
        );

        if (!success || data.length == 0) {
            // Fallback: hash the market address + block number
            return keccak256(abi.encodePacked(market, block.number));
        }

        return keccak256(data);
    }
}
