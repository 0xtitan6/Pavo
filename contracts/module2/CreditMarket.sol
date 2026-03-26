// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/access/Ownable2Step.sol';
import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import './interfaces/ICreditMarket.sol';
import './interfaces/ILoanPositionToken.sol';
import './interfaces/IOrchestrator.sol';
import './libraries/ScaleFactorLib.sol';
import './libraries/CreditTypesLib.sol';
import './libraries/CreditErrors.sol';
import './libraries/CreditEvents.sol';

/// @title CreditMarket - Per-borrower undercollateralized credit facility
/// @notice Maps 1:1 to DAML Module2.Market template (8 choices)
/// @dev One CreditMarket deployed per borrower-asset pair via Orchestrator (CREATE2)
///      Custody-native RWA lending with Canton/DAML cross-platform state synchronization
///
///      Key Financial Invariants (matching DAML):
///        - scaleFactor >= RAY (starts at 1e27, only grows)
///        - borrower must maintain: totalAssets >= liquidityRequired
///        - liquidityRequired = pendingWithdrawals + unclaimedWithdrawals + reserve + fees
contract CreditMarket is ICreditMarket, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ScaleFactorLib for uint256;

    // ─── Immutables ────────────────────────────────────────────────────

    address public immutable override borrower;
    address public immutable override asset;
    bytes32 public immutable override marketId;
    ILoanPositionToken public positionToken;
    address public immutable orchestrator;

    // ─── State ─────────────────────────────────────────────────────────

    CreditTypesLib.MarketParameters internal _parameters;
    CreditTypesLib.CreditMarketState internal _state;

    // ─── Withdrawal Data ───────────────────────────────────────────────

    /// @dev FIFO queue of unpaid batch expiries
    uint32[] internal _unpaidBatches;

    /// @dev Batch expiry => batch data
    mapping(uint32 => WithdrawalBatch) internal _batches;

    /// @dev Batch expiry => account => withdrawal status
    mapping(uint32 => mapping(address => AccountWithdrawalStatus)) internal _accountStatuses;

    // Structs for withdrawal tracking (storage-compatible)
    struct WithdrawalBatch {
        uint104 scaledTotalAmount;
        uint104 scaledAmountBurned;
        uint128 normalizedAmountPaid;
    }

    struct AccountWithdrawalStatus {
        uint104 scaledAmount;
        uint128 normalizedAmountWithdrawn;
    }

    // ─── Modifiers ─────────────────────────────────────────────────────

    modifier onlyBorrower() {
        if (msg.sender != borrower) revert CreditErrors.UnauthorizedBorrower();
        _;
    }

    modifier onlyOrchestrator() {
        if (msg.sender != orchestrator) revert CreditErrors.UnauthorizedLender();
        _;
    }

    modifier notClosed() {
        if (_state.isClosed) revert CreditErrors.MarketClosed();
        _;
    }

    modifier notMatured() {
        if (_state.isMatured) revert CreditErrors.MarketMatured();
        if (_parameters.maturityDate != 0 && block.timestamp >= _parameters.maturityDate) {
            revert CreditErrors.MarketMatured();
        }
        _;
    }

    /// @dev Restricts access to the protocol operator (owner of the Orchestrator)
    modifier onlyProtocolOperator() {
        if (msg.sender != Ownable(orchestrator).owner()) revert CreditErrors.UnauthorizedBorrower();
        _;
    }

    // ─── Constructor ───────────────────────────────────────────────────

    /// @param _borrower The borrower for this market
    /// @param _asset The ERC-20 asset for deposits/borrows
    /// @param _positionToken The LPT ERC-20 for this market
    /// @param _orchestrator The Orchestrator contract that created this market
    /// @param params Market configuration parameters
    constructor(
        address _borrower,
        address _asset,
        address _positionToken,
        address _orchestrator,
        CreditTypesLib.MarketParameters memory params
    ) Ownable(msg.sender) {
        if (_borrower == address(0) || _asset == address(0)) revert CreditErrors.ZeroAddress();
        if (params.withdrawalBatchDuration == 0) revert CreditErrors.InvalidBatchDuration();
        if (params.maxDelinquencyPeriod == 0) revert CreditErrors.InvalidMaxDelinquencyPeriod();
        if (params.maturityDate != 0 && params.maturityDate <= block.timestamp) revert CreditErrors.InvalidMaturityDate();
        if (params.collateralRatioBps > 15000) revert CreditErrors.InvalidCollateralRatio();

        borrower = _borrower;
        asset = _asset;
        if (_positionToken != address(0)) {
            positionToken = ILoanPositionToken(_positionToken);
        }
        orchestrator = _orchestrator;
        marketId = keccak256(abi.encodePacked(_borrower, _asset));

        _parameters = params;

        // Initialize state with RAY scale factor
        _state.scaleFactor = ScaleFactorLib.toUint112(ScaleFactorLib.RAY);
        _state.lastInterestAccruedTimestamp = uint32(block.timestamp);
        _state.annualInterestBips = params.annualInterestBips;
        _state.delinquencyFeeBips = params.delinquencyFeeBips;
        _state.reserveRatioBips = params.reserveRatioBips;
        _state.protocolFeeBips = params.protocolFeeBips;
        _state.delinquencyGracePeriod = params.delinquencyGracePeriod;
        _state.maxDelinquencyPeriod = params.maxDelinquencyPeriod;
        _state.maxTotalSupply = params.maxTotalSupply;
    }

    /// @notice Set the position token address (callable once by orchestrator)
    /// @notice Sets the position token address after market deployment
    /// @dev Used during factory deployment to break the circular dependency
    ///      between CreditMarket and LoanPositionToken.
    /// @param _positionToken The LoanPositionToken address
    function setPositionToken(address _positionToken) external onlyOrchestrator {
        if (address(positionToken) != address(0)) revert CreditErrors.MarketAlreadyExists();
        if (_positionToken == address(0)) revert CreditErrors.ZeroAddress();
        positionToken = ILoanPositionToken(_positionToken);
    }

    // ─── View Functions ────────────────────────────────────────────────

    /// @notice Returns the current market state
    /// @return The CreditMarketState struct with scale factor, pending withdrawals, etc.
    function getState() external view override returns (CreditTypesLib.CreditMarketState memory) {
        return _state;
    }

    /// @notice Returns the market configuration parameters
    /// @return The MarketParameters struct with interest rates, durations, etc.
    function getParameters() external view override returns (CreditTypesLib.MarketParameters memory) {
        return _parameters;
    }

    /// @notice Returns the normalized total supply (deposits + accrued interest)
    /// @return The total value of all deposits in asset units
    function totalSupply() external view override returns (uint256) {
        return ScaleFactorLib.normalizeAmount(_state.scaledTotalSupply, _state.scaleFactor);
    }

    /// @notice Returns the amount available for borrowing
    /// @return The assets available minus liquidity requirements (reserves + pending withdrawals)
    function borrowableAssets() external view override returns (uint256) {
        uint256 totalAssets = IERC20(asset).balanceOf(address(this));
        uint256 required = _liquidityRequired();
        return ScaleFactorLib.satSub(totalAssets, required);
    }

    /// @notice Returns the minimum liquidity the borrower must maintain
    /// @return The sum of reserves, pending withdrawals, and protocol fees
    function liquidityRequired() external view override returns (uint256) {
        return _liquidityRequired();
    }

    /// @notice Returns whether the market is currently delinquent
    /// @return True if assets held are below required liquidity
    function isDelinquent() external view override returns (bool) {
        return _state.isDelinquent;
    }

    // ─── Core Operations (match DAML Market choices) ───────────────────

    /// @inheritdoc ICreditMarket
    function deposit(
        uint256 amount,
        address onBehalfOf
    ) external override nonReentrant notClosed notMatured returns (uint256 scaledAmount) {
        if (amount == 0) revert CreditErrors.ZeroAmount();
        if (!IOrchestrator(orchestrator).isKnownLender(address(this), onBehalfOf)) {
            revert CreditErrors.UnauthorizedLender();
        }

        // Accrue interest before state change
        _accrueInterest();

        // Check max supply
        uint256 normalizedSupply = ScaleFactorLib.normalizeAmount(
            _state.scaledTotalSupply,
            _state.scaleFactor
        );
        if (normalizedSupply + amount > _state.maxTotalSupply) {
            revert CreditErrors.DepositExceedsMaxSupply();
        }

        // Calculate scaled amount
        scaledAmount = ScaleFactorLib.scaleAmount(amount, _state.scaleFactor);
        uint104 scaledAmount104 = ScaleFactorLib.toUint104(scaledAmount);

        // Update state
        _state.scaledTotalSupply += scaledAmount104;

        // Transfer asset in
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        // Mint position tokens
        positionToken.mint(onBehalfOf, scaledAmount);

        emit CreditEvents.Deposit(address(this), onBehalfOf, amount, scaledAmount);
    }

    /// @inheritdoc ICreditMarket
    function borrow(uint256 amount) external override nonReentrant notClosed notMatured onlyBorrower {
        if (amount == 0) revert CreditErrors.ZeroAmount();
        if (_state.isLiquidating) revert CreditErrors.MarketLiquidating();

        _accrueInterest();

        uint256 totalAssets = IERC20(asset).balanceOf(address(this));
        uint256 required = _liquidityRequired();
        uint256 borrowable = ScaleFactorLib.satSub(totalAssets, required);

        if (amount > borrowable) revert CreditErrors.InsufficientBorrowableLiquidity();

        // Check credit limit at Orchestrator level (cross-market enforcement)
        IOrchestrator(orchestrator).checkAndRecordBorrow(address(this), amount);

        // Track outstanding debt (per-market)
        _state.totalBorrowed += ScaleFactorLib.toUint128(amount);

        // Transfer asset to borrower
        IERC20(asset).safeTransfer(borrower, amount);

        emit CreditEvents.Borrow(address(this), borrower, amount);
    }

    /// @inheritdoc ICreditMarket
    function repay(uint256 amount) external override nonReentrant notClosed {
        if (amount == 0) revert CreditErrors.ZeroAmount();
        if (amount > uint256(_state.totalBorrowed)) revert CreditErrors.RepayExceedsDebt();

        _accrueInterest();

        // Track debt reduction (per-market + Orchestrator level)
        _state.totalBorrowed -= ScaleFactorLib.toUint128(amount);
        IOrchestrator(orchestrator).recordRepayment(address(this), amount);

        // Transfer asset from repayer
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        // Check if delinquency resolved
        _updateDelinquencyStatus();

        emit CreditEvents.Repay(address(this), borrower, amount);
    }

    /// @inheritdoc ICreditMarket
    function requestWithdrawal(uint256 scaledAmount) external override nonReentrant notClosed {
        if (scaledAmount == 0) revert CreditErrors.ZeroAmount();

        _accrueInterest();

        // Determine batch expiry
        uint32 expiry = _state.pendingWithdrawalExpiry;
        if (expiry == 0 || block.timestamp >= expiry) {
            expiry = uint32(block.timestamp) + _parameters.withdrawalBatchDuration;
            _state.pendingWithdrawalExpiry = expiry;
        }

        // Update batch
        WithdrawalBatch storage batch = _batches[expiry];
        batch.scaledTotalAmount += ScaleFactorLib.toUint104(scaledAmount);

        // Update state
        _state.scaledPendingWithdrawals += ScaleFactorLib.toUint104(scaledAmount);

        // Track account status
        _accountStatuses[expiry][msg.sender].scaledAmount += ScaleFactorLib.toUint104(scaledAmount);

        // Burn position tokens from lender
        positionToken.burn(msg.sender, scaledAmount);

        uint256 normalizedAmount = ScaleFactorLib.normalizeAmount(scaledAmount, _state.scaleFactor);
        emit CreditEvents.WithdrawalRequested(address(this), msg.sender, normalizedAmount, expiry);
    }

    /// @inheritdoc ICreditMarket
    function processWithdrawalBatch() external override nonReentrant {
        uint32 expiry = _state.pendingWithdrawalExpiry;
        if (expiry == 0) revert CreditErrors.NoPendingWithdrawalBatch();
        if (block.timestamp < expiry) revert CreditErrors.WithdrawalBatchNotExpired();

        _accrueInterest();

        WithdrawalBatch storage batch = _batches[expiry];
        uint256 scaledOwed = uint256(batch.scaledTotalAmount) - uint256(batch.scaledAmountBurned);

        // Available liquidity for this batch
        uint256 totalAssets = IERC20(asset).balanceOf(address(this));
        uint256 unavailableAssets = _state.normalizedUnclaimedWithdrawals
            + _state.accruedProtocolFees;
        uint256 availableLiquidity = ScaleFactorLib.satSub(totalAssets, unavailableAssets);

        // Process: burn as much as available
        uint256 scaledLiquidity = ScaleFactorLib.scaleAmount(availableLiquidity, _state.scaleFactor);
        uint256 scaledBurned = ScaleFactorLib.min(scaledLiquidity, scaledOwed);
        uint256 normalizedPaid = ScaleFactorLib.normalizeAmount(scaledBurned, _state.scaleFactor);

        // Update batch
        batch.scaledAmountBurned += ScaleFactorLib.toUint104(scaledBurned);
        batch.normalizedAmountPaid += ScaleFactorLib.toUint128(normalizedPaid);

        // Update state
        _state.scaledPendingWithdrawals -= ScaleFactorLib.toUint104(scaledBurned);
        _state.scaledTotalSupply -= ScaleFactorLib.toUint104(scaledBurned);
        _state.normalizedUnclaimedWithdrawals += ScaleFactorLib.toUint128(normalizedPaid);

        // Track unpaid if any
        uint256 unpaid = scaledOwed - scaledBurned;
        if (unpaid > 0) {
            _unpaidBatches.push(expiry);
        }

        // Reset pending batch
        _state.pendingWithdrawalExpiry = 0;

        // Update delinquency status
        _updateDelinquencyStatus();

        uint256 normalizedUnpaid = ScaleFactorLib.normalizeAmount(unpaid, _state.scaleFactor);
        emit CreditEvents.WithdrawalBatchProcessed(
            address(this),
            expiry,
            normalizedPaid,
            normalizedUnpaid
        );
    }

    /// @inheritdoc ICreditMarket
    function claimWithdrawal(uint32 batchExpiry) external override nonReentrant returns (uint256 amount) {
        WithdrawalBatch storage batch = _batches[batchExpiry];
        AccountWithdrawalStatus storage status = _accountStatuses[batchExpiry][msg.sender];

        if (status.scaledAmount == 0) revert CreditErrors.ZeroAmount();
        if (batch.normalizedAmountPaid == 0) revert CreditErrors.ZeroAmount();

        // Calculate proportional share
        uint256 accountShare = uint256(status.scaledAmount) * batch.normalizedAmountPaid
            / batch.scaledTotalAmount;
        amount = accountShare - status.normalizedAmountWithdrawn;

        if (amount == 0) revert CreditErrors.ZeroAmount();

        // Update account status
        status.normalizedAmountWithdrawn += ScaleFactorLib.toUint128(amount);

        // Reduce unclaimed
        _state.normalizedUnclaimedWithdrawals -= ScaleFactorLib.toUint128(amount);

        // Transfer to lender
        IERC20(asset).safeTransfer(msg.sender, amount);

        emit CreditEvents.WithdrawalClaimed(address(this), msg.sender, amount);
    }

    /// @inheritdoc ICreditMarket
    function accrueInterest() external override nonReentrant {
        _accrueInterest();
    }

    /// @inheritdoc ICreditMarket
    function closeMarket() external override nonReentrant onlyBorrower {
        if (_state.scaledPendingWithdrawals > 0) revert CreditErrors.MarketNotClosed();

        _accrueInterest();
        _state.isClosed = true;

        emit CreditEvents.MarketClosed(address(this), borrower, _state.scaleFactor);
    }

    // ─── Margin Call & Liquidation ────────────────────────────────

    /// @notice Issues a margin call when borrower is delinquent past grace period
    /// @dev Only callable by owner (protocol operator)
    function marginCall() external onlyProtocolOperator nonReentrant {
        _accrueInterest();

        CreditTypesLib.CreditMarketState storage state = _state;

        // Must be delinquent
        if (!state.isDelinquent) revert CreditErrors.NotDelinquent();

        // Must be past grace period
        if (state.timeDelinquent < _parameters.delinquencyGracePeriod) {
            revert CreditErrors.NotDelinquent();
        }

        // Cannot issue if already liquidating
        if (state.isLiquidating) revert CreditErrors.MarketLiquidating();

        // Set margin call with 72-hour cure period
        uint32 curePeriod = 72 hours;
        state.marginCallTimestamp = uint32(block.timestamp);
        state.marginCallDeadline = uint32(block.timestamp) + curePeriod;

        // Calculate deficit
        uint256 totalAssets = IERC20(asset).balanceOf(address(this));
        uint256 required = _liquidityRequired();
        uint256 deficit = required > totalAssets ? required - totalAssets : 0;

        emit CreditEvents.MarginCallIssued(address(this), borrower, deficit, state.marginCallDeadline);
    }

    /// @notice Borrower cures a margin call by restoring market health
    /// @dev Must resolve delinquency (repay enough) before calling cure
    function cure() external nonReentrant {
        if (msg.sender != borrower) revert CreditErrors.UnauthorizedBorrower();

        _accrueInterest();

        CreditTypesLib.CreditMarketState storage state = _state;

        // Must have active margin call
        if (state.marginCallTimestamp == 0) revert CreditErrors.MarginCallNotActive();

        // Verify delinquency is resolved
        if (state.isDelinquent) revert CreditErrors.NotDelinquent();

        // Clear margin call
        state.marginCallTimestamp = 0;
        state.marginCallDeadline = 0;

        emit CreditEvents.MarginCallCured(address(this), borrower);
    }

    /// @notice Initiates liquidation after margin call deadline expires
    /// @dev Only callable by owner. Prevents new borrows.
    function liquidate() external onlyProtocolOperator nonReentrant {
        _accrueInterest();

        CreditTypesLib.CreditMarketState storage state = _state;

        // Must have active margin call
        if (state.marginCallTimestamp == 0) revert CreditErrors.MarginCallNotActive();

        // Deadline must have passed
        if (block.timestamp < state.marginCallDeadline) revert CreditErrors.MarginCallNotExpired();

        // Already liquidating?
        if (state.isLiquidating) revert CreditErrors.MarketLiquidating();

        // Set liquidating flag
        state.isLiquidating = true;

        emit CreditEvents.LiquidationInitiated(address(this), borrower, state.totalBorrowed);
    }

    // ─── Internal Functions ────────────────────────────────────────────

    /// @dev Core interest accrual — matches DAML Market.AccrueInterest choice
    function _accrueInterest() internal {
        uint256 timeDelta = block.timestamp - _state.lastInterestAccruedTimestamp;
        if (timeDelta == 0) return;

        (
            uint256 newScaleFactor,
            uint256 baseInterestRay,
            uint256 delinquencyFeeRay,
            uint256 protocolFee,
            uint256 newTimeDelinquent
        ) = ScaleFactorLib.updateScaleFactorAndFees(
            _state.scaleFactor,
            _state.annualInterestBips,
            _state.delinquencyFeeBips,
            _state.protocolFeeBips,
            _state.scaledTotalSupply,
            _state.isDelinquent,
            _state.timeDelinquent,
            _state.delinquencyGracePeriod,
            _state.maxDelinquencyPeriod,
            timeDelta
        );

        _state.scaleFactor = ScaleFactorLib.toUint112(newScaleFactor);
        _state.accruedProtocolFees += ScaleFactorLib.toUint128(protocolFee);
        _state.timeDelinquent = ScaleFactorLib.toUint32(newTimeDelinquent);
        _state.lastInterestAccruedTimestamp = uint32(block.timestamp);

        // Update delinquency status
        _updateDelinquencyStatus();

        emit CreditEvents.InterestAccrued(
            address(this),
            baseInterestRay,
            delinquencyFeeRay,
            protocolFee,
            newScaleFactor
        );
    }

    /// @dev Updates the isDelinquent flag based on current assets vs required
    ///      Emits DelinquencyStatusChanged if status changes
    function _updateDelinquencyStatus() internal {
        uint256 totalAssets = IERC20(asset).balanceOf(address(this));
        uint256 required = _liquidityRequired();
        bool wasDelinquent = _state.isDelinquent;
        _state.isDelinquent = totalAssets < required;

        if (wasDelinquent != _state.isDelinquent) {
            emit CreditEvents.DelinquencyStatusChanged(
                address(this),
                _state.isDelinquent,
                _state.timeDelinquent
            );
        }
    }

    /// @dev Calculates minimum liquidity required: reserves + pending withdrawals + fees
    /// @return The minimum assets the borrower must maintain
    function _liquidityRequired() internal view returns (uint256) {
        return ScaleFactorLib.liquidityRequired(
            _state.scaledTotalSupply,
            _state.scaledPendingWithdrawals,
            _state.normalizedUnclaimedWithdrawals,
            _state.accruedProtocolFees,
            _state.reserveRatioBips,
            _state.scaleFactor
        );
    }
}
