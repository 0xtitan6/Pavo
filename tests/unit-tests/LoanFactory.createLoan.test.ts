import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyLoanDetails, verifyTokenBalances, verifyCreatedEvent, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";
import hre from "hardhat";

// Test suite: LoanFactory createLoan tests for VeniceFi - Check
describe("LoanFactory createLoan tests for VeniceFi", function () {
  beforeEach(async function () {
    await deployContracts(); // Deploy contracts before each test
  });

  // Test case: create a lend offer successfully - Check
  it("Should create a lend offer successfully", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6); // 1,000 USDC
    const rateIndex = 1; // 5% annual rate
    const durationIndex = 1; // 7 days
    const assetAddress = await usdcMock.getAddress(); // Get USDC mock address
    const collateralAddress = ethers.ZeroAddress; // For lend offer, collateral should be 0
    const initialCollateralRatio = 12000; // 120%
    const liquidationThreshold = 11000; // 110%

    const lendOfferParams = await createLendOfferParams(
      assetAmount,
      rateIndex,
      durationIndex,
      assetAddress,
      collateralAddress,
      initialCollateralRatio,
      liquidationThreshold
    );
    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Create a Lend Offer Successfully", lendOfferParams, "USDC"); // Log loan parameters

    // Transfer and approve USDC for testing
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    
    // Create loan and get ID
    const [loanId, parsedCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    // Verify loan details
    await verifyLoanDetails(loanId, lender.address, ethers.ZeroAddress, assetAmount, lendOfferParams.collateralAmount, LoanStatus.s1);

    // Get LoanFactory address
    const contractAddress = await loanFactory.getAddress();

    // Verify USDC balances
    await verifyTokenBalances(usdcMock, contractAddress, lender.address, assetAmount, 0n, "USDC");

    const expectedRate = await loanFactory.RATE_BPS(lendOfferParams.rateIndex);
    const expectedDuration = await loanFactory.DURATION_DAYS(lendOfferParams.durationIndex);
    await verifyCreatedEvent(parsedCreatedEvent, loanId, lender.address, assetAmount, LoanStatus.s1, expectedRate, expectedDuration);
  });

  // Test case: create a borrow offer successfully - Check
  it("Should create a borrow offer successfully", async function () {
    const collateralAmount = hre.ethers.parseUnits("1", 8); // 1 BTC
    const rateIndex = 2; // 6% annual rate
    const durationIndex = 2; // 30 days
    const initialCollateralRatio = 12000; // 120%
    const liquidationThreshold = 11000; // 110%

    const loanParams = await createBorrowOfferParams(
      collateralAmount,
      rateIndex,
      durationIndex,
      initialCollateralRatio,
      liquidationThreshold,
      ethers.ZeroAddress, // For borrow offer, assetAddress should be ZeroAddress initially
      await btcMock.getAddress()
    );
    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Create a Borrow Offer Successfully", loanParams, undefined, "BTC"); // Log loan parameters

    // Transfer and approve BTC for testing 
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");

    // Create loan and get ID
    const [borrowLoanId, parsedBorrowCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Verify loan details
    await verifyLoanDetails(borrowLoanId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, collateralAmount, LoanStatus.s2);

    // Get LoanFactory address
    const contractAddress = await loanFactory.getAddress();

    // Verify BTC balances
    await verifyTokenBalances(btcMock, contractAddress, borrower.address, collateralAmount, 0n, "BTC");

    // Verify Created event
    const expectedRate = await loanFactory.RATE_BPS(loanParams.rateIndex);
    const expectedDuration = await loanFactory.DURATION_DAYS(loanParams.durationIndex);
    await verifyCreatedEvent(parsedBorrowCreatedEvent, borrowLoanId, borrower.address, collateralAmount, LoanStatus.s2, expectedRate, expectedDuration);
  });

  // Test case: create multiple loans with unique IDs - Check
  it("Should create multiple loans with unique IDs", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const collateralAmount = 0n;
    const rateIndex = 1;
    const durationIndex = 1;
    const initialCollateralRatio = 11000;
    const liquidationThreshold = 10000;
    const assetAddress = await usdcMock.getAddress(); // Get USDC mock address
    const collateralAddress = await btcMock.getAddress(); // Get BTC mock address

    // Create a lend offer with the same parameters for multiple loans
    const lendOfferParams = await createLendOfferParams(
      assetAmount,
      rateIndex,
      durationIndex,
      assetAddress,
      collateralAddress,
      initialCollateralRatio,
      liquidationThreshold
    );
    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Create Multiple Loans with Unique IDs", lendOfferParams, "USDC"); // Log loan parameters

    // Transfer and approve USDC for two loans for testing
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount * 2n, "USDC");

    console.log("Creating first loan...");
    // Create first loan and get ID
    const [loanId1, parsedCreatedEvent1] = await createLoanAndGetId(lender, lendOfferParams);
    
    console.log("Creating second loan...");
    // Create second loan and get ID
    const [loanId2, parsedCreatedEvent2] = await createLoanAndGetId(lender, lendOfferParams);

    // Verify loans have different IDs
    expect(loanId1).to.not.equal(loanId2);
    console.log("Verified loan IDs are unique: ", loanId1.toString(), "!=", loanId2.toString());

    // Verify both loans exist
    console.log("Verifying both loans exist...");
    const loan1 = await loanFactory.loans(loanId1); // Get first loan details
    const loan2 = await loanFactory.loans(loanId2); // Get second loan details
    expect(loan1.lender).to.equal(lender.address);
    expect(loan2.lender).to.equal(lender.address);
    console.log("Loan 1 lender:", loan1.lender, ", Loan 2 lender:", loan2.lender);
    console.log("Verification complete: Both loans exist and have correct lenders.");

    // Verify Created event for first loan
    const expectedRate1 = await loanFactory.RATE_BPS(lendOfferParams.rateIndex);
    const expectedDuration1 = await loanFactory.DURATION_DAYS(lendOfferParams.durationIndex);
    await verifyCreatedEvent(parsedCreatedEvent1, loanId1, lender.address, assetAmount, LoanStatus.s1, expectedRate1, expectedDuration1);
    
    // Verify Created event for second loan
    const expectedRate2 = await loanFactory.RATE_BPS(lendOfferParams.rateIndex);
    const expectedDuration2 = await loanFactory.DURATION_DAYS(lendOfferParams.durationIndex);
    await verifyCreatedEvent(parsedCreatedEvent2, loanId2, lender.address, assetAmount, LoanStatus.s1, expectedRate2, expectedDuration2);
  });
});
