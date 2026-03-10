// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";

/// @title Test2_LoanCalcCreate
/// @notice Solidity unit tests for LoanCalculator (pure math) and createLoan.
contract Test2_LoanCalcCreate is TestBase {

    // =========================================================================
    // 3. LOAN CALCULATOR — POSITIVE
    // =========================================================================

    function test_LoanCalc_TotalRepaymentZeroDuration() external pure {
        uint256 result = LoanCalculator.calculateTotalRepayment(1_000 * 1e6, 500, 0);
        require(result == 1_000 * 1e6, "Zero duration: repayment == principal");
    }

    function test_LoanCalc_TotalRepaymentPositive() external pure {
        uint256 result = LoanCalculator.calculateTotalRepayment(1_000 * 1e6, 500, 30);
        require(result > 1_000 * 1e6, "Repayment should exceed principal with interest");
    }

    function test_LoanCalc_TotalRepaymentMonotone() external pure {
        uint256 r30  = LoanCalculator.calculateTotalRepayment(1_000 * 1e6, 500, 30);
        uint256 r365 = LoanCalculator.calculateTotalRepayment(1_000 * 1e6, 500, 365);
        require(r365 > r30, "Longer duration should give higher repayment");
    }

    function test_LoanCalc_TotalRepaymentHigherRate() external pure {
        uint256 rLow  = LoanCalculator.calculateTotalRepayment(1_000 * 1e6, 400, 30);
        uint256 rHigh = LoanCalculator.calculateTotalRepayment(1_000 * 1e6, 1100, 30);
        require(rHigh > rLow, "Higher rate should give higher repayment");
    }

    function test_LoanCalc_TotalRepaymentLargerPrincipal() external pure {
        uint256 r1k  = LoanCalculator.calculateTotalRepayment(1_000 * 1e6,  500, 30);
        uint256 r10k = LoanCalculator.calculateTotalRepayment(10_000 * 1e6, 500, 30);
        // Compound interest scales proportionally with principal (within integer rounding)
        require(r10k >= r1k * 10 - 10 && r10k <= r1k * 10 + 10, "Repayment should scale proportionally with principal");
    }

    function test_LoanCalc_ProratedRepaymentZeroHours() external pure {
        uint256 result = LoanCalculator.calculateProratedRepaymentHourly(1_000 * 1e6, 500, 0);
        require(result == 1_000 * 1e6, "Zero hours: prorated == principal");
    }

    function test_LoanCalc_ProratedRepaymentGrowsWithTime() external pure {
        uint256 r1   = LoanCalculator.calculateProratedRepaymentHourly(1_000 * 1e6, 500, 1);
        uint256 r24  = LoanCalculator.calculateProratedRepaymentHourly(1_000 * 1e6, 500, 24);
        uint256 r720 = LoanCalculator.calculateProratedRepaymentHourly(1_000 * 1e6, 500, 720);
        require(r1 < r24,   "Prorated grows: 1h vs 24h");
        require(r24 < r720, "Prorated grows: 24h vs 720h");
    }

    function test_LoanCalc_PowBase1() external pure {
        uint256 result = LoanCalculator.pow(1e18, 100);
        require(result == 1e18, "1^n should equal 1 (scaled)");
    }

    function test_LoanCalc_PowExponent0() external pure {
        uint256 result = LoanCalculator.pow(2e18, 0);
        require(result == 1e18, "x^0 should equal 1 (scaled)");
    }

    // =========================================================================
    // 4. CREATE LOAN — POSITIVE
    // =========================================================================

    function test_CreateLendOffer_Basic() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);

        uint256 id = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        _assertNeq(id, 0, "Loan ID should not be zero");
        _assertEq(_loanId(e, id), id, "Stored loan ID should match");
        _assertEq(_loanAsset(e, id), assetAmt, "Asset amount mismatch");
        _assertEq(_loanCollateral(e, id), 0, "Collateral should be 0");
        _assertEq(uint256(_loanStatus(e, id)), 0, "Status should be s1");
        _assertAddrEq(_loanLender(e, id), address(this), "Lender mismatch");
    }

    function test_CreateBorrowOffer_Basic() external {
        Env memory e = _deploy();
        uint256 collateralAmt = 1 * 1e8;
        e.wbtc.approve(address(e.factory), collateralAmt);

        uint256 id = e.factory.createLoan(
            0, collateralAmt, 12000, 11000, address(e.usdc), address(e.wbtc), 2, 2
        );

        _assertNeq(id, 0, "Borrow offer ID should not be zero");
        _assertEq(_loanAsset(e, id), 0, "Asset should be 0");
        _assertEq(_loanCollateral(e, id), collateralAmt, "Collateral mismatch");
        _assertEq(uint256(_loanStatus(e, id)), 1, "Status should be s2");
        _assertAddrEq(_loanBorrower(e, id), address(this), "Borrower mismatch");
    }

    function test_CreateLoanIds_AreUnique() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt * 3);

        uint256 id1 = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        uint256 id2 = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        uint256 id3 = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        _assertNeq(id1, id2, "IDs 1 and 2 must differ");
        _assertNeq(id2, id3, "IDs 2 and 3 must differ");
        _assertNeq(id1, id3, "IDs 1 and 3 must differ");
    }

    function test_CreateLoan_AllDurationIndices() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt * 6);

        for (uint8 d = 0; d <= 5; d++) {
            uint256 id = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, d);
            _assertNeq(id, 0, "Each duration index should produce a valid loan");
        }
    }

    function test_CreateLoan_AllRateIndices() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt * 8);

        for (uint8 r = 0; r <= 7; r++) {
            uint256 id = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), r, 1);
            _assertNeq(id, 0, "Each rate index should produce a valid loan");
        }
    }

    function test_CreateLoan_FundsTransferredToFactory() external {
        Env memory e = _deploy();
        uint256 assetAmt = 5_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);

        uint256 before_ = e.usdc.balanceOf(address(e.factory));
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        uint256 after_ = e.usdc.balanceOf(address(e.factory));

        _assertEq(after_ - before_, assetAmt, "Factory should hold lend funds");
    }

    function test_CreateBorrowOffer_CollateralTransferredToFactory() external {
        Env memory e = _deploy();
        uint256 collateralAmt = 2 * 1e8;
        e.wbtc.approve(address(e.factory), collateralAmt);

        uint256 before_ = e.wbtc.balanceOf(address(e.factory));
        e.factory.createLoan(0, collateralAmt, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        uint256 after_ = e.wbtc.balanceOf(address(e.factory));

        _assertEq(after_ - before_, collateralAmt, "Factory should hold borrow collateral");
    }

    function test_CreateLoan_MaxICR() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 id = e.factory.createLoan(assetAmt, 0, 50000, 15000, address(e.usdc), address(e.wbtc), 1, 1);
        _assertNeq(id, 0, "Max ICR loan should be created");
    }

    // =========================================================================
    // 4. CREATE LOAN — NEGATIVE
    // =========================================================================

    function testFail_CreateLoan_BothZero() external {
        Env memory e = _deploy();
        e.factory.createLoan(0, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
    }

    function testFail_CreateLoan_BothNonZero() external {
        Env memory e = _deploy();
        e.usdc.approve(address(e.factory), 1_000 * 1e6);
        e.wbtc.approve(address(e.factory), 1 * 1e8);
        e.factory.createLoan(1_000 * 1e6, 1 * 1e8, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
    }

    function testFail_CreateLoan_InvalidDurationIndex() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 6);
    }

    function testFail_CreateLoan_InvalidRateIndex() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 8, 1);
    }

    function testFail_CreateLoan_ICR_EqualToLT() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 11000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
    }

    function testFail_CreateLoan_ICR_BelowMin() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 10999, 10000, address(e.usdc), address(e.wbtc), 1, 1);
    }

    function testFail_CreateLoan_ICR_AboveMax() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 50001, 11000, address(e.usdc), address(e.wbtc), 1, 1);
    }

    function testFail_CreateLoan_LT_BelowMin() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 12000, 9999, address(e.usdc), address(e.wbtc), 1, 1);
    }

    function testFail_CreateLoan_LT_AboveMax() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 50000, 15001, address(e.usdc), address(e.wbtc), 1, 1);
    }

    function testFail_CreateLoan_UnsupportedPair() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.wbtc), address(e.usdc), 1, 1);
    }

    function testFail_CreateLoan_BelowMinAssetAmount() external {
        Env memory e = _deploy();
        uint256 assetAmt = 50 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
    }

    function testFail_CreateLoan_WhenPaused() external {
        Env memory e = _deploy();
        e.factory.pause();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
    }
}
