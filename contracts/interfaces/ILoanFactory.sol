// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Loan Factory Interface Contract
/// @notice This contract serves as a interface for the loan factory for 
/// creating and managing loans (lend and borrow) within Pavo.
interface ILoanFactory {
    
    // Status of a loan at the current state
    enum Status {
        s1,      // s1 - offer to lend
        s2,      // s2 - offer to borrow
        s3,      // s3 - ongoing loan
        s4       // s4 - terminated loan
    }

    /// Struct for New borrower/lenders offers and Active Loans
    /// Unified offer structure for ℓ (offer to lend) and b (offer to borrow)
    //@ Loan Struct
    struct Loan {
        uint256 id;                         // id of the loan
        uint256 startTime;                  // t0 (start of loan once taken up)
        uint256 asset;                      // v (USDC amount of loan) 
        uint256 collateral;                 // z (BTC amount of collateral)
        uint256 initialCollateralRatio;     // rho (collateral-to-loan ratio at time t0) 
        uint256 liquidationThreshold;       // c (liquidation threshold)
        address lender;                     // w (lender wallet) offer to lend address
        address borrower;                   // w′ (borrower wallet) offer to borrow address
        address assetAddress;               // Token address for the loan asset 
        address collateralAddress;          // Token address for the collateral asset
        uint8 rateIndex;                    // r (interest rate index for each time step)
        uint8 durationIndex;                // d (duration index of loan)
        Status s;                           // Current state of the loan
    }

    /// @notice Event emitted when an loan is created
    event Created(uint256 indexed id, 
        address indexed creator, 
        uint256 amount, 
        Status s, 
        uint256 rate, 
        uint256 duration);

    /// @notice Event emitted when an loan is cancelled
    event Cancelled(address indexed canceller, Status s);

    /// @notice Event emitted when a loan is matched
    event TakeUp(address indexed borrower, address indexed lender);

    /// @notice Event emitted when a loan ends
    event Ended(address indexed ender);

    /// @notice Event emitted when a loan is liquidated
    event Liquidated(address indexed liquidator);

    /// @notice Event emitted when a loan is interrupted
    event Interrupted(address indexed borrower);

    /// @notice Event emitted when collateral is topped up
    event ToppedUp(address indexed borrower);

    /// @notice Event emitted when a protocol fee is collected at loan creation
    event FeeCollected(address indexed token, address indexed recipient, uint256 amount);

    /// @notice Creates a new loan (lend or borrow)
    /// @param _asset The USDC amount of the loan
    /// @param _collateral The BTC amount of collateral
    /// @param _initialCollateralRatio The initial collateral-to-loan ratio for the loan
    /// @param _liquidationThreshold The liquidation threshold for the loan
    /// @param _assetAddress The token address for the loan asset (USDC)
    /// @param _collateralAddress The token address for the collateral asset (BTC)
    /// @param _rateIndex The interest rate index for the loan
    /// @param _durationIndex The duration index of the loan
    /// @return id The id of the created loan
    function createLoan(
        uint256 _asset,
        uint256 _collateral,
        uint256 _initialCollateralRatio,
        uint256 _liquidationThreshold,
        address _assetAddress,
        address _collateralAddress,
        uint8 _rateIndex,
        uint8 _durationIndex
    ) external returns (uint256);

    /// @notice Cancel a loan (lend or borrow)
    /// @param id The id of the loan to cancel
    function cancelLoan(uint256 id) external;

    /// @notice Match a loan (borrower takes lender loan or lender takes borrower loan)
    /// @param takeUpId The id of the loan to take up (borrower's offer or lender's offer)
    /// @param offerId The id of the offer to match (lender's offer or borrower's offer)
    function takeUpLoan(uint256 takeUpId, uint256 offerId) external;

    /// @notice End a loan at maturity
    /// @param id The id of the loan to repay
    function endLoan(uint256 id) external;

    /// @notice Liquidates loan if collateral ratio falls below threshold
    /// @param id The id of the loan to liquidate
    function liquidateLoan(uint256 id) external;

    /// @notice Interrupt loan early with full interest
    /// @param id The id of the loan to interrupt early
    function interruptLoan(uint256 id) external;

    /// @notice Top up collateral to improve loan health
    /// @param id The id of the loan to top up
    /// @param additionalCollateral The additional BTC collateral amount
    function topUp(uint256 id, uint256 additionalCollateral) external;
}