// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";

/// @title Test5_TopUpAdmin
/// @notice Solidity unit tests for topUp and admin functions.
contract Test5_TopUpAdmin is TestBase {

    // =========================================================================
    // 10. TOP UP — POSITIVE
    // =========================================================================

    function test_TopUp_IncreasesCollateral() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);

        uint256 extra = 5e6; // 0.05 BTC — borrowerAgent already has 10 BTC seeded
        uint256 collBefore = _loanCollateral(e, activeLoanId);
        e.borrowerAgent.topUp(address(e.wbtc), activeLoanId, extra);
        uint256 collAfter  = _loanCollateral(e, activeLoanId);

        _assertEq(collAfter - collBefore, extra, "Collateral should increase by top-up amount");
    }

    function test_TopUp_TransfersFundsToFactory() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);

        uint256 extra = 1e7; // 0.1 BTC
        uint256 factoryBefore = e.wbtc.balanceOf(address(e.factory));
        e.borrowerAgent.topUp(address(e.wbtc), activeLoanId, extra);
        uint256 factoryAfter  = e.wbtc.balanceOf(address(e.factory));

        _assertEq(factoryAfter - factoryBefore, extra, "Factory BTC balance should increase");
    }

    function test_TopUp_MultipleTopUpsAccumulate() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);

        uint256 extra = 5e6;
        uint256 collBefore = _loanCollateral(e, activeLoanId);
        e.borrowerAgent.topUp(address(e.wbtc), activeLoanId, extra);
        e.borrowerAgent.topUp(address(e.wbtc), activeLoanId, extra);
        e.borrowerAgent.topUp(address(e.wbtc), activeLoanId, extra);
        uint256 collAfter = _loanCollateral(e, activeLoanId);

        _assertEq(collAfter - collBefore, extra * 3, "Three top-ups should accumulate");
    }

    // =========================================================================
    // 10. TOP UP — NEGATIVE
    // =========================================================================

    function testFail_TopUp_ZeroAmount() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);
        e.factory.topUp(activeLoanId, 0);
    }

    function testFail_TopUp_NotBorrower() external {
        Env memory e = _deploy();
        uint256 activeLoanId = _createAndMatchLoan(e);

        Attacker atk = new Attacker(address(e.factory));
        e.wbtc.transfer(address(atk), 1e6);
        atk.tryTopUp(activeLoanId, 1e6);
    }

    function testFail_TopUp_NotActiveLoan() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        e.wbtc.approve(address(e.factory), 1e6);
        e.factory.topUp(lendId, 1e6);
    }

    function testFail_TopUp_NonExistent() external {
        Env memory e = _deploy();
        e.wbtc.approve(address(e.factory), 1e6);
        e.factory.topUp(9999, 1e6);
    }

    // =========================================================================
    // 11. ADMIN — POSITIVE
    // =========================================================================

    function test_Admin_SetProtocolFee() external {
        Env memory e = _deploy();
        e.factory.setProtocolFee(100);
        _assertEq(e.factory.protocolFeeBps(), 100, "Protocol fee should be 100 bps");
    }

    function test_Admin_SetFeeRecipient() external {
        Env memory e = _deploy();
        address feeAddr = address(0xFEE);
        e.factory.setFeeRecipient(feeAddr);
        _assertAddrEq(e.factory.feeRecipient(), feeAddr, "Fee recipient mismatch");
    }

    function test_Admin_FeeCollectedOnLendOffer() external {
        Env memory e = _deploy();
        address feeRecipient = address(0xFEE);
        e.factory.setProtocolFee(100);
        e.factory.setFeeRecipient(feeRecipient);

        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        uint256 expectedFee = (assetAmt * 100) / 10000;
        _assertEq(e.usdc.balanceOf(feeRecipient), expectedFee, "Fee recipient should receive 1%");
    }

    function test_Admin_FeeCollectedOnBorrowOffer() external {
        Env memory e = _deploy();
        address feeRecipient = address(0xFEE);
        e.factory.setProtocolFee(100);
        e.factory.setFeeRecipient(feeRecipient);

        uint256 collateralAmt = 1 * 1e8;
        e.wbtc.approve(address(e.factory), collateralAmt);
        e.factory.createLoan(0, collateralAmt, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);

        uint256 expectedFee = (collateralAmt * 100) / 10000;
        _assertEq(e.wbtc.balanceOf(feeRecipient), expectedFee, "Fee recipient should receive 1% of collateral");
    }

    function test_Admin_Pause_Unpause() external {
        Env memory e = _deploy();
        e.factory.pause();
        _check(e.factory.paused(), "Factory should be paused");
        e.factory.unpause();
        _check(!e.factory.paused(), "Factory should be unpaused");
    }

    function test_Admin_ZeroFeeNoDeduction() external {
        Env memory e = _deploy();
        uint256 assetAmt = 1_000 * 1e6;
        e.usdc.approve(address(e.factory), assetAmt);

        uint256 before_ = e.usdc.balanceOf(address(e.factory));
        e.factory.createLoan(assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1);
        uint256 after_  = e.usdc.balanceOf(address(e.factory));

        _assertEq(after_ - before_, assetAmt, "Full amount in factory (zero fee)");
    }

    function test_Admin_SetMorphoAdapterToZero() external {
        Env memory e = _deploy();
        e.factory.setMorphoAdapter(address(0));
        _assertAddrEq(address(e.factory.yieldAdapter()), address(0), "Morpho adapter should be zero");
    }

    // =========================================================================
    // 11. ADMIN — NEGATIVE
    // =========================================================================

    function testFail_Admin_SetProtocolFeeExceedsMax() external {
        Env memory e = _deploy();
        e.factory.setProtocolFee(501);
    }

    function testFail_Admin_PauseNotOwner() external {
        Env memory e = _deploy();
        Attacker atk = new Attacker(address(e.factory));
        atk.tryPause();
    }

    function testFail_Admin_UnpauseNotOwner() external {
        Env memory e = _deploy();
        e.factory.pause();
        Attacker atk = new Attacker(address(e.factory));
        atk.tryUnpause();
    }

    function testFail_Admin_SetFeeNotOwner() external {
        Env memory e = _deploy();
        Attacker atk = new Attacker(address(e.factory));
        atk.trySetFee(100);
    }

    function testFail_Admin_LoanFactory_ZeroOracle() external {
        Env memory e = _deploy();
        new LoanFactory(address(0), address(e.registry), address(0), 0);
    }

    function testFail_Admin_LoanFactory_ZeroRegistry() external {
        Env memory e = _deploy();
        new LoanFactory(address(e.oracle), address(0), address(0), 0);
    }

    function testFail_Admin_LoanFactory_FeeTooHigh() external {
        Env memory e = _deploy();
        new LoanFactory(address(e.oracle), address(e.registry), address(0), 501);
    }

    function testFail_Admin_PriceOracle_ZeroOwner() external {
        new PriceOracle(address(0));
    }
}
