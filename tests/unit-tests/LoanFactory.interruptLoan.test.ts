import { expect } from "chai";
import { ethers } from "hardhat";
import { loanFactory, usdcMock, btcMock, lender, borrower, deployContracts, loanCalculatorTest, LoanStatus} from "../utils/deployments";
import {
  setupLoanParamsAndLog,
  createLoanAndGetId,
  transferAndApproveToken,
  interruptLoanAndVerify,
  verifyInterruptionTokenTransfers,
  verifyLoanDeleted,
  verifyInterruptedEvent,
  createLendOfferParams,
  verifyLoanDetails,
  createBorrowOfferParams,
} from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory interruptLoan tests for VeniceFi", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should interrupt loan successfully with full interest", async function () {
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

    await setupLoanParamsAndLog("Interrupt Loan Successfully with Full Interest (Basic)", loanParams, "USDC", "BTC");

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), borrowCollateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, borrowCollateralAmount, LoanStatus.s2);

    const lendOfferAssetAmount = hre.ethers.parseUnits("50000", 6); // 50,000 USDC
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

    await setupLoanParamsAndLog("Lend Offer for Interrupt Loan Successfully with Full Interest", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), lendOfferAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, lendOfferAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, lendOfferAssetAmount, borrowCollateralAmount, LoanStatus.s3);

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      lendOfferAssetAmount,
      await loanFactory.RATE_BPS(lendOfferRateIndex),
      await loanFactory.DURATION_DAYS(lendOfferDurationIndex)
    );
    console.log(`Calculated total repayment: ${totalRepayment.toString()} USDC.`);

    await transferAndApproveToken(usdcMock, borrower, await loanFactory.getAddress(), totalRepayment, "USDC");

    const interruptReceipt = await interruptLoanAndVerify(borrower, lendOfferId);

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

    await verifyLoanDeleted(lendOfferId);

    await verifyInterruptedEvent(interruptReceipt, borrower.address);
  });

  it("Should interrupt loan with different parameters", async function () {
    const collateralAmount = hre.ethers.parseUnits("2", 8); // 2 BTC
    const loanAssetAmount = hre.ethers.parseUnits("50000", 6); // 50,000 USDC
    const rateIndex = 3; // 7% annual rate
    const durationIndex = 4; // 180 days

    const loanParams = {
      assetAmount: 0n,
      collateralAmount: collateralAmount,
      rateIndex: rateIndex,
      durationIndex: durationIndex,
      initialCollateralRatio: 12000,
      liquidationThreshold: 11000,
      assetAddress: await usdcMock.getAddress(),
      collateralAddress: await btcMock.getAddress(),
    };

    await setupLoanParamsAndLog("Interrupt Loan with Different Parameters", loanParams, "USDC", "BTC");

    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");

    const [borrowOfferId] = await createLoanAndGetId(borrower, loanParams);

    await verifyLoanDetails(borrowOfferId, ethers.ZeroAddress, borrower.address, loanParams.assetAmount, collateralAmount, LoanStatus.s2);

    const lendOfferAssetAmount = hre.ethers.parseUnits("50000", 6); // 50,000 USDC
    const lendOfferRateIndex = rateIndex;
    const lendOfferDurationIndex = durationIndex;
    const lendOfferInitialCollateralRatio = 11000;
    const lendOfferLiquidationThreshold = 10000;
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

    await setupLoanParamsAndLog("Lend Offer for Interrupt Loan with Different Parameters", lendOfferParams, "USDC");

    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), loanAssetAmount, "USDC");

    const [lendOfferId] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(lendOfferId, lender.address, ethers.ZeroAddress, loanAssetAmount, 0n, LoanStatus.s1);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    console.log(`Loan ${lendOfferId.toString()} taken up by borrower ${borrower.address}`);

    await verifyLoanDetails(lendOfferId, lender.address, borrower.address, loanAssetAmount, collateralAmount, LoanStatus.s3);

    const totalRepayment = await loanCalculatorTest.testCalculateTotalRepayment(
      loanAssetAmount,
      await loanFactory.RATE_BPS(rateIndex),
      await loanFactory.DURATION_DAYS(durationIndex)
    );
    console.log(`Calculated total repayment: ${totalRepayment.toString()} USDC.`);

    await transferAndApproveToken(usdcMock, borrower, await loanFactory.getAddress(), totalRepayment, "USDC");

    const interruptReceipt = await interruptLoanAndVerify(borrower, lendOfferId);

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

    await verifyLoanDeleted(lendOfferId);

    await verifyInterruptedEvent(interruptReceipt, borrower.address);
  });
});
