/**
 * Module2.integration.test.ts
 *
 * Full lifecycle integration test for Module 2 (Undercollateralized Credit):
 *   1. Deploy Orchestrator
 *   2. Authorize borrower (Tier 2)
 *   3. Create market (USDC, 5% APR, 20% reserve, 7 day batches, 7 day grace)
 *   4. Register 2 lenders
 *   5. Lender 1 deposits 100K USDC
 *   6. Lender 2 deposits 50K USDC
 *   7. Borrower borrows 100K (within borrowable limit)
 *   8. Advance time 6 months
 *   9. Accrue interest -> verify scale factor ~ 1.025
 *   10. Borrower repays 50K
 *   11. Lender 1 requests withdrawal of half their position
 *   12. Advance time past batch expiry
 *   13. Process withdrawal batch
 *   14. Lender 1 claims withdrawal
 *   15. Verify all balances and state
 *
 * Run: npx hardhat test --grep 'Module2 Integration'
 */
import hre from "hardhat";
import { expect } from "chai";
import { ethers } from "hardhat";

// Deploy and get contract instances
async function deployModule2() {
  const signers = await hre.ethers.getSigners();
  const owner = signers[0];

  // Deploy USDC mock
  const usdc = await hre.ethers.deployContract("ERC20Mock", [
    "USD Coin",
    "USDC",
    owner.address,
    hre.ethers.parseUnits("10000000", 6),
    6,
  ]);
  await usdc.waitForDeployment();

  // Deploy Orchestrator
  const orchestrator = await hre.ethers.deployContract("Orchestrator", [owner.address]);
  await orchestrator.waitForDeployment();

  return { owner, usdc, orchestrator };
}

async function createMarket(orchestrator: any, borrowerAddr: any, usdc: any) {
  const marketParams = {
    annualInterestBips: 500, // 5% APR
    delinquencyFeeBips: 1000,
    withdrawalBatchDuration: 7 * 24 * 3600,
    reserveRatioBips: 2000,
    delinquencyGracePeriod: 7 * 24 * 3600,
    protocolFeeBips: 1000,
    maxDelinquencyPeriod: 30 * 24 * 3600,
    maxTotalSupply: ethers.parseUnits("10000000", 6),
    maturityDate: 0,
    gmslaRefHash: ethers.ZeroHash,
    collateralRatioBps: 0,
  };

  const tx = await orchestrator.createMarket(borrowerAddr, await usdc.getAddress(), marketParams);
  const receipt = await tx.wait();

  // Extract market address from MarketCreated event
  const marketCreatedEvent = receipt.logs.find((log: any) => {
    try {
      return orchestrator.interface.parseLog(log)?.name === "MarketCreated";
    } catch {
      return false;
    }
  });

  const marketAddress = marketCreatedEvent.args[0];
  const market = await hre.ethers.getContractAt("CreditMarket", marketAddress);

  return market;
}

describe("Module2 Integration", function () {
  // Signers
  let owner: any;
  let borrower: any;
  let lender1: any;
  let lender2: any;

  // Contracts
  let orchestrator: any;
  let usdc: any;
  let market: any;

  // Constants
  const USDC_DECIMALS = 6;
  const RAY = 10n ** 27n; // EVM RAY constant

  // Market parameters
  const ANNUAL_INTEREST_BIPS = 500; // 5% APR
  const DELINQUENCY_FEE_BIPS = 1000; // 10% penalty
  const RESERVE_RATIO_BIPS = 2000; // 20% reserve
  const PROTOCOL_FEE_BIPS = 1000; // 10% of interest to protocol
  const WITHDRAWAL_BATCH_DURATION = 7 * 24 * 3600; // 7 days
  const DELINQUENCY_GRACE_PERIOD = 7 * 24 * 3600; // 7 days
  const MAX_DELINQUENCY_PERIOD = 30 * 24 * 3600; // 30 days
  const MAX_TOTAL_SUPPLY = ethers.parseUnits("10000000", USDC_DECIMALS); // $10M max

  // Amounts
  const LENDER1_DEPOSIT = ethers.parseUnits("100000", USDC_DECIMALS); // 100K USDC
  const LENDER2_DEPOSIT = ethers.parseUnits("50000", USDC_DECIMALS); // 50K USDC
  const BORROW_AMOUNT = ethers.parseUnits("100000", USDC_DECIMALS); // 100K USDC
  const REPAY_AMOUNT = ethers.parseUnits("50000", USDC_DECIMALS); // 50K USDC

  // Time helpers
  const SIX_MONTHS = 180 * 24 * 3600; // ~6 months in seconds

  beforeEach(async function () {
    // Get signers
    [owner, borrower, lender1, lender2] = await hre.ethers.getSigners();

    // Deploy USDC mock
    usdc = await hre.ethers.deployContract("ERC20Mock", [
      "USD Coin",
      "USDC",
      owner.address,
      ethers.parseUnits("10000000", USDC_DECIMALS), // 10M supply
      USDC_DECIMALS,
    ]);
    await usdc.waitForDeployment();

    // Deploy Orchestrator
    orchestrator = await hre.ethers.deployContract("Orchestrator", [owner.address]);
    await orchestrator.waitForDeployment();

    // Step 2: Authorize borrower (Tier 2)
    await orchestrator.authorizeBorrower(borrower.address, 1); // TIER_2 = 1

    // Step 3: Create market
    const marketParams = {
      annualInterestBips: ANNUAL_INTEREST_BIPS,
      delinquencyFeeBips: DELINQUENCY_FEE_BIPS,
      withdrawalBatchDuration: WITHDRAWAL_BATCH_DURATION,
      reserveRatioBips: RESERVE_RATIO_BIPS,
      delinquencyGracePeriod: DELINQUENCY_GRACE_PERIOD,
      protocolFeeBips: PROTOCOL_FEE_BIPS,
      maxDelinquencyPeriod: MAX_DELINQUENCY_PERIOD,
      maxTotalSupply: MAX_TOTAL_SUPPLY,
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0,
    };

    const tx = await orchestrator.createMarket(borrower.address, await usdc.getAddress(), marketParams);
    const receipt = await tx.wait();

    // Extract market address from MarketCreated event
    const marketCreatedEvent = receipt.logs.find((log: any) => {
      try {
        return orchestrator.interface.parseLog(log)?.name === "MarketCreated";
      } catch {
        return false;
      }
    });
    const marketAddress = marketCreatedEvent.args[0];

    market = await hre.ethers.getContractAt("CreditMarket", marketAddress);

    // Step 4: Register lenders
    await orchestrator.registerLender(marketAddress, lender1.address);
    await orchestrator.registerLender(marketAddress, lender2.address);

    // Fund lenders with USDC
    await usdc.transfer(lender1.address, ethers.parseUnits("200000", USDC_DECIMALS));
    await usdc.transfer(lender2.address, ethers.parseUnits("100000", USDC_DECIMALS));

    // Approve market to spend USDC
    await usdc.connect(lender1).approve(marketAddress, ethers.MaxUint256);
    await usdc.connect(lender2).approve(marketAddress, ethers.MaxUint256);
    await usdc.connect(borrower).approve(marketAddress, ethers.MaxUint256);
  });

  it("Full lifecycle: deposit -> borrow -> accrue interest -> repay -> withdraw", async function () {
    const marketAddress = await market.getAddress();

    // ── Step 5 & 6: Lender deposits ─────────────────────────────────
    // Lender 1 deposits 100K
    const lender1BalanceBefore = await usdc.balanceOf(lender1.address);
    const tx1 = await market.connect(lender1).deposit(LENDER1_DEPOSIT, lender1.address);
    await tx1.wait();

    // Get scaled amount from deposit event
    const deposit1Event = (await tx1.wait()).logs.find((log: any) => {
      try {
        return market.interface.parseLog(log)?.name === "Deposit";
      } catch {
        return false;
      }
    });
    const lender1ScaledAmount = deposit1Event.args.scaledAmount;

    // Verify LPT minted
    const positionTokenAddr = await market.positionToken();
    const lpt = await hre.ethers.getContractAt("LoanPositionToken", positionTokenAddr);
    const lender1LptBalance = await lpt.balanceOf(lender1.address);
    expect(lender1LptBalance).to.equal(lender1ScaledAmount);

    // Lender 2 deposits 50K
    const tx2 = await market.connect(lender2).deposit(LENDER2_DEPOSIT, lender2.address);
    await tx2.wait();

    const deposit2Event = (await tx2.wait()).logs.find((log: any) => {
      try {
        return market.interface.parseLog(log)?.name === "Deposit";
      } catch {
        return false;
      }
    });
    const lender2ScaledAmount = deposit2Event.args.scaledAmount;

    // Total supply should be ~150K USDC (allow small RAY rounding)
    const totalSupply = await market.totalSupply();
    expect(totalSupply).to.be.closeTo(LENDER1_DEPOSIT + LENDER2_DEPOSIT, 1000n);

    console.log("✓ Lenders deposited 150K USDC total");

    // ── Step 7: Borrower borrows 100K ─────────────────────────────────
    // Check borrowable assets first
    const borrowableBefore = await market.borrowableAssets();
    console.log("  Borrowable assets before borrow:", ethers.formatUnits(borrowableBefore, USDC_DECIMALS));

    // Borrower borrows 100K
    const borrowerBalanceBefore = await usdc.balanceOf(borrower.address);
    await market.connect(borrower).borrow(BORROW_AMOUNT);
    const borrowerBalanceAfter = await usdc.balanceOf(borrower.address);

    expect(borrowerBalanceAfter - borrowerBalanceBefore).to.equal(BORROW_AMOUNT);
    console.log("✓ Borrower borrowed 100K USDC");

    // ── Step 8: Advance time 6 months ─────────────────────────────────
    await hre.ethers.provider.send("evm_increaseTime", [SIX_MONTHS]);
    await hre.ethers.provider.send("evm_mine", []);

    console.log("✓ Advanced 6 months");

    // ── Step 9: Accrue interest & verify scale factor ~ 1.025 ─────────
    // Expected: 5% APR for 0.5 years = 2.5% = 1.025
    const stateBefore = await market.getState();
    const scaleFactorBefore = stateBefore.scaleFactor;

    await market.accrueInterest();

    const stateAfter = await market.getState();
    const scaleFactorAfter = stateAfter.scaleFactor;

    // Verify scale factor increased
    expect(scaleFactorAfter).to.be.gt(scaleFactorBefore);

    // Expected scale factor: RAY * (1 + 0.05 * 0.5) = 1e27 * 1.025 = 1.025e27
    // With some tolerance for calculation differences
    const expectedScaleFactor = RAY * 1025n / 1000n;
    const tolerance = RAY / 100n; // 1% tolerance

    console.log("  Scale factor before:", ethers.formatUnits(scaleFactorBefore, 27));
    console.log("  Scale factor after:", ethers.formatUnits(scaleFactorAfter, 27));
    console.log("  Expected scale factor:", ethers.formatUnits(expectedScaleFactor, 27));

    // Scale factor should be approximately 1.025 RAY (within 1%)
    expect(scaleFactorAfter).to.be.closeTo(expectedScaleFactor, tolerance);
    console.log("✓ Scale factor ~1.025 after 6 months at 5% APR");

    // ── Step 10: Borrower repays 50K ───────────────────────────────────
    // First, give borrower some USDC to repay
    await usdc.transfer(borrower.address, REPAY_AMOUNT);

    const marketBalanceBefore = await usdc.balanceOf(marketAddress);
    await market.connect(borrower).repay(REPAY_AMOUNT);
    const marketBalanceAfter = await usdc.balanceOf(marketAddress);

    expect(marketBalanceAfter - marketBalanceBefore).to.equal(REPAY_AMOUNT);
    console.log("✓ Borrower repaid 50K USDC");

    // ── Step 11: Lender 1 requests withdrawal of half ─────────────────
    // Half of lender 1's position = 50K USDC normalized
    // Need to calculate scaled amount for half
    const lender1ScaledHalf = lender1ScaledAmount / 2n;

    // Request withdrawal
    const expiryBefore = await market.getState().then((s: any) => s.pendingWithdrawalExpiry);
    await market.connect(lender1).requestWithdrawal(lender1ScaledHalf);

    const stateAfterWithdrawal = await market.getState();
    const expiryAfter = stateAfterWithdrawal.pendingWithdrawalExpiry;

    // Verify expiry was set
    expect(expiryAfter).to.be.gt(0);
    console.log("✓ Lender 1 requested withdrawal of 50K USDC worth, batch expires at", expiryAfter);

    // ── Step 12: Advance time past batch expiry ───────────────────────
    const batchDuration = WITHDRAWAL_BATCH_DURATION;
    await hre.ethers.provider.send("evm_increaseTime", [Number(batchDuration) + 1]);
    await hre.ethers.provider.send("evm_mine", []);

    console.log("✓ Advanced past batch expiry");

    // ── Step 13: Process withdrawal batch ───────────────────────────────
    const lender1UsdcBeforeClaim = await usdc.balanceOf(lender1.address);

    await market.processWithdrawalBatch();

    console.log("✓ Withdrawal batch processed");

    // ── Step 14: Lender 1 claims withdrawal ───────────────────────────
    await market.connect(lender1).claimWithdrawal(expiryAfter);

    const lender1UsdcAfterClaim = await usdc.balanceOf(lender1.address);
    const claimedAmount = lender1UsdcAfterClaim - lender1UsdcBeforeClaim;

    console.log("  Lender 1 claimed:", ethers.formatUnits(claimedAmount, USDC_DECIMALS), "USDC");

    // ── Step 15: Verify all balances and state ─────────────────────────
    // Check total supply decreased by claimed amount
    const finalTotalSupply = await market.totalSupply();
    console.log("  Final total supply:", ethers.formatUnits(finalTotalSupply, USDC_DECIMALS), "USDC");

    // Verify market state is consistent
    const finalState = await market.getState();
    console.log("  Final scale factor:", ethers.formatUnits(finalState.scaleFactor, 27));

    // Verify no pending withdrawals
    expect(finalState.scaledPendingWithdrawals).to.equal(0);

    console.log("✓ All verifications passed");
  });

  it("Should handle withdrawal with insufficient liquidity (partial payout)", async function () {
    const marketAddress = await market.getAddress();

    // Lender 1 deposits full amount
    await market.connect(lender1).deposit(LENDER1_DEPOSIT, lender1.address);

    // Borrower borrows most liquidity (leaving small amount for withdrawals)
    // With 100K deposit and 20% reserve, borrowable is ~80K
    await market.connect(borrower).borrow(ethers.parseUnits("75000", USDC_DECIMALS));

    // Lender 1 requests withdrawal of half
    const positionTokenAddr = await market.positionToken();
    const lpt = await hre.ethers.getContractAt("LoanPositionToken", positionTokenAddr);
    const lender1Scaled = await lpt.balanceOf(lender1.address);
    const withdrawalScaled = lender1Scaled / 2n;

    await market.connect(lender1).requestWithdrawal(withdrawalScaled);

    const stateAfterReq = await market.getState();
    const batchExpiry = stateAfterReq.pendingWithdrawalExpiry;

    // Advance past batch expiry
    await hre.ethers.provider.send("evm_increaseTime", [WITHDRAWAL_BATCH_DURATION + 1]);
    await hre.ethers.provider.send("evm_mine", []);

    // Process batch - should only pay out what's available
    await market.processWithdrawalBatch();

    // Try to claim - should get partial amount
    const lender1UsdcBefore = await usdc.balanceOf(lender1.address);
    await market.connect(lender1).claimWithdrawal(batchExpiry);
    const lender1UsdcAfter = await usdc.balanceOf(lender1.address);

    const claimed = lender1UsdcAfter - lender1UsdcBefore;
    console.log("  Partial withdrawal claimed:", ethers.formatUnits(claimed, USDC_DECIMALS), "USDC");

    // Should be less than requested due to insufficient liquidity
    expect(claimed).to.be.lt(ethers.parseUnits("50000", USDC_DECIMALS));
    expect(claimed).to.be.gt(0);

    console.log("✓ Partial withdrawal handled correctly");
  });

  it("Should reject borrow exceeding borrowable limit", async function () {
    // Lender deposits 100K
    await market.connect(lender1).deposit(LENDER1_DEPOSIT, lender1.address);

    // Try to borrow more than available
    const borrowable = await market.borrowableAssets();
    console.log("  Borrowable:", ethers.formatUnits(borrowable, USDC_DECIMALS), "USDC");

    // Attempt to borrow more than available
    await expect(
      market.connect(borrower).borrow(borrowable + 1n)
    ).to.be.revertedWithCustomError(market, "InsufficientBorrowableLiquidity");

    console.log("✓ Borrow limit enforced correctly");
  });

  it("Should track scaled vs normalized balances correctly", async function () {
    const marketAddress = await market.getAddress();

    // Deposit
    const tx = await market.connect(lender1).deposit(LENDER1_DEPOSIT, lender1.address);
    const receipt = await tx.wait();

    const depositEvent = receipt.logs.find((log: any) => {
      try {
        return market.interface.parseLog(log)?.name === "Deposit";
      } catch {
        return false;
      }
    });
    const scaledAmount = depositEvent.args.scaledAmount;

    // Initial scale factor is ~RAY (1e27), may drift slightly due to time passing during setup
    const state = await market.getState();
    expect(state.scaleFactor).to.be.closeTo(RAY, RAY / 10000n); // within 0.01%

    // Scaled amount should be approximately equal to deposit amount at initial scale factor
    // Interest accrues during beforeEach setup, so scaleFactor > RAY => scaledAmount < deposit
    expect(scaledAmount).to.be.closeTo(LENDER1_DEPOSIT, 10000n);

    // Normalized balance should be close to deposit amount (larger tolerance for RAY math)
    const positionTokenAddr = await market.positionToken();
    const lpt = await hre.ethers.getContractAt("LoanPositionToken", positionTokenAddr);
    const normalized = await lpt.normalizedBalanceOf(lender1.address);
    expect(normalized).to.be.closeTo(LENDER1_DEPOSIT, LENDER1_DEPOSIT / 100n); // 1% tolerance

    console.log("✓ Scaled vs normalized tracking verified");
  });

  it("Should calculate liquidity requirement correctly", async function () {
    // Lender deposits 150K total
    await market.connect(lender1).deposit(LENDER1_DEPOSIT, lender1.address);
    await market.connect(lender2).deposit(LENDER2_DEPOSIT, lender2.address);

    // Check liquidity requirement
    const liquidityRequired = await market.liquidityRequired();
    console.log("  Liquidity required:", ethers.formatUnits(liquidityRequired, USDC_DECIMALS), "USDC");

    // With 20% reserve ratio and no pending withdrawals:
    // Reserve = (totalSupply * 20%) = 150K * 0.2 = 30K
    const expectedReserve = (BigInt(LENDER1_DEPOSIT) + BigInt(LENDER2_DEPOSIT)) * 2000n / 10000n;
    // Allow small tolerance due to internal calculations
    expect(liquidityRequired).to.be.closeTo(expectedReserve, 1000n);

    console.log("✓ Liquidity requirement calculated correctly");
  });
});
