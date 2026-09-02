import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, mockAggregator, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyLoanDetails, verifyTokenBalances, fastForwardTime, verifyLoanDeleted, liquidateLoanAndVerify, verifyLiquidationTokenTransfers, verifyLiquidatedEvent, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory liquidateLoan tests for Pavo", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should liquidate a loan with unhealthy collateral ratio", async function () {
    // 0.601 BTC at $50k = $30,050 collateral. Loan = $25,000. Initial health ~120%.
    // After price drop to $40k: 0.601 BTC = $24,040 < 110% * $25,000 = $27,500 → liquidatable
    const borrowCollateralAmount = hre.ethers.parseUnits("0.601", 8);
    const borrowRateIndex = 7; // 11% annual rate
    const borrowDurationIndex = 5; // 365 days
    const borrowOfferInitialCollateralRatio = 12000; // 120% initial (passes with $50k price)
    const borrowOfferLiquidationThreshold = 11000; // 110%
    const borrowAssetAddress = await usdcMock.getAddress();
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

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, borrowCollateralAmount, LoanStatus.s2);

    const lendOfferAssetAmount = hre.ethers.parseUnits("25000", 6); // 25,000 USDC
    const lendOfferRateIndex = 7; // 11% annual rate
    const lendOfferDurationIndex = 5; // 365 days
    const lendOfferInitialCollateralRatio = 12000; // 120%
    const lendOfferLiquidationThreshold = 11000; // 110%
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
    await setupLoanParamsAndLog("Lend Offer for Liquidation", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3);

    // Drop BTC price to $40,000 — makes 0.601 BTC = $24,040 < 110% * $25k = $27,500
    const newBtcPrice = 40_000n * 10n ** 8n;
    await mockAggregator.setAnswer(newBtcPrice);
    console.log("BTC price dropped to $40,000 to trigger liquidation");

    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, ethers.ZeroAddress, borrowCollateralAmount, 0n, "BTC");

    const liquidateReceipt = await liquidateLoanAndVerify(lender, lendOfferId);

    await verifyLoanDeleted(lendOfferId);

    await verifyLiquidationTokenTransfers(lender, borrower, contractAddress, borrowCollateralAmount, lendOfferAssetAmount);

    await verifyLiquidatedEvent(liquidateReceipt, lender.address);
  });

  it("Should liquidate a loan with different parameters", async function () {
    // 0.721 BTC at $50k = $36,050 collateral. Loan = $30,000. Initial health ~120%.
    // After price drop to $40k: 0.721 BTC = $28,840 < 110% * $30k = $33,000 → liquidatable
    const borrowCollateralAmount = hre.ethers.parseUnits("0.721", 8);
    const borrowRateIndex = 7; // 11% annual rate
    const borrowDurationIndex = 5; // 365 days
    const borrowOfferInitialCollateralRatio = 12000; // 120%
    const borrowOfferLiquidationThreshold = 11000; // 110%
    const borrowAssetAddress = await usdcMock.getAddress();
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

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, borrowCollateralAmount, LoanStatus.s2);

    const lendOfferAssetAmount = hre.ethers.parseUnits("30000", 6); // 30,000 USDC
    const lendOfferRateIndex = 7; // 11% annual rate
    const lendOfferDurationIndex = 5; // 365 days
    const lendOfferInitialCollateralRatio = 12000; // 120%
    const lendOfferLiquidationThreshold = 11000; // 110%
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
    await setupLoanParamsAndLog("Lend Offer for Liquidation with Different Parameters", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3);

    // Drop BTC price to $40,000 — makes 0.721 BTC = $28,840 < 110% * $30k = $33,000
    const newBtcPrice = 40_000n * 10n ** 8n;
    await mockAggregator.setAnswer(newBtcPrice);
    console.log("BTC price dropped to $40,000 to trigger liquidation");

    const contractAddress = await loanFactory.getAddress();
    await verifyTokenBalances(btcMock, contractAddress, ethers.ZeroAddress, borrowCollateralAmount, 0n, "BTC");

    const liquidateReceipt = await liquidateLoanAndVerify(lender, lendOfferId);

    await verifyLoanDeleted(lendOfferId);

    await verifyLiquidationTokenTransfers(lender, borrower, contractAddress, borrowCollateralAmount, lendOfferAssetAmount);

    await verifyLiquidatedEvent(liquidateReceipt, lender.address);
  });
});
