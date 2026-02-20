import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyLoanDetails, verifyTokenBalances, verifyLoanDeleted, cancelLoanAndVerify, verifyCancelledEvent, createLendOfferParams } from "../utils/loanHelpers";

import hre from "hardhat";

// Test suite: LoanFactory cancelLoan tests for VeniceFi
describe("LoanFactory cancelLoan tests for VeniceFi", function () {
    
  beforeEach(async function () {
    await deployContracts();
  });

  // Test case: cancel a lend offer successfully - Check
  it("Should cancel a lend offer successfully", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6); // 1,000 USDC
    const rateIndex = 1; // 5% annual rate
    const durationIndex = 1; // 7 days
    const assetAddress = await usdcMock.getAddress();
    const collateralAddress = ethers.ZeroAddress;
    const initialCollateralRatio = 12000; // 120%
    const liquidationThreshold = 11000; // 110%


    const lendOfferParams = await createLendOfferParams(
      assetAmount,
      rateIndex,
      durationIndex,
      assetAddress,
      collateralAddress,
      initialCollateralRatio,
      liquidationThreshold,
    );

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Cancel a Lend Offer Successfully", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");

    // Create loan and get ID
    const [loanId, parsedCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    // Verify USDC is in contract
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(usdcMock, contractAddress, ethers.ZeroAddress, assetAmount, 0n, "USDC");

    // Cancel the lend offer
    const cancelReceipt = await cancelLoanAndVerify(lender, loanId);

    // Verify loan was deleted
    await verifyLoanDeleted(loanId);

    // Verify USDC was returned to lender
    await verifyTokenBalances(usdcMock, contractAddress, lender.address, 0n, assetAmount, "USDC");

    // Verify Cancelled event was emitted
    await verifyCancelledEvent(cancelReceipt, lender.address, LoanStatus.s1);
  });

  // Test case: cancel a borrow offer successfully - Check
  it("Should cancel a borrow offer successfully", async function () {
    const assetAmount = 0n;
    const collateralAmount = hre.ethers.parseUnits("1", 8); // 1 BTC
    const rateIndex = 2; // 6% annual rate
    const durationIndex = 2; // 30 days
    const initialCollateralRatio = 12000; // 120%
    const liquidationThreshold = 11000; // 110%
    const assetAddress = ethers.ZeroAddress;
    const collateralAddress = await btcMock.getAddress();

    const loanParams = {
      assetAmount,
      collateralAmount,
      rateIndex,
      durationIndex,
      initialCollateralRatio,
      liquidationThreshold,
      assetAddress,
      collateralAddress,
    };

    // Setup loan parameters and log them
    await setupLoanParamsAndLog("Cancel a Borrow Offer Successfully", loanParams, undefined, "BTC");

    // Transfer and approve BTC
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");

    // Create loan and get ID
    const [loanId, parsedCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    // Verify BTC is in contract
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, ethers.ZeroAddress, collateralAmount, 0n, "BTC");

    // Cancel the borrow offer
    const cancelReceipt = await cancelLoanAndVerify(borrower, loanId);

    // Verify loan was deleted
    await verifyLoanDeleted(loanId);

    // Verify BTC was returned to borrower
    await verifyTokenBalances(btcMock, contractAddress, borrower.address, 0n, collateralAmount, "BTC");

    // Verify Cancelled event was emitted
    await verifyCancelledEvent(cancelReceipt, borrower.address, LoanStatus.s2);
  });

  // Test case: cancel multiple loans successfully - Check
  it("Should cancel multiple loans successfully", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const rateIndex = 1;
    const durationIndex = 1;
    const assetAddress = await usdcMock.getAddress();
    const collateralAddress = await btcMock.getAddress();
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
    await setupLoanParamsAndLog("Cancel Multiple Loans Successfully", lendOfferParams, "USDC");

    // Transfer and approve USDC
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount * 2n, "USDC");

    console.log("Creating first loan...");
    const [loanId1, parsedCreatedEvent1] = await createLoanAndGetId(lender, lendOfferParams);
    
    console.log("Creating second loan...");
    const [loanId2, parsedCreatedEvent2] = await createLoanAndGetId(lender, lendOfferParams);

    // Cancel first loan
    const cancelReceipt1 = await cancelLoanAndVerify(lender, loanId1);

    // Cancel second loan
    const cancelReceipt2 = await cancelLoanAndVerify(lender, loanId2);

    // Verify both loans were deleted
    await verifyLoanDeleted(loanId1);
    await verifyLoanDeleted(loanId2);

    // Verify all USDC was returned
    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(usdcMock, contractAddress, lender.address, 0n, assetAmount * 2n, "USDC");

    // Verify Cancelled events were emitted (assuming separate events for each cancellation)
    await verifyCancelledEvent(cancelReceipt1, lender.address, LoanStatus.s1);
    await verifyCancelledEvent(cancelReceipt2, lender.address, LoanStatus.s1);
  });
});
