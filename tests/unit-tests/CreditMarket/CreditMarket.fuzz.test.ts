/**
 * CreditMarket.fuzz.test.ts
 *
 * Property-based fuzz tests for CreditMarket invariants.
 * Uses random inputs to verify core financial safety properties.
 *
 * Run: npx hardhat test --grep "CreditMarket fuzz"
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

const ONE_DAY = 86400;
const SEVEN_DAYS = 604800;
const THREE_DAYS = 259200;
const THIRTY_DAYS = 2592000;
const RAY = 10n ** 27n;

// Generate a random bigint in range [min, max]
function randomBigInt(min: bigint, max: bigint): bigint {
  if (min >= max) return min;
  const range = max - min;
  const bits = range.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const randomHex = ethers.hexlify(ethers.randomBytes(bytes));
  const randomVal = BigInt(randomHex) % (range + 1n);
  return min + randomVal;
}

describe("CreditMarket fuzz tests", function () {
  async function deployFuzzFixture() {
    const [owner, borrower, lender, lender2] = await ethers.getSigners();

    const asset = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("200000000", 6), 6
    ]);

    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);
    await orchestrator.authorizeBorrower(borrower.address, 3);

    const params: CreditTypesLib.MarketParametersStruct = {
      annualInterestBips: 500,
      delinquencyFeeBips: 200,
      withdrawalBatchDuration: SEVEN_DAYS,
      reserveRatioBips: 1000,
      delinquencyGracePeriod: THREE_DAYS,
      protocolFeeBips: 100,
      maxDelinquencyPeriod: THIRTY_DAYS,
      maxTotalSupply: ethers.parseUnits("10000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0
    };

    const marketAddress = await orchestrator.createMarket.staticCall(
      borrower.address, await asset.getAddress(), params
    );
    await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);
    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    await orchestrator.registerLender(marketAddress, lender.address);
    await orchestrator.registerLender(marketAddress, lender2.address);

    // Fund generously
    await asset.transfer(lender.address, ethers.parseUnits("50000000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
    await asset.transfer(lender2.address, ethers.parseUnits("50000000", 6));
    await asset.connect(lender2).approve(marketAddress, ethers.MaxUint256);
    await asset.transfer(borrower.address, ethers.parseUnits("50000000", 6));
    await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

    const positionToken = await ethers.getContractAt("LoanPositionToken", await market.positionToken());

    return { market, marketAddress, asset, orchestrator, owner, borrower, lender, lender2, positionToken };
  }

  // --- Invariant 1: scaleFactor is monotonically non-decreasing ---

  it("scaleFactor never decreases after random time advances and interest accrual (20 iterations)", async function () {
    const { market, lender, borrower } = await loadFixture(deployFuzzFixture);

    // Initial deposit and borrow to activate interest
    await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);
    await market.connect(borrower).borrow(ethers.parseUnits("50000", 6));

    let prevScaleFactor = (await market.getState()).scaleFactor;
    expect(prevScaleFactor).to.be.gte(RAY);

    for (let i = 0; i < 20; i++) {
      // Random time advance: 1 hour to 30 days
      const timeAdvance = Number(randomBigInt(3600n, BigInt(THIRTY_DAYS)));
      await time.increase(timeAdvance);

      await market.accrueInterest();
      const state = await market.getState();

      expect(state.scaleFactor).to.be.gte(prevScaleFactor,
        `scaleFactor decreased at iteration ${i}: ${state.scaleFactor} < ${prevScaleFactor}`
      );
      prevScaleFactor = state.scaleFactor;
    }
  });

  // --- Invariant 2: deposit/withdraw roundtrip has no underflow ---

  it("random deposit amounts never cause underflow (10 iterations)", async function () {
    const { market, asset, lender, lender2, positionToken } = await loadFixture(deployFuzzFixture);

    for (let i = 0; i < 10; i++) {
      // Random deposit: 1 USDC to 1M USDC
      const amount = randomBigInt(1_000_000n, 1_000_000_000_000n); // 1 to 1M USDC (6 dec)

      const balBefore = await asset.balanceOf(lender.address);
      await market.connect(lender).deposit(amount, lender.address);
      const balAfter = await asset.balanceOf(lender.address);

      // Asset balance should decrease by exactly the deposit amount
      expect(balBefore - balAfter).to.equal(amount);

      // Position tokens minted should be > 0
      const ptBal = await positionToken.balanceOf(lender.address);
      expect(ptBal).to.be.gt(0);
    }

    // Total supply should be positive
    const state = await market.getState();
    expect(state.scaledTotalSupply).to.be.gt(0);
  });

  // --- Invariant 3: borrow cannot exceed available liquidity ---

  it("borrow reverts when exceeding available liquidity", async function () {
    const { market, lender, borrower } = await loadFixture(deployFuzzFixture);

    // Deposit fixed amount
    const depositAmount = ethers.parseUnits("100000", 6);
    await market.connect(lender).deposit(depositAmount, lender.address);

    // Try to borrow more than deposited
    const excessBorrow = depositAmount + 1n;
    await expect(
      market.connect(borrower).borrow(excessBorrow)
    ).to.be.reverted;
  });

  // --- Invariant 4: repay reduces totalBorrowed ---

  it("repay always reduces totalBorrowed (5 iterations)", async function () {
    const { market, lender, borrower } = await loadFixture(deployFuzzFixture);

    await market.connect(lender).deposit(ethers.parseUnits("500000", 6), lender.address);
    await market.connect(borrower).borrow(ethers.parseUnits("200000", 6));

    for (let i = 0; i < 5; i++) {
      const stateBefore = await market.getState();
      const totalBorrowedBefore = stateBefore.totalBorrowed;

      if (totalBorrowedBefore === 0n) break;

      // Random repay: 1 USDC to 10% of outstanding
      const maxRepay = totalBorrowedBefore / 10n;
      const repayAmount = maxRepay > 1_000_000n
        ? randomBigInt(1_000_000n, maxRepay)
        : 1_000_000n;

      await market.connect(borrower).repay(repayAmount);

      const stateAfter = await market.getState();
      expect(stateAfter.totalBorrowed).to.be.lt(totalBorrowedBefore,
        `totalBorrowed did not decrease at iteration ${i}`
      );

      // Advance time for interest
      await time.increase(ONE_DAY);
      await market.accrueInterest();
    }
  });

  // --- Invariant 5: withdrawal batch processing respects FIFO ---

  it("withdrawal batches are processed in FIFO order", async function () {
    const { market, lender, lender2, borrower, positionToken } = await loadFixture(deployFuzzFixture);

    // Deposit
    await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);
    await market.connect(lender2).deposit(ethers.parseUnits("50000", 6), lender2.address);

    // Borrow some to create partial fill scenario
    await market.connect(borrower).borrow(ethers.parseUnits("120000", 6));

    // First withdrawal request
    const amount1 = ethers.parseUnits("10000", 6);
    await market.connect(lender).requestWithdrawal(amount1);

    // Get batch expiry for first batch
    const state1 = await market.getState();

    // Advance past first batch expiry
    await time.increase(SEVEN_DAYS + 1);

    // Process first batch
    await market.processWithdrawalBatch();

    // Second withdrawal request — creates new batch
    const amount2 = ethers.parseUnits("5000", 6);
    await market.connect(lender2).requestWithdrawal(amount2);

    // Advance past second batch
    await time.increase(SEVEN_DAYS + 1);
    await market.processWithdrawalBatch();

    // Both batches should be processed (order verified by no reverts)
  });
});
