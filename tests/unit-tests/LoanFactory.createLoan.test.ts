import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory, LoanStatus } from "../utils/deployments";
import { setupLoanParamsAndLog, transferAndApproveToken, createLoanAndGetId, verifyLoanDetails, verifyTokenBalances, verifyCreatedEvent, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory createLoan tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should create a lend offer successfully", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const rateIndex = 1;
    const durationIndex = 1;
    const initialCollateralRatio = 12000;
    const liquidationThreshold = 11000;

    const lendOfferParams = await createLendOfferParams(
      assetAmount, rateIndex, durationIndex,
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      initialCollateralRatio, liquidationThreshold
    );
    await setupLoanParamsAndLog("Create a Lend Offer Successfully", lendOfferParams, "USDC");
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");

    const [loanId, parsedCreatedEvent] = await createLoanAndGetId(lender, lendOfferParams);

    await verifyLoanDetails(loanId, lender.address, ethers.ZeroAddress, assetAmount, 0n, LoanStatus.s1);
    await verifyTokenBalances(usdcMock, await loanFactory.getAddress(), lender.address, assetAmount, 0n, "USDC");

    const expectedRate = await loanFactory.RATE_BPS(rateIndex);
    const expectedDuration = await loanFactory.DURATION_DAYS(durationIndex);
    await verifyCreatedEvent(parsedCreatedEvent, loanId, lender.address, assetAmount, LoanStatus.s1, expectedRate, expectedDuration);
  });

  it("Should create a borrow offer successfully", async function () {
    const collateralAmount = hre.ethers.parseUnits("1", 8);
    const rateIndex = 2;
    const durationIndex = 2;
    const initialCollateralRatio = 12000;
    const liquidationThreshold = 11000;

    const loanParams = await createBorrowOfferParams(
      collateralAmount, rateIndex, durationIndex,
      initialCollateralRatio, liquidationThreshold,
      await usdcMock.getAddress(),
      await btcMock.getAddress()
    );
    await setupLoanParamsAndLog("Create a Borrow Offer Successfully", loanParams, undefined, "BTC");
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");

    const [borrowLoanId, parsedBorrowCreatedEvent] = await createLoanAndGetId(borrower, loanParams);

    await verifyLoanDetails(borrowLoanId, ethers.ZeroAddress, borrower.address, 0n, collateralAmount, LoanStatus.s2);
    await verifyTokenBalances(btcMock, await loanFactory.getAddress(), borrower.address, collateralAmount, 0n, "BTC");

    const expectedRate = await loanFactory.RATE_BPS(rateIndex);
    const expectedDuration = await loanFactory.DURATION_DAYS(durationIndex);
    await verifyCreatedEvent(parsedBorrowCreatedEvent, borrowLoanId, borrower.address, collateralAmount, LoanStatus.s2, expectedRate, expectedDuration);
  });

  it("Should create multiple loans with unique IDs", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const rateIndex = 1;
    const durationIndex = 1;
    const initialCollateralRatio = 12000;
    const liquidationThreshold = 11000;

    const lendOfferParams = await createLendOfferParams(
      assetAmount, rateIndex, durationIndex,
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      initialCollateralRatio, liquidationThreshold
    );
    await setupLoanParamsAndLog("Create Multiple Loans with Unique IDs", lendOfferParams, "USDC");
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount * 2n, "USDC");

    const [loanId1] = await createLoanAndGetId(lender, lendOfferParams);
    const [loanId2] = await createLoanAndGetId(lender, lendOfferParams);

    expect(loanId1).to.not.equal(loanId2);
    console.log("Verified loan IDs are unique:", loanId1.toString(), "!=", loanId2.toString());

    const loan1 = await loanFactory.loans(loanId1);
    const loan2 = await loanFactory.loans(loanId2);
    expect(loan1.lender).to.equal(lender.address);
    expect(loan2.lender).to.equal(lender.address);
  });

  it("Should reject lend offer below minimum asset amount", async function () {
    const assetAmount = hre.ethers.parseUnits("50", 6); // below 100 USDC minimum
    const lendOfferParams = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    await expect(createLoanAndGetId(lender, lendOfferParams)).to.be.reverted;
  });

  it("Should reject loan with initialCollateralRatio <= liquidationThreshold", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const lendOfferParams = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(),
      await btcMock.getAddress(),
      11000, // initialCollateralRatio
      11000  // liquidationThreshold — must be strictly less
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    await expect(createLoanAndGetId(lender, lendOfferParams))
      .to.be.revertedWith("Initial collateral ratio must exceed liquidation threshold");
  });

  it("Should reject loan with unsupported token pair", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    const lendOfferParams = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(),
      ethers.ZeroAddress, // not registered
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    await expect(createLoanAndGetId(lender, lendOfferParams))
      .to.be.revertedWith("Unsupported collateral/asset pair");
  });
});
