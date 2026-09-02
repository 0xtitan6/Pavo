import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, loanCalculatorTest, LoanStatus } from "../utils/deployments";
import { createLoanAndGetId, endLoanAndVerify, fastForwardTime, prepareBorrowerForRepayment, setupLoanParamsAndLog, transferAndApproveToken, verifyEndedEvent, verifyLoanDeleted, verifyLoanDetails, verifyTokenBalances, createLendOfferParams, createBorrowOfferParams, verifyEndLoanTokenTransfers } from "../utils/loanHelpers";

import hre from "hardhat";

describe("LoanFactory endLoan tests for Pavo", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should end a lend offer successfully at maturity", async function () {
    const borrowCollateralAmount = hre.ethers.parseUnits("1", 8); // 1 BTC
    const borrowRateIndex = 1; // 5% annual rate
    const borrowDurationIndex = 0; // 1 day duration
    const borrowInitialCollateralRatio = 11000; // 110%
    const borrowLiquidationThreshold = 10000; // 100%
    const borrowAssetAddress = await usdcMock.getAddress();
    const borrowCollateralAddress = await btcMock.getAddress();

    const loanParams = await createBorrowOfferParams(
        borrowCollateralAmount,
        borrowRateIndex,
        borrowDurationIndex,
        borrowInitialCollateralRatio,
        borrowLiquidationThreshold,
        borrowAssetAddress,
        borrowCollateralAddress
    );
    await setupLoanParamsAndLog("End a Lend Offer Successfully at Maturity", loanParams, undefined, "BTC");

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, loanParams.collateralAmount, LoanStatus.s2);
    await verifyTokenBalances(btcMock, await loanFactory.getAddress(), borrower.address, loanParams.collateralAmount, 0n, "BTC");

    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6);
    const lendOfferRateIndex = 1; // 5% annual rate
    const lendOfferDurationIndex = 0; // 1 day duration
    const lendOfferInitialCollateralRatio = 11000; // 110%
    const lendOfferLiquidationThreshold = 10000; // 100%
    const lendOfferAssetAddress = await usdcMock.getAddress();
    const lendOfferCollateralAddress = await btcMock.getAddress();

    const lendOfferParams = await createLendOfferParams(
      lendOfferAssetAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      lendOfferAssetAddress,
      lendOfferCollateralAddress,
      lendOfferInitialCollateralRatio,
      lendOfferLiquidationThreshold
    );

    await setupLoanParamsAndLog("Lend Offer for Matching", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3);

    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, borrower.address, borrowCollateralAmount, 0n, "BTC");

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      lendOfferAssetAmount,
      await loanFactory.RATE_BPS(lendOfferRateIndex),
      await loanFactory.DURATION_DAYS(lendOfferDurationIndex)
    );

    await prepareBorrowerForRepayment(borrower, totalRepayment);

    // Fast forward to maturity (1 day + 1 second)
    await fastForwardTime(1);

    const endReceipt = await endLoanAndVerify(borrower, lendOfferId);

    await verifyLoanDeleted(lendOfferId);

    await verifyEndLoanTokenTransfers(
      lender,
      borrower,
      contractAddress,
      lendOfferAssetAmount,
      borrowCollateralAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      borrowCollateralAddress
    );

    await verifyEndedEvent(endReceipt, borrower.address);
  });

  it("Should end a loan with longer duration successfully", async function () {
    const borrowCollateralAmount = hre.ethers.parseUnits("2", 8); // 2 BTC
    const borrowRateIndex = 2; // 6% annual rate
    const borrowDurationIndex = 1; // 7 days duration
    const borrowInitialCollateralRatio = 11000; // 110%
    const borrowLiquidationThreshold = 10000; // 100%
    const borrowAssetAddress = await usdcMock.getAddress();
    const borrowCollateralAddress = await btcMock.getAddress();

    const loanParams = await createBorrowOfferParams(
        borrowCollateralAmount,
        borrowRateIndex,
        borrowDurationIndex,
        borrowInitialCollateralRatio,
        borrowLiquidationThreshold,
        borrowAssetAddress,
        borrowCollateralAddress
    );

    await setupLoanParamsAndLog("End a Loan Successfully with Longer Duration (7-day duration)", loanParams, undefined, "BTC");

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, borrowCollateralAmount, LoanStatus.s2);
    await verifyTokenBalances(btcMock, await loanFactory.getAddress(), borrower.address, borrowCollateralAmount, 0n, "BTC");

    const lendOfferAssetAmount = hre.ethers.parseUnits("50000", 6);
    const lendOfferRateIndex = 2; // 6% annual rate
    const lendOfferDurationIndex = 1; // 7 days duration
    const lendOfferInitialCollateralRatio = 11000; // 110%
    const lendOfferLiquidationThreshold = 10000; // 100%
    const lendOfferAssetAddress = await usdcMock.getAddress();
    const lendOfferCollateralAddress = await btcMock.getAddress();

    const lendOfferParams = await createLendOfferParams(
      lendOfferAssetAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      lendOfferAssetAddress,
      lendOfferCollateralAddress,
      lendOfferInitialCollateralRatio,
      lendOfferLiquidationThreshold
    );

    await setupLoanParamsAndLog("Lend Offer for Matching Longer Duration", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3);

    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, borrower.address, borrowCollateralAmount, 0n, "BTC");

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      lendOfferAssetAmount,
      await loanFactory.RATE_BPS(lendOfferRateIndex),
      await loanFactory.DURATION_DAYS(lendOfferDurationIndex)
    );

    await prepareBorrowerForRepayment(borrower, totalRepayment);

    // Fast forward to maturity (7 days + 1 second)
    await fastForwardTime(7);

    const endReceipt = await endLoanAndVerify(borrower, lendOfferId);

    await verifyLoanDeleted(lendOfferId);

    await verifyEndLoanTokenTransfers(
      lender,
      borrower,
      contractAddress,
      lendOfferAssetAmount,
      borrowCollateralAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      borrowCollateralAddress
    );

    await verifyEndedEvent(endReceipt, borrower.address);
  });
});
