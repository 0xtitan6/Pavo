import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, owner, loanFactory, loanCalculatorTest } from "../utils/deployments";
import { transferAndApproveToken, createLoanAndGetId, createLendOfferParams, createBorrowOfferParams, fastForwardTime } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory interruptLoan negative tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  async function createActiveLoan(durationIndex: number): Promise<{ lendOfferId: bigint; loanAmount: bigint }> {
    const collateralAmount = hre.ethers.parseUnits("1.102", 8);
    const loanAmount = hre.ethers.parseUnits("25000", 6);

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
    return { lendOfferId, loanAmount };
  }

  it("Should reject interruptLoan by lender (not borrower)", async function () {
    const { lendOfferId, loanAmount } = await createActiveLoan(2); // 30-day loan

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      loanAmount, await loanFactory.RATE_BPS(1), await loanFactory.DURATION_DAYS(2)
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), totalRepayment, "USDC");

    await expect(loanFactory.connect(lender).interruptLoan(lendOfferId))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject interruptLoan by a third party (owner)", async function () {
    const { lendOfferId, loanAmount } = await createActiveLoan(2);

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      loanAmount, await loanFactory.RATE_BPS(1), await loanFactory.DURATION_DAYS(2)
    );
    await transferAndApproveToken(usdcMock, owner, await loanFactory.getAddress(), totalRepayment, "USDC");

    await expect(loanFactory.connect(owner).interruptLoan(lendOfferId))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject interruptLoan on nonexistent loan", async function () {
    await expect(loanFactory.connect(borrower).interruptLoan(999))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject interruptLoan on a loan offer (not yet active, s2)", async function () {
    const collateralAmount = hre.ethers.parseUnits("1.102", 8);
    const borrowParams = await createBorrowOfferParams(
      collateralAmount, 1, 2, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    await expect(loanFactory.connect(borrower).interruptLoan(borrowOfferId))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject interruptLoan after loan has matured", async function () {
    const { lendOfferId, loanAmount } = await createActiveLoan(0); // 1-day loan

    // Fast forward past maturity
    await fastForwardTime(2);

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      loanAmount, await loanFactory.RATE_BPS(1), await loanFactory.DURATION_DAYS(0)
    );
    await transferAndApproveToken(usdcMock, borrower, await loanFactory.getAddress(), totalRepayment, "USDC");

    await expect(loanFactory.connect(borrower).interruptLoan(lendOfferId))
      .to.be.revertedWith("Loan has already matured");
  });

  it("Should reject interruptLoan when borrower has insufficient USDC allowance", async function () {
    const { lendOfferId } = await createActiveLoan(2); // 30-day loan

    // Borrower approves nothing — safeTransferFrom will revert
    await expect(loanFactory.connect(borrower).interruptLoan(lendOfferId))
      .to.be.reverted; // ERC20 insufficient allowance
  });
});
