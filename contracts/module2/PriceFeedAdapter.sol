// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/access/Ownable2Step.sol';
import '@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol';

import './interfaces/IPriceFeedAdapter.sol';

/// @title PriceFeedAdapter - Chainlink price feed adapter for Module 2 undercollateralized lending
/// @notice Wraps Chainlink AggregatorV3Interface for LTV monitoring and margin call triggers
/// @dev Validates price > 0 and checks staleness against configurable threshold
contract PriceFeedAdapter is IPriceFeedAdapter, Ownable2Step {
    // ─── Errors ────────────────────────────────────────────────────────

    error FeedNotSet(address asset);
    error InvalidPrice(address asset, int256 price);
    error ZeroAddress();

    // ─── State ─────────────────────────────────────────────────────────

    /// @notice Asset address => Chainlink price feed
    mapping(address => AggregatorV3Interface) internal _feeds;

    /// @notice Staleness threshold in seconds (default: 1 hour)
    uint256 public stalenessThreshold;

    // ─── Constructor ───────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {
        stalenessThreshold = 3600;
    }

    // ─── Core ──────────────────────────────────────────────────────────

    /// @inheritdoc IPriceFeedAdapter
    function setFeed(address asset, address feed) external override onlyOwner {
        if (asset == address(0) || feed == address(0)) revert ZeroAddress();
        _feeds[asset] = AggregatorV3Interface(feed);
        emit FeedUpdated(asset, feed);
    }

    /// @inheritdoc IPriceFeedAdapter
    function getPrice(address asset) external view override returns (uint256 price, uint8 decimals) {
        AggregatorV3Interface feed = _feeds[asset];
        if (address(feed) == address(0)) revert FeedNotSet(asset);

        (
            ,
            int256 answer,
            ,
            ,
        ) = feed.latestRoundData();

        if (answer <= 0) revert InvalidPrice(asset, answer);

        price = uint256(answer);
        decimals = feed.decimals();
    }

    /// @inheritdoc IPriceFeedAdapter
    function isStale(address asset) external view override returns (bool) {
        AggregatorV3Interface feed = _feeds[asset];
        if (address(feed) == address(0)) revert FeedNotSet(asset);

        (
            ,
            ,
            ,
            uint256 updatedAt,
        ) = feed.latestRoundData();

        return block.timestamp - updatedAt > stalenessThreshold;
    }

    /// @inheritdoc IPriceFeedAdapter
    function setStalenessThreshold(uint256 _seconds) external override onlyOwner {
        stalenessThreshold = _seconds;
        emit StalenessThresholdUpdated(_seconds);
    }
}
