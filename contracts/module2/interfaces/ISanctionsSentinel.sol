// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISanctionsSentinel - Interface for sanctions screening
/// @notice Checks addresses against Chainalysis sanctions oracle with owner overrides
interface ISanctionsSentinel {
    // ─── Events ─────────────────────────────────────────────────────────
    event SanctionOverride(address indexed addr, bool sanctioned);
    event SanctionsListUpdated(address indexed sanctionsList);

    // ─── Functions ──────────────────────────────────────────────────────

    /// @notice Check if an address is sanctioned
    /// @param addr The address to check
    /// @return True if the address is sanctioned
    function isSanctioned(address addr) external view returns (bool);

    /// @notice Override the sanctions status of an address (whitelist false positives)
    /// @param addr The address to override
    /// @param sanctioned Whether the address should be considered sanctioned
    function overrideSanction(address addr, bool sanctioned) external;

    /// @notice Update the Chainalysis sanctions list oracle address
    /// @param _sanctionsList The new sanctions list contract address
    function setSanctionsList(address _sanctionsList) external;
}
