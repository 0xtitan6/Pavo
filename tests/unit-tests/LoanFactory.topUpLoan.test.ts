import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyLoanDetails, verifyTokenBalances, prepareBorrowerForTopUp, topUpAndVerify, verifyCollateralIncrease, verifyToppedUpEvent, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";

import hre from "hardhat";

// Test suite: LoanFactory topUp tests for VeniceFi
describe("LoanFactory topUp tests for VeniceFi", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // Test case: top up collateral successfully
  it("Should top up collateral successfully", async function () {
    // Create borrow offer parameters
    const borrowCollateralAmount = hre.ethers.parseUnits("1.102", 8); // 1.102 BTC collateral to meet collateral ratio
    const borrowRateIndex = 1; // 5% annual interest rate
    const borrowDurationIndex = 2; // 30 days loan duration
    const borrowInitialCollateralRatio = 11000; // 110% initial collateral ratio
    const borrowLiquidationThreshold = 10000; // 100% liquidation threshold
    const borrowAssetAddress = ethers.ZeroAddress;
    const borrowCollateralAddress = await btcMock.getAddress(); 

    // Setup loan parameters and log them
    const loanParams = await createBorrowOfferParams(
      borrowCollateralAmount,
      borrowRateIndex,
      borrowDurationIndex,
      borrowInitialCollateralRatio,
      borrowLiquidationThreshold,
      borrowAssetAddress,
      borrowCollateralAddress
    );

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Top Up Collateral Successfully (Basic)", loanParams, "USDC", "BTC");

    // Transfer and approve BTC
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create borrow offer
    const [borrowOfferId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Create a lend offer
    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC loan amount
    const lendOfferCollateralAmount = 0n; // For lend offer, collateral should be 0
    const lendOfferRateIndex = 2; // 6% annual rate
    const lendOfferDurationIndex = 1; // 7 days duration
    const lendOfferInitialCollateralRatio = 11000; // Use a valid default for lend offer
    const lendOfferLiquidationThreshold = 10000; // Use a valid default for lend offer
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
    await setupLoanParamsAndLog("Lend Offer for Matching TopUp", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId, parsedLendCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    // Verify lend offer details
    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, lendOfferCollateralAmount, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Verify loan is active before topUp
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3); // Status.s3 (active)

    // Prepare borrower for topUp
    await prepareBorrowerForTopUp(borrower, borrowCollateralAmount);

    // Perform topUp operation
    const topUpReceipt = await topUpAndVerify(borrower, lendOfferId, borrowCollateralAmount);

    // Verify ToppedUp event emission
    await verifyToppedUpEvent(topUpReceipt, borrower.address);
  });

  // Test case: top up collateral multiple times
  it("Should top up collateral multiple times", async function () {
    // Create borrow offer parameters
    const borrowCollateralAmount = hre.ethers.parseUnits("1.102", 8); // 1.102 BTC collateral to meet collateral ratio
    const borrowRateIndex = 1; // 5% annual interest rate
    const borrowDurationIndex = 2; // 30 days loan duration
    const borrowInitialCollateralRatio = 11000; // 110% initial collateral ratio
    const borrowLiquidationThreshold = 10000; // 100% liquidation threshold
    const borrowAssetAddress = ethers.ZeroAddress;
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

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Top Up Collateral Multiple Times (Basic)", loanParams, "USDC", "BTC");

    // Transfer and approve BTC
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create borrow offer
    const [borrowOfferId, parsedBorrowCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Create a lend offer
    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC loan amount
    const lendOfferCollateralAmount = 0n; // For lend offer, collateral should be 0
    const lendOfferRateIndex = 2; // 6% annual rate
    const lendOfferDurationIndex = 1; // 7 days duration
    const lendOfferInitialCollateralRatio = 11000; // Use a valid default for lend offer
    const lendOfferLiquidationThreshold = 10000; // Use a valid default for lend offer
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
    await setupLoanParamsAndLog("Lend Offer for Matching TopUp", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId, parsedLendCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);
    // Verify lend offer details
    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, lendOfferCollateralAmount, LoanStatus.s1);   

    // Create a lend offer
    const secondLendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC loan amount
    const secondLendOfferRateIndex = 2; // 6% annual rate
    const secondLendOfferDurationIndex = 1; // 7 days duration
    const secondLendOfferInitialCollateralRatio = 11000; // Use a valid default for lend offer
    const secondLendOfferLiquidationThreshold = 10000; // Use a valid default for lend offer
    const secondLendOfferAssetAddress = await usdcMock.getAddress();
    const secondLendOfferCollateralAddress = ethers.ZeroAddress;
    const secondLendOfferParams = await createLendOfferParams(    
      secondLendOfferAssetAmount,
      secondLendOfferRateIndex,
      secondLendOfferDurationIndex,
      secondLendOfferAssetAddress,
      secondLendOfferCollateralAddress,
      secondLendOfferInitialCollateralRatio,
      secondLendOfferLiquidationThreshold
    );

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Lend Offer for Matching Second TopUp", secondLendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), secondLendOfferAssetAmount, "USDC");

    // Create second loan and get ID
    const [secondLendOfferId, parsedSecondLendCreatedEvent] = await createLoanAndGetId(lender, secondLendOfferParams);
    // Verify lend offer details
    await verifyLoanDetails(secondLendOfferId, lender.address, ethers.ZeroAddress, secondLendOfferAssetAmount, 0n, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Perform first topUp    
    await prepareBorrowerForTopUp(borrower, borrowCollateralAmount);
    const topUpReceipt1 = await topUpAndVerify(borrower, lendOfferId, borrowCollateralAmount);
    // Verify loan is active before topUp
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount + borrowCollateralAmount, LoanStatus.s3); // Status.s3 (active)
    // Verify first topUp results
    await verifyCollateralIncrease(lendOfferId, borrowCollateralAmount * 2n);

    // Perform second topUp
    await prepareBorrowerForTopUp(borrower, borrowCollateralAmount);
    const topUpReceipt2 = await topUpAndVerify(borrower, lendOfferId, borrowCollateralAmount);
    // Verify loan is active before topUp
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount * 3n, LoanStatus.s3); // Status.s3 (active)
    await verifyCollateralIncrease(lendOfferId, borrowCollateralAmount * 3n);
  });

  // Test case: top up collateral with large amount
  it("Should top up collateral with large amount", async function () {
    // Create borrow offer parameters 
    const borrowCollateralAmount = hre.ethers.parseUnits("1.102", 8); // 1.102 BTC collateral to meet collateral ratio
    const borrowRateIndex = 1; // 5% annual interest rate
    const borrowDurationIndex = 2; // 30 days loan duration
    const borrowInitialCollateralRatio = 11000; // 110% initial collateral ratio
    const borrowLiquidationThreshold = 10000; // 100% liquidation threshold
    const borrowAssetAddress = ethers.ZeroAddress;
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

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Top Up Collateral with Large Amount", loanParams, "USDC", "BTC");

    // Transfer and approve BTC
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create borrow offer
    const [borrowOfferId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Create a lend offer
    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC loan amount
    const lendOfferRateIndex = 2; // 6% annual rate
    const lendOfferDurationIndex = 1; // 7 days duration
    const lendOfferInitialCollateralRatio = 11000; // Use a valid default for lend offer
    const lendOfferLiquidationThreshold = 10000; // Use a valid default for lend offer
    const lendOfferAssetAddress = await usdcMock.getAddress();
    const lendOfferCollateralAddress = ethers.ZeroAddress;

    const secondLendOfferParams = await createLendOfferParams(
      lendOfferAssetAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      lendOfferAssetAddress,
      lendOfferCollateralAddress,
      lendOfferInitialCollateralRatio,
      lendOfferLiquidationThreshold
    );

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Lend Offer for Large TopUp", secondLendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [secondLendOfferId, parsedSecondLendCreatedEvent] = await createLoanAndGetId(lender, secondLendOfferParams);
    // Verify lend offer details
    await verifyLoanDetails(secondLendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, secondLendOfferId);
    console.log(`Loan ${secondLendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Verify the active loan status before topUp
    await verifyLoanDetails(secondLendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3); // Status.s3 (active)

    // Prepare borrower for large topUp
    await prepareBorrowerForTopUp(borrower, borrowCollateralAmount);

    // Perform large amount topUp
    const topUpReceipt = await topUpAndVerify(borrower, secondLendOfferId, borrowCollateralAmount);

    // Verify large collateral increase
    const expectedFinalCollateral = borrowCollateralAmount * 2n;
    await verifyCollateralIncrease(secondLendOfferId, expectedFinalCollateral);

    // Verify large BTC transfer to contract
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, borrower.address, expectedFinalCollateral, 0n, "BTC");

    // Verify ToppedUp event emission
    await verifyToppedUpEvent(topUpReceipt, borrower.address);
  });
});
