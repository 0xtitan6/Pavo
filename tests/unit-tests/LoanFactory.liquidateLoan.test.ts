import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyLoanDetails, verifyTokenBalances, fastForwardTime, verifyLoanDeleted, liquidateLoanAndVerify, verifyLiquidationTokenTransfers, verifyLiquidatedEvent, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";
import hre from "hardhat";

// Test suite: LoanFactory liquidateLoan tests for VeniceFi
describe("LoanFactory liquidateLoan tests for VeniceFi", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // Test case: liquidate a loan with unhealthy collateral ratio - Check
  it("Should liquidate a loan with unhealthy collateral ratio", async function () {
    // Setup loan parameters before creating borrow offer
    const borrowCollateralAmount = hre.ethers.parseUnits("0.601", 8); // BTC collateral sufficient for 120% ratio on 25k USDC
    const borrowRateIndex = 7; // 11% annual rate (highest rate)
    const borrowDurationIndex = 5; // 365 days (longest duration)
    const borrowOfferInitialCollateralRatio = 11000; // 110%
    const borrowOfferLiquidationThreshold = 10000; // 100%
    const borrowAssetAddress = ethers.ZeroAddress;
    const borrowCollateralAddress = await btcMock.getAddress();

    const loanParams = await createBorrowOfferParams(
      borrowCollateralAmount,
      borrowRateIndex,
      borrowDurationIndex,
      borrowOfferInitialCollateralRatio,
      borrowOfferLiquidationThreshold,
      borrowAssetAddress,
      borrowCollateralAddress
    );

    await setupLoanParamsAndLog("Liquidate Loan with Unhealthy Collateral Ratio", loanParams, "USDC", "BTC");

    // Transfer BTC to borrower
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create borrow offer
    const [borrowOfferId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Verify borrow offer details
    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, borrowCollateralAmount, LoanStatus.s2);

    // Create a lend offer
    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // We need a loan amount for liquidation logic
    const lendOfferRateIndex = 7; // 11% annual rate (high rate to make loan unhealthy)
    const lendOfferDurationIndex = 1; // 7 days
    const lendOfferInitialCollateralRatio = 12000; // 120%
    const lendOfferLiquidationThreshold = 11000; // 110%
    const lendOfferAssetAddress = await usdcMock.getAddress();
    const lendOfferCollateralAddress = await btcMock.getAddress();

    const lendOfferParams = await createLendOfferParams(
      lendOfferAssetAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      lendOfferAssetAddress, // Corrected assetAddress for lend offer
      lendOfferCollateralAddress,
      lendOfferInitialCollateralRatio,
      lendOfferLiquidationThreshold
    );
    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Lend Offer for Liquidation", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId, parsedLendCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Verify the active loan status
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3); // Status.s3 = active

    // Fast forward time significantly to make the loan unhealthy
    await fastForwardTime(365);

    // Verify BTC is in the contract before liquidation
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, ethers.ZeroAddress, borrowCollateralAmount, 0n, "BTC");

    // Liquidate the loan
    const liquidateReceipt = await liquidateLoanAndVerify(lender, lendOfferId);

    // Verify loan was deleted
    await verifyLoanDeleted(lendOfferId);

    // Verify token transfers after liquidation
    await verifyLiquidationTokenTransfers(lender, borrower, contractAddress, borrowCollateralAmount, lendOfferAssetAmount);

    // Verify liquidation event was emitted
    await verifyLiquidatedEvent(liquidateReceipt, lender.address);
  });

  // Test case: liquidate a loan with different parameters
  it("Should liquidate a loan with different parameters", async function () {
    // Setup loan parameters before creating borrow offer
    const borrowCollateralAmount = hre.ethers.parseUnits("0.721", 8); // BTC collateral sufficient for 120% ratio on 30k USDC
    const borrowRateIndex = 7; // Increased annual rate to make loan unhealthy faster
    const borrowDurationIndex = 3; // 90 days
    const borrowOfferInitialCollateralRatio = 11000; // 110%
    const borrowOfferLiquidationThreshold = 10000; // 100%
    const borrowAssetAddress = ethers.ZeroAddress;
    const borrowCollateralAddress = await btcMock.getAddress();

    const loanParams = await createBorrowOfferParams(
      borrowCollateralAmount,
      borrowRateIndex,
      borrowDurationIndex,
      borrowOfferInitialCollateralRatio,
      borrowOfferLiquidationThreshold,
      borrowAssetAddress,
      borrowCollateralAddress
    );
    await setupLoanParamsAndLog("Liquidate Loan with Different Parameters", loanParams, "USDC", "BTC");

    // Transfer BTC to borrower
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    // Create borrow offer
    const [borrowOfferId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Verify borrow offer details
    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, borrowCollateralAmount, LoanStatus.s2);

    // Create a lend offer with different parameters
    const lendOfferAssetAmount = hre.ethers.parseUnits("30000", 6); // 30,000 USDC
    const lendOfferRateIndex = 7; // 11% annual rate (high rate to make loan unhealthy)
    const lendOfferDurationIndex = 1; // 7 days
    const lendOfferInitialCollateralRatio = 12000; // 120%
    const lendOfferLiquidationThreshold = 11000; // 110%
    const lendOfferAssetAddress = await usdcMock.getAddress();  
    const lendOfferCollateralAddress = ethers.ZeroAddress;

    const lendOfferParams = await createLendOfferParams(
      lendOfferAssetAmount,
      lendOfferRateIndex,
      lendOfferDurationIndex,
      lendOfferAssetAddress, // Corrected assetAddress for lend offer
      lendOfferCollateralAddress,
      lendOfferInitialCollateralRatio,
      lendOfferLiquidationThreshold
    );
    // Setup loan parameters and log them for testing
    await setupLoanParamsAndLog("Lend Offer for Liquidation with Different Parameters", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    // Create loan and get ID
    const [lendOfferId, parsedLendCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    // Take up the loan (borrower takes lend offer)
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address} matching borrow offer ${borrowOfferId.toString()}`);

    // Verify the active loan status
    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3); // Status.s3 = active

    // Fast forward time to make the loan unhealthy
    await fastForwardTime(365);

    // Verify BTC is in the contract before liquidation
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, ethers.ZeroAddress, borrowCollateralAmount, 0n, "BTC");

    // Liquidate the loan
    const liquidateReceipt = await liquidateLoanAndVerify(lender, lendOfferId);

    // Verify loan was deleted
    await verifyLoanDeleted(lendOfferId);

    // Verify token transfers after liquidation
    await verifyLiquidationTokenTransfers(lender, borrower, contractAddress, borrowCollateralAmount, lendOfferAssetAmount);

    // Verify liquidation event was emitted
    await verifyLiquidatedEvent(liquidateReceipt, lender.address);
  });
});
