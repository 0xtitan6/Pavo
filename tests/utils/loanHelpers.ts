import { expect } from "chai";
import { ethers } from "hardhat";
import { usdcMock, btcMock, loanFactory, loanCalculatorTest, priceOracle } from "./deployments";
import hre from "hardhat";

interface LoanParams {
  assetAmount: bigint;
  collateralAmount: bigint;
  rateIndex: number;
  durationIndex: number;
  initialCollateralRatio: number;
  liquidationThreshold: number;
  assetAddress: string;
  collateralAddress: string;
}

// **********************************************************
//                 Utilities
// **********************************************************

export async function fastForwardTime(days: number) {
  const seconds = days * 24 * 60 * 60 + 1;
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine", []);
}

// **********************************************************
//                 Loan Parameter Creation
// **********************************************************

export async function setupLoanParamsAndLog(testCaseName: string, loanParams: LoanParams, assetUnit?: string, collateralUnit?: string) {
  console.log(`\n--- Test Case: ${testCaseName} ---`);
  console.log(`  Asset Amount: ${loanParams.assetAmount.toString()} ${assetUnit || ""}`);
  console.log(`  Collateral Amount: ${loanParams.collateralAmount.toString()} ${collateralUnit || ""}`);
  console.log(`  Rate Index: ${loanParams.rateIndex}, Duration Index: ${loanParams.durationIndex}`);
  console.log(`  Initial Collateral Ratio: ${loanParams.initialCollateralRatio}, Liquidation Threshold: ${loanParams.liquidationThreshold}`);
}

export async function createLendOfferParams(
  assetAmount: bigint,
  rateIndex: number,
  durationIndex: number,
  assetAddress: string,
  collateralAddress: string,
  initialCollateralRatio: number,
  liquidationThreshold: number
): Promise<LoanParams> {
  return {
    assetAmount,
    collateralAmount: 0n,
    rateIndex,
    durationIndex,
    initialCollateralRatio,
    liquidationThreshold,
    assetAddress,
    collateralAddress,
  };
}

export async function createBorrowOfferParams(
  collateralAmount: bigint,
  rateIndex: number,
  durationIndex: number,
  initialCollateralRatio: number,
  liquidationThreshold: number,
  assetAddress: string,
  collateralAddress: string
): Promise<LoanParams> {
  return {
    assetAmount: 0n,
    collateralAmount,
    rateIndex,
    durationIndex,
    initialCollateralRatio,
    liquidationThreshold,
    assetAddress,
    collateralAddress,
  };
}

// **********************************************************
//                 Loan Lifecycle Actions
// **********************************************************

export async function createLoanAndGetId(signer: any, loanParams: LoanParams): Promise<any> {
  const createTx = await loanFactory.connect(signer).createLoan(
    loanParams.assetAmount,
    loanParams.collateralAmount,
    loanParams.initialCollateralRatio,
    loanParams.liquidationThreshold,
    loanParams.assetAddress,
    loanParams.collateralAddress,
    loanParams.rateIndex,
    loanParams.durationIndex
  );
  const receipt = await createTx.wait();
  expect(receipt.status).to.equal(1);

  const createdEvent = receipt.logs.find((log: any) => {
    try { return loanFactory.interface.parseLog(log)?.name === "Created"; }
    catch { return false; }
  });
  expect(createdEvent).to.not.be.undefined;
  const parsed = loanFactory.interface.parseLog(createdEvent!);
  const loanId = parsed!.args[0];
  expect(loanId).to.not.equal(0);
  console.log("Created Loan ID:", loanId.toString());
  return [loanId, parsed];
}

export async function cancelLoanAndVerify(signer: any, loanId: bigint): Promise<any> {
  const tx = await loanFactory.connect(signer).cancelLoan(loanId);
  const receipt = await tx.wait();
  expect(receipt.status).to.equal(1);
  return receipt;
}

export async function endLoanAndVerify(signer: any, loanId: bigint): Promise<any> {
  const tx = await loanFactory.connect(signer).endLoan(loanId);
  const receipt = await tx.wait();
  expect(receipt.status).to.equal(1);
  return receipt;
}

export async function interruptLoanAndVerify(signer: any, loanId: bigint): Promise<any> {
  const tx = await loanFactory.connect(signer).interruptLoan(loanId);
  const receipt = await tx.wait();
  expect(receipt.status).to.equal(1);
  return receipt;
}

export async function liquidateLoanAndVerify(liquidator: any, loanId: bigint): Promise<any> {
  const tx = await loanFactory.connect(liquidator).liquidateLoan(loanId);
  const receipt = await tx.wait();
  expect(receipt.status).to.equal(1);
  return receipt;
}

export async function topUpAndVerify(borrower: any, loanId: bigint, amount: bigint): Promise<any> {
  const tx = await loanFactory.connect(borrower).topUp(loanId, amount);
  const receipt = await tx.wait();
  expect(receipt.status).to.equal(1);
  return receipt;
}

// **********************************************************
//                 Verification Functions
// **********************************************************

export async function verifyLoanDetails(
  loanId: bigint,
  expectedLender: string,
  expectedBorrower: string,
  expectedAssetAmount: bigint,
  expectedCollateralAmount: bigint,
  expectedStatus: any
) {
  const loan = await loanFactory.loans(loanId);
  expect(loan.lender).to.equal(expectedLender);
  expect(loan.borrower).to.equal(expectedBorrower);
  expect(loan.asset).to.equal(expectedAssetAmount);
  expect(loan.collateral).to.equal(expectedCollateralAmount);
  expect(loan.s).to.equal(expectedStatus);
}

export async function verifyLoanDeleted(loanId: bigint) {
  const loan = await loanFactory.loans(loanId);
  expect(loan.id).to.equal(0);
  expect(loan.lender).to.equal(ethers.ZeroAddress);
  expect(loan.borrower).to.equal(ethers.ZeroAddress);
}

export async function verifyCollateralIncrease(loanId: bigint, expectedFinalCollateral: bigint) {
  const loan = await loanFactory.loans(loanId);
  expect(loan.collateral).to.equal(expectedFinalCollateral);
}

export async function verifyTokenBalances(
  tokenMock: any,
  contractAddress: string,
  participantAddress: string,
  expectedContractBalance: bigint,
  expectedParticipantBalance: bigint,
  tokenName: string
) {
  const contractBalance = await tokenMock.balanceOf(contractAddress);
  const participantBalance = await tokenMock.balanceOf(participantAddress);
  expect(contractBalance).to.equal(expectedContractBalance);
  expect(participantBalance).to.equal(expectedParticipantBalance);
  console.log(`LoanFactory ${tokenName} balance: ${contractBalance.toString()}`);
  console.log(`${participantAddress} ${tokenName} balance: ${participantBalance.toString()}`);
}

// **********************************************************
//                 Event Verifications
// **********************************************************

export async function verifyCreatedEvent(
  parsedEvent: any,
  expectedLoanId: bigint,
  expectedParticipant: string,
  expectedAmount: bigint,
  expectedStatus: any,
  expectedRate: bigint,
  expectedDuration: bigint
) {
  expect(parsedEvent!.args[0]).to.equal(expectedLoanId);
  expect(parsedEvent!.args[1]).to.equal(expectedParticipant);
  expect(parsedEvent!.args[2]).to.equal(expectedAmount);
  expect(parsedEvent!.args[3]).to.equal(expectedStatus);
  expect(parsedEvent!.args[4]).to.equal(expectedRate);
  expect(parsedEvent!.args[5]).to.equal(expectedDuration);
}

export async function verifyCancelledEvent(receipt: any, expectedParticipant: string, expectedStatus: any) {
  const event = receipt.logs.find((log: any) => {
    try { return loanFactory.interface.parseLog(log)?.name === "Cancelled"; }
    catch { return false; }
  });
  expect(event).to.not.be.undefined;
  const parsed = loanFactory.interface.parseLog(event!);
  expect(parsed!.args[0]).to.equal(expectedParticipant);
  expect(parsed!.args[1]).to.equal(expectedStatus);
}

export async function verifyEndedEvent(receipt: any, expectedParticipant: string) {
  const event = receipt.logs.find((log: any) => {
    try { return loanFactory.interface.parseLog(log)?.name === "Ended"; }
    catch { return false; }
  });
  expect(event).to.not.be.undefined;
  const parsed = loanFactory.interface.parseLog(event!);
  expect(parsed!.args[0]).to.equal(expectedParticipant);
}

export async function verifyInterruptedEvent(receipt: any, expectedParticipant: string) {
  const event = receipt.logs.find((log: any) => {
    try { return loanFactory.interface.parseLog(log)?.name === "Interrupted"; }
    catch { return false; }
  });
  expect(event).to.not.be.undefined;
  const parsed = loanFactory.interface.parseLog(event!);
  expect(parsed!.args[0]).to.equal(expectedParticipant);
}

export async function verifyLiquidatedEvent(receipt: any, expectedLiquidator: string) {
  const event = receipt.logs.find((log: any) => {
    try { return loanFactory.interface.parseLog(log)?.name === "Liquidated"; }
    catch { return false; }
  });
  expect(event).to.not.be.undefined;
  const parsed = loanFactory.interface.parseLog(event!);
  expect(parsed!.args[0]).to.equal(expectedLiquidator);
}

export async function verifyToppedUpEvent(receipt: any, expectedParticipant: string) {
  const event = receipt.logs.find((log: any) => {
    try { return loanFactory.interface.parseLog(log)?.name === "ToppedUp"; }
    catch { return false; }
  });
  expect(event).to.not.be.undefined;
  const parsed = loanFactory.interface.parseLog(event!);
  expect(parsed!.args[0]).to.equal(expectedParticipant);
}

// **********************************************************
//                 Token Transfers/Approvals
// **********************************************************

export async function transferAndApproveToken(
  tokenMock: any,
  from: any,
  spenderAddress: string,
  amount: bigint,
  tokenName: string
) {
  await tokenMock.transfer(from.address, amount);
  await tokenMock.connect(from).approve(spenderAddress, amount);
  console.log(`Transferred and approved ${amount.toString()} ${tokenName} for ${from.address}`);
}

export async function prepareBorrowerForRepayment(borrower: any, totalRepayment: bigint) {
  const approvalAmount = (totalRepayment * 105n) / 100n;
  await transferAndApproveToken(usdcMock, borrower, await loanFactory.getAddress(), approvalAmount, "USDC");
}

export async function prepareBorrowerForTopUp(borrower: any, totalCollateralNeeded: bigint) {
  await btcMock.transfer(borrower.address, totalCollateralNeeded);
  await btcMock.connect(borrower).approve(await loanFactory.getAddress(), totalCollateralNeeded);
}

// **********************************************************
//                 Comprehensive Verifications
// **********************************************************

export async function verifyEndLoanTokenTransfers(
  lender: any,
  borrower: any,
  contractAddress: string,
  loanAssetAmount: bigint,
  borrowCollateralAmount: bigint,
  lendOfferRateIndex: number,
  lendOfferDurationIndex: number,
  collateralAddress: string
) {
  const oracleAddress = await priceOracle.getAddress();

  const expectedBtcPayout = await loanCalculatorTest.testCalculateBTCPayout.staticCall(
    loanAssetAmount,
    await loanFactory.RATE_BPS(lendOfferRateIndex),
    await loanFactory.DURATION_DAYS(lendOfferDurationIndex),
    borrowCollateralAmount,
    collateralAddress,
    6, // assetDecimals — USDC has 6 decimals
    oracleAddress
  );
  const expectedExcessCollateral = await loanCalculatorTest.testCalculateExcessCollateral.staticCall(
    loanAssetAmount,
    await loanFactory.RATE_BPS(lendOfferRateIndex),
    await loanFactory.DURATION_DAYS(lendOfferDurationIndex),
    borrowCollateralAmount,
    collateralAddress,
    6, // assetDecimals — USDC has 6 decimals
    oracleAddress
  );

  const finalLenderBtcBalance = await btcMock.balanceOf(lender.address);
  const finalBorrowerBtcBalance = await btcMock.balanceOf(borrower.address);

  expect(finalLenderBtcBalance).to.equal(expectedBtcPayout);
  expect(finalBorrowerBtcBalance).to.equal(expectedExcessCollateral);

  console.log("Lender BTC balance after endLoan:", finalLenderBtcBalance.toString());
  console.log("Borrower BTC balance after endLoan (excess):", finalBorrowerBtcBalance.toString());

  await verifyTokenBalances(btcMock, contractAddress, ethers.ZeroAddress, 0n, 0n, "BTC");
  await verifyTokenBalances(usdcMock, contractAddress, ethers.ZeroAddress, 0n, 0n, "USDC");
}

export async function verifyInterruptionTokenTransfers(
  lenderAddress: string,
  borrowerAddress: string,
  loanFactoryAddress: string,
  usdcMockAddress: string,
  btcMockAddress: string,
  loanAssetAmount: bigint,
  collateralAmount: bigint,
  totalRepayment: bigint
) {
  const lenderUsdcBalance = await usdcMock.balanceOf(lenderAddress);
  expect(lenderUsdcBalance).to.equal(totalRepayment);
  console.log(`Lender USDC balance after interruption: ${lenderUsdcBalance.toString()}`);

  const borrowerBtcBalance = await btcMock.balanceOf(borrowerAddress);
  expect(borrowerBtcBalance).to.equal(collateralAmount);
  console.log(`Borrower BTC balance after interruption: ${borrowerBtcBalance.toString()}`);

  expect(await usdcMock.balanceOf(loanFactoryAddress)).to.equal(0n);
  expect(await btcMock.balanceOf(loanFactoryAddress)).to.equal(0n);
}

export async function verifyLiquidationTokenTransfers(
  lender: any,
  borrower: any,
  contractAddress: string,
  collateralAmount: bigint,
  assetAmount: bigint
) {
  const lenderBtcBalance = await btcMock.balanceOf(lender.address);
  expect(lenderBtcBalance).to.equal(collateralAmount);
  console.log(`Lender BTC balance after liquidation: ${lenderBtcBalance.toString()}`);

  expect(await btcMock.balanceOf(contractAddress)).to.equal(0n);
  expect(await usdcMock.balanceOf(contractAddress)).to.equal(0n);
}
