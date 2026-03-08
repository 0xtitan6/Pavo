import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyTokenBalances, verifyLoanDeleted, cancelLoanAndVerify, verifyCancelledEvent, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory cancelLoan tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should cancel a lend offer successfully", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const lendOfferParams = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      12000, 11000
    );
    await setupLoanParamsAndLog("Cancel a Lend Offer Successfully", lendOfferParams, "USDC");
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");

    const [loanId] = await createLoanAndGetId(lender, lendOfferParams);
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(usdcMock, contractAddress, ethers.ZeroAddress, assetAmount, 0n, "USDC");

    const cancelReceipt = await cancelLoanAndVerify(lender, loanId);

    await verifyLoanDeleted(loanId);
    await verifyTokenBalances(usdcMock, contractAddress, lender.address, 0n, assetAmount, "USDC");
    await verifyCancelledEvent(cancelReceipt, lender.address, LoanStatus.s1);
  });

  it("Should cancel a borrow offer successfully", async function () {
    const collateralAmount = hre.ethers.parseUnits("1", 8);
    const loanParams = await createBorrowOfferParams(
      collateralAmount, 2, 2, 12000, 11000,
      await usdcMock.getAddress(),
      await btcMock.getAddress()
    );
    await setupLoanParamsAndLog("Cancel a Borrow Offer Successfully", loanParams, undefined, "BTC");
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");

    const [loanId] = await createLoanAndGetId(borrower, loanParams);
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, ethers.ZeroAddress, collateralAmount, 0n, "BTC");

    const cancelReceipt = await cancelLoanAndVerify(borrower, loanId);

    await verifyLoanDeleted(loanId);
    await verifyTokenBalances(btcMock, contractAddress, borrower.address, 0n, collateralAmount, "BTC");
    await verifyCancelledEvent(cancelReceipt, borrower.address, LoanStatus.s2);
  });

  it("Should cancel multiple loans successfully", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const lendOfferParams = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      12000, 11000
    );
    await setupLoanParamsAndLog("Cancel Multiple Loans Successfully", lendOfferParams, "USDC");
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount * 2n, "USDC");

    const [loanId1] = await createLoanAndGetId(lender, lendOfferParams);
    const [loanId2] = await createLoanAndGetId(lender, lendOfferParams);

    const cancelReceipt1 = await cancelLoanAndVerify(lender, loanId1);
    const cancelReceipt2 = await cancelLoanAndVerify(lender, loanId2);

    await verifyLoanDeleted(loanId1);
    await verifyLoanDeleted(loanId2);

    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(usdcMock, contractAddress, lender.address, 0n, assetAmount * 2n, "USDC");

    await verifyCancelledEvent(cancelReceipt1, lender.address, LoanStatus.s1);
    await verifyCancelledEvent(cancelReceipt2, lender.address, LoanStatus.s1);
  });

  it("Should reject cancel from non-creator", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const lendOfferParams = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const [loanId] = await createLoanAndGetId(lender, lendOfferParams);

    await expect(loanFactory.connect(borrower).cancelLoan(loanId))
      .to.be.revertedWith("Only loan creator can cancel");
  });
});
