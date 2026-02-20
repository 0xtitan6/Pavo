import { expect } from "chai";
import { ethers } from "hardhat";
import { loanFactory, usdcMock, btcMock, owner, lender, borrower, deployContracts, loanCalculatorTest, LoanStatus} from "../utils/deployments";
import {
  setupLoanParamsAndLog,
  createLoanAndGetId,
  transferAndApproveToken,
  prepareBorrowerForRepayment,
  interruptLoanAndVerify,
  verifyInterruptionTokenTransfers,
  verifyLoanDeleted,
  verifyInterruptedEvent,
  createLendOfferParams,
  verifyLoanDetails,
  createBorrowOfferParams,
} from "../utils/loanHelpers";
import hre from "hardhat";

// Test suite: LoanFactory interruptLoan tests for VeniceFi
describe("LoanFactory interruptLoan tests for VeniceFi", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // Test case: interrupt loan successfully with full interest
  it("Should interrupt loan successfully with full interest", async function () {

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
    await setupLoanParamsAndLog("Interrupt Loan Successfully with Full Interest (Basic)", loanParams,"USDC","BTC");

    // Prepare borrower with sufficient BTC for testing
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create borrow offer
    const [borrowOfferId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Verify borrow offer details
    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, borrowCollateralAmount, LoanStatus.s2);

    // Create a lend offer
    const lendOfferAssetAmount = hre.ethers.parseUnits("50000", 6); // 50,000 USDC loan
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
    await setupLoanParamsAndLog("Lend Offer for Interrupt Loan Successfully with Full Interest", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId, parsedLendCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    // Verify lend offer details
    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, lendOfferCollateralAmount, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Verify the active loan status and details after takeUpLoan
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3); // Status.s3 = active

    // Calculate total repayment including full interest
    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      lendOfferAssetAmount,
      await loanFactory.RATE_BPS(lendOfferRateIndex),
      await loanFactory.DURATION_DAYS(lendOfferDurationIndex)
    );
    console.log(`Calculated total repayment: ${totalRepayment.toString()} USDC.`);

    // Prepare borrower for repayment
    await transferAndApproveToken(usdcMock, borrower, await loanFactory.getAddress(), totalRepayment, "USDC");

    // Perform interruptLoan operation
    const interruptReceipt = await interruptLoanAndVerify(borrower, lendOfferId);

    // Verify token transfers
    await verifyInterruptionTokenTransfers(
      lender.address,
      borrower.address,
      await loanFactory.getAddress(),
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      lendOfferAssetAmount,
      borrowCollateralAmount,
      totalRepayment
    );

    // Verify loan is deleted
    await verifyLoanDeleted(lendOfferId);

    // Verify Interrupted event emission
    await verifyInterruptedEvent(interruptReceipt, borrower.address);
  });

  // Test case: interrupt loan with different parameters
  it("Should interrupt loan with different parameters", async function () {
    const collateralAmount = hre.ethers.parseUnits("2", 8); // 2 BTC collateral
    const loanAssetAmount = hre.ethers.parseUnits("50000", 6); // 50,000 USDC loan
    const rateIndex = 3; // 7% annual interest rate
    const durationIndex = 4; // 180 days loan duration

    const loanParams = {
      assetAmount: hre.ethers.parseUnits("0", 6),
      collateralAmount: collateralAmount,
      rateIndex: rateIndex,
      durationIndex: durationIndex,
      initialCollateralRatio: 12000,
      liquidationThreshold: 11000,
      assetAddress: await usdcMock.getAddress(),
      collateralAddress: await btcMock.getAddress(),
    };

    await setupLoanParamsAndLog("Interrupt Loan with Different Parameters", loanParams, "USDC", "BTC");

    // Prepare borrower with sufficient BTC
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");

    // Create borrow offer
    const [borrowOfferId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Verify borrow offer details
    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, collateralAmount, LoanStatus.s2);

    // Create a lend offer
    const lendOfferCollateralAmount = 0n; // For lend offer, collateral should be 0
    const lendOfferAssetAmount = hre.ethers.parseUnits("50000", 6); // 50,000 USDC loan
    const lendOfferRateIndex = rateIndex;
    const lendOfferDurationIndex = durationIndex;
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
    await setupLoanParamsAndLog("Lend Offer for Interrupt Loan with Different Parameters (Basic)", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), loanAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId, parsedLendCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    // Verify lend offer details
    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, loanAssetAmount, lendOfferParams.collateralAmount, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Verify the active loan status and details after takeUpLoan
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, loanAssetAmount, collateralAmount, LoanStatus.s3); // Status.s3 = active

    // Calculate total repayment including full interest
    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      loanAssetAmount,
      await loanFactory.RATE_BPS(rateIndex),
      await loanFactory.DURATION_DAYS(durationIndex)
    );
    console.log(`Calculated total repayment: ${totalRepayment.toString()} USDC.`);

    // Prepare borrower for repayment
    await transferAndApproveToken(usdcMock, borrower, await loanFactory.getAddress(), totalRepayment, "USDC");

    // Perform interruptLoan operation
    const interruptReceipt = await interruptLoanAndVerify(borrower, lendOfferId);

    // Verify token transfers
    await verifyInterruptionTokenTransfers(
      lender.address,
      borrower.address,
      await loanFactory.getAddress(),
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      lendOfferAssetAmount,
      collateralAmount,
      totalRepayment
    );

    // Verify loan is deleted
    await verifyLoanDeleted(lendOfferId);

    // Verify Interrupted event emission
    await verifyInterruptedEvent(interruptReceipt, borrower.address);
  });
});
