// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title MockAggregatorV3
/// @notice Mock Chainlink price feed for testing
/// @dev Allows setting price, decimals, and staleness for test scenarios
contract MockAggregatorV3 is AggregatorV3Interface {

    uint8 private _decimals;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;
    string private _description;

    constructor(uint8 decimals_, int256 initialAnswer) {
        _decimals = decimals_;
        _answer = initialAnswer;
        _updatedAt = block.timestamp;
        _roundId = 1;
        _description = "Mock Price Feed";
    }

    // ========================================================================
    // TEST CONTROLS
    // ========================================================================

    /// @notice Set a new price (simulates oracle update)
    function setAnswer(int256 answer) external {
        _answer = answer;
        _updatedAt = block.timestamp;
        _roundId++;
    }

    /// @notice Set updatedAt to a past timestamp (simulates stale price)
    function setUpdatedAt(uint256 updatedAt) external {
        _updatedAt = updatedAt;
    }

    /// @notice Set price without updating the timestamp (simulates stale with new price)
    function setAnswerWithTimestamp(int256 answer, uint256 updatedAt) external {
        _answer = answer;
        _updatedAt = updatedAt;
        _roundId++;
    }

    // ========================================================================
    // AggregatorV3Interface
    // ========================================================================

    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function getRoundData(uint80 roundId_) external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (roundId_, _answer, _updatedAt, _updatedAt, roundId_);
    }

    function latestRoundData() external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
