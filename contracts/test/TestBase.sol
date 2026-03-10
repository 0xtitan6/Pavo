// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../LoanFactory.sol";
import "../AssetRegistry.sol";
import "../PriceOracle.sol";
import "../libraries/LoanCalculator.sol";
import "../mocks/ERC20Mock.sol";
import "../mocks/MockAggregatorV3.sol";

/// @title TestBase
/// @notice Shared fixture and helpers for all ParthenonFi Solidity test contracts.
abstract contract TestBase {

    int256 constant BTC_PRICE = 50_000 * 1e8; // $50 000 with 8 feed decimals

    struct Env {
        ERC20Mock usdc;
        ERC20Mock wbtc;
        MockAggregatorV3 feed;
        AssetRegistry registry;
        PriceOracle oracle;
        LoanFactory factory;
        // Separate agent so lender != borrower (required by takeUpLoan)
        BorrowerAgent borrowerAgent;
    }

    // ── Assertion helpers ────────────────────────────────────────────────────

    function _check(bool cond, string memory err) internal pure {
        require(cond, err);
    }

    function _assertEq(uint256 a, uint256 b, string memory err) internal pure {
        require(a == b, err);
    }

    function _assertAddrEq(address a, address b, string memory err) internal pure {
        require(a == b, err);
    }

    function _assertNeq(uint256 a, uint256 b, string memory err) internal pure {
        require(a != b, err);
    }

    function _assertGt(uint256 a, uint256 b, string memory err) internal pure {
        require(a > b, err);
    }

    // ── Fixture ──────────────────────────────────────────────────────────────

    function _deploy() internal returns (Env memory e) {
        e.usdc = new ERC20Mock("USD Coin",    "USDC", address(this), 10_000_000 * 1e6, 6);
        e.wbtc = new ERC20Mock("Wrapped BTC", "WBTC", address(this), 100 * 1e8,        8);
        e.feed = new MockAggregatorV3(8, BTC_PRICE);

        e.registry = new AssetRegistry();
        e.registry.registerAsset(address(e.wbtc), "WBTC", "BTC/USD", 8);
        e.registry.registerAsset(address(e.usdc), "USDC", "",        6);
        e.registry.setAssetSupported(address(e.wbtc), true);
        e.registry.setAssetSupported(address(e.usdc), true);
        e.registry.setPairSupported(address(e.wbtc), address(e.usdc), true);

        e.oracle = new PriceOracle(address(this));
        e.oracle.setFeed(address(e.wbtc), address(e.feed), 400 days);

        e.factory = new LoanFactory(
            address(e.oracle), address(e.registry), address(0), 0
        );

        // Deploy a separate borrower agent so lender != borrower in takeUpLoan
        e.borrowerAgent = new BorrowerAgent(address(e.factory));
        // Seed borrower agent with WBTC
        e.wbtc.transfer(address(e.borrowerAgent), 10 * 1e8);
    }

    // ── Loan struct field helpers (public mapping returns tuple) ─────────────

    function _loanStatus(Env memory e, uint256 id) internal view returns (ILoanFactory.Status s) {
        (,,,,,,,,,,,,s) = e.factory.loans(id);
    }

    function _loanId(Env memory e, uint256 id) internal view returns (uint256 lid) {
        (lid,,,,,,,,,,,,) = e.factory.loans(id);
    }

    function _loanAsset(Env memory e, uint256 id) internal view returns (uint256 asset) {
        (,, asset,,,,,,,,,,) = e.factory.loans(id);
    }

    function _loanCollateral(Env memory e, uint256 id) internal view returns (uint256 coll) {
        (,,, coll,,,,,,,,,) = e.factory.loans(id);
    }

    function _loanLender(Env memory e, uint256 id) internal view returns (address lender) {
        (,,,,,, lender,,,,,,) = e.factory.loans(id);
    }

    function _loanBorrower(Env memory e, uint256 id) internal view returns (address borrower) {
        (,,,,,,, borrower,,,,,) = e.factory.loans(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // _createAndMatchLoan
    //
    // address(this)       = lender  (creates lend offer, msg.sender for takeUpLoan)
    // e.borrowerAgent     = borrower (separate contract address, creates borrow offer,
    //                                then takes up the lend offer via takeUpLoan)
    //
    // takeUpLoan flow: borrowerAgent calls takeUpLoan(borrowId, lendId)
    //   → msg.sender = borrowerAgent.address (borrower of borrowId, != lender of lendId)
    //   → branches into "Borrower takes up lend offer"
    // ─────────────────────────────────────────────────────────────────────────

    function _createAndMatchLoan(Env memory e) internal returns (uint256 activeLoanId) {
        uint256 assetAmt      = 1_000 * 1e6;
        uint256 collateralAmt = 1 * 1e8;       // 1 BTC = $50 000 >> $1 000 loan

        // Lender (address(this)) creates lend offer
        e.usdc.approve(address(e.factory), assetAmt);
        uint256 lendId = e.factory.createLoan(
            assetAmt, 0, 12000, 11000, address(e.usdc), address(e.wbtc), 1, 1
        );

        // Borrower agent creates borrow offer and immediately takes up lend offer
        uint256 borrowId = e.borrowerAgent.createBorrowOfferAndTakeUp(
            collateralAmt, address(e.usdc), address(e.wbtc), lendId
        );
        (borrowId); // suppress unused warning — borrowId is deleted after takeUp

        activeLoanId = lendId; // lend offer is now the active s3 loan
    }

    /// @dev Warp time via Hevm/Hardhat cheatcode
    function _warpDays(uint256 numDays) internal {
        uint256 target = block.timestamp + numDays * 1 days;
        address vm = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;
        (bool ok,) = vm.call(abi.encodeWithSelector(bytes4(0xe5d6bf02), target));
        (ok);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BorrowerAgent
// A thin proxy that acts as the borrower. Deployed at a different address
// than the test contract (lender), satisfying the lender != borrower invariant
// in takeUpLoan.
// ─────────────────────────────────────────────────────────────────────────────

contract BorrowerAgent {
    LoanFactory private immutable factory;

    constructor(address _factory) {
        factory = LoanFactory(_factory);
    }

    /// @notice Creates a borrow offer and immediately takes up an existing lend offer.
    /// @return borrowId The ID of the (now-deleted) borrow offer
    function createBorrowOfferAndTakeUp(
        uint256 collateralAmt,
        address assetAddress,
        address collateralAddress,
        uint256 lendId
    ) external returns (uint256 borrowId) {
        // Approve collateral to LoanFactory
        IERC20(collateralAddress).approve(address(factory), collateralAmt);

        // Create borrow offer (s2)
        borrowId = factory.createLoan(
            0, collateralAmt, 12000, 11000,
            assetAddress, collateralAddress, 1, 1
        );

        // Take up lend offer: borrower (this) takes the lend offer
        // takeUpId = borrowId (s2, owned by this contract)
        // offerId  = lendId   (s1, owned by the test contract = lender)
        factory.takeUpLoan(borrowId, lendId);
    }

    /// @notice Creates a borrow offer only (does not take up anything)
    /// @return borrowId The ID of the created borrow offer
    function createBorrowOffer(
        uint256 collateralAmt,
        address assetAddress,
        address collateralAddress
    ) external returns (uint256 borrowId) {
        IERC20(collateralAddress).approve(address(factory), collateralAmt);
        borrowId = factory.createLoan(
            0, collateralAmt, 12000, 11000,
            assetAddress, collateralAddress, 1, 1
        );
    }

    /// @notice Creates a borrow offer with a custom asset token (for M-6 mismatch tests)
    function createBorrowOfferAsset(
        uint256 collateralAmt,
        address assetAddress,
        address collateralAddress
    ) external returns (uint256 borrowId) {
        IERC20(collateralAddress).approve(address(factory), collateralAmt);
        borrowId = factory.createLoan(
            0, collateralAmt, 12000, 11000,
            assetAddress, collateralAddress, 1, 1
        );
    }

    /// @notice Repay an active loan early (borrower interrupt)
    function interruptLoan(address usdcToken, uint256 loanId, uint256 repaymentApproval) external {
        IERC20(usdcToken).approve(address(factory), repaymentApproval);
        factory.interruptLoan(loanId);
    }

    /// @notice Top up collateral on an active loan
    function topUp(address collateralToken, uint256 loanId, uint256 amount) external {
        IERC20(collateralToken).approve(address(factory), amount);
        factory.topUp(loanId, amount);
    }

    /// @notice Receive WBTC (for topUp or collateral refunds)
    receive() external payable {}
}

/// @notice Generic attacker that tries to call restricted LoanFactory functions
contract Attacker {
    LoanFactory private factory;

    constructor(address _factory) { factory = LoanFactory(_factory); }

    function tryCancelLoan(uint256 id) external     { factory.cancelLoan(id); }
    function tryInterruptLoan(uint256 id) external  { factory.interruptLoan(id); }
    function tryTopUp(uint256 id, uint256 amt) external { factory.topUp(id, amt); }
    function tryTakeUpLoan(uint256 a, uint256 b) external { factory.takeUpLoan(a, b); }
    function tryPause() external                    { factory.pause(); }
    function tryUnpause() external                  { factory.unpause(); }
    function trySetFee(uint256 bps) external        { factory.setProtocolFee(bps); }
}
