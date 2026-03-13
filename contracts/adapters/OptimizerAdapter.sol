// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @title OptimizerAdapter
/// @notice Earns yield on idle offer funds via ParthenonOptimizer (ERC-4626 vault) while offers await matching.
/// @dev Replaces MorphoAdapter as the primary IYieldAdapter implementation.
///      Follows the same patterns as MorphoAdapter (per-loanId share tracking, deposit caps, market
///      pause/freeze, emergency withdrawal) but delegates to the ERC-4626 optimizer vault instead
///      of directly to Morpho Blue.
///
///      Lifecycle:
///        createLoan  → deposit(token, amount, loanId)   — idle funds earn yield via optimizer
///        cancelLoan  → withdraw(token, loanId, owner)   — return funds + yield to creator
///        takeUpLoan  → withdraw(token, loanId, to)      — pull funds out for loan settlement
contract OptimizerAdapter is IYieldAdapter, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ========================================================================
    // CONSTANTS
    // ========================================================================

    uint256 public constant MAX_BATCH_SIZE = 50;

    // ========================================================================
    // STATE
    // ========================================================================

    /// @notice The LoanFactory contract — only caller allowed to deposit/withdraw
    address public immutable loanFactory;

    /// @notice token → IERC4626 optimizer vault for that token
    mapping(address => address) public optimizers;

    /// @notice token → whether an optimizer has been configured
    mapping(address => bool) public marketConfigured;

    /// @notice token → whether deposits are paused (withdrawals always allowed)
    mapping(address => bool) public marketPaused;

    /// @notice token → maximum total shares that can be deposited (0 = no cap)
    mapping(address => uint256) public marketCap;

    /// @notice token → whether the market is fully frozen
    mapping(address => bool) public marketFrozen;

    /// @notice token → total optimizer vault shares currently held
    mapping(address => uint256) public totalShares;

    /// @notice loanId → token → optimizer vault shares held for that offer
    mapping(uint256 => mapping(address => uint256)) public sharesOf;

    /// @notice token → number of active positions
    mapping(address => uint256) public activePositions;

    /// @notice Total active positions across all tokens
    uint256 public override totalActivePositions;

    /// @notice token → set of active loanIds
    mapping(address => EnumerableSet.UintSet) private _positionsByToken;

    /// @notice loanId → token → original deposit amount
    mapping(uint256 => mapping(address => uint256)) public depositedAmount;

    /// @notice token → total assets deposited
    mapping(address => uint256) public totalDepositedAssets;

    /// @notice Registry of all configured tokens
    EnumerableSet.AddressSet private _marketsCreated;

    // ========================================================================
    // EVENTS
    // ========================================================================

    event OptimizerConfigured(address indexed token, address indexed optimizer);
    event MarketPauseToggled(address indexed token, bool paused);
    event MarketCapSet(address indexed token, uint256 cap);
    event Deposited(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares);
    event Withdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to);
    event EmergencyWithdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to);
    event MarketFreezeToggled(address indexed token, bool frozen);
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

    /// @param _loanFactory LoanFactory address — only caller allowed to deposit/withdraw
    constructor(address _loanFactory) Ownable(msg.sender) {
        require(_loanFactory != address(0), "LoanFactory address cannot be zero");
        loanFactory = _loanFactory;
    }

    // ========================================================================
    // ADMIN — owner only
    // ========================================================================

    /// @notice Configure an optimizer vault for a given token.
    /// @dev Blocks reconfiguration when active positions exist. Validates optimizer.asset() == token.
    /// @param token     The asset token address
    /// @param optimizer The ERC-4626 optimizer vault for this token
    function configureOptimizer(address token, address optimizer) external onlyOwner {
        require(token != address(0), "Token cannot be zero");
        require(optimizer != address(0), "Optimizer cannot be zero");
        require(IERC4626(optimizer).asset() == token, "Optimizer asset mismatch");
        require(activePositions[token] == 0, "Active positions exist for token");

        if (!marketConfigured[token]) {
            _marketsCreated.add(token);
        }
        optimizers[token] = optimizer;
        marketConfigured[token] = true;
        emit OptimizerConfigured(token, optimizer);
    }

    /// @notice Pause or unpause deposits for a specific market.
    /// @param token  The asset token address
    /// @param paused Whether to pause (true) or unpause (false)
    function setMarketPaused(address token, bool paused) external onlyOwner {
        require(marketConfigured[token], "No optimizer for token");
        marketPaused[token] = paused;
        emit MarketPauseToggled(token, paused);
    }

    /// @notice Set a deposit cap (in optimizer vault shares) for a specific market.
    /// @param token The asset token address
    /// @param cap   Maximum total shares allowed (0 = no cap)
    function setMarketCap(address token, uint256 cap) external onlyOwner {
        require(marketConfigured[token], "No optimizer for token");
        marketCap[token] = cap;
        emit MarketCapSet(token, cap);
    }

    /// @notice Fully freeze or unfreeze a market (blocks both deposits and withdrawals when frozen).
    /// @param token  The asset token address
    /// @param frozen Whether to freeze (true) or unfreeze (false)
    function setMarketFrozen(address token, bool frozen) external onlyOwner {
        require(marketConfigured[token], "No optimizer for token");
        marketFrozen[token] = frozen;
        emit MarketFreezeToggled(token, frozen);
    }

    /// @notice Remove a market configuration when it has no active positions.
    /// @dev Requires zero active positions and zero outstanding shares.
    /// @param token The asset token address to deconfigure
    function deconfigureMarket(address token) external onlyOwner {
        require(marketConfigured[token], "No optimizer for token");
        require(activePositions[token] == 0, "Active positions exist for token");
        require(totalShares[token] == 0, "Outstanding shares exist");

        delete optimizers[token];
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

    /// @notice Deposit idle offer funds into the optimizer vault to earn yield.
    /// @dev Pulls tokens from LoanFactory via safeTransferFrom, deposits into ERC-4626 optimizer.
    /// @param token  The asset token address
    /// @param amount The amount of tokens to deposit
    /// @param loanId The loan ID to associate this deposit with
    function deposit(
        address token,
        uint256 amount,
        uint256 loanId
    ) external onlyLoanFactory nonReentrant {
        require(marketConfigured[token], "No optimizer for token");
        require(!marketFrozen[token], "Market frozen");
        require(!marketPaused[token], "Market deposits paused");
        require(amount > 0, "Amount must be > 0");

        address optimizer = optimizers[token];

        // Pull funds from LoanFactory
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Approve optimizer and deposit via ERC-4626
        IERC20(token).forceApprove(optimizer, amount);
        uint256 shares = IERC4626(optimizer).deposit(amount, address(this));
        require(shares > 0, "Deposit returned zero shares");

        // Clear residual approval
        IERC20(token).forceApprove(optimizer, 0);

        // Track position
        if (sharesOf[loanId][token] == 0) {
            activePositions[token]++;
            totalActivePositions++;
            _positionsByToken[token].add(loanId);
        }
        sharesOf[loanId][token] += shares;
        totalShares[token] += shares;
        depositedAmount[loanId][token] += amount;
        totalDepositedAssets[token] += amount;

        // Enforce cap
        uint256 cap = marketCap[token];
        require(cap == 0 || totalShares[token] <= cap, "Market deposit cap exceeded");

        emit Deposited(loanId, token, amount, shares);
    }

    /// @notice Withdraw offer funds (+ accrued yield) from the optimizer vault.
    /// @dev Follows CEI pattern: clears state before external redeem call.
    /// @param token  The asset token address
    /// @param loanId The loan ID to withdraw for
    /// @param to     The recipient address for withdrawn assets
    /// @return assets The amount of assets received from redemption
    function withdraw(
        address token,
        uint256 loanId,
        address to
    ) external onlyLoanFactory nonReentrant returns (uint256 assets) {
        require(to != address(0), "Recipient cannot be zero");
        require(!marketFrozen[token], "Market frozen");
        uint256 shares = sharesOf[loanId][token];
        require(shares > 0, "No position for loan");

        address optimizer = optimizers[token];

        // Clear state before external call (CEI)
        uint256 deposited = depositedAmount[loanId][token];
        sharesOf[loanId][token] = 0;
        depositedAmount[loanId][token] = 0;
        totalDepositedAssets[token] -= deposited;
        activePositions[token]--;
        totalActivePositions--;
        totalShares[token] -= shares;
        _positionsByToken[token].remove(loanId);

        // Redeem all shares via ERC-4626
        assets = IERC4626(optimizer).redeem(shares, to, address(this));
        require(assets > 0, "Withdrawal returned zero assets");

        emit Withdrawn(loanId, token, assets, shares, to);
    }

    // ========================================================================
    // ADMIN — emergency recovery
    // ========================================================================

    /// @notice Emergency withdraw all shares for a given loan position.
    /// @param token  The asset token address
    /// @param loanId The loan ID to emergency-withdraw
    /// @param to     The recipient address
    /// @return assets The amount of assets received
    function emergencyWithdraw(
        address token,
        uint256 loanId,
        address to
    ) external onlyOwner nonReentrant returns (uint256 assets) {
        require(to != address(0), "Recipient cannot be zero");
        uint256 shares = sharesOf[loanId][token];
        require(shares > 0, "No position for loan");

        address optimizer = optimizers[token];

        uint256 deposited = depositedAmount[loanId][token];
        sharesOf[loanId][token] = 0;
        depositedAmount[loanId][token] = 0;
        totalDepositedAssets[token] -= deposited;
        activePositions[token]--;
        totalActivePositions--;
        totalShares[token] -= shares;
        _positionsByToken[token].remove(loanId);

        assets = IERC4626(optimizer).redeem(shares, to, address(this));
        require(assets > 0, "Withdrawal returned zero assets");

        emit EmergencyWithdrawn(loanId, token, assets, shares, to);
    }

    /// @notice Batch emergency withdraw for multiple loan positions.
    /// @param token   The asset token address
    /// @param loanIds Array of loan IDs to withdraw (max MAX_BATCH_SIZE)
    /// @param to      The recipient address
    /// @return totalAssets_ Total assets received across all positions
    function batchEmergencyWithdraw(
        address token,
        uint256[] calldata loanIds,
        address to
    ) external onlyOwner nonReentrant returns (uint256 totalAssets_) {
        require(to != address(0), "Recipient cannot be zero");
        require(loanIds.length > 0, "Empty loanIds array");
        require(loanIds.length <= MAX_BATCH_SIZE, "Batch too large");

        address optimizer = optimizers[token];

        for (uint256 i = 0; i < loanIds.length; i++) {
            uint256 lid = loanIds[i];
            uint256 shares = sharesOf[lid][token];
            if (shares == 0) continue;

            uint256 deposited = depositedAmount[lid][token];
            sharesOf[lid][token] = 0;
            depositedAmount[lid][token] = 0;
            totalDepositedAssets[token] -= deposited;
            activePositions[token]--;
            totalActivePositions--;
            totalShares[token] -= shares;
            _positionsByToken[token].remove(lid);

            uint256 assets = IERC4626(optimizer).redeem(shares, to, address(this));
            require(assets > 0, "Withdrawal returned zero assets");
            totalAssets_ += assets;

            emit EmergencyWithdrawn(lid, token, assets, shares, to);
        }
        require(totalAssets_ > 0, "No assets withdrawn");
    }

    // ========================================================================
    // VIEW
    // ========================================================================

    /// @notice Check whether an optimizer is configured for a token.
    /// @param token The asset token address
    /// @return Whether the token has a configured optimizer
    function hasMarket(address token) external view returns (bool) {
        return marketConfigured[token];
    }

    /// @notice Get the optimizer vault shares held for a specific loan and token.
    /// @param loanId The loan ID
    /// @param token  The asset token address
    /// @return The number of optimizer vault shares held
    function getShares(uint256 loanId, address token) external view returns (uint256) {
        return sharesOf[loanId][token];
    }

    /// @notice Get all active loanIds for a given token.
    /// @param token The asset token address
    /// @return loanIds Array of active loan IDs deposited into this token's optimizer
    function getPositionsByToken(address token) external view returns (uint256[] memory loanIds) {
        uint256 length = _positionsByToken[token].length();
        loanIds = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            loanIds[i] = _positionsByToken[token].at(i);
        }
    }

    /// @notice Get all configured market tokens.
    /// @return tokens Array of token addresses with configured optimizers
    function getCreatedMarkets() external view returns (address[] memory tokens) {
        uint256 length = _marketsCreated.length();
        tokens = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            tokens[i] = _marketsCreated.at(i);
        }
    }

    /// @notice Estimate current asset value of a position via previewRedeem.
    /// @param loanId The loan ID
    /// @param token  The asset token address
    /// @return estimatedAssets Current estimated value of the position in assets
    /// @return deposited       Original amount deposited
    function estimatePositionValue(uint256 loanId, address token) external view returns (
        uint256 estimatedAssets,
        uint256 deposited
    ) {
        uint256 shares = sharesOf[loanId][token];
        deposited = depositedAmount[loanId][token];
        if (shares == 0) return (0, deposited);
        address optimizer = optimizers[token];
        estimatedAssets = IERC4626(optimizer).previewRedeem(shares);
    }

    /// @notice Get market utilization info for a given token.
    /// @param token The asset token address
    /// @return _totalShares      Total optimizer vault shares held
    /// @return _cap              Maximum shares allowed (0 = no cap)
    /// @return _activePositions  Number of active loan positions
    /// @return _paused           Whether deposits are paused
    /// @return _frozen           Whether the market is fully frozen
    /// @return _totalDeposited   Total assets originally deposited
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
}
