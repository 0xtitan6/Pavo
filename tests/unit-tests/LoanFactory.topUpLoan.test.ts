import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyLoanDetails, verifyTokenBalances, prepareBorrowerForTopUp, topUpAndVerify, verifyCollateralIncrease, verifyToppedUpEvent, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";

import hre from "hardhat";

describe("LoanFactory topUp tests for Pavo", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should top up collateral successfully", async function () {
    const borrowCollateralAmount = hre.ethers.parseUnits("1.102", 8); // 1.102 BTC
    const borrowRateIndex = 1; // 5% annual rate
    const borrowDurationIndex = 2; // 30 days
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

    await setupLoanParamsAndLog("Top Up Collateral Successfully (Basic)", loanParams, "USDC", "BTC");

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC
    const lendOfferRateIndex = 2; // 6% annual rate
    const lendOfferDurationIndex = 1; // 7 days
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

    await setupLoanParamsAndLog("Lend Offer for Matching TopUp", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3);

    await prepareBorrowerForTopUp(borrower, borrowCollateralAmount);

    const topUpReceipt = await topUpAndVerify(borrower, lendOfferId, borrowCollateralAmount);

    await verifyToppedUpEvent(topUpReceipt, borrower.address);
  });

  it("Should top up collateral multiple times", async function () {
    const borrowCollateralAmount = hre.ethers.parseUnits("1.102", 8); // 1.102 BTC
    const borrowRateIndex = 1; // 5% annual rate
    const borrowDurationIndex = 2; // 30 days
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

    await setupLoanParamsAndLog("Top Up Collateral Multiple Times (Basic)", loanParams, "USDC", "BTC");

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC
    const lendOfferRateIndex = 2; // 6% annual rate
    const lendOfferDurationIndex = 1; // 7 days
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

    await setupLoanParamsAndLog("Lend Offer for Matching TopUp", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    // Create a second lend offer (for second top-up matching context)
    const secondLendOfferAssetAmount = hre.ethers.parseUnits("25000", 6);
    const secondLendOfferParams = await createLendOfferParams(
      secondLendOfferAssetAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      lendOfferAssetAddress,
      lendOfferCollateralAddress,
      lendOfferInitialCollateralRatio,
      lendOfferLiquidationThreshold
    );

    await setupLoanParamsAndLog("Lend Offer for Matching Second TopUp", secondLendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), secondLendOfferAssetAmount, "USDC");

    const [secondLendOfferId] = await createLoanAndGetId(lender, secondLendOfferParams);

    await verifyLoanDetails(secondLendOfferId, lender.address, ethers.ZeroAddress, secondLendOfferAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    // First topUp
    await prepareBorrowerForTopUp(borrower, borrowCollateralAmount);
    const topUpReceipt1 = await topUpAndVerify(borrower, lendOfferId, borrowCollateralAmount);
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount + borrowCollateralAmount, LoanStatus.s3);
    await verifyCollateralIncrease(lendOfferId, borrowCollateralAmount * 2n);

    // Second topUp
    await prepareBorrowerForTopUp(borrower, borrowCollateralAmount);
    const topUpReceipt2 = await topUpAndVerify(borrower, lendOfferId, borrowCollateralAmount);
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount * 3n, LoanStatus.s3);
    await verifyCollateralIncrease(lendOfferId, borrowCollateralAmount * 3n);
  });

  it("Should top up collateral with large amount", async function () {
    const borrowCollateralAmount = hre.ethers.parseUnits("1.102", 8); // 1.102 BTC
    const borrowRateIndex = 1; // 5% annual rate
    const borrowDurationIndex = 2; // 30 days
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

    await setupLoanParamsAndLog("Top Up Collateral with Large Amount", loanParams, "USDC", "BTC");

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC
    const lendOfferRateIndex = 2; // 6% annual rate
    const lendOfferDurationIndex = 1; // 7 days
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

    await setupLoanParamsAndLog("Lend Offer for Large TopUp", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3);

    await prepareBorrowerForTopUp(borrower, borrowCollateralAmount);

    const topUpReceipt = await topUpAndVerify(borrower, lendOfferId, borrowCollateralAmount);

    const expectedFinalCollateral = borrowCollateralAmount * 2n;
    await verifyCollateralIncrease(lendOfferId, expectedFinalCollateral);

    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, borrower.address, expectedFinalCollateral, 0n, "BTC");

    await verifyToppedUpEvent(topUpReceipt, borrower.address);
  });
});
