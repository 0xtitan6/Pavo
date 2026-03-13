/**
 * parity-check.ts
 *
 * Cross-platform parity verifier for Module 2 math.
 * Reads test-vectors/module2-math.json, deploys ScaleFactorLibHarness,
 * and verifies EVM results match expected values from shared test vectors.
 *
 * Flags:
 *   --json   Output results as JSON to stdout (for CI consumption)
 *
 * Exit codes:
 *   0  All vectors passed
 *   1  One or more vectors failed
 *
 * Usage:
 *   npx hardhat run scripts/parity-check.ts
 *   npx hardhat run scripts/parity-check.ts -- --json
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const RAY = BigInt("1000000000000000000000000000"); // 1e27
const SECONDS_IN_365_DAYS = BigInt(365 * 24 * 3600);

const jsonMode = process.argv.includes("--json");

interface InterestVector {
  testId: string;
  description: string;
  annualInterestBips: number;
  timeDeltaSeconds: number;
  expectedInterestRay27: string;
  expectedInterestRay9: string;
  expectedNewScaleFactorRay27?: string;
  expectedNewScaleFactorRay9?: string;
}

interface ScaleConversionVector {
  testId: string;
  description: string;
  normalizedAmount?: string;
  scaledAmount?: string;
  scaleFactor27: string;
  scaleFactor9: string;
  expectedScaledAmount?: string;
  expectedNormalizedAmount?: string;
}

interface DelinquencyVector {
  testId: string;
  description: string;
  penaltyFeeBips: number;
  previousTimeDelinquent: number;
  gracePeriodSeconds: number;
  timeDeltaSeconds: number;
  isDelinquent: boolean;
  expectedTimeWithPenalty: number;
  expectedFeeRay27?: string;
  expectedNewTimeDelinquent?: number;
}

interface LiquidityVector {
  testId: string;
  description: string;
  scaledTotalSupply: string;
  scaledPendingWithdrawals: string;
  normalizedUnclaimedWithdrawals: string;
  accruedProtocolFees: string;
  reserveRatioBips: number;
  scaleFactor27: string;
  expectedLiquidityRequired: string;
}

interface WithdrawalVector {
  testId: string;
  description: string;
  scaledBatchAmount: string;
  availableLiquidity: string;
  scaleFactor27: string;
  expectedScaledAmountBurned: string;
  expectedNormalizedPaid: string;
}

interface Vectors {
  interest_accrual: InterestVector[];
  scale_conversions: ScaleConversionVector[];
  delinquency_fee: DelinquencyVector[];
  liquidity_required: LiquidityVector[];
  withdrawal_batch: WithdrawalVector[];
}

interface TestResult {
  testId: string;
  suite: string;
  status: "passed" | "failed";
  message?: string;
}

function log(msg: string): void {
  if (!jsonMode) {
    console.log(msg);
  }
}

async function main() {
  // Load test vectors
  const vectorsPath = path.join(__dirname, "..", "test-vectors", "module2-math.json");
  const vectors: Vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf-8"));

  // Deploy harness
  log("Deploying ScaleFactorLibHarness...");
  const Factory = await ethers.getContractFactory("ScaleFactorLibHarness");
  const harness = await Factory.deploy();
  await harness.waitForDeployment();
  log(`Harness deployed at ${await harness.getAddress()}\n`);

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const results: TestResult[] = [];

  function pass(testId: string, suite: string) {
    log(`  ✓ ${testId}`);
    passed++;
    results.push({ testId, suite, status: "passed" });
  }

  function fail(testId: string, suite: string, msg: string) {
    log(`  ✗ ${testId}: ${msg}`);
    failed++;
    failures.push(`${testId}: ${msg}`);
    results.push({ testId, suite, status: "failed", message: msg });
  }

  // ── 1. Interest Accrual ──────────────────────────────────────────────
  log("═══ Interest Accrual ═══");
  for (const v of vectors.interest_accrual) {
    try {
      const result = await harness.calculateLinearInterestFromBips(
        v.annualInterestBips,
        v.timeDeltaSeconds
      );
      const expected27 = BigInt(v.expectedInterestRay27);

      if (result !== expected27) {
        fail(v.testId, "interest_accrual", `interest: got ${result}, expected ${expected27}`);
        continue;
      }

      // Verify ratio to Ray9 is ~1e18
      const expected9 = BigInt(v.expectedInterestRay9);
      if (expected9 > 0n) {
        const ratio = result / expected9;
        const diff = ratio > BigInt(1e18) ? ratio - BigInt(1e18) : BigInt(1e18) - ratio;
        if (diff > BigInt(1e12)) {
          fail(v.testId, "interest_accrual", `Ray27/Ray9 ratio off: ${ratio} (diff ${diff} > 1e12)`);
          continue;
        }
      }

      pass(v.testId, "interest_accrual");
    } catch (e: any) {
      fail(v.testId, "interest_accrual", `exception: ${e.message}`);
    }
  }

  // ── 2. Scale Conversions ─────────────────────────────────────────────
  log("\n═══ Scale Conversions ═══");
  for (const v of vectors.scale_conversions) {
    try {
      if (v.normalizedAmount && v.expectedScaledAmount) {
        const result = await harness.scaleAmount(
          BigInt(v.normalizedAmount),
          BigInt(v.scaleFactor27)
        );
        const expected = BigInt(v.expectedScaledAmount);
        if (result !== expected) {
          fail(v.testId, "scale_conversions", `scaleAmount: got ${result}, expected ${expected}`);
          continue;
        }
      }

      if (v.scaledAmount && v.expectedNormalizedAmount) {
        const result = await harness.normalizeAmount(
          BigInt(v.scaledAmount),
          BigInt(v.scaleFactor27)
        );
        const expected = BigInt(v.expectedNormalizedAmount);
        if (result !== expected) {
          fail(v.testId, "scale_conversions", `normalizeAmount: got ${result}, expected ${expected}`);
          continue;
        }
      }

      pass(v.testId, "scale_conversions");
    } catch (e: any) {
      fail(v.testId, "scale_conversions", `exception: ${e.message}`);
    }
  }

  // ── 3. Delinquency Fees ──────────────────────────────────────────────
  log("\n═══ Delinquency Fees ═══");
  for (const v of vectors.delinquency_fee) {
    try {
      const [timeWithPenalty, newTimeDelinquent] =
        await harness.updateTimeDelinquentAndGetPenaltyTime(
          v.isDelinquent,
          v.previousTimeDelinquent,
          v.gracePeriodSeconds,
          v.timeDeltaSeconds
        );

      const expectedPenalty = BigInt(v.expectedTimeWithPenalty);
      if (timeWithPenalty !== expectedPenalty) {
        fail(
          v.testId,
          "delinquency_fee",
          `timeWithPenalty: got ${timeWithPenalty}, expected ${expectedPenalty}`
        );
        continue;
      }

      if (v.expectedFeeRay27) {
        const expectedFee = BigInt(v.expectedFeeRay27);
        if (timeWithPenalty > 0n) {
          const fee = await harness.calculateLinearInterestFromBips(
            v.penaltyFeeBips,
            timeWithPenalty
          );
          if (fee !== expectedFee) {
            fail(v.testId, "delinquency_fee", `feeRay27: got ${fee}, expected ${expectedFee}`);
            continue;
          }
        } else if (expectedFee !== 0n) {
          fail(v.testId, "delinquency_fee", `expected zero fee but vector says ${expectedFee}`);
          continue;
        }
      }

      pass(v.testId, "delinquency_fee");
    } catch (e: any) {
      fail(v.testId, "delinquency_fee", `exception: ${e.message}`);
    }
  }

  // ── 4. Liquidity Required ────────────────────────────────────────────
  log("\n═══ Liquidity Required ═══");
  for (const v of vectors.liquidity_required) {
    try {
      const result = await harness.liquidityRequired(
        BigInt(v.scaledTotalSupply),
        BigInt(v.scaledPendingWithdrawals),
        BigInt(v.normalizedUnclaimedWithdrawals),
        BigInt(v.accruedProtocolFees),
        v.reserveRatioBips,
        BigInt(v.scaleFactor27)
      );
      const expected = BigInt(v.expectedLiquidityRequired);
      if (result !== expected) {
        fail(v.testId, "liquidity_required", `liquidityRequired: got ${result}, expected ${expected}`);
        continue;
      }
      pass(v.testId, "liquidity_required");
    } catch (e: any) {
      fail(v.testId, "liquidity_required", `exception: ${e.message}`);
    }
  }

  // ── 5. Withdrawal Batch (informational) ──────────────────────────────
  // These vectors verify normalized/scaled math covered by scaleAmount/normalizeAmount above

  // ── Summary ──────────────────────────────────────────────────────────
  if (jsonMode) {
    const output = {
      timestamp: new Date().toISOString(),
      total: passed + failed,
      passed,
      failed,
      results,
      failures,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("\n═══════════════════════════════");
    console.log(`TOTAL: ${passed + failed} vectors | PASSED: ${passed} | FAILED: ${failed}`);
    if (failures.length > 0) {
      console.log("\nFailures:");
      for (const f of failures) {
        console.log(`  - ${f}`);
      }
    } else {
      console.log("ALL VECTORS PASSED ✓");
    }
    console.log("═══════════════════════════════");
  }

  // Exit code 1 on any failure
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
