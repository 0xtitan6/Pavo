/**
 * ParthenonFiSolidity.test.ts
 *
 * Hardhat TypeScript runner for the split Solidity-native unit tests:
 *
 *   Test1_RegistryOracle          — AssetRegistry + PriceOracle
 *   Test2_LoanCalcCreate          — LoanCalculator + createLoan
 *   Test3_CancelTakeUp            — cancelLoan + takeUpLoan
 *   Test4_EndInterruptLiquidate   — endLoan + interruptLoan + liquidateLoan
 *   Test5_TopUpAdmin              — topUp + admin
 *   Test6_LenderTakeUp            — lender-takes-borrow branch, M-6, pause invariants, coverage gaps
 *
 * Convention:
 *   test_*      → positive test: must NOT revert.
 *   testFail_*  → negative test: MUST revert.
 *
 * A fresh contract is deployed for every test case.
 * Time-sensitive tests warp EVM time before calling the function.
 */

import { expect } from "chai";
import hre from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function warpDays(days: number) {
  await hre.network.provider.send("evm_increaseTime", [days * 86_400 + 1]);
  await hre.network.provider.send("evm_mine", []);
}

// Setup config: some tests require calling a setup function (to persist state)
// before warping time and then calling the actual test function.
interface SetupConfig {
  setupFn:  string; // name of the setup function to call first
  warpDays: number; // days to warp AFTER setup, BEFORE calling the test function
}

const SETUP_CONFIG: Record<string, SetupConfig> = {
  // endLoan positive tests
  "test_EndLoan_AfterMaturity":                      { setupFn: "setup_EndLoan",          warpDays: 8 },
  "test_EndLoan_LoanDeleted":                        { setupFn: "setup_EndLoan",          warpDays: 8 },
  "test_EndLoan_FactoryBalanceZeroAfterSettlement":  { setupFn: "setup_EndLoan",          warpDays: 8 },
  // endLoan negative tests that need a matured loan
  "testFail_EndLoan_NotActiveStatus":                { setupFn: "setup_EndLoan_Negative", warpDays: 8 },
  "testFail_EndLoan_NonExistent":                    { setupFn: "setup_EndLoan_Negative", warpDays: 8 },
  "testFail_EndLoan_Twice":                          { setupFn: "setup_EndLoan",          warpDays: 8 },
  // interruptLoan positive tests (no warp — early repayment)
  "test_InterruptLoan_BorrowerEarlyRepayment":       { setupFn: "setup_InterruptLoan",    warpDays: 0 },
  "test_InterruptLoan_LoanDeleted":                  { setupFn: "setup_InterruptLoan",    warpDays: 0 },
  // interruptLoan negative: after maturity
  "testFail_InterruptLoan_AfterMaturity":            { setupFn: "setup_InterruptLoan",    warpDays: 8 },
  // liquidateLoan positive tests (price crashed in setup, no warp)
  "test_LiquidateLoan_WhenUnderCollateralized":      { setupFn: "setup_LiquidateLoan",    warpDays: 0 },
  "test_LiquidateLoan_LoanDeleted":                  { setupFn: "setup_LiquidateLoan",    warpDays: 0 },
  "test_LiquidateLoan_FactoryBalanceZero":           { setupFn: "setup_LiquidateLoan",    warpDays: 0 },
  // liquidateLoan negative: after maturity
  "testFail_LiquidateLoan_AfterMaturity":            { setupFn: "setup_EndLoan",          warpDays: 8 },

  // Test6: pause + time-warp tests
  "test_Pause_DoesNotBlock_EndLoan":                 { setupFn: "setup_PauseEndLoan",          warpDays: 8 },
  "test_Pause_DoesNotBlock_InterruptLoan":           { setupFn: "setup_PauseInterruptLoan",    warpDays: 0 },
  // Test6: two-step tests that need a live loan
  "test_InterruptLoan_LenderReceivesExactRepayment": { setupFn: "setup_InterruptRepayment",    warpDays: 0 },
  "test_EndLoan_AllCollateralDistributed":           { setupFn: "setup_EndLoanDistribution",   warpDays: 8 },
  "test_LiquidateLoan_AnyoneCanTrigger":             { setupFn: "setup_AnyoneLiquidates",      warpDays: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-contract test suites
// ─────────────────────────────────────────────────────────────────────────────

interface ContractGroup {
  contractName: string;
  suiteLabel:   string;
  groups:       Array<{ label: string; prefix: string }>;
}

const CONTRACTS: ContractGroup[] = [
  {
    contractName: "Test1_RegistryOracle",
    suiteLabel:   "1. Registry + Oracle",
    groups: [
      { label: "AssetRegistry", prefix: "AssetRegistry" },
      { label: "PriceOracle",   prefix: "PriceOracle"   },
    ],
  },
  {
    contractName: "Test2_LoanCalcCreate",
    suiteLabel:   "2. LoanCalculator + createLoan",
    groups: [
      { label: "LoanCalculator", prefix: "LoanCalc"     },
      { label: "createLoan",     prefix: "CreateL"      },
      { label: "createLoan (borrow)", prefix: "CreateBorrow" },
    ],
  },
  {
    contractName: "Test3_CancelTakeUp",
    suiteLabel:   "3. cancelLoan + takeUpLoan",
    groups: [
      { label: "cancelLoan",  prefix: "CancelL"     },
      { label: "takeUpLoan",  prefix: "TakeUpLoan"  },
    ],
  },
  {
    contractName: "Test4_EndInterruptLiquidate",
    suiteLabel:   "4. endLoan + interruptLoan + liquidateLoan",
    groups: [
      { label: "endLoan",       prefix: "EndLoan"       },
      { label: "interruptLoan", prefix: "InterruptLoan" },
      { label: "liquidateLoan", prefix: "LiquidateLoan" },
    ],
  },
  {
    contractName: "Test5_TopUpAdmin",
    suiteLabel:   "5. topUp + admin",
    groups: [
      { label: "topUp", prefix: "TopUp" },
      { label: "admin", prefix: "Admin" },
    ],
  },
  {
    contractName: "Test6_LenderTakeUp",
    suiteLabel:   "6. lender-takes-borrow + gaps",
    groups: [
      { label: "lenderTakesBorrow", prefix: "LenderTakesBorrow" },
      { label: "assetMismatch",     prefix: "M6"                },
      { label: "pauseInvariant",    prefix: "Pause"             },
      { label: "feeEdgeCases",      prefix: "Fee"               },
      { label: "interruptRepayment",prefix: "InterruptLoan"     },
      { label: "endLoanDistrib",    prefix: "EndLoan"           },
      { label: "liquidateAnyone",   prefix: "LiquidateLoan"     },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Build suite
// ─────────────────────────────────────────────────────────────────────────────

describe("ParthenonFi — Solidity Unit Tests", function () {
  this.timeout(120_000);

  for (const { contractName, suiteLabel, groups } of CONTRACTS) {
    describe(suiteLabel, function () {

      // Load ABI once per contract
      const artifact = hre.artifacts.readArtifactSync(contractName);
      const allTestFns: string[] = artifact.abi
        .filter((f: any) => f.type === "function" && (f.inputs?.length ?? 0) === 0)
        .map((f: any) => f.name as string)
        .filter((n: string) => n.startsWith("test_") || n.startsWith("testFail_"));

      for (const { label, prefix } of groups) {
        describe(label, function () {
          registerGroup(contractName, allTestFns, prefix);
        });
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: register `it` cases for matching functions
// ─────────────────────────────────────────────────────────────────────────────

function registerGroup(contractName: string, allFns: string[], prefix: string) {
  const filtered = allFns.filter((n) =>
    n.toLowerCase().includes(prefix.toLowerCase())
  );

  for (const fnName of filtered) {
    const isPositive   = fnName.startsWith("test_");
    const readableName = fnName.replace(/^testFail_|^test_/, "").replace(/_/g, " ");
    const setupCfg     = SETUP_CONFIG[fnName];

    if (isPositive) {
      it(`✓ ${readableName}`, async function () {
        const c = await hre.ethers.deployContract(contractName);
        if (setupCfg) {
          await (c as any)[setupCfg.setupFn]();
          if (setupCfg.warpDays > 0) await warpDays(setupCfg.warpDays);
        }
        await c[fnName]();
      });
    } else {
      it(`✗ [expects revert] ${readableName}`, async function () {
        const c = await hre.ethers.deployContract(contractName);
        if (setupCfg) {
          await (c as any)[setupCfg.setupFn]();
          if (setupCfg.warpDays > 0) await warpDays(setupCfg.warpDays);
        }
        await expect((c as any)[fnName]()).to.be.reverted;
      });
    }
  }
}
