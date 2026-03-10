// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";

/// @title Test4_EndInterruptLiquidate
/// @notice Solidity unit tests for endLoan, interruptLoan, and liquidateLoan.
///
/// For time-sensitive tests the TypeScript runner uses a two-step protocol:
///   1. call setup_<TestName>() — deploys env and creates an active loan, persists Env in storage
///   2. TypeScript warps EVM time
///   3. call test_<TestName>()  — runs the actual assertion
///
/// Non-time-sensitive tests are single-call as usual.
contract Test4_EndInterruptLiquidate is TestBase {

    // Persistent env for two-step tests
    Env private _e;
    uint256 private _activeLoanId;

    // =========================================================================
    // 7. END LOAN — two-step setup/test pair
    // =========================================================================

    function setup_EndLoan() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
    }

    function test_EndLoan_AfterMaturity() external {
        uint256 lenderWbtcBefore = _e.wbtc.balanceOf(address(this));
        _e.factory.endLoan(_activeLoanId);
        uint256 lenderWbtcAfter  = _e.wbtc.balanceOf(address(this));
        _assertGt(lenderWbtcAfter, lenderWbtcBefore, "Lender should receive BTC at maturity");
    }

    function test_EndLoan_LoanDeleted() external {
        _e.factory.endLoan(_activeLoanId);
        _assertEq(_loanId(_e, _activeLoanId), 0, "Loan should be deleted after endLoan");
    }

    function test_EndLoan_FactoryBalanceZeroAfterSettlement() external {
        _e.factory.endLoan(_activeLoanId);
        _assertEq(_e.wbtc.balanceOf(address(_e.factory)), 0, "Factory WBTC should be zero");
        _assertEq(_e.usdc.balanceOf(address(_e.factory)), 0, "Factory USDC should be zero");
    }

    // =========================================================================
    // 7. END LOAN — NEGATIVE (single-call; no maturity warp needed for most)
    // =========================================================================

    function testFail_EndLoan_BeforeMaturity() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);
        e.factory.endLoan(activeLoanId); // no time warp → should revert
    }

    // Two-step negative: try endLoan on a non-active (s1) loan after warp
    function setup_EndLoan_Negative() external {
        _e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        _e.usdc.approve(address(_e.factory), assetAmt);
        _activeLoanId = _e.factory.createLoan(assetAmt, 0, 12000, 11000, address(_e.usdc), address(_e.wbtc), 1, 1);
    }

    function testFail_EndLoan_NotActiveStatus() external {
        _e.factory.endLoan(_activeLoanId); // s1 → revert
    }

    function testFail_EndLoan_NonExistent() external {
        _e.factory.endLoan(9999);
    }

    function testFail_EndLoan_Twice() external {
        _e.factory.endLoan(_activeLoanId);
        _e.factory.endLoan(_activeLoanId);
    }

    // =========================================================================
    // 8. INTERRUPT LOAN — two-step setup/test pair
    // =========================================================================

    function setup_InterruptLoan() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
    }

    function test_InterruptLoan_BorrowerEarlyRepayment() external {
        uint256 repayment = LoanCalculator.calculateTotalRepayment(
            1_000 * 1e6, _e.factory.RATE_BPS(1), _e.factory.DURATION_DAYS(1)
        );
        // Fund borrowerAgent with USDC for repayment
        _e.usdc.transfer(address(_e.borrowerAgent), repayment);

        uint256 wbtcBefore = _e.wbtc.balanceOf(address(_e.borrowerAgent));
        _e.borrowerAgent.interruptLoan(address(_e.usdc), _activeLoanId, repayment);
        uint256 wbtcAfter  = _e.wbtc.balanceOf(address(_e.borrowerAgent));

        _assertGt(wbtcAfter, wbtcBefore, "Borrower should receive full collateral back");
    }

    function test_InterruptLoan_LoanDeleted() external {
        uint256 repayment = LoanCalculator.calculateTotalRepayment(
            1_000 * 1e6, _e.factory.RATE_BPS(1), _e.factory.DURATION_DAYS(1)
        );
        _e.usdc.transfer(address(_e.borrowerAgent), repayment);
        _e.borrowerAgent.interruptLoan(address(_e.usdc), _activeLoanId, repayment);

        _assertEq(_loanId(_e, _activeLoanId), 0, "Loan deleted after interrupt");
    }

    // =========================================================================
    // 8. INTERRUPT LOAN — NEGATIVE
    // =========================================================================

    function testFail_InterruptLoan_AfterMaturity() external {
        // Uses stored _e/_activeLoanId set by setup_InterruptLoan (with time warped past maturity)
        uint256 repayment = LoanCalculator.calculateTotalRepayment(
            1_000 * 1e6, _e.factory.RATE_BPS(1), _e.factory.DURATION_DAYS(1)
        );
        _e.usdc.transfer(address(_e.borrowerAgent), repayment);
        _e.borrowerAgent.interruptLoan(address(_e.usdc), _activeLoanId, repayment);
    }

    function testFail_InterruptLoan_NotBorrower() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);
        Attacker atk = new Attacker(address(e.factory));
        atk.tryInterruptLoan(activeLoanId);
    }

    function testFail_InterruptLoan_NotActiveLoan() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        e.factory.interruptLoan(lendId);
    }

    function testFail_InterruptLoan_NonExistent() external {
        Env memory e = _deploy();
        e.factory.interruptLoan(9999);
    }

    // =========================================================================
    // 9. LIQUIDATE LOAN — two-step setup/test pair
    // =========================================================================

    function setup_LiquidateLoan() external {
        _e = _deploy();
        _activeLoanId = _createAndMatchLoan(_e);
        // Crash price to $100/BTC — collateral value = $100, loan = $1000 → undercollateralized
        _e.feed.setAnswer(int256(BTC_PRICE / 500));
    }

    function test_LiquidateLoan_WhenUnderCollateralized() external {
        uint256 wbtcBefore = _e.wbtc.balanceOf(address(this));
        _e.factory.liquidateLoan(_activeLoanId);
        uint256 wbtcAfter  = _e.wbtc.balanceOf(address(this));
        _assertGt(wbtcAfter, wbtcBefore, "Lender should receive BTC on liquidation");
    }

    function test_LiquidateLoan_LoanDeleted() external {
        _e.factory.liquidateLoan(_activeLoanId);
        _assertEq(_loanId(_e, _activeLoanId), 0, "Loan deleted after liquidation");
    }

    function test_LiquidateLoan_FactoryBalanceZero() external {
        _e.factory.liquidateLoan(_activeLoanId);
        _assertEq(_e.wbtc.balanceOf(address(_e.factory)), 0, "Factory WBTC zero after liquidation");
    }

    // =========================================================================
    // 9. LIQUIDATE LOAN — NEGATIVE
    // =========================================================================

    function testFail_LiquidateLoan_HealthyLoan() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);
        e.factory.liquidateLoan(activeLoanId); // price unchanged → healthy
    }

    // Two-step negative: after maturity, liquidation should fail (use endLoan instead)
    // Uses setup_EndLoan (same setup: active loan) + time warp
    function testFail_LiquidateLoan_AfterMaturity() external {
        _e.feed.setAnswer(int256(BTC_PRICE / 10));
        _e.factory.liquidateLoan(_activeLoanId); // past maturity → must use endLoan
    }

    function testFail_LiquidateLoan_NotActiveLoan() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        e.factory.liquidateLoan(lendId);
    }

    function testFail_LiquidateLoan_NonExistent() external {
        Env memory e = _deploy();
        e.factory.liquidateLoan(9999);
    }
}
