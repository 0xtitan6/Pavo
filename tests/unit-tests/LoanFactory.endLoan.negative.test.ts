import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, loanCalculatorTest, LoanStatus } from "../utils/deployments";
import { transferAndApproveToken, createLoanAndGetId, createLendOfferParams, createBorrowOfferParams, fastForwardTime, prepareBorrowerForRepayment } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory endLoan negative tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  async function createActiveLoan(durationIndex: number): Promise<{ lendOfferId: bigint; loanAmount: bigint; collateralAmount: bigint }> {
    const collateralAmount = hre.ethers.parseUnits("1", 8); // 1 BTC = $50,000
    const loanAmount = hre.ethers.parseUnits("25000", 6);   // $25,000

    const borrowParams = await createBorrowOfferParams(
      collateralAmount, 1, durationIndex, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    const lendParams = await createLendOfferParams(
      loanAmount, 1, durationIndex,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), loanAmount, "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    return { lendOfferId, loanAmount, collateralAmount };
  }

  it("Should reject endLoan before maturity", async function () {
    const { lendOfferId, loanAmount } = await createActiveLoan(1); // 7-day loan

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      loanAmount, await loanFactory.RATE_BPS(1), await loanFactory.DURATION_DAYS(1)
    );
    await prepareBorrowerForRepayment(borrower, totalRepayment);

    // Only 3 days elapsed — loan hasn't matured yet
    await fastForwardTime(3);

    await expect(loanFactory.connect(borrower).endLoan(lendOfferId))
      .to.be.revertedWith("Loan has not matured yet");
  });

  it("Should reject endLoan on nonexistent loan", async function () {
    await expect(loanFactory.connect(lender).endLoan(999))
      .to.be.revertedWith("Loan not found or inactive");
  });

  it("Should reject endLoan on a loan offer (s1, not yet active)", async function () {
    const lendParams = await createLendOfferParams(
      hre.ethers.parseUnits("1000", 6), 1, 1,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), hre.ethers.parseUnits("1000", 6), "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    await expect(loanFactory.connect(lender).endLoan(lendOfferId))
      .to.be.revertedWith("Loan not found or inactive");
  });

  it("Should reject double endLoan after first succeeds", async function () {
    const { lendOfferId, loanAmount } = await createActiveLoan(0); // 1-day loan

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      loanAmount, await loanFactory.RATE_BPS(1), await loanFactory.DURATION_DAYS(0)
    );
    await prepareBorrowerForRepayment(borrower, totalRepayment);

    await fastForwardTime(1);
    await loanFactory.connect(borrower).endLoan(lendOfferId);

    // Loan is now deleted — second call must fail
    await expect(loanFactory.connect(borrower).endLoan(lendOfferId))
      .to.be.revertedWith("Loan not found or inactive");
  });
});
