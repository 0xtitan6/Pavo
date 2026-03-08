import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { transferAndApproveToken, createLoanAndGetId, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory cancelLoan negative tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should reject cancel of nonexistent loan (id 0)", async function () {
    await expect(loanFactory.connect(lender).cancelLoan(0))
      .to.be.revertedWith("Loan does not exist");
  });

  it("Should reject cancel of nonexistent loan (id never created)", async function () {
    await expect(loanFactory.connect(lender).cancelLoan(999))
      .to.be.revertedWith("Loan does not exist");
  });

  it("Should reject cancel of an active loan (s3)", async function () {
    // Set up and activate a loan
    const borrowCollateralAmount = hre.ethers.parseUnits("1.102", 8);
    const borrowParams = await createBorrowOfferParams(
      borrowCollateralAmount, 1, 2, 11000, 10000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    const lendAssetAmount = hre.ethers.parseUnits("25000", 6);
    const lendParams = await createLendOfferParams(
      lendAssetAmount, 1, 2,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      11000, 10000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendAssetAmount, "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);

    // lendOfferId is now active (s3) — cancel should fail
    await expect(loanFactory.connect(lender).cancelLoan(lendOfferId))
      .to.be.revertedWith("Loan not in cancellable state");
  });

  it("Should reject cancel by a third party (not lender or borrower)", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const lendParams = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const [loanId] = await createLoanAndGetId(lender, lendParams);

    // borrower (a third party) tries to cancel lender's offer
    await expect(loanFactory.connect(borrower).cancelLoan(loanId))
      .to.be.revertedWith("Only loan creator can cancel");
  });

  it("Should reject double-cancel of the same offer", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const lendParams = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const [loanId] = await createLoanAndGetId(lender, lendParams);

    await loanFactory.connect(lender).cancelLoan(loanId);

    // Second cancel should fail — loan no longer exists
    await expect(loanFactory.connect(lender).cancelLoan(loanId))
      .to.be.revertedWith("Loan does not exist");
  });
});
