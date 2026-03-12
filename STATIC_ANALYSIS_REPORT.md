# Static Analysis Report (Slither)

**Date:** 2026-03-12
**Tool:** Slither 0.11.4
**Config:** `slither . --exclude-dependencies --exclude-informational --exclude-low`
**Contracts analyzed:** 94 (including test/mocks), 62 detectors active
**Total results:** 202 (mostly test/mock noise)

---

## Summary

| Severity | Count | Fixed | False Positive |
|----------|-------|-------|----------------|
| High     | 6 findings across 6 detectors | 0 | 6 (all in test/mock code or protected by design) |
| Medium   | 1 real finding | 1 | 0 |
| Low      | N/A (excluded) | — | — |
| Informational | N/A (excluded) | — | — |

---

## Medium Findings

### M-1 — `cache-array-length` in `ParthenonOptimizer` — FIXED

**File:** `contracts/optimizer/ParthenonOptimizer.sol`
**Functions:** `totalAssets()`, `_allocateToSupplyQueue()`, `_withdrawFromQueue()`
**Finding:** Loop conditions read `_withdrawQueue.length` / `_supplyQueue.length` from storage on every iteration, costing an extra SLOAD per loop cycle.

**Fix applied:** Cached array length into a local `uint256` variable before each loop.

```solidity
// Before
for (uint256 i; i < _withdrawQueue.length; ++i) { ... }

// After
uint256 queueLen = _withdrawQueue.length;
for (uint256 i; i < queueLen; ++i) { ... }
```

**Impact:** Gas reduction proportional to queue length (up to 30 SLOAD saves per reallocation call).

---

## High Findings (All False Positives)

### H-1 — `unchecked-transfer` — FALSE POSITIVE

**Files:** `contracts/test/*.sol` only
**Finding:** Return value of `ERC20.transfer()` not checked.
**Why false positive:** All flagged instances are in Solidity test contracts (`TestBase`, `Test4_EndInterruptLiquidate`, `Test5_TopUpAdmin`, `Test6_LenderTakeUp`, `Test7_YieldSurplus`). No production contract is affected. All production contracts use OpenZeppelin `SafeERC20.safeTransfer()` which reverts on failure.

---

### H-2 — `incorrect-equality` (strict equality) — FALSE POSITIVE

**Files:** `contracts/optimizer/ParthenonOptimizer.sol`, `contracts/pool/ParthenonPool.sol`, `contracts/test/TestBase.sol`
**Finding:** Dangerous use of `==` comparisons.
**Why false positive:**
- `toWithdraw == 0` (optimizer line 359): intentional skip — if a market has zero withdrawable liquidity, move to the next. Correct.
- `remaining == 0` (optimizer line 366): this is a `require()` assertion ensuring full withdrawal satisfaction. Correct.
- `elapsed == 0` (pool line 491): intentional early-exit — if no time has passed since last accrual, skip. Identical to Morpho Blue's design.
- `TestBase._assertEq`: test contract assertion helper.

---

### H-3 — `locked-ether` — FALSE POSITIVE

**Files:** `contracts/mocks/ERC20Mock.sol`, `contracts/test/TestBase.sol` (`BorrowerAgent`)
**Finding:** Contracts with `payable` functions but no ETH withdrawal.
**Why false positive:**
- `ERC20Mock.constructor` is payable only because the parent `ERC20` constructor is; no ETH is ever sent to it.
- `BorrowerAgent` is a test helper contract — ETH locking in tests is inconsequential to production security.

---

### H-4 — `reentrancy-no-eth` — FALSE POSITIVE

**Files:** `contracts/pool/ParthenonPool.sol`, `contracts/optimizer/ParthenonOptimizer.sol`
**Finding:** External call before state write in `_accrueInterest` and `_deposit`.
**Why false positive:**

**ParthenonPool._accrueInterest:**
- All public/external functions that invoke `_accrueInterest` carry the `nonReentrant` modifier. Re-entry is blocked at every entry point.
- The external call is `IIrm.borrowRate()`, implemented by `FixedRateIrm` — a pure computation contract with no external calls and no mutable state visible to callers.
- This pattern is identical to Morpho Blue v1's `_accrueInterest`, which is regarded as safe for the same reasons.

**ParthenonOptimizer._deposit:**
- `_deposit` carries the `nonReentrant` modifier directly. Re-entry is impossible.

---

### H-5 — `uninitialized-local` — FALSE POSITIVE

**Files:** `contracts/pool/ParthenonPool.sol`, `contracts/LoanFactory.sol`
**Finding:** Local variables declared but not initialized.
**Why false positive:**
- `badDebtShares` / `badDebtAssets` in `liquidate()`: Solidity initializes `uint256` locals to `0`. Both are conditionally assigned in the same scope and emitted in the `Liquidate` event. Default 0 is correct when no bad debt exists.
- `feeShares` in `_accrueInterest()`: Conditionally set if fee > 0, otherwise remains 0. Correct: no fee shares minted when fee is zero.
- `id` / `newLoan` in `LoanFactory.createLoan()`: Assigned on the very next statement. Slither misidentifies sequential assignment as "uninitialized".

---

### H-6 — `unused-return` — FALSE POSITIVE

**Files:** `contracts/LoanFactory.sol`, `contracts/PriceOracle.sol`, `contracts/adapters/MorphoAdapter.sol`, `contracts/adapters/OptimizerAdapter.sol`
**Finding:** Return values of function calls are discarded.
**Why false positive (per instance):**

| Instance | Reason |
|----------|--------|
| `LoanFactory.cancelLoan` — `yieldAdapter.withdraw()` return | Adapter transfers assets directly to `to` and reverts on failure. Returned `uint256 withdrawn` is informational only. `nonReentrant` prevents double-withdrawal. |
| `PriceOracle._getRawValidatedPrice` — `latestRoundData()` | Only named-`None` elements discarded; all consumed values (`roundId`, `answer`, `updatedAt`, `answeredInRound`) are used. |
| `PriceOracle._checkSequencer` — `latestRoundData()` | `answer`, `startedAt`, `updatedAt` consumed; `roundId`/`answeredInRound` irrelevant for sequencer liveness check. |
| `MorphoAdapter`/`OptimizerAdapter` — `EnumerableSet.add/remove()` | Returns `bool` indicating duplicate; ignoring is the standard OZ usage pattern. Duplicate add/remove is idempotent. |
| `MorphoAdapter`/`OptimizerAdapter` — `morpho.supply/withdraw()` | Returns `(assets, shares)` where the non-specified value is always 0. Needed value is captured where required. |

---

## Excluded Findings (Test/Mock Contracts Only)

### `constable-states`
- `Test9_LoanCalculatorCoverage.calc` — test contract, not deployed.

### `immutable-states`
- `Attacker.factory`, `ERC20Mock._customDecimals`, `MockAggregatorV3._decimals`, `MockAggregatorV3Lagging.*` — all test/mock contracts.

---

## Post-Fix Verification

```
npx hardhat compile  →  0 errors, 0 warnings
npx hardhat test     →  1116 passing, 0 failing
```
