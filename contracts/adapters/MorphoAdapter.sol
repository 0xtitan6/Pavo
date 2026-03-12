// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IMorpho.sol";
import "../interfaces/IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title MorphoAdapter
/// @notice Earns yield on idle lend/borrow offer funds via Morpho Blue while offers await matching.
/// @custom:deprecated Use OptimizerAdapter instead — routes through ParthenonOptimizer (self-managed pool markets)
///                    rather than external Morpho Blue. Kept for backwards compatibility with existing tests.
/// @dev Two access tiers:
///      - owner (admin EOA): configures markets, pauses markets, sets deposit caps
///      - loanFactory: calls deposit/withdraw to move funds in/out of Morpho
///
///      Lifecycle (inspired by Morpho optimizer idle-to-match flow):
///        createLoan  → deposit(token, amount, loanId)   — idle funds earn yield on Morpho
///        cancelLoan  → withdraw(token, loanId, owner)   — return funds + yield to creator
///        takeUpLoan  → withdraw(token, loanId, to)      — pull funds out for loan settlement
///
///      Safety features (from Morpho optimizer patterns):
///        - Per-market pause: freeze deposits without breaking existing withdrawals
///        - Deposit caps: limit total exposure per market
///        - Total deposit tracking: on-chain visibility for frontend indexing
///        - Batch emergency withdrawal: efficient multi-position recovery
    ///        - Market registry: enumerate all configured markets (from marketsCreated[] pattern)
    ///        - Bulk pause/freeze: emergency all-market operations (from setPauseStatusForAllMarkets)
    ///        - Max markets limit: bounded storage growth (from MAX_NB_OF_MARKETS = 128)
contract MorphoAdapter is IYieldAdapter, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ========================================================================
    // CONSTANTS
    // ========================================================================

    /// @notice Maximum number of markets that can be configured
    /// @dev Bounds storage growth and gas cost of bulk operations (from Morpho optimizer MAX_NB_OF_MARKETS)
    uint256 public constant MAX_NB_OF_MARKETS = 128;

    /// @notice Maximum number of positions that can be batch-withdrawn in one tx
    /// @dev Bounds gas cost of batchEmergencyWithdraw (from Morpho optimizer gas-budgeted loop pattern)
    uint256 public constant MAX_BATCH_SIZE = 50;

    // ========================================================================
    // STATE
    // ========================================================================

    /// @notice Morpho Blue contract
    IMorpho public immutable morpho;

    /// @notice The LoanFactory contract — only caller allowed to deposit/withdraw
    address public immutable loanFactory;

    /// @notice token → MarketParams for that token's Morpho market
    mapping(address => MarketParams) public markets;

    /// @notice token → whether a market has been configured
    mapping(address => bool) public marketConfigured;

    /// @notice token → whether deposits are paused (withdrawals always allowed)
    /// @dev Inspired by Morpho optimizer's isPartiallyPaused — freeze new deposits without
    ///      locking existing positions. Useful during market volatility or migration.
    mapping(address => bool) public marketPaused;

    /// @notice token → maximum total shares that can be deposited (0 = no cap)
    /// @dev Limits total adapter exposure per market, preventing concentration risk
    mapping(address => uint256) public marketCap;

    /// @notice token → total Morpho shares currently held across all positions
    /// @dev Enables on-chain exposure tracking and deposit cap enforcement
    mapping(address => uint256) public totalShares;

    /// @notice loanId → token → Morpho shares held for that offer
    mapping(uint256 => mapping(address => uint256)) public sharesOf;

    /// @notice token → number of active positions (non-zero sharesOf entries)
    mapping(address => uint256) public activePositions;

    /// @notice Total active positions across all tokens (LOW-C8 fix)
    uint256 public override totalActivePositions;

    /// @notice token → set of active loanIds (enables position enumeration for migration)
    /// @dev Fixes INFO-10: activePositions was count-only, no loanId lookup for safe migration
    mapping(address => EnumerableSet.UintSet) private _positionsByToken;

    /// @notice loanId → token → original deposit amount (for yield calculation)
    /// @dev Allows frontends to compute yield = withdrawn - depositedAmount
    mapping(uint256 => mapping(address => uint256)) public depositedAmount;

    /// @notice token → total assets deposited across all positions (for aggregate yield monitoring)
    /// @dev Inspired by Morpho optimizer's aggregate supply tracking. Frontends can compute
    ///      total yield = totalWithdrawn - totalDepositedAssets for each market.
    mapping(address => uint256) public totalDepositedAssets;

    /// @notice token → whether the market is fully frozen (blocks deposits AND withdrawals)
    /// @dev Inspired by Morpho optimizer's isPaused (full) vs isPartiallyPaused (deposit-only).
    ///      Use for severe emergencies where even withdrawals must be stopped (e.g., oracle exploit).
    ///      Emergency withdrawals by owner bypass this freeze.
    mapping(address => bool) public marketFrozen;

    /// @notice Registry of all configured market tokens (from Morpho optimizer marketsCreated[] pattern)
    /// @dev Enables enumeration of all markets for frontend discovery and bulk admin operations
    EnumerableSet.AddressSet private _marketsCreated;

    // ========================================================================
    // EVENTS
    // ========================================================================

    event MarketConfigured(address indexed token, MarketParams params);
    event MarketPauseToggled(address indexed token, bool paused);
    event MarketCapSet(address indexed token, uint256 cap);
    event Deposited(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares);
    event Withdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to);
    event EmergencyWithdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to);
    event MarketFreezeToggled(address indexed token, bool frozen);
    event PartialWithdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, uint256 remainingShares, address indexed to);
    event AllMarketsPauseToggled(bool paused);
    event AllMarketsFreezeToggled(bool frozen);
    event MarketDeconfigured(address indexed token);

    // ========================================================================
    // MODIFIERS
    // ========================================================================

    modifier onlyLoanFactory() {
        require(msg.sender == loanFactory, "Only LoanFactory");
        _;
    }

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    /// @param _morpho       Morpho Blue contract address
    /// @param _loanFactory  LoanFactory address — the only caller allowed to deposit/withdraw
    constructor(address _morpho, address _loanFactory) Ownable(msg.sender) {
        require(_morpho != address(0), "Morpho address cannot be zero");
        require(_loanFactory != address(0), "LoanFactory address cannot be zero");
        morpho = IMorpho(_morpho);
        loanFactory = _loanFactory;
    }

    // ========================================================================
    // ADMIN — owner (EOA) only
    // ========================================================================

    /// @notice Configure the Morpho Blue market for a given token
    /// @dev Must be called before deposits for that token.
    /// @param token   The asset or collateral token address
    /// @param params  The Morpho Blue MarketParams for that token
    function configureMarket(address token, MarketParams calldata params) external onlyOwner {
        require(token != address(0), "Token cannot be zero");
        require(params.loanToken != address(0), "Loan token cannot be zero");
        require(params.collateralToken != address(0), "Collateral token cannot be zero");
        require(params.oracle != address(0), "Oracle cannot be zero");
        require(params.irm != address(0), "IRM cannot be zero");
        require(params.lltv > 0, "LLTV must be > 0");
        // Ensure token matches Morpho market's loan token to prevent misconfiguration
        require(token == params.loanToken, "Token must match market loanToken");
        require(activePositions[token] == 0, "Active positions exist for token");
        // Enforce max markets limit (from Morpho optimizer MAX_NB_OF_MARKETS pattern)
        if (!marketConfigured[token]) {
            require(_marketsCreated.length() < MAX_NB_OF_MARKETS, "Max markets reached");
            _marketsCreated.add(token);
        }
        markets[token] = params;
        marketConfigured[token] = true;
        emit MarketConfigured(token, params);
    }

    /// @notice Pause or unpause deposits for a specific market
    /// @dev Inspired by Morpho optimizer's partial pause: freezes new deposits while
    ///      allowing all existing positions to be withdrawn. Useful during market
    ///      volatility, migration, or when a Morpho market shows signs of stress.
    /// @param token  The token whose market to pause/unpause
    /// @param paused True to pause deposits, false to resume
    function setMarketPaused(address token, bool paused) external onlyOwner {
        require(marketConfigured[token], "No Morpho market for token");
        marketPaused[token] = paused;
        emit MarketPauseToggled(token, paused);
    }

    /// @notice Set a deposit cap (in shares) for a specific market
    /// @dev Limits total adapter exposure per Morpho market. Set to 0 to remove the cap.
    ///      Inspired by Morpho optimizer's market-level risk controls.
    /// @param token The token whose market cap to set
    /// @param cap   Maximum total shares allowed (0 = unlimited)
    function setMarketCap(address token, uint256 cap) external onlyOwner {
        require(marketConfigured[token], "No Morpho market for token");
        marketCap[token] = cap;
        emit MarketCapSet(token, cap);
    }

    /// @notice Fully freeze or unfreeze a market (blocks both deposits AND withdrawals)
    /// @dev More severe than pause (which only blocks deposits). Use for critical emergencies
    ///      like oracle exploits where withdrawals could drain funds at wrong prices.
    ///      Inspired by Morpho optimizer's isPaused (full stop) vs isPartiallyPaused (deposit-only).
    ///      Emergency withdrawals by owner bypass this freeze.
    /// @param token  The token whose market to freeze/unfreeze
    /// @param frozen True to freeze, false to unfreeze
    function setMarketFrozen(address token, bool frozen) external onlyOwner {
        require(marketConfigured[token], "No Morpho market for token");
        marketFrozen[token] = frozen;
        emit MarketFreezeToggled(token, frozen);
    }

    /// @notice Pause or unpause deposits for ALL configured markets
    /// @dev Inspired by Morpho optimizer's setPauseStatusForAllMarkets — single-tx emergency response.
    ///      Iterates over the marketsCreated registry. Gas cost bounded by MAX_NB_OF_MARKETS.
    /// @param paused True to pause all deposits, false to resume all
    function setPauseStatusForAllMarkets(bool paused) external onlyOwner {
        uint256 length = _marketsCreated.length();
        for (uint256 i = 0; i < length; i++) {
            address token = _marketsCreated.at(i);
            marketPaused[token] = paused;
            emit MarketPauseToggled(token, paused);
        }
        emit AllMarketsPauseToggled(paused);
    }

    /// @notice Freeze or unfreeze ALL configured markets
    /// @dev Emergency bulk freeze — stops both deposits and withdrawals across all markets.
    ///      Gas cost bounded by MAX_NB_OF_MARKETS.
    /// @param frozen True to freeze all markets, false to unfreeze all
    function setFreezeStatusForAllMarkets(bool frozen) external onlyOwner {
        uint256 length = _marketsCreated.length();
        for (uint256 i = 0; i < length; i++) {
            address token = _marketsCreated.at(i);
            marketFrozen[token] = frozen;
            emit MarketFreezeToggled(token, frozen);
        }
        emit AllMarketsFreezeToggled(frozen);
    }

    /// @notice Remove a market from the registry when it has no active positions
    /// @dev Allows cleanup of unused markets, freeing space under MAX_NB_OF_MARKETS.
    ///      Inspired by Morpho optimizer's bounded market registry — without removal,
    ///      once MAX_NB_OF_MARKETS is reached, no new markets can ever be added.
    /// @param token The token whose market to deconfigure
    function deconfigureMarket(address token) external onlyOwner {
        require(marketConfigured[token], "No Morpho market for token");
        require(activePositions[token] == 0, "Active positions exist for token");
        require(totalShares[token] == 0, "Outstanding shares exist");

        delete markets[token];
        marketConfigured[token] = false;
        marketPaused[token] = false;
        marketFrozen[token] = false;
        marketCap[token] = 0;
        _marketsCreated.remove(token);

        emit MarketDeconfigured(token);
    }

    // ========================================================================
    // CORE — LoanFactory only
    // ========================================================================

    /// @notice Deposit idle offer funds into Morpho Blue to earn yield
    /// @dev Checks market pause status and deposit cap before accepting funds.
    ///      Follows the Morpho optimizer pattern: idle capital → yield source → wait for match.
    /// @param token   The token being deposited (asset for lend offers, collateral for borrow)
    /// @param amount  The net amount (post-fee) to deposit
    /// @param loanId  The loan offer ID — used to track shares for later withdrawal
    function deposit(
        address token,
        uint256 amount,
        uint256 loanId
    ) external onlyLoanFactory nonReentrant {
        require(marketConfigured[token], "No Morpho market for token");
        require(!marketFrozen[token], "Market frozen");
        require(!marketPaused[token], "Market deposits paused");
        require(amount > 0, "Amount must be > 0");

        MarketParams memory params = markets[token];

        // Pull funds from LoanFactory into this adapter
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Approve Morpho to spend
        IERC20(token).forceApprove(address(morpho), amount);

        // Supply to Morpho; track shares so yield accrues to this position
        (, uint256 shares) = morpho.supply(params, amount, 0, address(this), "");
        require(shares > 0, "Supply returned zero shares");

        // LOW-2 Fix: Clear any residual approval (e.g. fee-on-transfer tokens)
        IERC20(token).forceApprove(address(morpho), 0);

        // Track active positions for configureMarket guard and LOW-C8 global counter
        if (sharesOf[loanId][token] == 0) {
            activePositions[token]++;
            totalActivePositions++;
            _positionsByToken[token].add(loanId);
        }
        sharesOf[loanId][token] += shares;
        totalShares[token] += shares;
        depositedAmount[loanId][token] += amount;
        totalDepositedAssets[token] += amount;

        // Enforce deposit cap after share accounting (check-after pattern for accurate cap)
        uint256 cap = marketCap[token];
        require(cap == 0 || totalShares[token] <= cap, "Market deposit cap exceeded");

        emit Deposited(loanId, token, amount, shares);
    }

    /// @notice Withdraw offer funds (+ accrued yield) from Morpho Blue
    /// @param token   The token to withdraw
    /// @param loanId  The loan offer ID whose shares are being redeemed
    /// @param to      Recipient of the withdrawn funds (lender, borrower, or LoanFactory)
    /// @return assets The actual amount of assets withdrawn (principal + yield)
    function withdraw(
        address token,
        uint256 loanId,
        address to
    ) external onlyLoanFactory nonReentrant returns (uint256 assets) {
        require(to != address(0), "Recipient cannot be zero");
        require(!marketFrozen[token], "Market frozen");
        uint256 shares = sharesOf[loanId][token];
        require(shares > 0, "No position for loan");

        MarketParams memory params = markets[token];

        // Clear shares before external call (CEI)
        uint256 deposited = depositedAmount[loanId][token];
        sharesOf[loanId][token] = 0;
        depositedAmount[loanId][token] = 0;
        totalDepositedAssets[token] -= deposited;
        activePositions[token]--;
        totalActivePositions--;
        totalShares[token] -= shares;
        _positionsByToken[token].remove(loanId);

        // Redeem all shares — assets returned include accrued yield
        (assets, ) = morpho.withdraw(params, 0, shares, address(this), to);
        require(assets > 0, "Withdrawal returned zero assets");

        emit Withdrawn(loanId, token, assets, shares, to);
    }

    /// @notice Withdraw a portion of a position's shares from Morpho Blue
    /// @dev Inspired by Morpho optimizer's partial matching: when only part of an offer
    ///      is matched, withdraw only the needed portion while the rest continues earning yield.
    ///      The position remains active with reduced shares.
    /// @param token            The token to withdraw
    /// @param loanId           The loan offer ID whose shares are being partially redeemed
    /// @param sharesToWithdraw The number of shares to withdraw (must be < total shares)
    /// @param to               Recipient of the withdrawn funds
    /// @return assets The actual amount of assets withdrawn
    function withdrawPartial(
        address token,
        uint256 loanId,
        uint256 sharesToWithdraw,
        address to
    ) external onlyLoanFactory nonReentrant returns (uint256 assets) {
        require(to != address(0), "Recipient cannot be zero");
        require(!marketFrozen[token], "Market frozen");
        uint256 currentShares = sharesOf[loanId][token];
        require(currentShares > 0, "No position for loan");
        require(sharesToWithdraw > 0, "Shares must be > 0");
        require(sharesToWithdraw < currentShares, "Use withdraw for full redemption");

        MarketParams memory params = markets[token];

        // Update shares before external call (CEI)
        sharesOf[loanId][token] = currentShares - sharesToWithdraw;
        totalShares[token] -= sharesToWithdraw;

        // Pro-rata deposited amount reduction for yield tracking
        uint256 depositedPortion = (depositedAmount[loanId][token] * sharesToWithdraw) / currentShares;
        depositedAmount[loanId][token] -= depositedPortion;
        totalDepositedAssets[token] -= depositedPortion;

        // Redeem partial shares
        (assets, ) = morpho.withdraw(params, 0, sharesToWithdraw, address(this), to);
        require(assets > 0, "Withdrawal returned zero assets");

        emit PartialWithdrawn(loanId, token, assets, sharesToWithdraw, sharesOf[loanId][token], to);
    }

    // ========================================================================
    // ADMIN — emergency recovery
    // ========================================================================

    /// @notice Emergency withdraw all shares for a given loan position, bypassing LoanFactory
    /// @dev Only callable by owner in case LoanFactory is compromised or paused
    /// @param token  The token to withdraw
    /// @param loanId The loan offer ID
    /// @param to     Recipient of the withdrawn funds
    /// @return assets The amount of assets withdrawn
    function emergencyWithdraw(
        address token,
        uint256 loanId,
        address to
    ) external onlyOwner nonReentrant returns (uint256 assets) {
        require(to != address(0), "Recipient cannot be zero");
        uint256 shares = sharesOf[loanId][token];
        require(shares > 0, "No position for loan");

        MarketParams memory params = markets[token];

        uint256 deposited = depositedAmount[loanId][token];
        sharesOf[loanId][token] = 0;
        depositedAmount[loanId][token] = 0;
        totalDepositedAssets[token] -= deposited;
        activePositions[token]--;
        totalActivePositions--;
        totalShares[token] -= shares;
        _positionsByToken[token].remove(loanId);

        (assets, ) = morpho.withdraw(params, 0, shares, address(this), to);
        require(assets > 0, "Withdrawal returned zero assets");

        emit EmergencyWithdrawn(loanId, token, assets, shares, to);
    }

    /// @notice Batch emergency withdraw multiple positions for a given token
    /// @dev Gas-efficient multi-position recovery. Inspired by Morpho optimizer's
    ///      gas-budgeted loop pattern — processes as many positions as gas allows.
    /// @param token   The token to withdraw
    /// @param loanIds Array of loan offer IDs to withdraw
    /// @param to      Recipient of all withdrawn funds
    /// @return totalAssets The total amount of assets withdrawn across all positions
    function batchEmergencyWithdraw(
        address token,
        uint256[] calldata loanIds,
        address to
    ) external onlyOwner nonReentrant returns (uint256 totalAssets) {
        require(to != address(0), "Recipient cannot be zero");
        require(loanIds.length > 0, "Empty loanIds array");
        require(loanIds.length <= MAX_BATCH_SIZE, "Batch too large");

        MarketParams memory params = markets[token];

        for (uint256 i = 0; i < loanIds.length; i++) {
            uint256 loanId = loanIds[i];
            uint256 shares = sharesOf[loanId][token];
            if (shares == 0) continue; // skip empty positions

            uint256 deposited = depositedAmount[loanId][token];
            sharesOf[loanId][token] = 0;
            depositedAmount[loanId][token] = 0;
            totalDepositedAssets[token] -= deposited;
            activePositions[token]--;
            totalActivePositions--;
            totalShares[token] -= shares;
            _positionsByToken[token].remove(loanId);

            (uint256 assets, ) = morpho.withdraw(params, 0, shares, address(this), to);
            require(assets > 0, "Withdrawal returned zero assets");
            totalAssets += assets;

            emit EmergencyWithdrawn(loanId, token, assets, shares, to);
        }
        require(totalAssets > 0, "No assets withdrawn");
    }

    // ========================================================================
    // VIEW
    // ========================================================================

    /// @notice Check whether a market is configured for a token
    /// @param token The token address to check
    /// @return True if a Morpho market is configured for this token
    function hasMarket(address token) external view returns (bool) {
        return marketConfigured[token];
    }

    /// @notice Check whether a market is paused for deposits
    /// @param token The token address
    /// @return True if deposits are paused for this market
    function isMarketPaused(address token) external view returns (bool) {
        return marketPaused[token];
    }

    /// @notice Get the Morpho shares held for a specific loan and token
    /// @param loanId The loan offer ID
    /// @param token  The token address
    /// @return shares The number of Morpho shares held
    function getShares(uint256 loanId, address token) external view returns (uint256 shares) {
        shares = sharesOf[loanId][token];
    }

    /// @notice Get the configured market parameters for a token
    /// @param token The token address
    /// @return params The Morpho Blue MarketParams
    function getMarketParams(address token) external view returns (MarketParams memory params) {
        require(marketConfigured[token], "No Morpho market for token");
        params = markets[token];
    }

    /// @notice Get market utilization info for frontend display
    /// @param token The token address
    /// @return _totalShares Total shares deposited in this market
    /// @return _cap The deposit cap (0 = unlimited)
    /// @return _activePositions Number of active positions
    /// @return _paused Whether deposits are paused
    /// @return _frozen Whether the market is fully frozen
    /// @return _totalDeposited Total assets deposited (for yield calculation: yield = totalWithdrawn - totalDeposited)
    function getMarketInfo(address token) external view returns (
        uint256 _totalShares,
        uint256 _cap,
        uint256 _activePositions,
        bool _paused,
        bool _frozen,
        uint256 _totalDeposited
    ) {
        _totalShares = totalShares[token];
        _cap = marketCap[token];
        _activePositions = activePositions[token];
        _paused = marketPaused[token];
        _frozen = marketFrozen[token];
        _totalDeposited = totalDepositedAssets[token];
    }

    /// @notice Get all active loanIds for a given token (enables safe adapter migration)
    /// @dev Fixes INFO-10: allows enumeration of positions for migration or emergency recovery.
    ///      Inspired by Morpho optimizer's sorted position lists (HeapOrdering).
    /// @param token The token address
    /// @return loanIds Array of active loan IDs with positions in this market
    function getPositionsByToken(address token) external view returns (uint256[] memory loanIds) {
        uint256 length = _positionsByToken[token].length();
        loanIds = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            loanIds[i] = _positionsByToken[token].at(i);
        }
    }

    /// @notice Get the number of enumerable positions for a token
    /// @param token The token address
    /// @return count The number of positions
    function getPositionCount(address token) external view returns (uint256 count) {
        count = _positionsByToken[token].length();
    }

    /// @notice Get the original deposit amount for a position (for yield calculation)
    /// @dev Frontend can compute yield = withdrawnAmount - depositedAmount
    /// @param loanId The loan offer ID
    /// @param token  The token address
    /// @return amount The original deposit amount
    function getDepositedAmount(uint256 loanId, address token) external view returns (uint256 amount) {
        amount = depositedAmount[loanId][token];
    }

    /// @notice Get all configured market tokens (from Morpho optimizer marketsCreated[] pattern)
    /// @dev Enables frontend discovery of all active markets without scanning events
    /// @return tokens Array of token addresses with configured markets
    function getCreatedMarkets() external view returns (address[] memory tokens) {
        uint256 length = _marketsCreated.length();
        tokens = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            tokens[i] = _marketsCreated.at(i);
        }
    }

    /// @notice Get the number of configured markets
    /// @return count The number of markets in the registry
    function getMarketCount() external view returns (uint256 count) {
        count = _marketsCreated.length();
    }

    /// @notice Get total deposited assets for a market (for aggregate yield calculation)
    /// @dev Frontends can compute aggregate yield = totalWithdrawnAssets - totalDepositedAssets.
    ///      Inspired by Morpho optimizer's aggregate supply tracking in MorphoStorage.
    /// @param token The token address
    /// @return amount The total assets deposited across all active positions
    function getTotalDepositedAssets(address token) external view returns (uint256 amount) {
        amount = totalDepositedAssets[token];
    }

    /// @notice Estimate current asset value of a position (principal + unrealized yield)
    /// @dev Inspired by Morpho optimizer's RatesLens — frontends can display live PnL
    ///      without executing a withdrawal. Uses Morpho's previewRedeem for accuracy.
    /// @param loanId The loan offer ID
    /// @param token  The token address
    /// @return estimatedAssets The estimated assets if fully redeemed now
    /// @return deposited The original deposit amount (for yield = estimated - deposited)
    function estimatePositionValue(uint256 loanId, address token) external view returns (
        uint256 estimatedAssets,
        uint256 deposited
    ) {
        uint256 shares = sharesOf[loanId][token];
        deposited = depositedAmount[loanId][token];
        if (shares == 0) return (0, deposited);
        estimatedAssets = morpho.previewRedeem(markets[token], shares);
    }

    /// @notice Estimate total current value of all positions in a market
    /// @dev Aggregate version of estimatePositionValue for dashboard views.
    ///      Compares against totalDepositedAssets to show net yield across the market.
    /// @param token The token address
    /// @return estimatedTotal The estimated total assets if all positions redeemed now
    /// @return totalDeposited The total original deposits (yield = estimatedTotal - totalDeposited)
    function estimateMarketValue(address token) external view returns (
        uint256 estimatedTotal,
        uint256 totalDeposited
    ) {
        uint256 shares = totalShares[token];
        totalDeposited = totalDepositedAssets[token];
        if (shares == 0) return (0, totalDeposited);
        estimatedTotal = morpho.previewRedeem(markets[token], shares);
    }

    /// @notice Get full position info for a loan in a single call
    /// @dev Inspired by Morpho optimizer lens pattern — reduces RPC calls for frontends.
    ///      Combines sharesOf, depositedAmount, and active status.
    /// @param loanId The loan offer ID
    /// @param token  The token address
    /// @return shares The Morpho shares held
    /// @return deposited The original deposit amount
    /// @return isActive Whether the position has non-zero shares
    function getPositionInfo(uint256 loanId, address token) external view returns (
        uint256 shares,
        uint256 deposited,
        bool isActive
    ) {
        shares = sharesOf[loanId][token];
        deposited = depositedAmount[loanId][token];
        isActive = shares > 0;
    }

    /// @notice Get info for all configured markets in a single call
    /// @dev Inspired by Morpho optimizer lens contracts — batch query reduces RPC overhead.
    ///      Returns parallel arrays indexed by market. Gas cost bounded by MAX_NB_OF_MARKETS.
    /// @return tokens Array of token addresses
    /// @return _totalShares Array of total shares per market
    /// @return caps Array of deposit caps (0 = unlimited)
    /// @return _activePositions Array of active position counts
    /// @return pausedFlags Array of pause status flags
    /// @return frozenFlags Array of freeze status flags
    /// @return _totalDeposited Array of total deposited assets (for yield calculation)
    function getAllMarketsInfo() external view returns (
        address[] memory tokens,
        uint256[] memory _totalShares,
        uint256[] memory caps,
        uint256[] memory _activePositions,
        bool[] memory pausedFlags,
        bool[] memory frozenFlags,
        uint256[] memory _totalDeposited
    ) {
        uint256 length = _marketsCreated.length();
        tokens = new address[](length);
        _totalShares = new uint256[](length);
        caps = new uint256[](length);
        _activePositions = new uint256[](length);
        pausedFlags = new bool[](length);
        frozenFlags = new bool[](length);
        _totalDeposited = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            address token = _marketsCreated.at(i);
            tokens[i] = token;
            _totalShares[i] = totalShares[token];
            caps[i] = marketCap[token];
            _activePositions[i] = activePositions[token];
            pausedFlags[i] = marketPaused[token];
            frozenFlags[i] = marketFrozen[token];
            _totalDeposited[i] = totalDepositedAssets[token];
        }
    }

    /// @notice Get positions info for multiple loanIds in a single call
    /// @dev Batch version of getPositionInfo — reduces RPC calls when querying multiple positions.
    ///      Inspired by Morpho optimizer's UsersLens batch pattern.
    /// @param token   The token address
    /// @param loanIds Array of loan IDs to query
    /// @return shares Array of share balances
    /// @return deposited Array of deposited amounts
    function getBatchPositionInfo(address token, uint256[] calldata loanIds) external view returns (
        uint256[] memory shares,
        uint256[] memory deposited
    ) {
        uint256 length = loanIds.length;
        shares = new uint256[](length);
        deposited = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            shares[i] = sharesOf[loanIds[i]][token];
            deposited[i] = depositedAmount[loanIds[i]][token];
        }
    }
}
