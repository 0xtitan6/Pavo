import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyLoanDetails, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";

import hre from "hardhat";

describe("LoanFactory takeUpLoan tests for VeniceFi", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should allow a borrower to take up a lend offer successfully", async function () {
    // Create borrow offer parameters
    const borrowCollateralAmount = hre.ethers.parseUnits("1.102", 8); // 1.102 BTC collateral to meet collateral ratio
    const borrowRateIndex = 1; // 5% annual interest rate
    const borrowDurationIndex = 2; // 30 days loan duration
    const borrowInitialCollateralRatio = 11000; // 110% initial collateral ratio
    const borrowLiquidationThreshold = 10000; // 100% liquidation threshold
    const borrowAssetAddress = ethers.ZeroAddress;
    const borrowCollateralAddress = await btcMock.getAddress();

    // Scenario 2: Borrower takes lend offer
    const borrowOfferParams = await createBorrowOfferParams(
      borrowCollateralAmount,
      borrowRateIndex,
      borrowDurationIndex,
      borrowInitialCollateralRatio,
      borrowLiquidationThreshold,
      borrowAssetAddress,
      borrowCollateralAddress
    );

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Create Borrow Offer", borrowOfferParams, undefined, "BTC");

    // Transfer and approve BTC
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create loan and get ID
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowOfferParams);

    // Create lend offer parameters
    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC loan amount
    const lendOfferRateIndex = 1; // 5% annual interest rate
    const lendOfferDurationIndex = 2; // 30 days loan duration
    const lendOfferInitialCollateralRatio = 11000; // 110% initial collateral ratio
    const lendOfferLiquidationThreshold = 10000; // 100% (must match borrow offer for Scenario 4)
    const lendOfferAssetAddress = await usdcMock.getAddress();
    const lendOfferCollateralAddress = ethers.ZeroAddress;

    const lendOfferParams = await createLendOfferParams(
      lendOfferAssetAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      lendOfferAssetAddress,
      lendOfferCollateralAddress,
      lendOfferInitialCollateralRatio,
      lendOfferLiquidationThreshold
    );

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Create Lend Offer", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    // Take up the loan - borrower takes up lend offer
    await expect(loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId))
      .to.emit(loanFactory, "TakeUp")
      .withArgs(borrower.address, lender.address);

    // Verify loan details after takeUpLoan
    await verifyLoanDetails(
      lendOfferId,
      lender.address,
      borrower.address,
      lendOfferAssetAmount,
      borrowCollateralAmount,
      LoanStatus.s3 // Loan should be in active status (s3)
    );
  });

  it("Should allow a lender to take up a borrow offer successfully", async function () {
    // Create lend offer parameters
    const lendOfferAssetAmount = hre.ethers.parseUnits("100000", 6); // 100,000 USDC loan amount
    const lendOfferRateIndex = 1; // 5% annual interest rate
    const lendOfferDurationIndex = 2; // 30 days loan duration
    const lendOfferInitialCollateralRatio = 11000; // 110% initial collateral ratio
    const lendOfferLiquidationThreshold = 10000; // 100% (must match borrow offer for Scenario 4)
    const lendOfferAssetAddress = await usdcMock.getAddress();
    const lendOfferCollateralAddress = ethers.ZeroAddress;

    // Create lend offer parameters
    const lendOfferParams = await createLendOfferParams(
      lendOfferAssetAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      lendOfferAssetAddress,
      lendOfferCollateralAddress,
      lendOfferInitialCollateralRatio,
      lendOfferLiquidationThreshold
    );

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Create Lend Offer", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    // Create borrow offer parameters
    const borrowCollateralAmount = hre.ethers.parseUnits("2.21", 8); // 2.21 BTC collateral (sufficient for 110% ratio on 100k USDC)
    const borrowRateIndex = 1; // 5% annual interest rate
    const borrowDurationIndex = 2; // 30 days loan duration
    const borrowInitialCollateralRatio = 11000; // 110% initial collateral ratio
    const borrowLiquidationThreshold = 10000; // 100% liquidation threshold
    const borrowAssetAddress = ethers.ZeroAddress;
    const borrowCollateralAddress = await btcMock.getAddress();

    // Create borrow offer parameters
    const borrowOfferParams = await createBorrowOfferParams(
      borrowCollateralAmount,
      borrowRateIndex,
      borrowDurationIndex,
      borrowInitialCollateralRatio,
      borrowLiquidationThreshold,
      borrowAssetAddress,
      borrowCollateralAddress
    );

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Create Borrow Offer", borrowOfferParams, undefined, "BTC");

    // Transfer and approve BTC
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create loan and get ID
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowOfferParams);

    // Take up the loan - lender takes up borrow offer
    await expect(loanFactory.connect(lender).takeUpLoan(lendOfferId, borrowOfferId))
      .to.emit(loanFactory, "TakeUp")
      .withArgs(borrower.address, lender.address);

    // Verify loan details after takeUpLoan
    await verifyLoanDetails(
      borrowOfferId,
      lender.address,
      borrower.address,
      lendOfferAssetAmount, // The loan amount is the full lend offer amount (100,000 USDC)
      borrowCollateralAmount,
      LoanStatus.s3 // Loan should be in active status (s3)
    );
  });
});
