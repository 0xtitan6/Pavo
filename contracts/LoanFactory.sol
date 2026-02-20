// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/ILoanFactory.sol";
import "./libraries/LoanCalculator.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Loan Factory Contract
/// @notice This contract serves as a factory for creating and managing loans (lend and borrow)
/// within VeniceFi.
contract LoanFactory is ILoanFactory, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Initialize at 0 by default
    uint256 private loanCounter;
    
    /// @notice Minimum asset amount (100 USDC with 6 decimals)
    uint256 public constant MIN_ASSET_AMOUNT = 100 * 10**6;
    
    /// @notice Basis points constants for collateral and liquidation thresholds
    uint256 public constant MIN_LIQUIDATION_THRESHOLD_BPS = 10000;     // 100% - allows Scenario 4
    uint256 public constant MAX_LIQUIDATION_THRESHOLD_BPS = 15000;    // 150% - allows higher thresholds for Scenario 2
    uint256 public constant MIN_INITIAL_COLLATERAL_RATIO_BPS = 11000;  // 110% - allows Scenario 4
    uint256 public constant MAX_INITIAL_COLLATERAL_RATIO_BPS = 50000; // 500% - allows high over-collateralization
    
    /// @notice Duration array: 0=1 day, 1=7 days, 2=30 days, 3=90 days, 4=180 days, 5=365 days
    uint256[6] public DURATION_DAYS = [1, 7, 30, 90, 180, 365];

    /// @notice Interest rate array (in basis points): 0=4%, 1=5%, 2=6%, 3=7%, 4=8%, 5=9%, 6=10%, 7=11%
    uint256[8] public RATE_BPS = [400, 500, 600, 700, 800, 900, 1000, 1100];
    
    /// @notice Mapping of is to offer details (optimized for storage packing)
    mapping(uint256 => Loan) public loans;

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
    ) external override nonReentrant returns (uint256) {

        // Validate duration (6 periods: 0-5)
        require(_durationIndex <= 5, "Invalid duration index");

        // Validate interest rate (8 rates: 0-7) 
        require(_rateIndex <= 7, "Invalid interest rate index");

        // Validate liquidation threshold bounds for loan
        require(_liquidationThreshold >= MIN_LIQUIDATION_THRESHOLD_BPS && 
            _liquidationThreshold <= MAX_LIQUIDATION_THRESHOLD_BPS,
            "Invalid liquidation threshold for loan");

        // Validate initial collateral ratio bounds
        require(_initialCollateralRatio >= MIN_INITIAL_COLLATERAL_RATIO_BPS && 
            _initialCollateralRatio <= MAX_INITIAL_COLLATERAL_RATIO_BPS,
            "Invalid initial collateral ratio");

        // Initialize a new loan filled with parameters in createLoan
        Loan memory newLoan;

        // Initialize a new id
        uint256 id = 0;

        // lender
        // Validate asset is greater than minimum required and collateral is zero
        if (_asset >= MIN_ASSET_AMOUNT && _collateral == 0) {
            
            // Asset token 
            IERC20 assetToken = IERC20(_assetAddress);    
            
            // Set lender as owner of loan, borrower as 0x, and status as offer to lend
            newLoan.lender = msg.sender;
            newLoan.borrower = address(0);
            newLoan.s = Status.s1;
            
            // Generate unique id using keccak256 hash of relevant loan content + randomness
            id = uint256(keccak256(abi.encodePacked(
                _asset,                           // USDC amount
                RATE_BPS[_rateIndex],             // interest rate
                DURATION_DAYS[_durationIndex],    // loan duration
                _assetAddress,                    // USDC token address
                msg.sender,                       // lender address
                block.timestamp,                  // creation time
                loanCounter++                     // uniqueness for loan 
            )));

            // Transfer USDC from lender to contract
            assetToken.safeTransferFrom(msg.sender, address(this), _asset);
        }

        // borrower
        // Validate collateral is greater than 0 and asset is zero
        else if (_collateral > 0 && _asset == 0) {   

            // Collateral token
            IERC20 collateralToken = IERC20(_collateralAddress); 

            // Set borrower as owner of loan, lender as 0x, and status as offer to borrow
            newLoan.borrower = msg.sender;
            newLoan.lender = address(0);
            newLoan.s = Status.s2;
            
            // Generate unique id using keccak256 hash of relevant offer content + randomness
            id = uint256(keccak256(abi.encodePacked(
                _collateral,                      // BTC amount
                RATE_BPS[_rateIndex],             // interest rate
                DURATION_DAYS[_durationIndex],    // loan duration
                _collateralAddress,               // BTC token address
                msg.sender,                       // borrower address
                block.timestamp,                  // creation time
                loanCounter++                     // uniqueness for loan
            )));
            
            // Transfer BTC from borrower to contract
            collateralToken.safeTransferFrom(msg.sender, address(this), _collateral);
        }

        // Invalid offer parameters
        else {
            revert("Invalid offer parameters");
        }

        // Initialize a struct to hold information
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

        // Store offer using transactionId
        loans[id] = newLoan;
        
        // Event emitted when an loan is created 
        // if and else statement if borrow or lend
        emit Created(
            newLoan.id, 
            msg.sender, 
            newLoan.s == Status.s1 ? newLoan.asset : newLoan.collateral, // Amount based on status
            newLoan.s, // Use the set status to indicate offer type 
            RATE_BPS[newLoan.rateIndex],
            DURATION_DAYS[newLoan.durationIndex]
        );

        return newLoan.id;
    }
    
    /// @notice Cancel a loan (lend or borrow)
    /// @param id The id of the loan to cancel
    function cancelLoan(uint256 id) external nonReentrant override {

        // Get the loan
        Loan storage loan = loans[id];

        // Validate loan existence
        require(loan.id == id, "Loan does not exist");
        
        // Validate caller is the loan creator
        require(loan.lender == msg.sender || loan.borrower == msg.sender, "Only loan creator can cancel");

        // Capture status before modification
        Status previousStatus = loan.s;

        // Return tokens to creator
        // Lender return
        if (loan.s == Status.s1) {

            // Asset token 
            IERC20 assetToken = IERC20(loan.assetAddress);    

            // Set loan status to S4 (terminated)
            loan.s = Status.s4;

            // Lender loan: return USDC - contract to lender 
            assetToken.safeTransfer(loan.lender, loan.asset);

        // Borrower return
        } else if (loan.s == Status.s2) {

            // Collateral token 
            IERC20 collateralToken = IERC20(loan.collateralAddress);  

            // Set loan status to S4 (terminated)
            loan.s = Status.s4;

            // Borrower loan: return BTC collateral - contract to borrower
            collateralToken.safeTransfer(loan.borrower, loan.collateral);

        } else {
            revert("Loan not in cancellable state");
        }

        // Delete loan data from storage 
        // Clears data from storage, offering gas refund, and setting struct to zero values
        delete loans[id];
        
        // Event emitted when an loan is cancelled
        emit Cancelled(msg.sender, previousStatus);
    }

    /// @notice Take up a loan (borrower takes lender loan or lender takes borrower loan) 
    /// check a lender/borrower doesn't take up loan
    /// @param takeUpId The id of the loan to take up
    /// @param offerId The id of the offer being matched
    function takeUpLoan(uint256 takeUpId, uint256 offerId) external nonReentrant override {
        Loan storage takeUpRef = loans[takeUpId];
        Loan storage offerRef = loans[offerId];

        // Borrower wallet w′ takes up lend offer ℓ by committing z BTC collateral
        if (takeUpRef.borrower == msg.sender && takeUpRef.borrower != offerRef.lender) {
            // takeUpLoan is the borrow offer (b), offerLoan is the lend offer (ℓ)
            Loan storage borrowOffer = takeUpRef;
            Loan storage lendOffer = offerRef;
            
            // Verify loan statuses
            require(
                borrowOffer.s == Status.s2 && lendOffer.s == Status.s1, 
                "Invalid: borrowOffer must be s2 and lendOffer must be s1"
            );

            // Get collateral value: φt0(z)
            uint256 collateralValue = LoanCalculator.getOraclePrice(borrowOffer.collateral, borrowOffer.collateralAddress); // φt0(z)
            
            // Validate equation φt0(z) > max(ρv, cv)
            uint256 requiredForInitialRatio = (lendOffer.initialCollateralRatio * lendOffer.asset) / 10000;     // ρv
            uint256 requiredForLiquidation = (lendOffer.liquidationThreshold * lendOffer.asset) / 10000;         // cv
            
            require(collateralValue > Math.max(requiredForInitialRatio, requiredForLiquidation),
                "Collateral insufficient: phi(z) must be > max(rho*v, c*v)"
            );

            // borrower receives USDC
            IERC20 assetToken = IERC20(lendOffer.assetAddress);

            // Transfer usdc to borrower
            assetToken.safeTransfer(borrowOffer.borrower, lendOffer.asset);
            
            // Transform lend offer into active loan
            lendOffer.borrower = borrowOffer.borrower;
            lendOffer.collateral = borrowOffer.collateral;
            lendOffer.collateralAddress = borrowOffer.collateralAddress;
            lendOffer.startTime = block.timestamp;
            lendOffer.s = Status.s3;
            
            // Emit matched event
            emit TakeUp(lendOffer.borrower, lendOffer.lender);

            // Lender wallet w takes up borrow offer b with collateral z BTC
        }   else if (takeUpRef.lender == msg.sender && takeUpRef.lender != offerRef.borrower) {

            // takeUpLoan is the lend offer (ℓ), offerLoan is the borrow offer (b)
            Loan storage lendOffer = takeUpRef;
            Loan storage borrowOffer = offerRef;
            
            // Verify loan statuses
            require(
                lendOffer.s == Status.s1 && borrowOffer.s == Status.s2,
                "Invalid: lendOffer must be s1 and borrowOffer must be s2"
            );

            // The φt(z) 
            uint256 collateralValue = LoanCalculator.getOraclePrice(borrowOffer.collateral, borrowOffer.collateralAddress);
            
            // Validate equation (39): φt0(z) > max(ρv, cv) where v = φt(z)
            uint256 requiredForInitialRatio = (borrowOffer.initialCollateralRatio * lendOffer.asset) / 10000;  // ρv
            uint256 requiredForLiquidation = (borrowOffer.liquidationThreshold * lendOffer.asset) / 10000;      // cv
            
            require(
                collateralValue > Math.max(requiredForInitialRatio, requiredForLiquidation),
                "Collateral insufficient: phi(z) must be > max(rho*v, c*v)"
            );

            IERC20 assetToken = IERC20(lendOffer.assetAddress);
            // Lender sends USDC = ϕt(z) (collateralValue) to borrower
            assetToken.safeTransfer(borrowOffer.borrower, lendOffer.asset);

            // Transform borrow offer into active loan
            borrowOffer.lender = lendOffer.lender;
            borrowOffer.startTime = block.timestamp;
            borrowOffer.asset = lendOffer.asset;
            borrowOffer.assetAddress = lendOffer.assetAddress;
            borrowOffer.s = Status.s3;

            // Emit matched event
            emit TakeUp(borrowOffer.borrower, borrowOffer.lender);
        }      

        else {
            revert("Unauthorized caller");
        }  

        // Delete the offer as it's been consumed
        delete loans[takeUpId];
    }

    /// @notice Liquidates loan if collateral ratio falls below threshold
    /// @param id The id of the loan to liquidate
    function liquidateLoan(uint256 id) external nonReentrant override {
        Loan storage loan = loans[id];
        
        // Validate loan exists, is active, and lender
        require(loan.id == id && loan.s == Status.s3
            && loan.lender == msg.sender,
            "Loan not found, inactive, or unauthorized");
        
        // Calculate days elapsed since loan offer taken up
        uint256 daysElapsed = (block.timestamp - loan.startTime) / 86400;
        
        // Calculate current collateral ratio using library function
        uint256 currentHealthScore = LoanCalculator.calculateHealthScore(
            loan.collateral, 
            loan.asset, 
            RATE_BPS[loan.rateIndex], 
            daysElapsed, // Use current time instead of full duration
            loan.collateralAddress
        );

        // Check if collateral ratio is below liquidation threshold
        require(currentHealthScore < loan.liquidationThreshold, "Collateral ratio above liquidation threshold");
        
        // Set loan status to S4 (terminated)
        loan.s = Status.s4;

        // Collateral token
        IERC20 collateralToken = IERC20(loan.collateralAddress);

        // Transfer collateral in contract to lender
        collateralToken.safeTransfer(loan.lender, loan.collateral);
        
        delete loans[id]; // Delete loan data from storage
        
        // Event emitted when a loan is liquidated
        emit Liquidated(msg.sender);
    }

    /// @notice End a loan at maturity
    /// @param id The id of the loan to repay
    function endLoan(uint256 id) external nonReentrant override {
        Loan storage loan = loans[id];
        
        // Validate loan exists and is active (S3)
        require(loan.s == Status.s3 && loan.id == id,
            "Loan not found, inactive, or unauthorized");
        
        // Check if loan has actually matured
        // Calculate maturity: taken-up time + (duration in days * seconds per day)
        uint256 maturityTime = loan.startTime + (DURATION_DAYS[loan.durationIndex] * 86400);
        require(block.timestamp >= maturityTime, "Loan has not matured yet");
        
        // Calculate BTC payout and excess collateral
        uint256 btcPayout = LoanCalculator.calculateBTCPayout(
            loan.asset, RATE_BPS[loan.rateIndex], DURATION_DAYS[loan.durationIndex], 
            loan.collateral, loan.collateralAddress
        );

        uint256 excessCollateral = LoanCalculator.calculateExcessCollateral(
            loan.asset, RATE_BPS[loan.rateIndex], DURATION_DAYS[loan.durationIndex], 
            loan.collateral, loan.collateralAddress
        );

        // Set loan status to S4 (terminated)
        loan.s = Status.s4;

        // Collateral token
        IERC20 collateralToken = IERC20(loan.collateralAddress);
       
        // Transfer BTC payout to lender (principal + interest in BTC)
        collateralToken.safeTransfer(loan.lender, btcPayout);
        
        // Transfer excess collateral to borrower
        collateralToken.safeTransfer(loan.borrower, excessCollateral);

        delete loans[id]; // Delete loan data from storage
 
        // Event emitted when a loan ends
        emit Ended(msg.sender);
    }

    /// @notice Interrupt loan early with full interest
    /// @param id The id of the loan to repay early
    function interruptLoan(uint256 id) external nonReentrant override {
        Loan storage loan = loans[id];
        
        // Validate loan exists and is active (S3) and caller is borrower
        require(loan.s == Status.s3 
            && loan.borrower == msg.sender, 
            "Loan not found, inactive, or unauthorized");

        // Calculate maturity: taken-up time + (duration in days * seconds per day)
        uint256 maturityTime = loan.startTime + (DURATION_DAYS[loan.durationIndex] * 86400);
        require(block.timestamp < maturityTime, "Loan has already matured");
        
        // Calculate full-term interest
        uint256 totalRepayment = LoanCalculator.calculateTotalRepayment(
            loan.asset, RATE_BPS[loan.rateIndex], DURATION_DAYS[loan.durationIndex]
        );

        // Set loan status to S4 (terminated)
        loan.s = Status.s4;

        // Asset token and Collateral token
        IERC20 assetToken = IERC20(loan.assetAddress);
        IERC20 collateralToken = IERC20(loan.collateralAddress);

        // Transfer total repayment from borrower to contract
        assetToken.safeTransferFrom(loan.borrower, address(this), totalRepayment);

        // Transfer principal + full interest from contract to lender 
        assetToken.safeTransfer(loan.lender, totalRepayment);
        
        // Return collateral to borrower
        collateralToken.safeTransfer(loan.borrower, loan.collateral);

        // Event emitted when a loan is interrupted
        emit Interrupted(loan.borrower);
        
        delete loans[id]; // Delete loan data from storage
    }

    /// @notice Top up collateral to improve loan health
    /// @param id The id of the loan to top up
    /// @param additionalCollateral The additional BTC collateral amount
    function topUp(uint256 id, uint256 additionalCollateral) external nonReentrant override {
        Loan storage loan = loans[id];
        
        // Validate loan exists, is active (S3) and caller is borrower
        require(loan.s == Status.s3 
            && loan.borrower == msg.sender, 
            "Loan not found, inactive, or unauthorized");

        // Validate additionalCollateral greater than zero    
        require(additionalCollateral > 0, "Additional collateral must be greater than zero");

        // Update collateral amount
        loan.collateral += additionalCollateral;

        // Collateral token
        IERC20 collateralToken = IERC20(loan.collateralAddress);
        
        // Transfer additional collateral from borrower to contract
        collateralToken.safeTransferFrom(loan.borrower, address(this), additionalCollateral);

        // Event emitted when collateral is topped up
        emit ToppedUp(loan.borrower);
    }
}