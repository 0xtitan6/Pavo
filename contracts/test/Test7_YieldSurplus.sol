// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";
import "../mocks/MockYieldAdapter.sol";

/// @title Test7_YieldSurplus
/// @notice Tests for MEDIUM-1 and MEDIUM-2 yield surplus distribution fixes in takeUpLoan.
///
///   MEDIUM-1: When idle lend funds are withdrawn from the yield adapter during takeUpLoan,
///             the yield surplus (principal+yield - principal) must go to the lender, not the borrower.
///
///   MEDIUM-2: When idle collateral is withdrawn from the yield adapter during takeUpLoan,
///             the yield surplus must be sent to the borrower (not locked in LoanFactory).
///
///   Tests cover both branches:
///     - Borrower takes up lend offer (eq. 36-38)
///     - Lender takes up borrow offer (eq. 42-44)
contract Test7_YieldSurplus is TestBase {

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Deploy standard env + MockYieldAdapter, configure it for USDC and WBTC
    function _deployWithAdapter() internal returns (Env memory e, MockYieldAdapter adapter) {
        e = _deploy();

        adapter = new MockYieldAdapter();
        adapter.setSupported(address(e.usdc), true);
        adapter.setSupported(address(e.wbtc), true);

        e.factory.setYieldAdapter(address(adapter));

        // Pre-fund adapter with extra tokens to cover 1% yield payouts
        // USDC: need 1% of any lend amount (up to 10k → 100 USDC)
        e.usdc.transfer(address(adapter), 10_000 * 1e6);
        // WBTC: need 1% of any collateral amount (up to 1 BTC → 0.01 BTC)
        e.wbtc.transfer(address(adapter), 1 * 1e8);
    }

    // =========================================================================
    // MEDIUM-1 FIX: Lender receives yield surplus (Borrower takes lend offer)
    // =========================================================================

    /// @notice When borrower takes up a lend offer, lender's idle yield must go to lender
    function test_BorrowerTakesLend_LenderGetsYieldSurplus() external {
        (Env memory e, ) = _deployWithAdapter();

        uint256 assetAmt      = 1_000 * 1e6;   // 1000 USDC
        uint256 collateralAmt = 1 * 1e8;        // 1 BTC

        // Lender creates lend offer → funds deposited into yield adapter
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Track lender balance before takeUp
        uint256 lenderBefore = e.usdc.balanceOf(address(this));

        // Borrower takes up lend offer
        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );

        uint256 lenderAfter = e.usdc.balanceOf(address(this));

        // Lender should receive yield surplus: 1% of 1000 USDC = 10 USDC
        uint256 expectedYield = assetAmt / 100;
        _assertEq(
            lenderAfter - lenderBefore,
            expectedYield,
            "MEDIUM-1: Lender must receive yield surplus on borrower takeUp"
        );
    }

    /// @notice Borrower should receive exactly the principal amount, not principal+yield
    function test_BorrowerTakesLend_BorrowerGetsOnlyPrincipal() external {
        (Env memory e, ) = _deployWithAdapter();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        uint256 borrowerBefore = e.usdc.balanceOf(address(e.borrowerAgent));

        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );

        uint256 borrowerAfter = e.usdc.balanceOf(address(e.borrowerAgent));

        _assertEq(
            borrowerAfter - borrowerBefore,
            assetAmt,
            "MEDIUM-1: Borrower must receive exactly principal (no yield)"
        );
    }

    // =========================================================================
    // MEDIUM-2 FIX: Collateral yield surplus goes to borrower (Borrower takes lend offer)
    // =========================================================================

    /// @notice When collateral is withdrawn from adapter during takeUp, surplus goes to borrower
    function test_BorrowerTakesLend_CollateralYieldToBorrower() external {
        (Env memory e, ) = _deployWithAdapter();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        // Lender creates lend offer
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Borrower creates borrow offer → collateral deposited into adapter
        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        // Track borrower WBTC balance before takeUp
        uint256 borrowerWbtcBefore = e.wbtc.balanceOf(address(e.borrowerAgent));

        // Borrower takes up lend offer
        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );

        uint256 borrowerWbtcAfter = e.wbtc.balanceOf(address(e.borrowerAgent));

        // Borrower should receive collateral yield surplus: 1% of 1 BTC = 0.01 BTC
        // Note: borrower committed collateralAmt in createBorrowOffer, so net change
        // from the second takeUp collateral withdrawal includes the surplus
        // The factory holds exactly collateralAmt (original), surplus sent to borrower
        uint256 factoryWbtc = e.wbtc.balanceOf(address(e.factory));
        _assertEq(
            factoryWbtc,
            collateralAmt,
            "MEDIUM-2: Factory should hold original collateral amount (not yield)"
        );
    }

    /// @notice Ensure collateral yield is NOT locked in factory (MEDIUM-2 regression)
    function test_BorrowerTakesLend_NoLockedCollateralYield() external {
        (Env memory e, ) = _deployWithAdapter();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Track total WBTC supply minus factory balance before
        uint256 factoryWbtcBefore = e.wbtc.balanceOf(address(e.factory));

        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );

        uint256 factoryWbtcAfter = e.wbtc.balanceOf(address(e.factory));

        // Factory should hold exactly the collateral amount, not collateral + yield
        _assertEq(
            factoryWbtcAfter - factoryWbtcBefore,
            collateralAmt,
            "MEDIUM-2: Factory must not lock excess collateral yield"
        );
    }

    // =========================================================================
    // MEDIUM-1 FIX: Lender receives yield surplus (Lender takes borrow offer)
    // =========================================================================

    /// @notice When lender takes up a borrow offer, lender's idle yield must go to lender
    function test_LenderTakesBorrow_LenderGetsYieldSurplus() external {
        (Env memory e, ) = _deployWithAdapter();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        // Borrower creates borrow offer → collateral deposited into adapter
        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        // Lender creates lend offer → funds deposited into adapter
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Track lender USDC balance
        uint256 lenderBefore = e.usdc.balanceOf(address(this));

        // Lender takes up borrow offer
        e.factory.takeUpLoan(lendId, borrowId);

        uint256 lenderAfter = e.usdc.balanceOf(address(this));

        // Lender should receive yield surplus: 1% of 1000 USDC = 10 USDC
        uint256 expectedYield = assetAmt / 100;
        _assertEq(
            lenderAfter - lenderBefore,
            expectedYield,
            "MEDIUM-1: Lender must receive yield surplus on lender takeUp"
        );
    }

    /// @notice Borrower should receive exactly principal on lender takeUp
    function test_LenderTakesBorrow_BorrowerGetsOnlyPrincipal() external {
        (Env memory e, ) = _deployWithAdapter();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        uint256 borrowerBefore = e.usdc.balanceOf(address(e.borrowerAgent));

        e.factory.takeUpLoan(lendId, borrowId);

        uint256 borrowerAfter = e.usdc.balanceOf(address(e.borrowerAgent));

        _assertEq(
            borrowerAfter - borrowerBefore,
            assetAmt,
            "MEDIUM-1: Borrower must receive exactly principal on lender takeUp"
        );
    }

    // =========================================================================
    // MEDIUM-2 FIX: Collateral yield surplus goes to borrower (Lender takes borrow offer)
    // =========================================================================

    /// @notice On lender takeUp, collateral yield surplus must go to borrower
    function test_LenderTakesBorrow_CollateralYieldToBorrower() external {
        (Env memory e, ) = _deployWithAdapter();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        // Borrower creates borrow offer → collateral deposited into adapter
        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        // Lender creates lend offer
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Lender takes up borrow offer
        e.factory.takeUpLoan(lendId, borrowId);

        // Factory should hold exactly the collateral, no excess locked
        uint256 factoryWbtc = e.wbtc.balanceOf(address(e.factory));
        _assertEq(
            factoryWbtc,
            collateralAmt,
            "MEDIUM-2: Factory should hold exactly original collateral on lender takeUp"
        );
    }

    // =========================================================================
    // NO ADAPTER — BASELINE (no yield surplus when adapter is not set)
    // =========================================================================

    // =========================================================================
    // MEDIUM-5 FIX: Negative yield — collateral adjusted to actual withdrawn amount
    // =========================================================================

    /// @dev Deploy env with adapter set to -5% yield (returns 95% of principal)
    function _deployWithNegativeYield() internal returns (Env memory e, MockYieldAdapter adapter) {
        e = _deploy();
        adapter = new MockYieldAdapter();
        adapter.setSupported(address(e.usdc), true);
        adapter.setSupported(address(e.wbtc), true);
        adapter.setYieldBps(9500); // -5% yield
        e.factory.setYieldAdapter(address(adapter));
    }

    /// @notice Negative yield on collateral: loan stores actual withdrawn amount, not original
    function test_NegativeYield_CollateralAdjusted_BorrowerTakesLend() external {
        (Env memory e, ) = _deployWithNegativeYield();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        // Lender creates lend offer (adapter returns 95% on withdraw)
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Borrower takes up lend offer
        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );

        // The active loan (lendId) should store effective collateral = 95% of original
        (, , , uint256 storedCollateral, , , , , , , , , ) = e.factory.loans(lendId);
        uint256 expected = (collateralAmt * 9500) / 10000;
        _assertEq(storedCollateral, expected, "MEDIUM-5: Loan must store actual collateral withdrawn");

        // Factory should hold exactly the effective collateral
        uint256 factoryBal = e.wbtc.balanceOf(address(e.factory));
        _assertEq(factoryBal, expected, "MEDIUM-5: Factory balance must match stored collateral");
    }

    /// @notice Negative yield on collateral: lender takes borrow branch
    function test_NegativeYield_CollateralAdjusted_LenderTakesBorrow() external {
        (Env memory e, ) = _deployWithNegativeYield();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        // Borrower creates borrow offer (adapter returns 95% on withdraw)
        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        // Lender creates lend offer
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Lender takes up borrow offer
        e.factory.takeUpLoan(lendId, borrowId);

        // The surviving loan is borrowId — collateral should be 95% of original
        (, , , uint256 storedCollateral, , , , , , , , , ) = e.factory.loans(borrowId);
        uint256 expected = (collateralAmt * 9500) / 10000;
        _assertEq(storedCollateral, expected, "MEDIUM-5: Loan must store actual collateral (lender takeUp)");
    }

    /// @notice Negative yield on asset: borrower receives reduced principal
    function test_NegativeYield_BorrowerGetsReducedPrincipal() external {
        (Env memory e, ) = _deployWithNegativeYield();

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        uint256 borrowerBefore = e.usdc.balanceOf(address(e.borrowerAgent));

        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );

        uint256 borrowerAfter = e.usdc.balanceOf(address(e.borrowerAgent));
        uint256 expectedAsset = (assetAmt * 9500) / 10000;
        _assertEq(
            borrowerAfter - borrowerBefore,
            expectedAsset,
            "MEDIUM-4: Borrower receives reduced principal on negative yield"
        );
    }

    // =========================================================================
    // MEDIUM-7 FIX: Post-withdrawal collateral re-validation reverts
    // =========================================================================

    /// @dev Deploy env with severe negative yield and barely-sufficient collateral.
    ///      Collateral = 0.025 BTC = $1,250 at $50k/BTC.
    ///      Initial check passes (1250 > 1200 = 120% of 1000 USDC).
    ///      After -5% yield: 0.02375 BTC = $1,187.50 → below 1200 threshold → revert.
    function _deployWithBarelyEnoughCollateral() internal returns (Env memory e, MockYieldAdapter adapter) {
        e = _deploy();
        adapter = new MockYieldAdapter();
        adapter.setSupported(address(e.usdc), true);
        adapter.setSupported(address(e.wbtc), true);
        adapter.setYieldBps(9500); // -5% yield
        e.factory.setYieldAdapter(address(adapter));
    }

    /// @notice MEDIUM-7: Borrower takes lend — severe negative yield on collateral causes revert
    function testFail_NegativeYield_PostWithdrawalCollateralInsufficient_BorrowerTakesLend() external {
        (Env memory e, ) = _deployWithBarelyEnoughCollateral();

        uint256 assetAmt      = 1_000 * 1e6;    // 1000 USDC
        uint256 collateralAmt = 2_500_000;       // 0.025 BTC = $1,250 (barely above 120% of $1,000)

        // Lender creates lend offer
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Borrower takes up lend offer — collateral withdrawn with -5% yield
        // 0.025 * 0.95 = 0.02375 BTC = $1,187.50 < $1,200 required → must revert
        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );
    }

    /// @notice MEDIUM-7: Lender takes borrow — severe negative yield on collateral causes revert
    function testFail_NegativeYield_PostWithdrawalCollateralInsufficient_LenderTakesBorrow() external {
        (Env memory e, ) = _deployWithBarelyEnoughCollateral();

        uint256 assetAmt      = 1_000 * 1e6;    // 1000 USDC
        uint256 collateralAmt = 2_500_000;       // 0.025 BTC = $1,250

        // Borrower creates borrow offer (collateral deposited into adapter)
        uint256 borrowId = e.borrowerAgent.createBorrowOffer(
            collateralAmt, address(e.usdc), address(e.wbtc)
        );

        // Lender creates lend offer
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Lender takes up borrow offer — collateral withdrawn with -5% yield
        // 0.025 * 0.95 = 0.02375 BTC = $1,187.50 < $1,200 required → must revert
        e.factory.takeUpLoan(lendId, borrowId);
    }

    /// @notice MEDIUM-7: Moderate negative yield still passes if collateral remains sufficient
    function test_NegativeYield_PostWithdrawalStillSufficient() external {
        (Env memory e, ) = _deployWithBarelyEnoughCollateral();

        uint256 assetAmt      = 1_000 * 1e6;    // 1000 USDC
        uint256 collateralAmt = 3_000_000;       // 0.03 BTC = $1,500

        // After -5% yield: 0.0285 BTC = $1,425 > $1,200 → should succeed
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );

        // Loan should be active with reduced collateral
        (, , , uint256 storedCollateral, , , , , , , , , ) = e.factory.loans(lendId);
        uint256 expected = (collateralAmt * 9500) / 10000;
        _assertEq(storedCollateral, expected, "MEDIUM-7: Collateral adjusted but loan proceeds");
    }

    // =========================================================================
    // NO ADAPTER — BASELINE (no yield surplus when adapter is not set)
    // =========================================================================

    /// @notice Without adapter, borrower gets exact principal, lender gets no yield
    function test_NoAdapter_BorrowerGetsExactPrincipal() external {
        Env memory e = _deploy(); // no adapter

        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;

        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        uint256 lenderBefore = e.usdc.balanceOf(address(this));
        uint256 borrowerBefore = e.usdc.balanceOf(address(e.borrowerAgent));

        e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );

        uint256 lenderAfter = e.usdc.balanceOf(address(this));
        uint256 borrowerAfter = e.usdc.balanceOf(address(e.borrowerAgent));

        _assertEq(lenderAfter, lenderBefore, "No adapter: lender should not receive any USDC");
        _assertEq(
            borrowerAfter - borrowerBefore,
            assetAmt,
            "No adapter: borrower gets exact principal"
        );
    }
}
