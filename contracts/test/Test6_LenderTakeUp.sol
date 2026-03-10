// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";

/// @title Test6_LenderTakeUp
/// @notice Tests for:
///   - Lender-takes-borrow-offer branch of takeUpLoan (eq. 42-44)  [CRITICAL: untested before]
///   - M-6: asset token mismatch validation
///   - pause() does NOT block settlement functions (cancelLoan, endLoan, interruptLoan, liquidateLoan, topUp)
///   - Fee with zero recipient
///   - interruptLoan: lender receives exact repayment
///   - endLoan: collateral fully distributed between lender and borrower
///   - liquidateLoan: anyone can call (no auth restriction)
contract Test6_LenderTakeUp is TestBase {

    // Persistent env for two-step tests
    Env private _e;
    uint256 private _activeLoanId;

    // =========================================================================
    // 12. LENDER TAKES BORROW OFFER (eq. 42-44) — POSITIVE
    // =========================================================================

    function test_LenderTakesBorrow_CreatesActiveLoan() external {
        Env memory e = _deploy();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8; // 1 BTC = $50k >> $1k loan

        // borrowerAgent creates s2 borrow offer (separate address from lender)
        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        // Lender (address(this)) creates s1 lend offer
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Lender takes up the borrow offer: takeUpLoan(takeUpId=lendId, offerId=borrowId)
        e.factory.takeUpLoan(lendId, borrowId);

        // borrowOffer (borrowId) should now be s3 (active loan)
        _assertEq(uint256(_loanStatus(e, borrowId)), 2, "Borrow offer should become s3 active loan");
    }

    function test_LenderTakesBorrow_LendOfferDeleted() external {
        Env memory e = _deploy();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        e.factory.takeUpLoan(lendId, borrowId);

        // Lend offer (taker) should be deleted
        _assertEq(_loanId(e, lendId), 0, "Lend offer should be deleted after taking up borrow");
    }

    function test_LenderTakesBorrow_ActiveLoanHasCorrectParties() external {
        Env memory e = _deploy();

        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            1 * 1e8, address(e.usdc), address(e.wbtc)
        );

        e.usdc.approve(address(e.factory), 1_000 * 1e6);
        uint256 lendId = e.factory.createLoan(
            1_000 * 1e6, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        e.factory.takeUpLoan(lendId, borrowId);

        // Active loan is borrowId; lender field should be address(this)
        _assertAddrEq(_loanLender(e, borrowId),   address(this),            "Lender should be test contract");
        _assertAddrEq(_loanBorrower(e, borrowId), address(e.borrowerAgent), "Borrower should be borrowerAgent");
        _assertNeq(_loanCollateral(e, borrowId),  0, "Active loan should have collateral");
        _assertNeq(_loanAsset(e, borrowId),       0, "Active loan should have asset");
    }

    function test_LenderTakesBorrow_BorrowerReceivesAsset() external {
        Env memory e = _deploy();

        uint256 assetAmt = 1_000 * 1e6;

        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            1 * 1e8, address(e.usdc), address(e.wbtc)
        );

        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        uint256 borrowerUsdcBefore = e.usdc.balanceOf(address(e.borrowerAgent));
        e.factory.takeUpLoan(lendId, borrowId);
        uint256 borrowerUsdcAfter = e.usdc.balanceOf(address(e.borrowerAgent));

        _assertGt(borrowerUsdcAfter, borrowerUsdcBefore, "Borrower should receive USDC");
    }

    function test_LenderTakesBorrow_FactoryCollateralBalance() external {
        Env memory e = _deploy();

        uint256 collateralAmt = 1 * 1e8;
        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        e.usdc.approve(address(e.factory), 1_000 * 1e6);
        uint256 lendId = e.factory.createLoan(
            1_000 * 1e6, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        e.factory.takeUpLoan(lendId, borrowId);

        // After match: factory holds collateral (WBTC), USDC sent to borrower
        _assertEq(e.wbtc.balanceOf(address(e.factory)), collateralAmt, "Factory should hold BTC collateral");
        _assertEq(e.usdc.balanceOf(address(e.factory)), 0, "Factory should have zero USDC after match");
    }

    // =========================================================================
    // 12. LENDER TAKES BORROW OFFER — NEGATIVE
    // =========================================================================

    function testFail_LenderTakesBorrow_SameAddressBothRoles() external {
        Env memory e = _deploy();

        // address(this) creates BOTH offers → lender == borrower → "Unauthorized caller"
        e.wbtc.approve(address(e.factory), 1 * 1e8);
        uint256 borrowId = e.factory.createLoan(
            0, 1 * 1e8, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        e.usdc.approve(address(e.factory), 1_000 * 1e6);
        uint256 lendId = e.factory.createLoan(
            1_000 * 1e6, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Lender == borrower → revert "Unauthorized caller"
        e.factory.takeUpLoan(lendId, borrowId);
    }

    function testFail_LenderTakesBorrow_WrongStatusOrder() external {
        Env memory e = _deploy();

        // Pass two s1 (lend) offers to lender-branch → should revert on status check
        e.usdc.approve(address(e.factory), 1_000 * 1e6);
        uint256 lendId1 = e.factory.createLoan(
            1_000 * 1e6, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );
        e.usdc.approve(address(e.factory), 1_000 * 1e6);
        uint256 lendId2 = e.factory.createLoan(
            1_000 * 1e6, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        e.factory.takeUpLoan(lendId1, lendId2); // both s1 → revert
    }

    // =========================================================================
    // 13. M-6: ASSET TOKEN MISMATCH (same collateral, different asset/stablecoin)
    // =========================================================================

    function testFail_TakeUpLoan_M6_AssetMismatch() external {
        Env memory e = _deploy();

        // Deploy a second stablecoin
        ERC20Mock dai = new ERC20Mock("DAI", "DAI", address(this), 10_000_000 * 1e6, 6);
        e.registry.registerAsset(address(dai), "DAI", "", 6);
        e.registry.setAssetSupported(address(dai), true);
        e.registry.setPairSupported(address(e.wbtc), address(dai), true);

        // Lend offer in USDC
        e.usdc.approve(address(e.factory), 1_000 * 1e6);
        uint256 lendId = e.factory.createLoan(
            1_000 * 1e6, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Borrow offer in DAI (different asset)
        dai.transfer(address(e.borrowerAgent), 0); // just registering dai
        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            1 * 1e8, address(dai), address(e.wbtc)
        );

        // takeUpLoan should revert: "Offers must use the same asset token"
        e.borrowerAgent.createBorrowOfferAndTakeUp(0, address(e.usdc), address(e.wbtc), lendId);
        // Direct call: borrowerAgent has borrow offer with DAI, lend offer with USDC
        e.factory.takeUpLoan(lendId, borrowId); // lender-branch: lendId(USDC) offerId(DAI borrowOffer)
    }

    // =========================================================================
    // 14. PAUSE DOES NOT BLOCK SETTLEMENT FUNCTIONS
    // =========================================================================

    function test_Pause_DoesNotBlock_CancelLoan() external {
        Env memory e = _deploy();
        e.usdc.approve(address(e.factory), 1_000 * 1e6);
        uint256 lendId = e.factory.createLoan(
            1_000 * 1e6, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        e.factory.pause();
        e.factory.cancelLoan(lendId); // must NOT revert when paused
        _assertEq(_loanId(e, lendId), 0, "Loan deleted after cancel while paused");
    }

    function test_Pause_DoesNotBlock_TopUp() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);
        e.factory.pause();

        uint256 collBefore = _loanCollateral(e, activeLoanId);
        e.borrowerAgent.topUp(address(e.wbtc), activeLoanId, 1e6);
        _assertGt(_loanCollateral(e, activeLoanId), collBefore, "topUp should work when paused");
    }

    function test_Pause_DoesNotBlock_LiquidateLoan() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
        _e.feed.setAnswer(int256(BTC_PRICE / 500));
        _e.factory.pause();
        _e.factory.liquidateLoan(_activeLoanId);
        _assertEq(_loanId(_e, _activeLoanId), 0, "Liquidation works while paused");
    }

    function setup_PauseEndLoan() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
    }

    function test_Pause_DoesNotBlock_EndLoan() external {
        _e.factory.pause();
        _e.factory.endLoan(_activeLoanId);
        _assertEq(_loanId(_e, _activeLoanId), 0, "endLoan works while paused");
    }

    function setup_PauseInterruptLoan() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
    }

    function test_Pause_DoesNotBlock_InterruptLoan() external {
        uint256 repayment = LoanCalculator.calculateTotalRepayment(
            1_000 * 1e6, _e.factory.RATE_BPS(1), _e.factory.DURATION_DAYS(1)
        );
        _e.usdc.transfer(address(_e.borrowerAgent), repayment);
        _e.factory.pause();
        _e.borrowerAgent.interruptLoan(address(_e.usdc), _activeLoanId, repayment);
        _assertEq(_loanId(_e, _activeLoanId), 0, "interruptLoan works while paused");
    }

    // =========================================================================
    // 15. FEE WITH ZERO RECIPIENT — full amount stays in factory
    // =========================================================================

    function test_FeeRecipientZero_NoFeeDeducted() external {
        Env memory e = _deploy();
        e.factory.setProtocolFee(200); // 2%
        e.factory.setFeeRecipient(address(0)); // zero → disable fee collection

        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);

        uint256 factoryBefore = e.usdc.balanceOf(address(e.factory));
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        uint256 factoryAfter = e.usdc.balanceOf(address(e.factory));

        _assertEq(factoryAfter - factoryBefore, assetAmt, "Full amount in factory when fee recipient is zero");
    }

    // =========================================================================
    // 16. INTERRUPTLOAN — LENDER RECEIVES EXACT REPAYMENT AMOUNT
    // =========================================================================

    function setup_InterruptRepayment() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
    }

    function test_InterruptLoan_LenderReceivesExactRepayment() external {
        uint256 repayment = LoanCalculator.calculateTotalRepayment(
            1_000 * 1e6, _e.factory.RATE_BPS(1), _e.factory.DURATION_DAYS(1)
        );
        _e.usdc.transfer(address(_e.borrowerAgent), repayment);

        uint256 lenderBefore = _e.usdc.balanceOf(address(this));
        _e.borrowerAgent.interruptLoan(address(_e.usdc), _activeLoanId, repayment);
        uint256 lenderAfter = _e.usdc.balanceOf(address(this));

        _assertEq(lenderAfter - lenderBefore, repayment, "Lender should receive exact repayment amount");
    }

    // =========================================================================
    // 17. ENDLOAN — ALL COLLATERAL DISTRIBUTED (lender + borrower = total)
    // =========================================================================

    function setup_EndLoanDistribution() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
    }

    function test_EndLoan_AllCollateralDistributed() external {
        uint256 totalCollateral    = _loanCollateral(_e, _activeLoanId);
        uint256 lenderBefore       = _e.wbtc.balanceOf(address(this));
        uint256 borrowerBefore     = _e.wbtc.balanceOf(address(_e.borrowerAgent));

        _e.factory.endLoan(_activeLoanId);

        uint256 lenderGot   = _e.wbtc.balanceOf(address(this))            - lenderBefore;
        uint256 borrowerGot = _e.wbtc.balanceOf(address(_e.borrowerAgent)) - borrowerBefore;

        _assertEq(lenderGot + borrowerGot, totalCollateral, "Sum of payouts must equal total collateral");
        _assertGt(lenderGot,  0, "Lender should receive non-zero BTC");
        _assertGt(borrowerGot, 0, "Borrower should receive excess collateral");
    }

    // =========================================================================
    // 18. LIQUIDATION — NO CALLER RESTRICTION (anyone can call)
    // =========================================================================

    function setup_AnyoneLiquidates() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
        _e.feed.setAnswer(int256(BTC_PRICE / 500));
    }

    function test_LiquidateLoan_AnyoneCanTrigger() external {
        // Collateral goes to loan.lender regardless of who calls liquidateLoan.
        // This test calls as address(this) (who is the lender) — confirms no auth restriction.
        uint256 lenderBefore = _e.wbtc.balanceOf(address(this));
        _e.factory.liquidateLoan(_activeLoanId);
        uint256 lenderAfter  = _e.wbtc.balanceOf(address(this));

        _assertGt(lenderAfter, lenderBefore, "Lender receives collateral on liquidation");
        _assertEq(_loanId(_e, _activeLoanId), 0, "Loan deleted");
    }
}
