// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/access/Ownable2Step.sol';
import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

import './interfaces/IOrchestrator.sol';
import './interfaces/ICreditMarket.sol';
import './CreditMarket.sol';
import './LoanPositionToken.sol';
import './libraries/CreditTypesLib.sol';
import './libraries/CreditErrors.sol';
import './libraries/CreditEvents.sol';
import './interfaces/ISanctionsSentinel.sol';

/// @title Orchestrator - Central governance for undercollateralized lending
/// @notice Maps to DAML Module2.BorrowerAuthorization + market creation factory
/// @dev IEU-first design: all authorization, tier management, and market creation
///      flows through this single contract.
contract Orchestrator is IOrchestrator, Ownable2Step, ReentrancyGuard {
    // ─── State ─────────────────────────────────────────────────────────

    /// @notice Protocol fee recipient
    address public override protocolFeeRecipient;

    /// @notice Borrower address => authorization data
    mapping(address => CreditTypesLib.BorrowerAuth) internal _borrowerAuths;

    /// @notice Borrower => asset => market address
    mapping(address => mapping(address => address)) internal _markets;

    /// @notice Market => lender => is known
    mapping(address => mapping(address => bool)) internal _knownLenders;

    /// @notice Market address => borrower address (reverse lookup)
    mapping(address => address) internal _marketBorrower;

    /// @notice TICS bridge address (optional, set post-deployment)
    address public ticsBridge;

    /// @notice Sanctions sentinel address (optional, set post-deployment)
    address public sanctionsSentinel;

    /// @notice Price feed adapter address (optional, set post-deployment)
    address public priceFeedAdapter;

    // ─── Constructor ───────────────────────────────────────────────────

    constructor(address _feeRecipient) Ownable(msg.sender) {
        if (_feeRecipient == address(0)) revert CreditErrors.ZeroAddress();
        protocolFeeRecipient = _feeRecipient;
    }

    // ─── Borrower Management (match DAML BorrowerAuthorization choices) ─

    /// @notice Authorizes a borrower with a specific credit tier
    /// @param borrowerAddr The address of the borrower to authorize
    /// @param tier The credit tier (TIER_1 through TIER_4) determining max credit limit
    function authorizeBorrower(
        address borrowerAddr,
        CreditTypesLib.CreditTier tier
    ) external override onlyOwner {
        if (borrowerAddr == address(0)) revert CreditErrors.ZeroAddress();
        _checkSanctions(borrowerAddr);

        CreditTypesLib.BorrowerAuth storage auth = _borrowerAuths[borrowerAddr];
        auth.status = CreditTypesLib.BorrowerStatus.Approved;
        auth.tier = tier;
        auth.creditLimit = CreditTypesLib.tierToLimit(tier);
        auth.kycVerifiedAt = uint64(block.timestamp);

        emit CreditEvents.BorrowerAuthorized(borrowerAddr, uint8(tier));
    }

    /// @notice Updates a borrower's credit tier and credit limit
    /// @param borrowerAddr The borrower address
    /// @param newTier The new credit tier
    function updateCreditTier(
        address borrowerAddr,
        CreditTypesLib.CreditTier newTier
    ) external override onlyOwner {
        CreditTypesLib.BorrowerAuth storage auth = _borrowerAuths[borrowerAddr];
        if (auth.status != CreditTypesLib.BorrowerStatus.Approved) {
            revert CreditErrors.BorrowerNotApproved();
        }

        uint8 oldTier = uint8(auth.tier);
        auth.tier = newTier;
        auth.creditLimit = CreditTypesLib.tierToLimit(newTier);

        emit CreditEvents.CreditTierUpdated(borrowerAddr, oldTier, uint8(newTier));
    }

    /// @notice Suspends a borrower, preventing them from creating new markets
    /// @param borrowerAddr The borrower address to suspend
    function suspendBorrower(address borrowerAddr) external override onlyOwner {
        CreditTypesLib.BorrowerAuth storage auth = _borrowerAuths[borrowerAddr];
        auth.status = CreditTypesLib.BorrowerStatus.Suspended;

        emit CreditEvents.BorrowerSuspended(borrowerAddr, "Admin suspension");
    }

    /// @notice Reactivates a suspended borrower
    /// @param borrowerAddr The borrower address to reactivate
    function reactivateBorrower(address borrowerAddr) external override onlyOwner {
        CreditTypesLib.BorrowerAuth storage auth = _borrowerAuths[borrowerAddr];
        if (auth.kycVerifiedAt == 0) revert CreditErrors.BorrowerNotApproved();
        auth.status = CreditTypesLib.BorrowerStatus.Approved;

        emit CreditEvents.BorrowerReactivated(borrowerAddr);
    }

    // ─── Market Creation (match DAML BorrowerAuthorization.CreateMarket) ─

    /// @notice Creates a new credit market for a borrower-asset pair
    /// @param borrowerAddr The borrower address
    /// @param assetAddr The ERC-20 asset address
    /// @param params Market configuration parameters (interest rate, reserve ratio, etc.)
    /// @return market The address of the newly created CreditMarket
    function createMarket(
        address borrowerAddr,
        address assetAddr,
        CreditTypesLib.MarketParameters calldata params
    ) external override onlyOwner nonReentrant returns (address market) {
        // Validate borrower
        CreditTypesLib.BorrowerAuth storage auth = _borrowerAuths[borrowerAddr];
        if (auth.status != CreditTypesLib.BorrowerStatus.Approved) {
            revert CreditErrors.BorrowerNotApproved();
        }
        if (_markets[borrowerAddr][assetAddr] != address(0)) {
            revert CreditErrors.MarketAlreadyExists();
        }

        // Validate parameters
        if (params.annualInterestBips > 10000) revert CreditErrors.InvalidInterestRate();
        if (params.reserveRatioBips > 5000) revert CreditErrors.InvalidReserveRatio();
        if (params.withdrawalBatchDuration == 0) revert CreditErrors.InvalidBatchDuration();
        if (params.maxDelinquencyPeriod == 0) revert CreditErrors.InvalidMaxDelinquencyPeriod();
        if (params.collateralRatioBps > 15000) revert CreditErrors.InvalidCollateralRatio();
        if (params.maturityDate != 0 && params.maturityDate <= block.timestamp) {
            revert CreditErrors.InvalidMaturityDate();
        }

        // Deploy CreditMarket first (positionToken set to address(0) initially)
        CreditMarket creditMarket = new CreditMarket(
            borrowerAddr,
            assetAddr,
            address(0), // Position token set after deployment
            address(this),
            params
        );
        market = address(creditMarket);

        // Deploy LoanPositionToken with actual market address
        string memory lptName = string(abi.encodePacked("LPT-", _toHexString(market)));
        LoanPositionToken lpt = new LoanPositionToken(lptName, "LPT", market, address(this));

        // Wire position token into market
        creditMarket.setPositionToken(address(lpt));

        // Register market
        _markets[borrowerAddr][assetAddr] = market;
        _marketBorrower[market] = borrowerAddr;

        emit CreditEvents.MarketCreated(
            market,
            borrowerAddr,
            assetAddr,
            params.annualInterestBips,
            params.reserveRatioBips
        );
    }

    // ─── Lender Management ─────────────────────────────────────────────

    /// @inheritdoc IOrchestrator
    function registerLender(address market, address lender) external override onlyOwner {
        if (lender == address(0)) revert CreditErrors.ZeroAddress();
        _checkSanctions(lender);
        _knownLenders[market][lender] = true;
        emit CreditEvents.LenderRegistered(market, lender);
    }

    /// @notice Removes a lender from the known lenders list
    /// @param market The market address
    /// @param lender The lender address to remove
    function removeLender(address market, address lender) external override onlyOwner {
        _knownLenders[market][lender] = false;
        emit CreditEvents.LenderRemoved(market, lender);
    }

    // ─── View Functions ────────────────────────────────────────────────

    /// @notice Returns the borrower authorization record
    /// @param borrowerAddr The borrower address
    /// @return The BorrowerAuth struct with tier, credit limit, etc.
    function getBorrowerAuth(
        address borrowerAddr
    ) external view override returns (CreditTypesLib.BorrowerAuth memory) {
        return _borrowerAuths[borrowerAddr];
    }

    /// @notice Checks if an address is a known lender for a market
    /// @param market The market address
    /// @param lender The address to check
    /// @return True if the address is a registered lender
    function isKnownLender(address market, address lender) external view override returns (bool) {
        return _knownLenders[market][lender];
    }

    /// @notice Returns the market address for a borrower-asset pair
    /// @param borrowerAddr The borrower address
    /// @param assetAddr The asset address
    /// @return The market address or zero if not exists
    function getMarket(address borrowerAddr, address assetAddr) external view override returns (address) {
        return _markets[borrowerAddr][assetAddr];
    }

    // ─── Credit Limit Enforcement (called by CreditMarket) ────────────

    /// @notice Verifies borrow is within credit limit and records the debt
    /// @dev Called by CreditMarket before executing a borrow
    /// @param market The market requesting the check
    /// @param amount The amount to borrow
    function checkAndRecordBorrow(address market, uint256 amount) external override {
        address borrowerAddr = _marketBorrower[market];
        if (borrowerAddr == address(0) || msg.sender != market) {
            revert CreditErrors.UnauthorizedBorrower();
        }
        CreditTypesLib.BorrowerAuth storage auth = _borrowerAuths[borrowerAddr];
        uint256 normalized = _normalizeTo18(market, amount);
        uint256 newTotal = uint256(auth.totalBorrowed) + normalized;
        if (newTotal > uint256(auth.creditLimit)) {
            revert CreditErrors.CreditLimitExceeded();
        }
        auth.totalBorrowed = uint128(newTotal);
    }

    /// @notice Records a repayment, reducing the borrower's total borrowed
    /// @dev Called by CreditMarket after a successful repay
    /// @param market The market requesting the record
    /// @param amount The amount being repaid
    function recordRepayment(address market, uint256 amount) external override {
        address borrowerAddr = _marketBorrower[market];
        if (borrowerAddr == address(0) || msg.sender != market) {
            revert CreditErrors.UnauthorizedBorrower();
        }
        CreditTypesLib.BorrowerAuth storage auth = _borrowerAuths[borrowerAddr];
        uint256 normalized = _normalizeTo18(market, amount);
        if (normalized > uint256(auth.totalBorrowed)) {
            auth.totalBorrowed = 0;
        } else {
            auth.totalBorrowed -= uint128(normalized);
        }
    }

    // ─── Admin ─────────────────────────────────────────────────────────

    /// @notice Updates the protocol fee recipient address
    /// @param newRecipient The new fee recipient
    function setProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert CreditErrors.ZeroAddress();
        protocolFeeRecipient = newRecipient;
    }

    /// @notice Sets the TICS bridge address for attestations
    /// @param _bridge The bridge contract address
    function setTICSBridge(address _bridge) external onlyOwner {
        ticsBridge = _bridge;
    }

    /// @notice Sets the sanctions sentinel address
    /// @param _sentinel The SanctionsSentinel contract address
    function setSanctionsSentinel(address _sentinel) external onlyOwner {
        sanctionsSentinel = _sentinel;
    }

    /// @notice Sets the price feed adapter address
    /// @param _adapter The PriceFeedAdapter contract address
    function setPriceFeedAdapter(address _adapter) external onlyOwner {
        priceFeedAdapter = _adapter;
    }

    // ─── Internal Helpers ──────────────────────────────────────────────

    /// @dev Checks if an address is sanctioned via the SanctionsSentinel (if set)
    /// @param addr The address to check
    function _checkSanctions(address addr) internal view {
        if (sanctionsSentinel != address(0)) {
            if (ISanctionsSentinel(sanctionsSentinel).isSanctioned(addr)) {
                revert CreditErrors.AddressSanctioned();
            }
        }
    }

    /// @dev Normalizes a token amount to 18 decimals for credit limit comparison
    /// @param market The CreditMarket address to query for the underlying asset
    /// @param amount The amount in token-native decimals
    /// @return The amount scaled to 18 decimals
    function _normalizeTo18(address market, uint256 amount) internal view returns (uint256) {
        address token = ICreditMarket(market).asset();
        uint8 decimals = IERC20Metadata(token).decimals();
        if (decimals < 18) {
            return amount * 10 ** (18 - decimals);
        } else if (decimals > 18) {
            return amount / 10 ** (decimals - 18);
        }
        return amount;
    }

    /// @dev Converts an address to a 4-byte hex string
    function _toHexString(address addr) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes20 data = bytes20(addr);
        bytes memory str = new bytes(8); // first 4 bytes = 8 hex chars
        for (uint256 i = 0; i < 4; i++) {
            str[i * 2] = alphabet[uint8(data[i] >> 4)];
            str[i * 2 + 1] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
