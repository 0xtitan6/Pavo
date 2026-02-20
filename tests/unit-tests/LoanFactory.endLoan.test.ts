import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, loanCalculatorTest, LoanStatus } from "../utils/deployments";
import { createLoanAndGetId, endLoanAndVerify, fastForwardTime, prepareBorrowerForRepayment, setupLoanParamsAndLog, transferAndApproveToken, verifyEndedEvent, verifyLoanDeleted, verifyLoanDetails, verifyTokenBalances, createLendOfferParams, createBorrowOfferParams, verifyEndLoanTokenTransfers } from "../utils/loanHelpers";

import hre from "hardhat";

// Test suite: LoanFactory endLoan tests for VeniceFi
describe("LoanFactory endLoan tests for VeniceFi", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // Test case: end a lend offer successfully at maturity - Check
  it("Should end a lend offer successfully at maturity", async function () {
    // Create borrow offer parameters
    const borrowCollateralAmount = hre.ethers.parseUnits("1", 8); // 1 BTC
    const borrowRateIndex = 1; // 5% annual rate
    const borrowDurationIndex = 0; // 1 day duration
    const borrowInitialCollateralRatio = 11000; // 110%
    const borrowLiquidationThreshold = 10000; // 100%
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
    // Setup loan parameters and log them for testing
    await setupLoanParamsAndLog("End a Lend Offer Successfully at Maturity", loanParams, undefined, "BTC");

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create loan and get ID
    const [borrowOfferId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Verify loan details
    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, loanParams.collateralAmount, LoanStatus.s2);

    // Verify BTC balances
    await verifyTokenBalances(btcMock, await loanFactory.getAddress(), borrower.address, loanParams.collateralAmount, 0n, "BTC");

    // Create a lend offer
    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6);
    const lendOfferRateIndex = 1; // 5% annual rate
    const lendOfferDurationIndex = 0; // 1 day duration
    const lendOfferInitialCollateralRatio = 11000; // 110%
    const lendOfferLiquidationThreshold = 10000; // 100%
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

    // Setup loan parameters and log them for testing
    await setupLoanParamsAndLog("Lend Offer for Matching", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId, parsedLendCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    // Verify lend offer details
    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId); 
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Verify the active loan status
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3); // Status.s3 = active

    // Verify BTC is in the contract
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, borrower.address,  borrowCollateralAmount, 0n, "BTC");

    // Calculate total repayment (principal + interest) for allowance
    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      lendOfferAssetAmount,
      await loanFactory.RATE_BPS(lendOfferRateIndex),
      await loanFactory.DURATION_DAYS(lendOfferDurationIndex)
    );

    // Prepare borrower for repayment by approving the LoanFactory to transfer USDC
    await prepareBorrowerForRepayment(borrower, totalRepayment);

    // Fast forward time to maturity (1 day + 1 second)
    await fastForwardTime(1);

    // Calculate expected BTC payout and excess collateral
    const expectedBtcPayout = await loanCalculatorTest.testCalculateBTCPayout(
      lendOfferAssetAmount,
      await loanFactory.RATE_BPS(lendOfferRateIndex),
      await loanFactory.DURATION_DAYS(lendOfferDurationIndex),
      borrowCollateralAmount,
      borrowCollateralAddress
    );
    const expectedExcessCollateral = await loanCalculatorTest.testCalculateExcessCollateral(
      lendOfferAssetAmount,
      await loanFactory.RATE_BPS(lendOfferRateIndex),
      await loanFactory.DURATION_DAYS(lendOfferDurationIndex),
      borrowCollateralAmount,
      borrowCollateralAddress
    );

    // End the loan
    const endReceipt = await endLoanAndVerify(borrower, lendOfferId);

    // Verify loan was deleted
    await verifyLoanDeleted(lendOfferId);

    // Verify token transfers after ending the loan
    await verifyEndLoanTokenTransfers(
      lender,
      borrower,
      contractAddress,
      lendOfferAssetAmount,
      borrowCollateralAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      borrowCollateralAddress // This should be collateralAddress, not borrowCollateralAddress for the function signature
    );

    // Verify Ended event was emitted
    await verifyEndedEvent(endReceipt, borrower.address);
  });

  // Test case: end a loan with longer duration successfully - Check
  it("Should end a loan with longer duration successfully", async function () {

    // Create borrow offer parameters
    const borrowCollateralAmount = hre.ethers.parseUnits("2", 8); // 2 BTC
    const borrowRateIndex = 2; // 6% annual rate
    const borrowDurationIndex = 1; // 7 days duration
    const borrowInitialCollateralRatio = 11000; // 110%
    const borrowLiquidationThreshold = 10000; // 100%
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

    // Setup loan parameters and log them for testing
    await setupLoanParamsAndLog("End a Loan Successfully with Longer Duration (7-day duration)", loanParams, undefined, "BTC");

    // Transfer and approve BTC
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create loan and get ID
    const [borrowOfferId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Verify borrow offer details
    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, borrowCollateralAmount, LoanStatus.s2);

    // Verify BTC balances
    await verifyTokenBalances(btcMock, await loanFactory.getAddress(), borrower.address, borrowCollateralAmount, 0n, "BTC");

    // Create a lend offer
    const lendOfferAssetAmount = hre.ethers.parseUnits("50000", 6);
    const lendOfferRateIndex = 2; // 6% annual rate
    const lendOfferDurationIndex = 1; // 7 days duration
    const lendOfferInitialCollateralRatio = 11000; // 110%
    const lendOfferLiquidationThreshold = 10000; // 100%
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

    // Setup loan parameters and log them for testing
    await setupLoanParamsAndLog("Lend Offer for Matching Longer Duration", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId, parsedLendCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    // Verify lend offer details
    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Verify the active loan status
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3); // Status.s3 = active

    // Verify BTC is in the contract
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, borrower.address, borrowCollateralAmount, 0n, "BTC");

    // Calculate total repayment (principal + interest) for allowance
    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      lendOfferAssetAmount,
      await loanFactory.RATE_BPS(lendOfferRateIndex),
      await loanFactory.DURATION_DAYS(lendOfferDurationIndex)
    );

    // Prepare borrower for repayment by approving the LoanFactory to transfer USDC
    await prepareBorrowerForRepayment(borrower, totalRepayment);

    // Fast forward time to maturity (7 days + 1 second)
    await fastForwardTime(7);

    // End the loan
    const endReceipt = await endLoanAndVerify(borrower, lendOfferId);

    // Verify loan was deleted
    await verifyLoanDeleted(lendOfferId);

    // Verify token transfers after ending the loan
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

    // Verify Ended event was emitted
    await verifyEndedEvent(endReceipt, borrower.address);
  });
});