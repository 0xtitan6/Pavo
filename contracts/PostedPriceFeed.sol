// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title Posted Price Feed
/// @notice AggregatorV3Interface-compatible feed for assets without a Chainlink feed.
///         An authorized poster pushes values sourced off-chain (e.g. Ornn's Compute
///         Price Index from api.ornnai.com); PriceOracle consumes it like any
///         Chainlink feed via setFeed().
/// @dev Trust model: whoever holds a poster key sets the price — mitigated by the
///      sanity bounds here and PriceOracle's deviation circuit breaker. Pair
///      PriceOracle's maxStaleness with the source's cadence (e.g. ≈26h for
///      OCPI's daily 20:00 UTC settle).
contract PostedPriceFeed is AggregatorV3Interface {

    // ========================================================================
    // ERRORS
    // ========================================================================

    error ZeroAddress();
    error Unauthorized();
    error InvalidAnswer(int256 answer);
    error AnswerOutOfBounds(int256 answer, int256 minAnswer, int256 maxAnswer);
    error RoundNotFound(uint80 roundId);
    error InvalidBounds(int256 minAnswer, int256 maxAnswer);

    // ========================================================================
    // EVENTS
    // ========================================================================

    event AnswerUpdated(uint80 indexed roundId, int256 answer, uint256 updatedAt);
    event PosterUpdated(address indexed poster, bool authorized);
    event BoundsUpdated(int256 minAnswer, int256 maxAnswer);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ========================================================================
    // STRUCTS
    // ========================================================================

    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    // ========================================================================
    // STATE
    // ========================================================================

    /// @notice Contract owner (manages posters, bounds, ownership)
    address public owner;

    /// @notice Pending owner for two-step ownership transfer
    address public pendingOwner;

    /// @notice Addresses authorized to post prices
    mapping(address => bool) public posters;

    /// @notice Sanity bounds on posted answers (0 maxAnswer = unbounded above)
    /// @dev Protects against fat-finger posts (e.g. $265 instead of $2.65)
    int256 public minAnswer;
    int256 public maxAnswer;

    /// @notice Latest round id (0 until the first post)
    uint80 public latestRoundId;

    /// @notice Round id → posted answer and timestamp
    mapping(uint80 => Round) private rounds;

    uint8 private immutable _decimals;
    string private _description;

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    /// @param _owner Initial owner (also authorized as a poster for convenience)
    /// @param decimals_ Feed decimals (8 for Chainlink-style USD feeds)
    /// @param description_ Human-readable feed name (e.g. "OCPI H100 SXM / USD")
    constructor(address _owner, uint8 decimals_, string memory description_) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        posters[_owner] = true;
        _decimals = decimals_;
        _description = description_;
        emit PosterUpdated(_owner, true);
    }

    // ========================================================================
    // MODIFIERS
    // ========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyPoster() {
        if (!posters[msg.sender]) revert Unauthorized();
        _;
    }

    // ========================================================================
    // POSTING
    // ========================================================================

    /// @notice Post a new price (e.g. an index's daily settle)
    /// @param answer Index value scaled to feed decimals (e.g. $2.65 with 8 decimals = 265000000)
    function postAnswer(int256 answer) external onlyPoster {
        if (answer <= 0) revert InvalidAnswer(answer);
        if (answer < minAnswer || (maxAnswer != 0 && answer > maxAnswer)) {
            revert AnswerOutOfBounds(answer, minAnswer, maxAnswer);
        }

        uint80 roundId = ++latestRoundId;
        rounds[roundId] = Round({answer: answer, updatedAt: block.timestamp});

        emit AnswerUpdated(roundId, answer, block.timestamp);
    }

    // ========================================================================
    // ADMIN
    // ========================================================================

    /// @notice Authorize or revoke a poster address
    function setPoster(address poster, bool authorized) external onlyOwner {
        if (poster == address(0)) revert ZeroAddress();
        posters[poster] = authorized;
        emit PosterUpdated(poster, authorized);
    }

    /// @notice Set sanity bounds on posted answers (maxAnswer_ = 0 disables the upper bound)
    function setBounds(int256 minAnswer_, int256 maxAnswer_) external onlyOwner {
        if (minAnswer_ < 0 || (maxAnswer_ != 0 && maxAnswer_ < minAnswer_)) {
            revert InvalidBounds(minAnswer_, maxAnswer_);
        }
        minAnswer = minAnswer_;
        maxAnswer = maxAnswer_;
        emit BoundsUpdated(minAnswer_, maxAnswer_);
    }

    /// @notice Propose a new owner (step 1 of two-step transfer)
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferProposed(owner, newOwner);
    }

    /// @notice Accept ownership (step 2 of two-step transfer)
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
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
        Round memory round = rounds[roundId_];
        if (round.updatedAt == 0) revert RoundNotFound(roundId_);
        return (roundId_, round.answer, round.updatedAt, round.updatedAt, roundId_);
    }

    function latestRoundData() external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        uint80 latest = latestRoundId;
        if (latest == 0) revert RoundNotFound(0);
        Round memory round = rounds[latest];
        return (latest, round.answer, round.updatedAt, round.updatedAt, latest);
    }
}
