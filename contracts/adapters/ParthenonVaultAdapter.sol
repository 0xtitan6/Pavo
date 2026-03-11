// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IBoringVault.sol";
import "../interfaces/IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ParthenonVaultAdapter
/// @notice Bridges Parthenon Boring Vaults (parthenonfi-vaults) to Parthenon lending.
/// @dev Routes idle lending/borrowing capital into a Boring Vault via the Teller's
///      bulkDeposit/bulkWithdraw interface to earn yield while offers await matching.
///
///      Implements IYieldAdapter so LoanFactory can use it interchangeably with MorphoAdapter.
///
///      Architecture:
///        ParthenonVaultAdapter → ITeller.bulkDeposit/bulkWithdraw → BoringVault
///        AccountantWithRateProviders provides share pricing for NAV calculations.
///
///      Access model:
///        - owner: configures vaults, emergency withdraw
///        - loanFactory: deposits/withdraws on behalf of loan offers
///
///      This adapter requires SOLVER_ROLE on the vault's RolesAuthority to call
///      bulkDeposit and bulkWithdraw on the Teller.
contract ParthenonVaultAdapter is IYieldAdapter, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ========================================================================
    // STRUCTS
    // ========================================================================

    /// @notice Configuration for a vault associated with an asset
    struct VaultConfig {
        IBoringVault vault;       // The BoringVault contract
        ITeller teller;           // The Teller (deposit/withdraw entrypoint)
        IAccountant accountant;   // The Accountant (exchange rate provider)
        bool enabled;             // Whether this vault is active
    }

    // ========================================================================
    // STATE
    // ========================================================================

    /// @notice The LoanFactory — only caller allowed to deposit/withdraw
    address public immutable loanFactory;

    /// @notice asset → VaultConfig mapping
    mapping(address => VaultConfig) public vaults;

    /// @notice loanId → token → vault shares held for that offer
    mapping(uint256 => mapping(address => uint256)) public sharesOf;

    /// @notice token → number of active positions (non-zero sharesOf entries)
    mapping(address => uint256) public activePositions;

    /// @notice Total active positions across all tokens (LOW-C8 fix)
    uint256 public override totalActivePositions;

    /// @notice Slippage tolerance in basis points (default 100 = 1%)
    uint256 public slippageBps = 100;

    /// @notice Basis points denominator
    uint256 private constant BPS = 10_000;

    // ========================================================================
    // EVENTS
    // ========================================================================

    event VaultConfigured(
        address indexed asset,
        address vault,
        address teller,
        address accountant
    );
    event VaultDisabled(address indexed asset);
    event SlippageUpdated(uint256 oldBps, uint256 newBps);
    event Deposited(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares);
    event Withdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to);
    event EmergencyWithdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to);

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

    /// @param _loanFactory The LoanFactory contract address
    constructor(address _loanFactory) Ownable(msg.sender) {
        require(_loanFactory != address(0), "LoanFactory address cannot be zero");
        loanFactory = _loanFactory;
    }

    // ========================================================================
    // ADMIN
    // ========================================================================

    /// @notice Configure a vault for a given asset
    /// @dev The adapter must have SOLVER_ROLE on the vault's RolesAuthority
    /// @param asset      The ERC-20 token this vault accepts
    /// @param vault      The BoringVault contract address
    /// @param teller     The TellerWithMultiAssetSupport address
    /// @param accountant The AccountantWithRateProviders address
    function configureVault(
        address asset,
        address vault,
        address teller,
        address accountant
    ) external onlyOwner {
        require(asset != address(0), "Asset cannot be zero");
        require(vault != address(0), "Vault cannot be zero");
        require(teller != address(0), "Teller cannot be zero");
        require(accountant != address(0), "Accountant cannot be zero");
        require(activePositions[asset] == 0, "Active positions exist for asset");

        // LOW-C9 Fix: Cross-validate that teller references the correct vault and accountant
        require(ITeller(teller).vault() == vault, "Teller vault mismatch");
        require(ITeller(teller).accountant() == accountant, "Teller accountant mismatch");

        vaults[asset] = VaultConfig({
            vault: IBoringVault(vault),
            teller: ITeller(teller),
            accountant: IAccountant(accountant),
            enabled: true
        });

        emit VaultConfigured(asset, vault, teller, accountant);
    }

    /// @notice Disable a vault for a given asset
    /// @param asset The ERC-20 token whose vault to disable
    function disableVault(address asset) external onlyOwner {
        require(vaults[asset].enabled, "Vault not configured");
        vaults[asset].enabled = false;
        emit VaultDisabled(asset);
    }

    /// @notice Update the slippage tolerance for deposits and withdrawals
    /// @param newSlippageBps New slippage tolerance in basis points (max 1000 = 10%)
    function setSlippageBps(uint256 newSlippageBps) external onlyOwner {
        require(newSlippageBps <= 1000, "Slippage too high");
        uint256 old = slippageBps;
        slippageBps = newSlippageBps;
        emit SlippageUpdated(old, newSlippageBps);
    }

    // ========================================================================
    // CORE — LoanFactory only (IYieldAdapter implementation)
    // ========================================================================

    /// @notice Deposit idle offer funds into the vault to earn yield
    /// @param token   The token being deposited
    /// @param amount  The net amount (post-fee) to deposit
    /// @param loanId  The loan offer ID — used to track shares for later withdrawal
    function deposit(
        address token,
        uint256 amount,
        uint256 loanId
    ) external override onlyLoanFactory nonReentrant {
        VaultConfig memory config = vaults[token];
        require(config.enabled, "No vault configured for asset");
        require(amount > 0, "Amount must be > 0");

        // Pull funds from LoanFactory
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Approve Teller to spend
        IERC20(token).forceApprove(address(config.teller), amount);

        // Checkpoint accrued interest before reading rate (ensures accuracy)
        try config.accountant.checkpoint() {} catch {}

        // MEDIUM-3 Fix: Calculate minimum acceptable shares using accountant rate
        uint256 rate = config.accountant.getRateInQuote(token);
        uint256 minimumMint = (rate > 0) ? (amount * 1e18 * (BPS - slippageBps)) / (rate * BPS) : 0;

        // Deposit via Teller's bulkDeposit (requires SOLVER_ROLE)
        uint256 shares = config.teller.bulkDeposit(token, amount, minimumMint, address(this));
        require(shares > 0, "Deposit returned zero shares");

        // LOW-8 Fix: Clear any residual approval (e.g. fee-on-transfer tokens)
        IERC20(token).forceApprove(address(config.teller), 0);

        // Track active positions for configureVault guard (LOW-5) and LOW-C8 global counter
        if (sharesOf[loanId][token] == 0) {
            activePositions[token]++;
            totalActivePositions++;
        }
        sharesOf[loanId][token] += shares;

        emit Deposited(loanId, token, amount, shares);
    }

    /// @notice Withdraw offer funds (+ accrued yield) from the vault
    /// @param token   The token to withdraw
    /// @param loanId  The loan offer ID whose shares are being redeemed
    /// @param to      Recipient of the withdrawn funds
    /// @return assets The actual amount of assets withdrawn (principal + yield)
    function withdraw(
        address token,
        uint256 loanId,
        address to
    ) external override onlyLoanFactory nonReentrant returns (uint256 assets) {
        require(to != address(0), "Recipient cannot be zero");
        uint256 shares = sharesOf[loanId][token];
        require(shares > 0, "No position for loan");

        // Clear shares before external call (CEI)
        sharesOf[loanId][token] = 0;
        activePositions[token]--;
        totalActivePositions--;

        // Checkpoint accrued interest before reading rate (ensures accuracy)
        VaultConfig memory config = vaults[token];
        try config.accountant.checkpoint() {} catch {}

        // MEDIUM-3 Fix: Calculate minimum acceptable assets using accountant rate
        uint256 rate = config.accountant.getRateInQuote(token);
        uint256 minimumAssets = (rate > 0) ? (shares * rate * (BPS - slippageBps)) / (1e18 * BPS) : 0;

        // Withdraw via Teller's bulkWithdraw — assets include accrued yield
        assets = config.teller.bulkWithdraw(token, shares, minimumAssets, to);
        require(assets > 0, "Withdrawal returned zero assets");

        emit Withdrawn(loanId, token, assets, shares, to);
    }

    /// @notice Check whether a vault is configured for a token
    /// @param token The token address to check
    /// @return True if a vault is configured and enabled for this token
    function hasMarket(address token) external view override returns (bool) {
        return vaults[token].enabled;
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

        VaultConfig memory config = vaults[token];

        sharesOf[loanId][token] = 0;
        activePositions[token]--;
        totalActivePositions--;

        // MEDIUM-3 Fix: Apply same slippage protection as regular withdraw
        uint256 rate = config.accountant.getRateInQuote(token);
        uint256 minimumAssets = (rate > 0) ? (shares * rate * (BPS - slippageBps)) / (1e18 * BPS) : 0;

        assets = config.teller.bulkWithdraw(token, shares, minimumAssets, to);
        require(assets > 0, "Withdrawal returned zero assets");

        emit EmergencyWithdrawn(loanId, token, assets, shares, to);
    }

    // ========================================================================
    // VIEW
    // ========================================================================

    /// @notice Preview the assets that would be received when redeeming a loan's shares
    /// @param loanId The loan offer ID
    /// @param token  The token address
    /// @return assets The expected asset amount (includes accrued yield)
    function previewWithdraw(uint256 loanId, address token) external view returns (uint256 assets) {
        uint256 shares = sharesOf[loanId][token];
        if (shares == 0 || !vaults[token].enabled) return 0;

        uint256 rate = vaults[token].accountant.getRateInQuote(token);
        assets = (shares * rate) / 1e18;
    }

    /// @notice Get the current share price of the vault for a token
    /// @param token The token address
    /// @return price The price of one vault share in asset units (18-decimal fixed point)
    function getSharePrice(address token) external view returns (uint256 price) {
        VaultConfig memory config = vaults[token];
        require(config.enabled, "No vault configured for asset");
        price = config.accountant.getRateInQuote(token);
    }
}
