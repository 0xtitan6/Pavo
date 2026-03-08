import { expect } from "chai";
import hre from "hardhat";
import {
  deployContracts,
  usdcMock, btcMock, lender, borrower, owner, loanFactory, mockAggregator
} from "../utils/deployments";
import {
  transferAndApproveToken, createLoanAndGetId,
  createLendOfferParams, createBorrowOfferParams, fastForwardTime
} from "../utils/loanHelpers";

describe("LoanFactory pause tests (H-4)", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  async function makeLendOffer(assetAmount: bigint) {
    const params = await createLendOfferParams(
      assetAmount, 1, 2,
      await usdcMock.getAddress(), await btcMock.getAddress(), 12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const [id] = await createLoanAndGetId(lender, params);
    return id;
  }

  async function makeBorrowOffer(collateralAmount: bigint) {
    const params = await createBorrowOfferParams(
      collateralAmount, 1, 2, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");
    const [id] = await createLoanAndGetId(borrower, params);
    return id;
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  it("Should allow owner to pause and unpause", async function () {
    expect(await loanFactory.paused()).to.equal(false);
    await loanFactory.connect(owner).pause();
    expect(await loanFactory.paused()).to.equal(true);
    await loanFactory.connect(owner).unpause();
    expect(await loanFactory.paused()).to.equal(false);
  });

  it("Should reject pause from non-owner", async function () {
    await expect(loanFactory.connect(lender).pause()).to.be.reverted;
  });

  it("Should reject unpause from non-owner", async function () {
    await loanFactory.connect(owner).pause();
    await expect(loanFactory.connect(lender).unpause()).to.be.reverted;
  });

  // ── createLoan blocked when paused ────────────────────────────────────────

  it("Should revert createLoan (lend) when paused", async function () {
    await loanFactory.connect(owner).pause();

    const amount = hre.ethers.parseUnits("25000", 6);
    await usdcMock.transfer(lender.address, amount);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), amount);

    await expect(
      loanFactory.connect(lender).createLoan(
        amount, 0n, 12000, 11000,
        await usdcMock.getAddress(), await btcMock.getAddress(), 1, 2
      )
    ).to.be.reverted; // EnforcedPause
  });

  it("Should revert createLoan (borrow) when paused", async function () {
    await loanFactory.connect(owner).pause();

    const amount = hre.ethers.parseUnits("1.102", 8);
    await btcMock.transfer(borrower.address, amount);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), amount);

    await expect(
      loanFactory.connect(borrower).createLoan(
        0n, amount, 12000, 11000,
        await usdcMock.getAddress(), await btcMock.getAddress(), 1, 2
      )
    ).to.be.reverted;
  });

  // ── takeUpLoan blocked when paused ────────────────────────────────────────

  it("Should revert takeUpLoan when paused", async function () {
    // Create offers while unpaused
    const borrowOfferId = await makeBorrowOffer(hre.ethers.parseUnits("1.102", 8));
    const lendOfferId = await makeLendOffer(hre.ethers.parseUnits("25000", 6));

    await loanFactory.connect(owner).pause();

    await expect(loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId))
      .to.be.reverted;
  });

  // ── Lifecycle ops unaffected by pause ─────────────────────────────────────

  it("Should allow cancelLoan while paused", async function () {
    const lendOfferId = await makeLendOffer(hre.ethers.parseUnits("25000", 6));
    await loanFactory.connect(owner).pause();
    await expect(loanFactory.connect(lender).cancelLoan(lendOfferId)).to.not.be.reverted;
  });

  it("Should allow endLoan while paused (after maturity)", async function () {
    // Create and match a loan before pausing
    const borrowOfferId = await makeBorrowOffer(hre.ethers.parseUnits("1.102", 8));
    const lendOfferId = await makeLendOffer(hre.ethers.parseUnits("25000", 6));
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);

    // Get the active loan ID (it's lendOfferId after takeUpLoan merges borrow into lend)
    await loanFactory.connect(owner).pause();
    await fastForwardTime(31); // past 30-day duration

    await expect(loanFactory.connect(lender).endLoan(lendOfferId)).to.not.be.reverted;
  });

  it("Should allow interruptLoan while paused", async function () {
    const borrowOfferId = await makeBorrowOffer(hre.ethers.parseUnits("1.102", 8));
    const lendOfferId = await makeLendOffer(hre.ethers.parseUnits("25000", 6));
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);

    await loanFactory.connect(owner).pause();

    // Prepare borrower to repay
    const loan = await loanFactory.loans(lendOfferId);
    const totalRepayment = (loan.asset * 11n) / 10n; // rough overshoot
    await usdcMock.transfer(borrower.address, totalRepayment);
    await usdcMock.connect(borrower).approve(await loanFactory.getAddress(), totalRepayment);

    await expect(loanFactory.connect(borrower).interruptLoan(lendOfferId)).to.not.be.reverted;
  });

  it("Should allow liquidateLoan while paused", async function () {
    const borrowOfferId = await makeBorrowOffer(hre.ethers.parseUnits("1.102", 8));
    const lendOfferId = await makeLendOffer(hre.ethers.parseUnits("25000", 6));
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);

    await loanFactory.connect(owner).pause();

    // Crash BTC price to trigger liquidation
    await mockAggregator.setAnswer(1_000n * 10n ** 8n); // $1,000 — far below threshold

    await expect(loanFactory.connect(lender).liquidateLoan(lendOfferId)).to.not.be.reverted;
  });
});
