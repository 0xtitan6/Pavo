// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPriceFeedAdapter - Interface for Chainlink price feed adapter
/// @notice Wraps Chainlink AggregatorV3Interface for LTV monitoring and margin call triggers
interface IPriceFeedAdapter {
    // ─── Events ─────────────────────────────────────────────────────────
    event FeedUpdated(address indexed asset, address indexed feed);
    event StalenessThresholdUpdated(uint256 newThreshold);

    // ─── Functions ──────────────────────────────────────────────────────

    /// @notice Set or update the Chainlink price feed for an asset
    /// @param asset The asset address
    /// @param feed The Chainlink AggregatorV3Interface feed address
    function setFeed(address asset, address feed) external;

    /// @notice Get the latest price for an asset
    /// @param asset The asset address
    /// @return price The latest price (positive, from Chainlink)
    /// @return decimals The decimals of the price feed
    function getPrice(address asset) external view returns (uint256 price, uint8 decimals);

    /// @notice Check if the price feed for an asset is stale
    /// @param asset The asset address
    /// @return True if the price is stale (exceeds staleness threshold)
    function isStale(address asset) external view returns (bool);

    /// @notice Update the staleness threshold
    /// @param _seconds The new staleness threshold in seconds
    function setStalenessThreshold(uint256 _seconds) external;
}
