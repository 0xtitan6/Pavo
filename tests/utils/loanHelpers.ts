import { expect } from "chai";
import { ethers } from "hardhat";
import { usdcMock, btcMock, loanFactory, loanCalculatorTest } from "./deployments";

import hre from "hardhat";

/**
 * @dev Interface for loan parameters.
 */
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

/**
 * @dev Fast forwards the blockchain time by a specified number of days.
 * @param days The number of days to fast forward.
 */
export async function fastForwardTime(days: number) {
  const daysInSeconds = days * 24 * 60 * 60 + 1; // Add 1 second to ensure passing the exact duration
  await hre.network.provider.send("evm_increaseTime", [daysInSeconds]);
  await hre.network.provider.send("evm_mine", []);
  console.log(`Time fast-forwarded by ${daysInSeconds} seconds (${days} days + 1 second).`);
}

// **********************************************************
//                 Loan Parameter Creation
// **********************************************************

/**
 * @dev Sets up common loan parameters for logging and returns a `LoanParams` object.
 * @param testCaseName A descriptive name for the test case.
 * @param loanParams The LoanParams object containing loan details.
 * @param assetUnit A string representing the unit of the asset (e.g., "USDC").
 * @param collateralUnit A string representing the unit of the collateral (e.g., "BTC").
 */
export async function setupLoanParamsAndLog(testCaseName: string, loanParams: LoanParams, assetUnit?: string, collateralUnit?: string) {
  console.log(`\n--- Test Case: ${testCaseName} ---`);
  console.log("Loan Parameters:");
  console.log(`  Asset Amount: ${loanParams.assetAmount.toString()} ${assetUnit || ""}`);
  console.log(`  Collateral Amount: ${loanParams.collateralAmount.toString()} ${collateralUnit || ""}`);
  console.log(`  Rate Index: ${loanParams.rateIndex}`);
  console.log(`  Duration Index: ${loanParams.durationIndex}`);
  console.log(`  Initial Collateral Ratio: ${loanParams.initialCollateralRatio}`);
  console.log(`  Liquidation Threshold: ${loanParams.liquidationThreshold}`);
  console.log(`  Asset Address: ${loanParams.assetAddress}`);
  console.log(`  Collateral Address: ${loanParams.collateralAddress}`);
}

/**
 * @dev Creates a LoanParams object specifically for a lend offer with default values.
 * @param assetAmount The asset amount of the lend offer.
 * @param rateIndex The interest rate index for the lend offer.
 * @param durationIndex The duration index of the lend offer.
 * @param assetAddress The token address for the loan asset (USDC).
 * @param collateralAddress The token address for the collateral asset (BTC).
 * @returns A LoanParams object configured for a lend offer.
 */
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
    assetAmount: assetAmount,
    collateralAmount: 0n, // For lend offer, collateral should be 0
    rateIndex: rateIndex,
    durationIndex: durationIndex,
    initialCollateralRatio: initialCollateralRatio, 
    liquidationThreshold: liquidationThreshold,
    assetAddress: assetAddress,
    collateralAddress: collateralAddress,
  };
}

/**
 * @dev Creates a LoanParams object specifically for a borrow offer with default values.
 * @param collateralAmount The collateral amount of the borrow offer.
 * @param rateIndex The interest rate index for the borrow offer.
 * @param durationIndex The duration index of the borrow offer.
 * @param initialCollateralRatio The initial collateral ratio for the borrow offer.
 * @param liquidationThreshold The liquidation threshold for the borrow offer.
 * @param assetAddress The token address for the loan asset (USDC).
 * @param collateralAddress The token address for the collateral asset (BTC).
 * @returns A LoanParams object configured for a borrow offer.
 */
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
    assetAmount: 0n, // For borrow offer, asset amount should be 0
    collateralAmount: collateralAmount,
    rateIndex: rateIndex,
    durationIndex: durationIndex,
    initialCollateralRatio: initialCollateralRatio,
    liquidationThreshold: liquidationThreshold,
    assetAddress: ethers.ZeroAddress, // For borrow offer, assetAddress should be ZeroAddress initially
    collateralAddress: collateralAddress,
  };
}

// **********************************************************
//                 Loan Lifecycle Actions
// **********************************************************

/**
 * @dev Creates a loan and extracts the loan ID and parsed 'Created' event from the transaction receipt.
 * @param signer The signer creating the loan (lender or borrower).
 * @param loanParams The LoanParams object containing loan details.
 * @returns A tuple containing the loan ID and the transaction receipt.
 */
export async function createLoanAndGetId(signer: any, loanParams: LoanParams): Promise<any> {
  console.log(`Creating loan offer from ${signer.address}`);
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
  const createReceipt = await createTx.wait();
  expect(createReceipt.status).to.equal(1);
  console.log("Loan offer creation successful. Transaction hash:", createReceipt.hash);

  const createdEvent = createReceipt.logs.find((log: any) => {
    try {
      const parsed = loanFactory.interface.parseLog(log);
      return parsed?.name === 'Created';
    } catch {
      return false;
    }
  });
  expect(createdEvent).to.not.be.undefined;
  const parsedCreatedEvent = loanFactory.interface.parseLog(createdEvent!);  
  const loanId = parsedCreatedEvent!.args[0];
  expect(loanId).to.not.equal(0);
  console.log("Created Loan ID:", loanId.toString());
  return [loanId, parsedCreatedEvent];
}

/**
 * @dev Cancels a loan and returns the transaction receipt.
 * @param signer The signer (lender or borrower) canceling the loan.
 * @param loanId The ID of the loan to cancel.
 * @returns The transaction receipt of the cancellation.
 */
export async function cancelLoanAndVerify(signer: any, loanId: bigint): Promise<any> {
  console.log(`Attempting to cancel loan ID: ${loanId.toString()} from ${signer.address}`);
  const cancelTx = await loanFactory.connect(signer).cancelLoan(loanId);
  const cancelReceipt = await cancelTx.wait();
  expect(cancelReceipt.status).to.equal(1);
  console.log("Loan cancelled successfully. Transaction hash:", cancelReceipt.hash);
  return cancelReceipt;
}

/**
 * @dev Ends a loan and returns the transaction receipt.
 * @param signer The signer (borrower) ending the loan.
 * @param loanId The ID of the loan to end.
 * @returns The transaction receipt of the loan ending.
 */
export async function endLoanAndVerify(signer: any, loanId: bigint): Promise<any> {
  console.log(`Attempting to end loan ID: ${loanId.toString()} from ${signer.address}`);
  const endTx = await loanFactory.connect(signer).endLoan(loanId);
  const endReceipt = await endTx.wait();
  expect(endReceipt.status).to.equal(1);
  console.log("Loan ended successfully. Transaction hash:", endReceipt.hash);
  return endReceipt;
}

/**
 * @dev Interrupts a loan and returns the transaction receipt.
 * @param signer The signer (borrower) interrupting the loan.
 * @param loanId The ID of the loan to interrupt.
 * @returns The transaction receipt of the loan interruption.
 */
export async function interruptLoanAndVerify(signer: any, loanId: bigint): Promise<any> {
  console.log(`Attempting to interrupt loan ID: ${loanId.toString()} from ${signer.address}`);
  const interruptTx = await loanFactory.connect(signer).interruptLoan(loanId);
  const interruptReceipt = await interruptTx.wait();
  expect(interruptReceipt.status).to.equal(1);
  console.log("Loan interrupted successfully. Transaction hash:", interruptReceipt.hash);
  return interruptReceipt;
}

/**
 * @dev Liquidates a loan and returns the transaction receipt.
 * @param liquidator The account performing the liquidation.
 * @param loanId The ID of the loan to liquidate.
 * @returns The transaction receipt of the liquidation.
 */
export async function liquidateLoanAndVerify(liquidator: any, loanId: bigint): Promise<any> {
  console.log(`Attempting to liquidate loan ID: ${loanId.toString()} from liquidator: ${liquidator.address}`);
  const liquidateTx = await loanFactory.connect(liquidator).liquidateLoan(loanId);
  const liquidateReceipt = await liquidateTx.wait();
  expect(liquidateReceipt.status).to.equal(1);
  console.log("Loan liquidated successfully. Transaction hash:", liquidateReceipt.hash);
  return liquidateReceipt;
}

/**
 * @dev Performs a top-up operation and verifies the transaction.
 * @param borrower The borrower account.
 * @param loanId The ID of the loan to top up.
 * @param amount The amount of additional collateral to add.
 * @returns The transaction receipt of the top-up.
 */
export async function topUpAndVerify(borrower: any, loanId: bigint, amount: bigint): Promise<any> {
  console.log(`Attempting to top up loan ID: ${loanId.toString()} with additional collateral: ${amount.toString()} BTC from borrower: ${borrower.address}`);
  const topUpTx = await loanFactory.connect(borrower).topUp(loanId, amount);
  const topUpReceipt = await topUpTx.wait();
  expect(topUpReceipt.status).to.equal(1);
  console.log("Top up successful. Transaction hash:", topUpReceipt.hash);
  return topUpReceipt;
}

// **********************************************************
//                 Verification Functions
// **********************************************************

/**
 * @dev Verifies the details of a loan against expected values.
 * @param loanId The ID of the loan to verify.
 * @param expectedLender The expected lender address.
 * @param expectedBorrower The expected borrower address.
 * @param expectedAssetAmount The expected asset amount.
 * @param expectedCollateralAmount The expected collateral amount.
 * @param expectedStatus The expected loan status (s1=LendOffer, s2=BorrowOffer, s3=Active).
 */
export async function verifyLoanDetails(loanId: bigint, expectedLender: string, expectedBorrower: string, expectedAssetAmount: bigint, expectedCollateralAmount: bigint, expectedStatus: any) {
  console.log(`Verifying loan details for ID: ${loanId.toString()}`);
  const loan = await loanFactory.loans(loanId);
  expect(loan.lender).to.equal(expectedLender);
  expect(loan.borrower).to.equal(expectedBorrower);
  expect(loan.asset).to.equal(expectedAssetAmount);
  expect(loan.collateral).to.equal(expectedCollateralAmount);
  expect(loan.s).to.equal(expectedStatus);
  console.log(`  Lender: ${loan.lender}`);
  console.log(`  Borrower: ${loan.borrower}`);
  console.log(`  Asset Amount: ${loan.asset.toString()}`);
  console.log(`  Collateral Amount: ${loan.collateral.toString()}`);
  console.log(`  Status: ${loan.s}`);
}

/**
 * @dev Verifies that a loan has been deleted by checking for default values.
 * @param loanId The ID of the loan to verify.
 */
export async function verifyLoanDeleted(loanId: bigint) {
  const loan = await loanFactory.loans(loanId);
  expect(loan.id).to.equal(0);
  expect(loan.lender).to.equal(ethers.ZeroAddress);
  expect(loan.borrower).to.equal(ethers.ZeroAddress);
  console.log(`Verified loan ID ${loanId.toString()} is deleted.`);
}

/**
 * @dev Verifies that the loan collateral amount has increased as expected after a top-up.
 * @param loanId The ID of the loan to verify.
 * @param expectedFinalCollateral The expected final collateral amount after top-up.
 */
export async function verifyCollateralIncrease(loanId: bigint, expectedFinalCollateral: bigint) {
  const finalLoan = await loanFactory.loans(loanId);
  const finalCollateral = finalLoan.collateral;
  expect(finalCollateral).to.equal(expectedFinalCollateral);
  console.log(`Final collateral in loan ID ${loanId.toString()}: ${finalCollateral.toString()} BTC (Expected: ${expectedFinalCollateral.toString()})`);
}

/**
 * @dev Verifies the token balances of the LoanFactory contract and a participant.
 * @param tokenMock The mock token contract instance.
 * @param contractAddress The address of the LoanFactory contract.
 * @param participantAddress The address of the participant (e.g., lender, borrower).
 * @param expectedContractBalance The expected token balance of the contract.
 * @param expectedParticipantBalance The expected token balance of the participant.
 * @param tokenName A string name for the token (e.g., "USDC", "BTC").
 */
export async function verifyTokenBalances(tokenMock: any, contractAddress: string, participantAddress: string, expectedContractBalance: bigint, expectedParticipantBalance: bigint, tokenName: string) {
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

/**
 * @dev Verifies the arguments of the 'Created' event.
 * @param parsedEvent The parsed 'Created' event object.
 * @param expectedLoanId The expected loan ID from the event.
 * @param expectedParticipant The expected participant address from the event.
 * @param expectedAmount The expected asset/collateral amount from the event.
 * @param expectedStatus The expected loan status from the event.
 * @param expectedRate The expected rate from the event.
 * @param expectedDuration The expected duration from the event.
 */
export async function verifyCreatedEvent(parsedEvent: any, expectedLoanId: bigint, expectedParticipant: string, expectedAmount: bigint, expectedStatus: any, expectedRate: bigint, expectedDuration: bigint) {
  expect(parsedEvent!.args[0]).to.equal(expectedLoanId);
  expect(parsedEvent!.args[1]).to.equal(expectedParticipant);
  expect(parsedEvent!.args[2]).to.equal(expectedAmount);
  expect(parsedEvent!.args[3]).to.equal(expectedStatus);
  expect(parsedEvent!.args[4]).to.equal(expectedRate);
  expect(parsedEvent!.args[5]).to.equal(expectedDuration);
  console.log(`'Created' event emitted: LoanId=${expectedLoanId.toString()},
    Participant=${expectedParticipant},
    Amount=${expectedAmount.toString()},
    Status=${expectedStatus},
    Rate=${expectedRate},
    Duration=${expectedDuration}`);
}

/**
 * @dev Verifies the arguments of the 'Cancelled' event.
 * @param receipt The transaction receipt of the cancellation.
 * @param expectedParticipant The expected participant address from the event.
 * @param expectedStatus The expected loan status from the event.
 */
export async function verifyCancelledEvent(receipt: any, expectedParticipant: string, expectedStatus: any) {
  const event = receipt.logs.find((log: any) => {
    try {
      const parsed = loanFactory.interface.parseLog(log);
      return parsed?.name === 'Cancelled';
    } catch {
      return false;
    }
  });
  expect(event).to.not.be.undefined;
  const parsedEvent = loanFactory.interface.parseLog(event!);  
  expect(parsedEvent!.args[0]).to.equal(expectedParticipant);
  expect(parsedEvent!.args[1]).to.equal(expectedStatus);
  console.log(`'Cancelled' event emitted for participant: ${expectedParticipant} with status: ${expectedStatus}`);
}

/**
 * @dev Verifies the arguments of the 'Ended' event.
 * @param receipt The transaction receipt of the loan ending.
 * @param expectedParticipant The expected participant address from the event.
 */
export async function verifyEndedEvent(receipt: any, expectedParticipant: string) {
  const event = receipt.logs.find((log: any) => {
    try {
      const parsed = loanFactory.interface.parseLog(log);
      return parsed?.name === 'Ended';
    } catch {
      return false;
    }
  });
  expect(event).to.not.be.undefined;
  const parsedEvent = loanFactory.interface.parseLog(event!);  
  expect(parsedEvent!.args[0]).to.equal(expectedParticipant);
  console.log(`'Ended' event emitted: Participant=${expectedParticipant}`);
}

/**
 * @dev Verifies the arguments of the 'Interrupted' event.
 * @param receipt The transaction receipt of the loan interruption.
 * @param expectedParticipant The expected participant address from the event.
 */
export async function verifyInterruptedEvent(receipt: any, expectedParticipant: string) {
  const event = receipt.logs.find((log: any) => {
    try {
      const parsed = loanFactory.interface.parseLog(log);
      return parsed?.name === 'Interrupted';
    } catch {
      return false;
    }
  });
  expect(event).to.not.be.undefined;
  const parsedEvent = loanFactory.interface.parseLog(event!);  
  expect(parsedEvent!.args[0]).to.equal(expectedParticipant);
  console.log(`'Interrupted' event emitted for participant: ${expectedParticipant}`);
}

/**
 * @dev Verifies the arguments of the 'Liquidated' event.
 * @param receipt The transaction receipt of the liquidation.
 * @param expectedLiquidator The expected liquidator address from the event.
 */
export async function verifyLiquidatedEvent(receipt: any, expectedLiquidator: string) {
  const event = receipt.logs.find((log: any) => {
    try {
      const parsed = loanFactory.interface.parseLog(log);
      return parsed?.name === 'Liquidated';
    } catch {
      return false;
    }
  });
  expect(event).to.not.be.undefined;
  const parsedEvent = loanFactory.interface.parseLog(event!);  
  expect(parsedEvent!.args[0]).to.equal(expectedLiquidator);
  console.log(`'Liquidated' event emitted for liquidator: ${expectedLiquidator}`);
}

/**
 * @dev Verifies the arguments of the 'ToppedUp' event.
 * @param receipt The transaction receipt of the top-up.
 * @param expectedParticipant The expected participant address from the event.
 */
export async function verifyToppedUpEvent(receipt: any, expectedParticipant: string) {
  const event = receipt.logs.find((log: any) => {
    try {
      const parsed = loanFactory.interface.parseLog(log);
      return parsed?.name === 'ToppedUp';
    } catch {
      return false;
    }
  });
  expect(event).to.not.be.undefined;
  const parsedEvent = loanFactory.interface.parseLog(event!);  
  expect(parsedEvent!.args[0]).to.equal(expectedParticipant);
  console.log(`'ToppedUp' event emitted: Participant=${expectedParticipant}`);
}

// **********************************************************
//                 Token Transfers/Approvals
// **********************************************************

/**
 * @dev Transfers a specified token amount from an owner to a recipient and approves the spender.
 * @param tokenMock The mock token contract instance (e.g., usdcMock, btcMock).
 * @param from The signer account from which tokens are transferred (owner).
 * @param spenderAddress The address of the contract/account to approve.
 * @param amount The amount of tokens to transfer and approve.
 * @param tokenName A string name for the token (e.g., "USDC", "BTC").
 */
export async function transferAndApproveToken(tokenMock: any, from: any, spenderAddress: string, amount: bigint, tokenName: string) {
  await tokenMock.transfer(from.address, amount);
  console.log(`Transferred ${amount.toString()} ${tokenName} to ${from.address}`);
  await tokenMock.connect(from).approve(spenderAddress, amount);
  console.log(`${from.address} approved ${spenderAddress} for ${amount.toString()} ${tokenName}.`);
}

/**
 * @dev Prepares the borrower for repayment by transferring USDC and approving the LoanFactory.
 * @param borrower The borrower account.
 * @param totalRepayment The total amount to repay.
 */
export async function prepareBorrowerForRepayment(borrower: any, totalRepayment: bigint) {
  // Calculate a slightly larger approval amount to account for potential precision differences
  const approvalAmount = (totalRepayment * 105n) / 100n; // 5% buffer
  // Transfer and approve USDC for repayment
  await transferAndApproveToken(usdcMock, borrower, await loanFactory.getAddress(), approvalAmount, "USDC");
}

/**
 * @dev Prepares the borrower with sufficient collateral for initial loan and subsequent top-ups.
 * @param borrower The borrower account.
 * @param totalCollateralNeeded The total amount of collateral needed (initial + additional).
 */
export async function prepareBorrowerForTopUp(borrower: any, totalCollateralNeeded: bigint) {
  await btcMock.transfer(borrower.address, totalCollateralNeeded);
  console.log(`Transferred ${totalCollateralNeeded.toString()} BTC to borrower: ${borrower.address}`);
  await btcMock.connect(borrower).approve(await loanFactory.getAddress(), totalCollateralNeeded);
  console.log(`Borrower approved LoanFactory for ${totalCollateralNeeded.toString()} BTC.`);
}

// **********************************************************
//                 Comprehensive Verifications
// **********************************************************

/**
 * @dev Verifies token transfers and balances after a loan is ended.
 * @param lender The lender account.
 * @param borrower The borrower account.
 * @param contractAddress The address of the LoanFactory contract.
 * @param loanAssetAmount The asset amount of the loan.
 * @param borrowCollateralAmount The collateral amount provided by the borrower.
 * @param lendOfferRateIndex The rate index of the lend offer.
 * @param lendOfferDurationIndex The duration index of the lend offer.
 * @param collateralAddress The address of the collateral token.
 */
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
  // Calculate expected BTC payout and excess collateral
  const expectedBtcPayout = await loanCalculatorTest.testCalculateBTCPayout(
    loanAssetAmount,
    await loanFactory.RATE_BPS(lendOfferRateIndex),
    await loanFactory.DURATION_DAYS(lendOfferDurationIndex),
    borrowCollateralAmount,
    collateralAddress
  );
  const expectedExcessCollateral = await loanCalculatorTest.testCalculateExcessCollateral(
    loanAssetAmount,
    await loanFactory.RATE_BPS(lendOfferRateIndex),
    await loanFactory.DURATION_DAYS(lendOfferDurationIndex),
    borrowCollateralAmount,
    collateralAddress
  );

  // Verify token balances after ending the loan
  const finalLenderBtcBalance = await btcMock.balanceOf(lender.address);
  const finalBorrowerBtcBalance = await btcMock.balanceOf(borrower.address);

  expect(finalLenderBtcBalance).to.equal(expectedBtcPayout);
  console.log("Lender BTC balance after end loan:", finalLenderBtcBalance.toString());
  expect(finalBorrowerBtcBalance).to.equal(expectedExcessCollateral);
  console.log("Borrower BTC balance after end loan (excess collateral):", finalBorrowerBtcBalance.toString());

  // Verify contract balances
  await verifyTokenBalances(btcMock, contractAddress, ethers.ZeroAddress, 0n, 0n, "BTC");
  await verifyTokenBalances(usdcMock, contractAddress, ethers.ZeroAddress, 0n, 0n, "USDC");
}

/**
 * @dev Verifies token transfers after a loan interruption.
 * @param lenderAddress The address of the lender.
 * @param borrowerAddress The address of the borrower.
 * @param loanFactoryAddress The address of the LoanFactory contract.
 * @param usdcMockAddress The address of the USDC mock token.
 * @param btcMockAddress The address of the BTC mock token.
 * @param loanAssetAmount The original loan asset amount.
 * @param collateralAmount The original collateral amount.
 * @param totalRepayment The total amount repaid by the borrower.
 */
export async function verifyInterruptionTokenTransfers(lenderAddress: string, borrowerAddress: string, loanFactoryAddress: string, usdcMockAddress: string, btcMockAddress: string, loanAssetAmount: bigint, collateralAmount: bigint, totalRepayment: bigint) {
  // Check that lender received full repayment (principal + full interest)
  const lenderUsdcBalance = await usdcMock.balanceOf(lenderAddress);
  expect(lenderUsdcBalance).to.equal(totalRepayment);
  console.log(`Lender USDC balance after interruption: ${lenderUsdcBalance.toString()}`);

  // Check that borrower received collateral back
  const borrowerBtcBalance = await btcMock.balanceOf(borrowerAddress);
  expect(borrowerBtcBalance).to.equal(collateralAmount);
  console.log(`Borrower BTC balance after interruption (collateral returned): ${borrowerBtcBalance.toString()}`);

  // Check that contract has the original loan amount (this is correct behavior)
  const contractUsdcBalance = await usdcMock.balanceOf(loanFactoryAddress);
  expect(contractUsdcBalance).to.equal(0); // Contract should not hold the loan asset after interruption
  console.log(`LoanFactory USDC balance after interruption: ${contractUsdcBalance.toString()}`);
  
  // Check that contract has no BTC
  const contractBtcBalance = await btcMock.balanceOf(loanFactoryAddress);
  expect(contractBtcBalance).to.equal(0);
  console.log(`LoanFactory BTC balance after interruption: ${contractBtcBalance.toString()}`);
}

/**
 * @dev Verifies token balances after a loan liquidation.
 * @param lender The lender account.
 * @param borrower The borrower account.
 * @param contractAddress The address of the LoanFactory contract.
 * @param collateralAmount The expected collateral amount transferred to the lender.
 * @param loanAssetAmount The expected loan asset amount remaining in the contract.
 */
export async function verifyLiquidationTokenTransfers(lender: any, borrower: any, contractAddress: string, collateralAmount: bigint, assetAmount: bigint) {
  // Verify BTC collateral was transferred to lender
  const lenderBtcBalance = await btcMock.balanceOf(lender.address);
  expect(lenderBtcBalance).to.equal(collateralAmount);
  console.log(`Lender BTC balance after liquidation (collateral received): ${lenderBtcBalance.toString()}`);

  // Verify contract no longer has BTC
  const btcInContractAfter = await btcMock.balanceOf(contractAddress);
  expect(btcInContractAfter).to.equal(0);
  console.log(`LoanFactory BTC balance after liquidation: ${btcInContractAfter.toString()}`);

  // Verify the contract still has the USDC loan amount
  const usdcInContractAfter = await usdcMock.balanceOf(contractAddress);
  expect(usdcInContractAfter).to.equal(0); // Contract should not hold the loan asset after liquidation
  console.log(`LoanFactory USDC balance after liquidation: ${usdcInContractAfter.toString()}`);
}
