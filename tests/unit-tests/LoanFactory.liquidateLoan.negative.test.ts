import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, owner, loanFactory, mockAggregator, LoanStatus } from "../utils/deployments";
import { transferAndApproveToken, createLoanAndGetId, createLendOfferParams, createBorrowOfferParams, fastForwardTime } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory liquidateLoan negative tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // Shared helper: create and activate a loan
  async function createActiveLoan(
    collateralAmount: bigint,
    loanAmount: bigint,
    rateIndex: number,
    durationIndex: number,
    initRatio: number,
    liqThreshold: number
  ): Promise<{ lendOfferId: bigint }> {
    const borrowParams = await createBorrowOfferParams(
      collateralAmount, rateIndex, durationIndex, initRatio, liqThreshold,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    const lendParams = await createLendOfferParams(
      loanAmount, rateIndex, durationIndex,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      initRatio, liqThreshold
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), loanAmount, "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    return { lendOfferId };
  }

  it("Should reject liquidation by non-lender (borrower)", async function () {
    const collateral = hre.ethers.parseUnits("0.601", 8);
    const { lendOfferId } = await createActiveLoan(collateral, hre.ethers.parseUnits("25000", 6), 7, 5, 12000, 11000);

    // Drop price to make it liquidatable
    await mockAggregator.setAnswer(40_000n * 10n ** 8n);

    await expect(loanFactory.connect(borrower).liquidateLoan(lendOfferId))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject liquidation by a third party (owner)", async function () {
    const collateral = hre.ethers.parseUnits("0.601", 8);
    const { lendOfferId } = await createActiveLoan(collateral, hre.ethers.parseUnits("25000", 6), 7, 5, 12000, 11000);

    await mockAggregator.setAnswer(40_000n * 10n ** 8n);

    await expect(loanFactory.connect(owner).liquidateLoan(lendOfferId))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject liquidation of nonexistent loan", async function () {
    await expect(loanFactory.connect(lender).liquidateLoan(999))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject liquidation of a loan offer (not yet active, s1)", async function () {
    const lendParams = await createLendOfferParams(
      hre.ethers.parseUnits("1000", 6), 1, 1,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), hre.ethers.parseUnits("1000", 6), "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    await expect(loanFactory.connect(lender).liquidateLoan(lendOfferId))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject liquidation when health is above threshold", async function () {
    // 2 BTC at $50k = $100,000. Loan = $25,000. Health = 400% >> 110%
    const collateral = hre.ethers.parseUnits("2", 8);
    const { lendOfferId } = await createActiveLoan(collateral, hre.ethers.parseUnits("25000", 6), 1, 5, 12000, 11000);

    await expect(loanFactory.connect(lender).liquidateLoan(lendOfferId))
      .to.be.revertedWith("Health above liquidation threshold");
  });

  it("Should reject liquidation after loan has matured (C-2 fix)", async function () {
    // 1 BTC at $50k = $50,000. Loan = $25,000. Healthy — but we fast-forward past maturity.
    const collateral = hre.ethers.parseUnits("1", 8);
    const { lendOfferId } = await createActiveLoan(
      collateral, hre.ethers.parseUnits("25000", 6),
      7, 0, // durationIndex 0 = 1 day
      12000, 11000
    );

    // Fast forward past maturity (1 day)
    await fastForwardTime(2);

    // Even if we drop price, lender must use endLoan after maturity
    await mockAggregator.setAnswer(1_000n * 10n ** 8n); // extreme drop

    await expect(loanFactory.connect(lender).liquidateLoan(lendOfferId))
      .to.be.revertedWith("Loan matured: use endLoan");
  });
});
