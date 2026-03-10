// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/ILoanFactory.sol";
import "./interfaces/IAssetRegistry.sol";
import "./libraries/LoanCalculator.sol";
import "./PriceOracle.sol";
import "./adapters/MorphoAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Loan Factory Contract
/// @notice Factory for creating and managing peer-to-peer fixed-rate loans
/// @dev Implements the VeniceFi whitepaper lending protocol with Chainlink oracle integration
contract LoanFactory is ILoanFactory, ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ========================================================================
    // STATE VARIABLES
    // ========================================================================

    /// @notice Loan counter for unique ID generation
    uint256 private loanCounter;

    /// @notice The PriceOracle contract for Chainlink price feeds
    PriceOracle public immutable oracle;

    /// @notice The AssetRegistry for token whitelisting and pair validation
    IAssetRegistry public immutable assetRegistry;
    
    /// @notice Minimum loan value floor: 100 units in the asset's own decimals.
    ///         Compared against _asset (for lend offers) or collateralValue (for borrow offers)
    ///         after scaling by the asset's decimals at runtime, so it is asset-agnostic.
    uint256 public constant MIN_ASSET_UNITS = 100;

    /// @notice Basis points constants for collateral and liquidation thresholds
    uint256 public constant MIN_LIQUIDATION_THRESHOLD_BPS = 10000;     // 100%
    uint256 public constant MAX_LIQUIDATION_THRESHOLD_BPS = 15000;     // 150%
    uint256 public constant MIN_INITIAL_COLLATERAL_RATIO_BPS = 11000;  // 110%
    uint256 public constant MAX_INITIAL_COLLATERAL_RATIO_BPS = 50000;  // 500%
    
    /// @notice Duration options: 0=1 day, 1=7 days, 2=30 days, 3=90 days, 4=180 days, 5=365 days
    uint256[6] public DURATION_DAYS = [1, 7, 30, 90, 180, 365];

    /// @notice Interest rate options (basis points): 4%-11%
    uint256[8] public RATE_BPS = [400, 500, 600, 700, 800, 900, 1000, 1100];
    
    /// @notice Mapping of loan ID to Loan struct
    mapping(uint256 => Loan) public loans;

    /// @notice Protocol fee in basis points (e.g. 30 = 0.30%). Max 500 bps (5%).
    uint256 public protocolFeeBps;

    /// @notice Maximum protocol fee: 5%
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500;

    /// @notice Address that receives protocol fees
    address public feeRecipient;

    /// @notice Optional MorphoAdapter — if set, idle offer funds earn yield while waiting to be matched.
    ///         address(0) means no adapter (funds stay in LoanFactory as normal).
    MorphoAdapter public morphoAdapter;

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    /// @param _oracle The deployed PriceOracle contract address
    /// @param _assetRegistry The deployed AssetRegistry contract address
    /// @param _feeRecipient Address to receive protocol fees (can be zero to disable fees)
    /// @param _protocolFeeBps Protocol fee in basis points (0 = no fee, max 500 = 5%)
    constructor(
        address _oracle,
        address _assetRegistry,
        address _feeRecipient,
        uint256 _protocolFeeBps
    ) Ownable(msg.sender) {
        require(_oracle != address(0), "Oracle address cannot be zero");
        require(_assetRegistry != address(0), "AssetRegistry address cannot be zero");
        require(_protocolFeeBps <= MAX_PROTOCOL_FEE_BPS, "Fee exceeds maximum");
        oracle = PriceOracle(_oracle);
        assetRegistry = IAssetRegistry(_assetRegistry);
        feeRecipient = _feeRecipient;
        protocolFeeBps = _protocolFeeBps;
    }

    // ========================================================================
    // FEE ADMINISTRATION
    // ========================================================================

    /// @notice Emitted when the protocol fee rate is updated
    event ProtocolFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    /// @notice Update the protocol fee rate
    /// @param _feeBps New fee in basis points (max 500)
    function setProtocolFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= MAX_PROTOCOL_FEE_BPS, "Fee exceeds maximum");
        emit ProtocolFeeUpdated(protocolFeeBps, _feeBps);
        protocolFeeBps = _feeBps;
    }

    /// @notice Update the fee recipient address
    /// @param _recipient New recipient address
    function setFeeRecipient(address _recipient) external onlyOwner {
        // address(0) is valid — it disables fee collection (consistent with constructor)
        feeRecipient = _recipient;
    }

    /// @notice Set or unset the MorphoAdapter for idle yield
    /// @param _adapter MorphoAdapter address, or address(0) to disable
    function setMorphoAdapter(address _adapter) external onlyOwner {
        morphoAdapter = MorphoAdapter(_adapter);
    }

    // ========================================================================
    // PAUSE ADMINISTRATION — H-4 Fix
    // ========================================================================

    /// @notice Pause new loan creation and matching (emergency use only)
    /// @dev cancelLoan, endLoan, liquidateLoan, interruptLoan, topUp remain available
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause loan creation and matching
    function unpause() external onlyOwner {
        _unpause();
    }

    // ========================================================================
    // CREATE LOAN — Whitepaper eq. 33-34 (offer to lend) and eq. 40-41 (offer to borrow)
    // ========================================================================

    /// @notice Creates a new loan offer (lend or borrow)
    /// @param _asset The USDC amount of the loan
    /// @param _collateral The BTC amount of collateral
    /// @param _initialCollateralRatio The initial collateral-to-loan ratio (ρ in bps)
    /// @param _liquidationThreshold The liquidation threshold (c in bps)
    /// @param _assetAddress The token address for USDC
    /// @param _collateralAddress The token address for BTC (WBTC)
    /// @param _rateIndex The interest rate index (r)
    /// @param _durationIndex The duration index (d)
    /// @return id The ID of the created loan offer
    function createLoan(
        uint256 _asset,
        uint256 _collateral,
        uint256 _initialCollateralRatio,
        uint256 _liquidationThreshold,
        address _assetAddress,
        address _collateralAddress,
        uint8 _rateIndex,
        uint8 _durationIndex
    ) external override nonReentrant whenNotPaused returns (uint256) {

        // Validate duration (6 periods: 0-5)
        require(_durationIndex <= 5, "Invalid duration index");

        // Validate interest rate (8 rates: 0-7) 
        require(_rateIndex <= 7, "Invalid interest rate index");

        // Validate liquidation threshold bounds
        require(
            _liquidationThreshold >= MIN_LIQUIDATION_THRESHOLD_BPS && 
            _liquidationThreshold <= MAX_LIQUIDATION_THRESHOLD_BPS,
            "Invalid liquidation threshold"
        );

        // Validate initial collateral ratio bounds
        require(
            _initialCollateralRatio >= MIN_INITIAL_COLLATERAL_RATIO_BPS && 
            _initialCollateralRatio <= MAX_INITIAL_COLLATERAL_RATIO_BPS,
            "Invalid initial collateral ratio"
        );

        // M-1 Fix: Initial collateral ratio must exceed liquidation threshold
        require(
            _initialCollateralRatio > _liquidationThreshold,
            "Initial collateral ratio must exceed liquidation threshold"
        );

        // ── H-4 Fix: Validate tokens are whitelisted and the pair is supported ──
        require(
            assetRegistry.isValidPair(_collateralAddress, _assetAddress),
            "Unsupported collateral/asset pair"
        );

        Loan memory newLoan;
        uint256 id;

        // ── Offer to Lend (eq. 33-34): lender commits asset (stablecoin) ──
        if (_collateral == 0) {
            uint256 minAssetAmount = MIN_ASSET_UNITS * 10 ** IERC20Metadata(_assetAddress).decimals();
            require(_asset >= minAssetAmount, "Invalid offer parameters");

            IERC20 assetToken = IERC20(_assetAddress);
            newLoan.lender = msg.sender;
            newLoan.borrower = address(0);
            newLoan.s = Status.s1;
            id = ++loanCounter;

            // eq. 34: w_{t+1}[1] = w_t[1] - v  (commit asset)
            assetToken.safeTransferFrom(msg.sender, address(this), _asset);

            // Deduct protocol fee from asset; loan stores net amount
            if (protocolFeeBps > 0 && feeRecipient != address(0)) {
                uint256 fee = (_asset * protocolFeeBps) / 10000;
                _asset -= fee;
                assetToken.safeTransfer(feeRecipient, fee);
                emit FeeCollected(_assetAddress, feeRecipient, fee);
            }

            // Route net asset to Morpho if adapter is configured for this token
            if (address(morphoAdapter) != address(0) && morphoAdapter.hasMarket(_assetAddress)) {
                assetToken.forceApprove(address(morphoAdapter), _asset);
                morphoAdapter.deposit(_assetAddress, _asset, id);
            }
        }

        // ── Offer to Borrow (eq. 40-41): borrower commits collateral ──
        else if (_asset == 0) {
            // M-2 Fix: Enforce minimum collateral value (same 100-unit floor as lend offers)
            _requireCollateralAboveFloor(_collateral, _collateralAddress, _assetAddress);

            IERC20 collateralToken = IERC20(_collateralAddress);
            newLoan.borrower = msg.sender;
            newLoan.lender = address(0);
            newLoan.s = Status.s2;
            id = ++loanCounter;

            // eq. 41: w'_{t+1}[0] = w'_t[0] - z  (commit collateral)
            collateralToken.safeTransferFrom(msg.sender, address(this), _collateral);

            // Deduct protocol fee from collateral; loan stores net amount
            if (protocolFeeBps > 0 && feeRecipient != address(0)) {
                uint256 fee = (_collateral * protocolFeeBps) / 10000;
                _collateral -= fee;
                collateralToken.safeTransfer(feeRecipient, fee);
                emit FeeCollected(_collateralAddress, feeRecipient, fee);
            }

            // Route net collateral to Morpho if adapter is configured for this token
            if (address(morphoAdapter) != address(0) && morphoAdapter.hasMarket(_collateralAddress)) {
                collateralToken.forceApprove(address(morphoAdapter), _collateral);
                morphoAdapter.deposit(_collateralAddress, _collateral, id);
            }
        }

        else {
            revert("Invalid offer parameters");
        }

        // Store loan data
        newLoan.id = id;
        newLoan.startTime = 0;
        newLoan.asset = _asset;
        newLoan.collateral = _collateral;
        newLoan.initialCollateralRatio = _initialCollateralRatio;
        newLoan.liquidationThreshold = _liquidationThreshold;
        newLoan.assetAddress = _assetAddress;
        newLoan.collateralAddress = _collateralAddress;
        newLoan.rateIndex = _rateIndex;
        newLoan.durationIndex = _durationIndex;

        loans[id] = newLoan;
        
        emit Created(
            newLoan.id, 
            msg.sender, 
            newLoan.s == Status.s1 ? newLoan.asset : newLoan.collateral,
            newLoan.s,
            RATE_BPS[newLoan.rateIndex],
            DURATION_DAYS[newLoan.durationIndex]
        );

        return newLoan.id;
    }
    
    // ========================================================================
    // CANCEL LOAN — Whitepaper eq. 45-46 (cancel lend) and eq. 47-48 (cancel borrow)
    // ========================================================================

    /// @notice Cancel a loan offer and return funds
    /// @param id The ID of the loan to cancel
    function cancelLoan(uint256 id) external nonReentrant override {

        Loan storage loan = loans[id];

        require(loan.id == id && id != 0, "Loan does not exist");
        require(
            loan.lender == msg.sender || loan.borrower == msg.sender, 
            "Only loan creator can cancel"
        );

        // Read needed fields into locals before deleting
        Status previousStatus = loan.s;
        address assetAddress = loan.assetAddress;
        address collateralAddress = loan.collateralAddress;
        address lender_ = loan.lender;
        address borrower_ = loan.borrower;
        uint256 asset_ = loan.asset;
        uint256 collateral_ = loan.collateral;

        if (loan.s != Status.s1 && loan.s != Status.s2) {
            revert("Loan not in cancellable state");
        }

        // CEI: delete before external calls
        delete loans[id];

        // eq. 45-46: Cancel lend offer → return USDC (+ any Morpho yield) to lender
        if (previousStatus == Status.s1) {
            if (address(morphoAdapter) != address(0) && morphoAdapter.sharesOf(id, assetAddress) > 0) {
                morphoAdapter.withdraw(assetAddress, id, lender_);
            } else {
                IERC20(assetAddress).safeTransfer(lender_, asset_);
            }

        // eq. 47-48: Cancel borrow offer → return BTC (+ any Morpho yield) to borrower
        } else {
            if (address(morphoAdapter) != address(0) && morphoAdapter.sharesOf(id, collateralAddress) > 0) {
                morphoAdapter.withdraw(collateralAddress, id, borrower_);
            } else {
                IERC20(collateralAddress).safeTransfer(borrower_, collateral_);
            }
        }

        emit Cancelled(msg.sender, previousStatus);
    }

    // ========================================================================
    // TAKE UP LOAN — Whitepaper eq. 35-38 and eq. 42-44
    // ========================================================================

    /// @notice Take up a loan (borrower takes lender offer or lender takes borrower offer)
    /// @param takeUpId The ID of the taker's existing offer
    /// @param offerId The ID of the counterparty's offer
    function takeUpLoan(uint256 takeUpId, uint256 offerId) external nonReentrant whenNotPaused override {

        require(takeUpId != offerId, "IDs must differ");

        // ── Borrower takes up lend offer (eq. 35-38) ──
        if (loans[takeUpId].borrower == msg.sender && loans[takeUpId].borrower != loans[offerId].lender) {
            Loan storage borrowOffer = loans[takeUpId];
            Loan storage lendOffer = loans[offerId];

            require(
                borrowOffer.s == Status.s2 && lendOffer.s == Status.s1,
                "Invalid: borrowOffer must be s2 and lendOffer must be s1"
            );

            // M-6 Fix: Ensure both offers use the same asset (stablecoin)
            require(
                borrowOffer.assetAddress == lendOffer.assetAddress,
                "Offers must use the same asset token"
            );

            // eq. 39: ϕ_{t0}(z) > max(ρv, cv) — validate collateral via Chainlink
            // H-2 Fix: Use unchecked oracle so a market crash doesn't block takeUpLoan
            uint8 assetDec = IERC20Metadata(lendOffer.assetAddress).decimals();
            uint256 collateralValue = LoanCalculator.getOraclePriceUnchecked(
                borrowOffer.collateral,
                borrowOffer.collateralAddress,
                assetDec,
                oracle
            );

            uint256 requiredForInitialRatio = (lendOffer.initialCollateralRatio * lendOffer.asset) / 10000;
            uint256 requiredForLiquidation = (lendOffer.liquidationThreshold * lendOffer.asset) / 10000;

            require(
                collateralValue > Math.max(requiredForInitialRatio, requiredForLiquidation),
                "Collateral insufficient: phi(z) must be > max(rho*v, c*v)"
            );

            // eq. 36: w'_{t+1}[1] = w'_t[1] + v  (borrower receives asset)
            // If lend offer funds are in Morpho, withdraw directly to borrower (principal + yield)
            address lendAsset = lendOffer.assetAddress;
            address borrowerAddr = borrowOffer.borrower;
            if (address(morphoAdapter) != address(0) && morphoAdapter.sharesOf(offerId, lendAsset) > 0) {
                morphoAdapter.withdraw(lendAsset, offerId, borrowerAddr);
            } else {
                IERC20(lendAsset).safeTransfer(borrowerAddr, lendOffer.asset);
            }

            // If borrow offer collateral is in Morpho, withdraw back into LoanFactory for active loan
            address collateralAsset = borrowOffer.collateralAddress;
            if (address(morphoAdapter) != address(0) && morphoAdapter.sharesOf(takeUpId, collateralAsset) > 0) {
                morphoAdapter.withdraw(collateralAsset, takeUpId, address(this));
            }

            // eq. 38: Transform lend offer → active loan contract
            lendOffer.borrower = borrowerAddr;
            lendOffer.collateral = borrowOffer.collateral;
            lendOffer.collateralAddress = collateralAsset;
            lendOffer.startTime = block.timestamp;
            lendOffer.s = Status.s3;

            emit TakeUp(lendOffer.borrower, lendOffer.lender);
            // M-3 Fix: Signal to indexers that the taker's offer was consumed (not still open)
            emit Cancelled(msg.sender, Status.s2);

        // ── Lender takes up borrow offer (eq. 42-44) ──
        } else if (loans[takeUpId].lender == msg.sender && loans[takeUpId].lender != loans[offerId].borrower) {

            Loan storage lendOffer = loans[takeUpId];
            Loan storage borrowOffer = loans[offerId];

            require(
                lendOffer.s == Status.s1 && borrowOffer.s == Status.s2,
                "Invalid: lendOffer must be s1 and borrowOffer must be s2"
            );

            // M-6 Fix: Ensure both offers use the same asset (stablecoin)
            require(
                lendOffer.assetAddress == borrowOffer.assetAddress,
                "Offers must use the same asset token"
            );

            // eq. 39: ϕ_{t0}(z) > max(ρv, cv) — validate collateral via Chainlink
            // H-2 Fix: Use unchecked oracle so a market crash doesn't block takeUpLoan
            uint8 assetDec2 = IERC20Metadata(lendOffer.assetAddress).decimals();
            uint256 collateralValue2 = LoanCalculator.getOraclePriceUnchecked(
                borrowOffer.collateral,
                borrowOffer.collateralAddress,
                assetDec2,
                oracle
            );

            uint256 requiredForInitialRatio = (borrowOffer.initialCollateralRatio * lendOffer.asset) / 10000;
            uint256 requiredForLiquidation = (borrowOffer.liquidationThreshold * lendOffer.asset) / 10000;

            require(
                collateralValue2 > Math.max(requiredForInitialRatio, requiredForLiquidation),
                "Collateral insufficient: phi(z) must be > max(rho*v, c*v)"
            );

            // eq. 43-44: lender sends asset, borrower receives asset
            // If lend offer funds are in Morpho, withdraw directly to borrower (principal + yield)
            address lendAsset2 = lendOffer.assetAddress;
            address borrowerAddr2 = borrowOffer.borrower;
            if (address(morphoAdapter) != address(0) && morphoAdapter.sharesOf(takeUpId, lendAsset2) > 0) {
                morphoAdapter.withdraw(lendAsset2, takeUpId, borrowerAddr2);
            } else {
                IERC20(lendAsset2).safeTransfer(borrowerAddr2, lendOffer.asset);
            }

            // If borrow offer collateral is in Morpho, withdraw back into LoanFactory for active loan
            address collateralAsset2 = borrowOffer.collateralAddress;
            if (address(morphoAdapter) != address(0) && morphoAdapter.sharesOf(offerId, collateralAsset2) > 0) {
                morphoAdapter.withdraw(collateralAsset2, offerId, address(this));
            }

            // Transform borrow offer → active loan contract
            borrowOffer.lender = lendOffer.lender;
            borrowOffer.startTime = block.timestamp;
            borrowOffer.asset = lendOffer.asset;
            borrowOffer.assetAddress = lendOffer.assetAddress;
            borrowOffer.s = Status.s3;

            emit TakeUp(borrowOffer.borrower, borrowOffer.lender);
            // M-3 Fix: Signal to indexers that the taker's offer was consumed (not still open)
            emit Cancelled(msg.sender, Status.s1);
        }

        else {
            revert("Unauthorized caller");
        }  

        // Delete the taker's offer as it's been consumed
        delete loans[takeUpId];
    }

    // ========================================================================
    // LIQUIDATE — Whitepaper eq. 56-58
    // ========================================================================

    /// @notice Liquidates loan if health falls below threshold
    /// @dev eq. 58: ϕ_t(z) / ((1+r)^t * v) < c → lender claims all collateral
    /// @param id The ID of the loan to liquidate
    function liquidateLoan(uint256 id) external nonReentrant override {
        Loan storage loan = loans[id];
        
        require(
            loan.id == id && id != 0 && loan.s == Status.s3,
            "Loan not found or inactive"
        );

        // C-2 Fix: Prevent lender from liquidating after maturity (must use endLoan for fair split)
        uint256 maturityTime = loan.startTime + (DURATION_DAYS[loan.durationIndex] * 86400);
        require(block.timestamp < maturityTime, "Loan matured: use endLoan");
        
        // M-5 Fix: Calculate hours elapsed for smooth health decay (was days)
        uint256 hoursElapsed = (block.timestamp - loan.startTime) / 3600;
        
        // eq. 58: Calculate health score — unchecked so a price crash never blocks liquidation
        uint8 assetDecimals = IERC20Metadata(loan.assetAddress).decimals();
        uint256 currentHealthScore = LoanCalculator.calculateHealthScoreUnchecked(
            loan.collateral,
            loan.asset,
            RATE_BPS[loan.rateIndex],
            hoursElapsed,
            loan.collateralAddress,
            assetDecimals,
            oracle
        );

        // eq. 58: ϕ_t(z) / ((1+r)^t * v) < c
        require(currentHealthScore < loan.liquidationThreshold, "Health above liquidation threshold");

        // Read before delete
        address collateralAddress_ = loan.collateralAddress;
        address lender_ = loan.lender;
        uint256 collateral_ = loan.collateral;

        // CEI: delete before external calls
        delete loans[id];

        // eq. 57: w_{t+1}[0] = w_t[0] + z  (lender claims all BTC collateral)
        IERC20(collateralAddress_).safeTransfer(lender_, collateral_);

        emit Liquidated(msg.sender);
    }

    // ========================================================================
    // END LOAN — Whitepaper eq. 53-55 (natural maturity)
    // ========================================================================

    /// @notice End a loan at maturity, split BTC between lender and borrower
    /// @dev eq. 54: min{ϕ^(-1)((1+r)^d·v), z} to lender
    ///      eq. 55: max{z - ϕ^(-1)((1+r)^d·v), 0} to borrower
    /// @param id The ID of the loan to end
    function endLoan(uint256 id) external nonReentrant override {
        Loan storage loan = loans[id];
        
        require(
            loan.s == Status.s3 && loan.id == id && id != 0,
            "Loan not found or inactive"
        );
        
        // Check loan has matured
        uint256 maturityTime = loan.startTime + (DURATION_DAYS[loan.durationIndex] * 86400);
        require(block.timestamp >= maturityTime, "Loan has not matured yet");
        
        // eq. 54-55: Single oracle call — unchecked so matured loans are always settleable
        uint8 assetDecimals = IERC20Metadata(loan.assetAddress).decimals();
        uint256 excessCollateral = LoanCalculator.calculateExcessCollateralUnchecked(
            loan.asset,
            RATE_BPS[loan.rateIndex],
            DURATION_DAYS[loan.durationIndex],
            loan.collateral,
            loan.collateralAddress,
            assetDecimals,
            oracle
        );
        uint256 collateralPayout = loan.collateral - excessCollateral;

        // Read before delete
        address collateralAddress_ = loan.collateralAddress;
        address lender_ = loan.lender;
        address borrower_ = loan.borrower;

        // CEI: delete before external calls
        delete loans[id];

        IERC20 collateralToken = IERC20(collateralAddress_);

        // eq. 54: Transfer collateral payout to lender
        if (collateralPayout > 0) {
            collateralToken.safeTransfer(lender_, collateralPayout);
        }

        // eq. 55: Transfer excess collateral to borrower
        if (excessCollateral > 0) {
            collateralToken.safeTransfer(borrower_, excessCollateral);
        }

        emit Ended(msg.sender);
    }

    // ========================================================================
    // INTERRUPT LOAN — Whitepaper eq. 49-52 (early repayment)
    // ========================================================================

    /// @notice Borrower ends loan early, pays full-term interest in USDC
    /// @dev eq. 50-51: borrower pays (1+r)^d * v in USDC
    ///      eq. 52: borrower gets back full BTC collateral z
    /// @param id The ID of the loan to interrupt
    function interruptLoan(uint256 id) external nonReentrant override {
        Loan storage loan = loans[id];
        
        require(
            loan.s == Status.s3 && loan.borrower == msg.sender, 
            "Loan not found, inactive, or unauthorized"
        );

        uint256 maturityTime = loan.startTime + (DURATION_DAYS[loan.durationIndex] * 86400);
        require(block.timestamp < maturityTime, "Loan has already matured");
        
        // eq. 50: (1+r)^d * v — full-term interest even for early repayment
        uint256 totalRepayment = LoanCalculator.calculateTotalRepayment(
            loan.asset, RATE_BPS[loan.rateIndex], DURATION_DAYS[loan.durationIndex]
        );

        // Read before delete
        address assetAddress_ = loan.assetAddress;
        address collateralAddress_ = loan.collateralAddress;
        address lender_ = loan.lender;
        address borrower_ = loan.borrower;
        uint256 collateral_ = loan.collateral;

        // CEI: delete before external calls
        delete loans[id];

        // eq. 50-51: Borrower pays full repayment directly to lender
        // M-5 Fix: Pull from msg.sender explicitly (== borrower_, but safer for future delegation/proxy patterns)
        IERC20(assetAddress_).safeTransferFrom(msg.sender, lender_, totalRepayment);

        // eq. 52: Return full BTC collateral to borrower
        IERC20(collateralAddress_).safeTransfer(borrower_, collateral_);

        emit Interrupted(borrower_);
    }

    // ========================================================================
    // TOP UP — Whitepaper eq. 59-60
    // ========================================================================

    /// @notice Borrower adds collateral to improve loan health
    /// @dev eq. 59-60: z → z + ε, borrower commits ε BTC
    /// @param id The ID of the loan to top up
    /// @param additionalCollateral The additional BTC amount ε
    function topUp(uint256 id, uint256 additionalCollateral) external nonReentrant override {
        Loan storage loan = loans[id];
        
        require(
            loan.s == Status.s3 && loan.borrower == msg.sender, 
            "Loan not found, inactive, or unauthorized"
        );

        require(additionalCollateral > 0, "Additional collateral must be > 0");

        // eq. 60: w'_{t+1}[0] = w'_t[0] - ε  (borrower commits BTC) — transfer first (CEI)
        IERC20 collateralToken = IERC20(loan.collateralAddress);
        collateralToken.safeTransferFrom(loan.borrower, address(this), additionalCollateral);

        // eq. 59: z → z + ε — update state after transfer
        loan.collateral += additionalCollateral;

        emit ToppedUp(loan.borrower);
    }

    // ========================================================================
    // INTERNAL HELPERS
    // ========================================================================

    /// @dev Checks that the collateral's current market value meets the 100-unit floor.
    ///      Extracted into a private function to avoid stack-too-deep in createLoan.
    function _requireCollateralAboveFloor(
        uint256 collateral,
        address collateralAddress,
        address assetAddress
    ) private {
        uint8 assetDecimals = IERC20Metadata(assetAddress).decimals();
        uint256 collateralValue = LoanCalculator.getOraclePrice(
            collateral, collateralAddress, assetDecimals, oracle
        );
        require(
            collateralValue >= MIN_ASSET_UNITS * 10 ** assetDecimals,
            "Collateral value too low"
        );
    }
}