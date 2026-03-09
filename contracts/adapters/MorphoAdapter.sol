// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IMorpho.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MorphoAdapter
/// @notice Earns yield on idle lend/borrow offer funds via Morpho Blue while offers await matching.
/// @dev Two access tiers:
///      - owner (admin EOA): configures markets via configureMarket
///      - loanFactory: calls deposit/withdraw to move funds in/out of Morpho
///
///      Lifecycle:
///        createLoan  → deposit(token, amount, loanId)   — idle funds earn yield
///        cancelLoan  → withdraw(token, loanId, owner)   — return funds + yield to creator
///        takeUpLoan  → withdraw(token, loanId, to)      — pull funds out for loan settlement
contract MorphoAdapter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    /// @notice loanId → token → Morpho shares held for that offer
    mapping(uint256 => mapping(address => uint256)) public sharesOf;

    // ========================================================================
    // EVENTS
    // ========================================================================

    event MarketConfigured(address indexed token, MarketParams params);
    event Deposited(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares);
    event Withdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to);

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
        markets[token] = params;
        marketConfigured[token] = true;
        emit MarketConfigured(token, params);
    }

    // ========================================================================
    // CORE — LoanFactory only
    // ========================================================================

    /// @notice Deposit idle offer funds into Morpho Blue to earn yield
    /// @param token   The token being deposited (asset for lend offers, collateral for borrow)
    /// @param amount  The net amount (post-fee) to deposit
    /// @param loanId  The loan offer ID — used to track shares for later withdrawal
    function deposit(
        address token,
        uint256 amount,
        uint256 loanId
    ) external onlyLoanFactory nonReentrant {
        require(marketConfigured[token], "No Morpho market for token");
        require(amount > 0, "Amount must be > 0");

        MarketParams memory params = markets[token];

        // Pull funds from LoanFactory into this adapter
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Approve Morpho to spend
        IERC20(token).forceApprove(address(morpho), amount);

        // Supply to Morpho; track shares so yield accrues to this position
        (, uint256 shares) = morpho.supply(params, amount, 0, address(this), "");

        sharesOf[loanId][token] += shares;

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
        uint256 shares = sharesOf[loanId][token];
        require(shares > 0, "No position for loan");

        MarketParams memory params = markets[token];

        // Clear shares before external call (CEI)
        sharesOf[loanId][token] = 0;

        // Redeem all shares — assets returned include accrued yield
        (assets, ) = morpho.withdraw(params, 0, shares, address(this), to);

        emit Withdrawn(loanId, token, assets, shares, to);
    }

    // ========================================================================
    // VIEW
    // ========================================================================

    /// @notice Check whether a market is configured for a token
    function hasMarket(address token) external view returns (bool) {
        return marketConfigured[token];
    }
}
