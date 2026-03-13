// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/access/Ownable2Step.sol';

import './interfaces/ISanctionsSentinel.sol';

/// @title ISanctionsList - Chainalysis sanctions oracle interface
/// @notice Standard interface: single isSanctioned(address) check
interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}

/// @title SanctionsSentinel - Sanctions screening for Module 2 undercollateralized lending
/// @notice Wraps Chainalysis sanctions oracle with owner-managed overrides for false positives
/// @dev Returns false (safe default) when no oracle is configured, enabling testnet deployment
contract SanctionsSentinel is ISanctionsSentinel, Ownable2Step {
    // ─── State ─────────────────────────────────────────────────────────

    /// @notice Chainalysis sanctions list oracle address
    address public sanctionsList;

    /// @notice Owner-managed overrides: address => override value
    /// @dev When an override exists, it takes precedence over the oracle result
    mapping(address => bool) internal _hasOverride;
    mapping(address => bool) internal _overrideValue;

    // ─── Constructor ───────────────────────────────────────────────────

    /// @param _sanctionsList The Chainalysis sanctions list address (use address(0) for testnet)
    constructor(address _sanctionsList) Ownable(msg.sender) {
        sanctionsList = _sanctionsList;
    }

    // ─── Core ──────────────────────────────────────────────────────────

    /// @inheritdoc ISanctionsSentinel
    function isSanctioned(address addr) external view override returns (bool) {
        // Check for owner override first
        if (_hasOverride[addr]) {
            return _overrideValue[addr];
        }

        // If no oracle configured (testnet), return false (safe default)
        if (sanctionsList == address(0)) {
            return false;
        }

        // Query Chainalysis oracle
        return ISanctionsList(sanctionsList).isSanctioned(addr);
    }

    // ─── Admin ─────────────────────────────────────────────────────────

    /// @inheritdoc ISanctionsSentinel
    function overrideSanction(address addr, bool sanctioned) external override onlyOwner {
        _hasOverride[addr] = true;
        _overrideValue[addr] = sanctioned;
        emit SanctionOverride(addr, sanctioned);
    }

    /// @inheritdoc ISanctionsSentinel
    function setSanctionsList(address _sanctionsList) external override onlyOwner {
        sanctionsList = _sanctionsList;
        emit SanctionsListUpdated(_sanctionsList);
    }
}
