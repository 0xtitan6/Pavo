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
    uint256 private _startedAt;
    bool private _hasCustomStartedAt;
    uint80 private _roundId;
    uint80 private _answeredInRound;
    bool private _hasCustomAnsweredInRound;
    string private _description;

    constructor(uint8 decimals_, int256 initialAnswer) {
        _decimals = decimals_;
        _answer = initialAnswer;
        _updatedAt = block.timestamp;
        _startedAt = block.timestamp;
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

    /// @notice Set startedAt independently from updatedAt (for sequencer feed testing)
    function setStartedAt(uint256 startedAt) external {
        _startedAt = startedAt;
        _hasCustomStartedAt = true;
    }

    /// @notice Set answeredInRound to a custom value (for testing stale round detection)
    function setAnsweredInRound(uint80 answeredInRound) external {
        _answeredInRound = answeredInRound;
        _hasCustomAnsweredInRound = true;
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
        uint256 started = _hasCustomStartedAt ? _startedAt : _updatedAt;
        uint80 answered = _hasCustomAnsweredInRound ? _answeredInRound : roundId_;
        return (roundId_, _answer, started, _updatedAt, answered);
    }

    function latestRoundData() external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        uint256 started = _hasCustomStartedAt ? _startedAt : _updatedAt;
        uint80 answered = _hasCustomAnsweredInRound ? _answeredInRound : _roundId;
        return (_roundId, _answer, started, _updatedAt, answered);
    }
}
