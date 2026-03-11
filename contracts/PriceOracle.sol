// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Price Oracle for VeniceFi
/// @notice Wraps Chainlink price feeds with safety checks (staleness, zero-price, sequencer)
/// @dev Implements ϕ_t(H_t, v) valuation process from whitepaper equation 23
contract PriceOracle {

    // ========================================================================
    // ERRORS
    // ========================================================================
    
    error StalePrice(uint256 updatedAt, uint256 maxAge);
    error InvalidPrice(int256 price);
    error SequencerDown();
    error SequencerFeedStale(uint256 updatedAt, uint256 maxAge);
    error GracePeriodNotOver(uint256 timeSinceUp, uint256 gracePeriod);
    error ZeroAddress();
    error Unauthorized();
    error FeedNotConfigured(address token);
    error PriceDeviationTooLarge(uint256 oldPrice, uint256 newPrice, uint256 maxDeviationBps);

    // ========================================================================
    // EVENTS
    // ========================================================================

    event FeedUpdated(address indexed token, address indexed feed, uint256 maxStaleness, uint8 decimals);
    event SequencerFeedUpdated(address indexed feed);
    event MaxDeviationUpdated(uint256 oldDeviation, uint256 newDeviation);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner);

    // ========================================================================
    // STRUCTS
    // ========================================================================

    /// @notice Configuration for a token's Chainlink price feed
    struct FeedConfig {
        AggregatorV3Interface feed;       // Chainlink aggregator proxy
        uint256 maxStaleness;             // Maximum acceptable age in seconds
        uint8 feedDecimals;               // Decimals returned by the feed (typically 8)
        bool exists;                      // Whether this feed has been configured
    }

    // ========================================================================
    // STATE
    // ========================================================================

    /// @notice Contract owner (can update feeds, transfer ownership)
    address public owner;

    /// @notice Pending owner for two-step ownership transfer (H-5 Fix)
    address public pendingOwner;

    /// @notice Mapping of token address → Chainlink feed configuration
    mapping(address => FeedConfig) public feeds;

    /// @notice Optional L2 sequencer uptime feed (set to address(0) on L1)
    AggregatorV3Interface public sequencerUptimeFeed;

    /// @notice Grace period after sequencer comes back up (default: 1 hour)
    uint256 public constant SEQUENCER_GRACE_PERIOD = 3600;

    /// @notice Maximum staleness for the sequencer uptime feed itself (default: 1 hour)
    uint256 public constant SEQUENCER_MAX_STALENESS = 3600;

    /// @notice Maximum allowed price deviation between consecutive reads (default: 50% = 5000 bps)
    /// @dev Circuit breaker — if price moves more than this in one read, revert
    uint256 public maxDeviationBps = 5000;

    /// @notice Last known good price per token (for deviation checks)
    mapping(address => uint256) public lastGoodPrice;

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    /// @param _owner The initial owner of the oracle contract
    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ========================================================================
    // MODIFIERS
    // ========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ========================================================================
    // ADMIN FUNCTIONS
    // ========================================================================

    /// @notice Configure or update a Chainlink price feed for a token
    /// @param token The ERC20 token address (e.g., WBTC)
    /// @param feed The Chainlink AggregatorV3Interface proxy address
    /// @param maxStaleness Maximum age in seconds before price is considered stale
    ///        BTC/USD on Ethereum mainnet: heartbeat = 3600s, so use ~3660s
    function setFeed(
        address token,
        address feed,
        uint256 maxStaleness
    ) external onlyOwner {
        if (token == address(0) || feed == address(0)) revert ZeroAddress();
        
        AggregatorV3Interface priceFeed = AggregatorV3Interface(feed);
        uint8 feedDecimals = priceFeed.decimals();

        feeds[token] = FeedConfig({
            feed: priceFeed,
            maxStaleness: maxStaleness,
            feedDecimals: feedDecimals,
            exists: true
        });

        emit FeedUpdated(token, feed, maxStaleness, feedDecimals);
    }

    /// @notice Set the L2 sequencer uptime feed (only needed on L2s like Arbitrum, Optimism)
    /// @param feed The sequencer uptime feed address (set to address(0) to disable)
    function setSequencerUptimeFeed(address feed) external onlyOwner {
        sequencerUptimeFeed = AggregatorV3Interface(feed);
        emit SequencerFeedUpdated(feed);
    }

    /// @notice Minimum allowed deviation to prevent silently disabling the circuit breaker (M-2 Fix)
    uint256 public constant MIN_DEVIATION_BPS = 100; // 1%

    /// @notice Update the maximum price deviation allowed (circuit breaker threshold)
    /// @param newMaxDeviationBps New deviation in basis points (e.g., 5000 = 50%); must be >= MIN_DEVIATION_BPS
    function setMaxDeviation(uint256 newMaxDeviationBps) external onlyOwner {
        require(newMaxDeviationBps >= MIN_DEVIATION_BPS, "Deviation below minimum");
        uint256 old = maxDeviationBps;
        maxDeviationBps = newMaxDeviationBps;
        emit MaxDeviationUpdated(old, newMaxDeviationBps);
    }

    /// @notice Propose a new owner (step 1 of two-step transfer — H-5 Fix)
    /// @dev The proposed owner must call acceptOwnership() to complete the transfer.
    ///      Prevents accidental transfers to wrong addresses.
    /// @param newOwner The proposed new owner address
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferProposed(owner, newOwner);
    }

    /// @notice Accept ownership (step 2 of two-step transfer — H-5 Fix)
    /// @dev Must be called by the pending owner to finalise the transfer.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // ========================================================================
    // CORE ORACLE FUNCTIONS — ϕ_t(z) and ϕ_t^(-1)(v)
    // ========================================================================

    /// @notice Get the asset-denominated value of a collateral amount: ϕ_t(z)
    /// @dev Whitepaper equation 23: ϕ_t(H_t, v) valuation process
    ///      Returns value expressed in the asset token's decimal units
    /// @param amount Collateral token amount (e.g., BTC with 8 decimals)
    /// @param tokenAddress The collateral token whose price feed to use
    /// @param assetDecimals Decimals of the asset (lent) token (e.g., 6 for USDC, 18 for DAI)
    /// @return assetValue The collateral value denominated in asset units
    function getOraclePrice(
        uint256 amount,
        address tokenAddress,
        uint8 assetDecimals
    ) external returns (uint256 assetValue) {
        uint256 priceUsd = _getValidatedPrice(tokenAddress);
        FeedConfig memory config = feeds[tokenAddress];
        uint256 collateralDecimals = IERC20Metadata(tokenAddress).decimals();
        assetValue = _scaleToAsset(amount * priceUsd, collateralDecimals + config.feedDecimals, assetDecimals);
    }

    /// @notice Get the collateral amount for an asset value: ϕ_t^(-1)(v)
    /// @dev Inverse of getOraclePrice — given an asset amount, return how much collateral that buys
    /// @param assetAmount Asset (stablecoin) amount in asset decimal units
    /// @param tokenAddress The collateral token whose price feed to use
    /// @param assetDecimals Decimals of the asset (lent) token
    /// @return tokenAmount The collateral token amount
    function getInverseOraclePrice(
        uint256 assetAmount,
        address tokenAddress,
        uint8 assetDecimals
    ) external returns (uint256 tokenAmount) {
        uint256 priceUsd = _getValidatedPrice(tokenAddress);
        FeedConfig memory config = feeds[tokenAddress];
        uint256 collateralDecimals = IERC20Metadata(tokenAddress).decimals();
        tokenAmount = _scaleToAsset(assetAmount, assetDecimals, collateralDecimals + config.feedDecimals) / priceUsd;
    }

    /// @notice Get collateral value in asset units, bypassing the circuit breaker
    /// @dev Use for liquidations and loan settlement where blocking the call would trap funds.
    ///      Still validates staleness, zero-price, and sequencer — only skips deviation check.
    /// @param amount Collateral token amount
    /// @param tokenAddress The collateral token whose price feed to use
    /// @param assetDecimals Decimals of the asset (lent) token
    /// @return assetValue The collateral value in asset decimal units
    function getOraclePriceUnchecked(
        uint256 amount,
        address tokenAddress,
        uint8 assetDecimals
    ) external view returns (uint256 assetValue) {
        uint256 priceUsd = _getRawValidatedPrice(tokenAddress);
        // NOTE: Does NOT update lastGoodPrice — prevents unchecked calls (liquidation/settlement)
        // from poisoning the circuit breaker's baseline during extreme market events.
        FeedConfig memory config = feeds[tokenAddress];
        uint256 collateralDecimals = IERC20Metadata(tokenAddress).decimals();
        assetValue = _scaleToAsset(amount * priceUsd, collateralDecimals + config.feedDecimals, assetDecimals);
    }

    /// @notice Get collateral amount for an asset value, bypassing the circuit breaker
    /// @dev Use for liquidations and loan settlement where blocking the call would trap funds.
    ///      Still validates staleness, zero-price, and sequencer — only skips deviation check.
    /// @param assetAmount Asset (stablecoin) amount in asset decimal units
    /// @param tokenAddress The collateral token whose price feed to use
    /// @param assetDecimals Decimals of the asset (lent) token
    /// @return tokenAmount The collateral token amount
    function getInverseOraclePriceUnchecked(
        uint256 assetAmount,
        address tokenAddress,
        uint8 assetDecimals
    ) external view returns (uint256 tokenAmount) {
        uint256 priceUsd = _getRawValidatedPrice(tokenAddress);
        // NOTE: Does NOT update lastGoodPrice — same rationale as getOraclePriceUnchecked.
        FeedConfig memory config = feeds[tokenAddress];
        uint256 collateralDecimals = IERC20Metadata(tokenAddress).decimals();
        tokenAmount = _scaleToAsset(assetAmount, assetDecimals, collateralDecimals + config.feedDecimals) / priceUsd;
    }

    /// @notice View-only version of getOraclePrice (doesn't update lastGoodPrice)
    /// @dev Use this for off-chain reads / UI. On-chain operations should use getOraclePrice.
    /// @param amount Collateral token amount
    /// @param tokenAddress The collateral token whose price feed to use
    /// @param assetDecimals Decimals of the asset (lent) token
    function getOraclePriceView(
        uint256 amount,
        address tokenAddress,
        uint8 assetDecimals
    ) external view returns (uint256 assetValue) {
        uint256 priceUsd = _getRawValidatedPrice(tokenAddress);
        FeedConfig memory config = feeds[tokenAddress];
        uint256 collateralDecimals = IERC20Metadata(tokenAddress).decimals();
        assetValue = _scaleToAsset(amount * priceUsd, collateralDecimals + config.feedDecimals, assetDecimals);
    }

    /// @notice View-only version of getInverseOraclePrice
    /// @param assetAmount Asset (stablecoin) amount in asset decimal units
    /// @param tokenAddress The collateral token whose price feed to use
    /// @param assetDecimals Decimals of the asset (lent) token
    function getInverseOraclePriceView(
        uint256 assetAmount,
        address tokenAddress,
        uint8 assetDecimals
    ) external view returns (uint256 tokenAmount) {
        uint256 priceUsd = _getRawValidatedPrice(tokenAddress);
        FeedConfig memory config = feeds[tokenAddress];
        uint256 collateralDecimals = IERC20Metadata(tokenAddress).decimals();
        tokenAmount = _scaleToAsset(assetAmount, assetDecimals, collateralDecimals + config.feedDecimals) / priceUsd;
    }

    /// @dev Scale a value from `fromDecimals` to `toDecimals` without underflow.
    ///      If fromDecimals >= toDecimals: divide by 10^(from-to)
    ///      If fromDecimals <  toDecimals: multiply by 10^(to-from)
    function _scaleToAsset(
        uint256 value,
        uint256 fromDecimals,
        uint256 toDecimals
    ) private pure returns (uint256) {
        if (fromDecimals >= toDecimals) {
            return value / (10 ** (fromDecimals - toDecimals));
        } else {
            return value * (10 ** (toDecimals - fromDecimals));
        }
    }

    // ========================================================================
    // INTERNAL VALIDATION
    // ========================================================================

    /// @dev Full validation pipeline: sequencer → staleness → zero → deviation
    ///      Updates lastGoodPrice on success (state-changing)
    function _getValidatedPrice(address tokenAddress) internal returns (uint256) {
        uint256 price = _getRawValidatedPrice(tokenAddress);
        
        // Circuit breaker: check deviation from last known good price
        uint256 lastPrice = lastGoodPrice[tokenAddress];
        if (lastPrice > 0 && maxDeviationBps > 0) {
            uint256 deviation;
            if (price > lastPrice) {
                deviation = ((price - lastPrice) * 10000) / lastPrice;
            } else {
                deviation = ((lastPrice - price) * 10000) / lastPrice;
            }
            if (deviation > maxDeviationBps) {
                revert PriceDeviationTooLarge(lastPrice, price, maxDeviationBps);
            }
        }

        // Update last known good price
        lastGoodPrice[tokenAddress] = price;

        return price;
    }

    /// @dev Validation without state changes (for view functions)
    function _getRawValidatedPrice(address tokenAddress) internal view returns (uint256) {
        FeedConfig memory config = feeds[tokenAddress];
        if (!config.exists) revert FeedNotConfigured(tokenAddress);

        // Step 1: Check L2 sequencer (if configured)
        _checkSequencer();

        // Step 2: Get latest round data from Chainlink
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = config.feed.latestRoundData();

        // Step 3: Validate price is positive
        if (answer <= 0) revert InvalidPrice(answer);

        // Step 4: Validate freshness (staleness check)
        if (block.timestamp - updatedAt > config.maxStaleness) {
            revert StalePrice(updatedAt, config.maxStaleness);
        }

        // Step 5: Chainlink best-practice — answeredInRound must not lag roundId
        if (answeredInRound < roundId) revert StalePrice(updatedAt, config.maxStaleness);

        return uint256(answer);
    }

    /// @dev Check L2 sequencer uptime (no-op on L1 where sequencerUptimeFeed == address(0))
    function _checkSequencer() internal view {
        if (address(sequencerUptimeFeed) == address(0)) return;

        (
            ,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
        ) = sequencerUptimeFeed.latestRoundData();

        // Check the sequencer feed itself is fresh
        if (block.timestamp - updatedAt > SEQUENCER_MAX_STALENESS) {
            revert SequencerFeedStale(updatedAt, SEQUENCER_MAX_STALENESS);
        }

        // answer == 0 means sequencer is up, answer == 1 means it's down
        if (answer != 0) revert SequencerDown();

        // Enforce grace period after sequencer comes back up
        uint256 timeSinceUp = block.timestamp - startedAt;
        if (timeSinceUp < SEQUENCER_GRACE_PERIOD) {
            revert GracePeriodNotOver(timeSinceUp, SEQUENCER_GRACE_PERIOD);
        }
    }
}