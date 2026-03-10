// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";

/// @title Test3_CancelTakeUp
/// @notice Solidity unit tests for cancelLoan and takeUpLoan.
contract Test3_CancelTakeUp is TestBase {

    // =========================================================================
    // 5. CANCEL LOAN — POSITIVE
    // =========================================================================

    function test_CancelLendOffer_ReturnsUsdc() external {
        Env memory e = _deploy();
        uint256 assetAmt = 2_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 id = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        uint256 balBefore = e.usdc.balanceOf(address(this));
        e.factory.cancelLoan(id);
        uint256 balAfter  = e.usdc.balanceOf(address(this));

        _assertEq(balAfter - balBefore, assetAmt, "USDC should be returned to lender");
        _assertEq(_loanId(e, id), 0, "Loan should be deleted after cancel");
    }

    function test_CancelBorrowOffer_ReturnsWbtc() external {
        Env memory e = _deploy();
        uint256 collateralAmt = 1 * 1e8;
        e.wbtc.approve(address(e.factory), collateralAmt);
        uint256 id = e.factory.createLoan(0, collateralAmt, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        uint256 balBefore = e.wbtc.balanceOf(address(this));
        e.factory.cancelLoan(id);
        uint256 balAfter  = e.wbtc.balanceOf(address(this));

        _assertEq(balAfter - balBefore, collateralAmt, "WBTC should be returned to borrower");
    }

    function test_CancelLoan_FactoryBalanceZero() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 id = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        e.factory.cancelLoan(id);
        _assertEq(e.usdc.balanceOf(address(e.factory)), 0, "Factory USDC should be zero after cancel");
    }

    // =========================================================================
    // 5. CANCEL LOAN — NEGATIVE
    // =========================================================================

    function testFail_CancelLoan_NotExists() external {
        Env memory e = _deploy();
        e.factory.cancelLoan(9999);
    }

    function testFail_CancelLoan_NotCreator() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 id = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        Attacker atk = new Attacker(address(e.factory));
        atk.tryCancelLoan(id);
    }

    function testFail_CancelLoan_ActiveLoan() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);
        _check(
            _loanStatus(e, activeLoanId) == ILoanFactory.Status.s3,
            "Loan should be s3 before cancel attempt"
        );
        e.factory.cancelLoan(activeLoanId);
    }

    function testFail_CancelLoan_Twice() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 id = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        e.factory.cancelLoan(id);
        e.factory.cancelLoan(id);
    }

    // =========================================================================
    // 6. TAKE UP LOAN — POSITIVE
    // =========================================================================

    function test_TakeUpLoan_OffersExistBeforeMatch() external {
        Env memory e = _deploy();
        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        e.wbtc.approve(address(e.factory), collateralAmt);
        uint256 borrowId = e.factory.createLoan(0, collateralAmt, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        _assertEq(uint256(_loanStatus(e, lendId)),   0, "Lend offer should be s1");
        _assertEq(uint256(_loanStatus(e, borrowId)), 1, "Borrow offer should be s2");
        _assertNeq(_loanAsset(e, lendId),            0, "Lend offer should have asset amount");
        _assertNeq(_loanCollateral(e, borrowId),     0, "Borrow offer should have collateral amount");
    }

    function test_TakeUpLoan_FullMatchCreatesActiveLoan() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);
        _assertEq(uint256(_loanStatus(e, activeLoanId)), 2, "Matched loan should be s3");
    }

    function test_TakeUpLoan_BorrowOfferDeletedAfterMatch() external {
        Env memory e = _deploy();
        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        // Lender (address(this)) creates lend offer
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        // Borrower agent creates borrow offer and takes up lend offer
        // borrowId is deleted after takeUpLoan, so we need to predict what it will be
        // We use _createAndMatchLoan logic via borrowerAgent
        uint256 borrowId = e.borrowerAgent.createBorrowOfferAndTakeUp(collateralAmt, address(e.usdc), address(e.wbtc), lendId);
        (borrowId); // suppress unused-variable warning

        // After takeUp, the borrow offer (borrowId) should be deleted; lendId becomes active loan
        // The borrow offer slot should be empty — use lendId+1 heuristic or simply verify via lendId
        // Since borrowId was returned from createBorrowOfferAndTakeUp before it got deleted,
        // we verify its slot is now empty
        _assertEq(_loanId(e, borrowId), 0, "Taker borrow offer should be deleted");
    }

    function test_TakeUpLoan_ActiveLoanHasCorrectFields() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);

        _assertNeq(_loanAsset(e, activeLoanId),      0, "Active loan should have asset");
        _assertNeq(_loanCollateral(e, activeLoanId), 0, "Active loan should have collateral");
        _assertAddrEq(_loanLender(e, activeLoanId),   address(this),              "Lender should be test contract");
        _assertAddrEq(_loanBorrower(e, activeLoanId), address(e.borrowerAgent),   "Borrower should be borrowerAgent");
    }

    // =========================================================================
    // 6. TAKE UP LOAN — NEGATIVE
    // =========================================================================

    function testFail_TakeUpLoan_SameId() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 id = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        e.factory.takeUpLoan(id, id);
    }

    function testFail_TakeUpLoan_WhenPaused() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        uint256 collateralAmt = 1 * 1e8;
        e.wbtc.approve(address(e.factory), collateralAmt);
        uint256 borrowId = e.factory.createLoan(0, collateralAmt, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        e.factory.pause();
        e.factory.takeUpLoan(borrowId, lendId);
    }

    function testFail_TakeUpLoan_Unauthorized() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        uint256 collateralAmt = 1 * 1e8;
        e.wbtc.approve(address(e.factory), collateralAmt);
        uint256 borrowId = e.factory.createLoan(0, collateralAmt, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        Attacker atk = new Attacker(address(e.factory));
        atk.tryTakeUpLoan(borrowId, lendId);
    }
}
