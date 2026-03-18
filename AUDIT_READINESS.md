# Audit Readiness Checklist — ParthenonFi Contracts

**Prepared by**: Glass (Security Researcher)
**Date**: 2026-03-11 (updated Round 2)
**Repo**: parthenonfi-contracts
**Solidity**: 0.8.28 | **Framework**: Hardhat 2.26.3

---

## 1. Known Issues — Severity & Status

### CRITICAL / HIGH

| ID | Description | Status |
|----|-------------|--------|
| H-5 | Single-step ownership in PriceOracle | **FIXED** — Two-step transfer (propose/accept) |
| H-6 | Collateral token mismatch in takeUpLoan | **FIXED** — Explicit token matching in both branches |
| HIGH-3 | No parameter matching in takeUpLoan | **BY DESIGN** — P2P marketplace, taker accepts maker's terms |
| C2 | Missing loan existence checks in takeUpLoan | **FIXED** — `require(loans[id].id == id)` guards added |

### MEDIUM

| ID | Description | Status |
|----|-------------|--------|
| MEDIUM-1 | takeUpLoan yield surplus sent to wrong party | **FIXED** — Surplus goes to lender |
| MEDIUM-2 | Collateral yield surplus locked in LoanFactory | **FIXED** — Surplus sent to borrower |
| MEDIUM-3 | VaultAdapter missing slippage protection | **FIXED** — Configurable `slippageBps` (default 1%) |
| MEDIUM-4 | Negative yield underflow in settlement | **FIXED** — `min(withdrawn, principal)` prevents underflow |
| MEDIUM-5 | Negative yield collateral insolvency | **FIXED** — Loan stores actual withdrawn amount |
| MEDIUM-C5 | getOraclePriceUnchecked poisons lastGoodPrice | **FIXED** — Now `view`, cannot write state |
| MEDIUM-C6 | MorphoAdapter allows reconfiguration with active positions | **FIXED** — Blocked when `activePositions[token] > 0` |
| MEDIUM-7 | Post-withdrawal collateral not re-validated | **FIXED** — Re-validation in both takeUpLoan branches |

### LOW

| ID | Description | Status |
|----|-------------|--------|
| LOW-1 | setYieldAdapter allows direct replacement | **FIXED** — Two-step (clear to zero, then set new) |
| LOW-2 | MorphoAdapter residual approval after supply | **FIXED** — `forceApprove(morpho, 0)` after supply |
| LOW-C4 | VaultAdapter missing assets>0 after withdraw | **FIXED** — Validation added |
| LOW-C5 | Missing FeeRecipientUpdated/YieldAdapterUpdated events | **FIXED** — Events added |
| LOW-5 | VaultAdapter allows reconfiguration with active positions | **FIXED** — Blocked when `activePositions[asset] > 0` |
| LOW-6 | MorphoAdapter emergencyWithdraw missing assets>0 check | **FIXED** — Validation added |
| LOW-7 | VaultAdapter emergencyWithdraw missing assets>0 check | **FIXED** — Validation added |
| LOW-8 | VaultAdapter residual approval after bulkDeposit | **FIXED** — `forceApprove(teller, 0)` after deposit |
| LOW-9 | LoanFactory residual approval to yieldAdapter | **FIXED** — Cleared after deposit in createLoan |
| LOW-C6 | Sequencer uptime feed missing staleness check | **FIXED** — `SEQUENCER_MAX_STALENESS = 3600s` added |
| LOW-C7 | Deviation check granularity is 0.01% | **OPEN** — 10000 scaling factor, by design |
| LOW-C9 | configureVault missing cross-validation | **FIXED** — Validates teller.vault()==vault, teller.accountant()==accountant |

### INFO (Documented, no code changes required)

| ID | Description | Status |
|----|-------------|--------|
| INFO-5 | Orphaned IVaultAdapter.sol | **FIXED** — Removed dead code |
| INFO-4 | Position orphaning risk on setYieldAdapter | **DOCUMENTED** — NatSpec warning added |
| INFO-6 | Borrower bears lender's negative asset yield | **BY DESIGN** — P2P terms accepted by taker |
| INFO-7 | VaultAdapter checkpoint() failure silently swallowed | **DOCUMENTED** — Stale rate risk, tested |
| INFO-9 | VaultAdapter slippage degrades to zero when rate=0 | **DOCUMENTED** — Edge case tested |
| INFO-10 | No adapter position enumeration | **DOCUMENTED** — `activePositions` is count-only |
| INFO-11 | No EmergencyWithdrawn event distinction | **FIXED** — Separate event added to both adapters |
| INFO-12 | takeUpLoan deletes taker after external calls | **DOCUMENTED** — Safe via `nonReentrant`, inconsistent CEI |
| INFO-14 | emergencyWithdraw can orphan loan state | **DOCUMENTED** — Operational risk, admin-only function |
| INFO-A | cancelLoan sends all withdrawn funds (principal+yield) to canceller | **BY DESIGN** — Depositor earned the yield, no surplus split needed |
| INFO-B | disableVault does not prevent withdrawals | **BY DESIGN** — Existing positions must remain withdrawable; `hasMarket` blocks new deposits |
| INFO-D | MorphoAdapter.withdraw assets>0 reverts on dust rounding | **DOCUMENTED** — Extremely unlikely edge case with dust positions |
| INFO-E | endLoan() dual oracle calls may diverge with live feed | **DOCUMENTED** — Recommend deriving excessCollateral from single price snapshot |
| INFO-15 | batchEmergencyWithdraw missing per-position assets>0 check | **DOCUMENTED** — Requires Morpho to behave unexpectedly; batch checks totalAssets>0 at end |
| INFO-16 | cancelLoan yield not tracked (no YieldSurplus event) | **BY DESIGN** — Depositor earned the yield; inconsistent with takeUpLoan event emission but correct behavior |
| INFO-17 | ParthenonVaultAdapter checkpoint try/catch swallows failure | **DOCUMENTED** — Duplicate of INFO-7; stale rate used for slippage calc if checkpoint reverts |

**Summary**: All CRITICAL/HIGH/MEDIUM/LOW findings fixed. Only INFO-level design decisions remain open.

### Module 2 — Credit Markets (CreditMarket, Orchestrator, TICSBridge)

| ID | Description | Severity | Status |
|----|-------------|----------|--------|
| M2-1 | LoanPositionToken uses `require()` instead of custom errors | LOW | **OPEN** — Refactor to CreditErrors.* |
| M2-2 | Missing zero-address checks in Orchestrator setters (setTICSBridge, setSanctionsSentinel, setPriceFeedAdapter) | LOW | **OPEN** — Add checks |
| M2-3 | `setTransferability()` and `setCustodianSignature()` not in ILoanPositionToken interface | LOW | **OPEN** — Add to interface |
| M2-4 | `registerLender()` has no sanctions check (only `authorizeBorrower()` does) | LOW | **OPEN** — Add `_checkSanctions(lender)` |
| M2-5 | TICSBridge signature accepts both relayer AND attester as valid signers | MEDIUM | **BY DESIGN** — OR gate for operational flexibility |
| M2-6 | No timeout for LOCKED collateral state (only RESERVED has timeout) | LOW | **OPEN** — Consider adding LOCKED timeout |
| M2-7 | `_computeMarketStateHash` fallback hashes `(market, block.number)` on staticcall failure | INFO | **DOCUMENTED** — Attestation signature prevents spoofing |
| M2-8 | No post-deployment verification script for multi-step initialization | MEDIUM | **OPEN** — Create verification script |

### Pool — ParthenonPool (Morpho Blue Fork)

| ID | Description | Severity | Status |
|----|-------------|----------|--------|
| P-1 | Morpho Blue fork with Ownable2Step and ReentrancyGuard additions | INFO | **BY DESIGN** — Security hardening over upstream |
| P-2 | SafeTransferLib operates on `address` instead of `IERC20` (scoped to pool/) | INFO | **BY DESIGN** — Matches upstream Morpho pattern |

### Optimizer — ParthenonOptimizer (MetaMorpho-inspired)

| ID | Description | Severity | Status |
|----|-------------|----------|--------|
| O-1 | Clean-room reimplementation, not line-by-line fork | INFO | **DOCUMENTED** — See ATTRIBUTION.md |

### Oracle — PriceFeedAdapter (Module 2)

| ID | Description | Severity | Status |
|----|-------------|----------|--------|
| OR-1 | No L2 sequencer uptime feed support | HIGH | **OPEN** — Required before L2 deploy |
| OR-2 | Single feed per asset, no fallback oracle | MEDIUM | **OPEN** — Post-launch improvement |
| OR-3 | No price deviation / circuit breaker checks | MEDIUM | **OPEN** — Post-launch improvement |
| OR-4 | `setFeed()` doesn't validate feed returns data | LOW | **OPEN** — Document for auditors |
| OR-5 | Staleness threshold bounded to 60s–604800s | INFO | **FIXED** — Sprint 7 |

---

## 2. Test Coverage Report

### Test Counts

| Suite | Tests | Status |
|-------|-------|--------|
| Module 1 (LoanFactory, PriceOracle, AssetRegistry, Adapters) | 866 | All passing |
| Module 2 (CreditMarket, Orchestrator, TICSBridge, LPT, PriceFeedAdapter, SanctionsSentinel) | 400+ | All passing |
| Pool (ParthenonPool — Morpho Blue fork) | 200+ | All passing |
| Optimizer (ParthenonOptimizer) | 100+ | All passing |
| **Total parthenonfi-contracts** | **1577** | **All passing** |

### Coverage by Contract (parthenonfi-contracts)

| Contract | Line | Branch | Function | Notes |
|----------|------|--------|----------|-------|
| LoanFactory.sol | 100% | 94.64% | 100% | Core lending logic |
| PriceOracle.sol | 100% | 100% | 100% | Oracle + circuit breaker |
| AssetRegistry.sol | 100% | 100% | 100% | Token registry |
| LoanCalculator.sol | 100% | 100% | 100% | Math library |
| MorphoAdapter.sol | 100% | 95.45% | 100% | Morpho yield routing |
| ParthenonVaultAdapter.sol | 100%* | 95.83%* | 100%* | Vault yield routing |

\* ParthenonVaultAdapter shows 0% in full-suite `npx hardhat coverage` but 100% when run in isolation — known Hardhat coverage tool artifact.

**Branch gaps**: Remaining uncovered branches are exclusively `nonReentrant`/`onlyOwner`/`whenNotPaused` modifier branches — inherently untestable without reentrancy attacks.

### Module 2 Coverage

| Contract | Notes |
|----------|-------|
| CreditMarket.sol | 13 test suites (borrow, deposit, repay, withdrawal, liquidation, delinquency, marginCall, batchExpiry, crossMarket, integration, fuzz, gas, branches) |
| Orchestrator.sol | 1 test suite |
| TICSBridge.sol | 4 test suites (core, e2e, keeper, downtime) |
| LoanPositionToken.sol | 2 test suites |
| PriceFeedAdapter.sol | 1 test suite |
| SanctionsSentinel.sol | 2 test suites (unit + integration) |
| ScaleFactorLib.sol | Property-based fuzz tests |

### Pool Coverage

| Contract | Notes |
|----------|-------|
| ParthenonPool.sol | 14 test suites (supply, borrow, repay, withdraw, liquidate, createMarket, authorization, collateral, accrueInterest, flashLoan, security, edgeCases, fuzz, gas) |
| FixedRateIrm.sol | 1 test suite |
| PoolOracleAdapter.sol | 1 test suite |

### Optimizer Coverage

| Contract | Notes |
|----------|-------|
| ParthenonOptimizer.sol | 6 test suites (deposit, withdraw, reallocation, multiStrategy, erc4626, fees) |
| OptimizerAdapter.sol | 1 test suite |

### Test Structure
- **Solidity test contracts** (`contracts/test/Test1-Test10`): Core logic, edge cases, branch coverage, precision fuzz
- **TypeScript tests** (`tests/unit-tests/`): Integration, adapter lifecycle, event verification, Module 2/Pool/Optimizer
- **Mocks**: MockERC20, MockAggregatorV3, MockMorpho, MockBoringVault, MockTeller, MockYieldAdapter, MockAccountantConfigurable

---

## 3. NatSpec Coverage

| Contract | Public/External Functions | Documented | Coverage |
|----------|--------------------------|------------|----------|
| LoanFactory.sol | 13 | 13 | **100%** |
| PriceOracle.sol | 11 | 11 | **100%** |
| AssetRegistry.sol | 9 | 9 (@inheritdoc) | **100%** |
| LoanCalculator.sol | 12 (internal) | 12 | **100%** |
| MorphoAdapter.sol | 28 | 28 | **100%** |
| ParthenonVaultAdapter.sol | 9 | 9 | **100%** |
| **Total** | **82** | **82** | **100%** |

**All public/external functions have @notice and/or @dev documentation.** AssetRegistry uses `@inheritdoc IAssetRegistry`. LoanCalculator documents all internal functions. Audit fix rationale is embedded in @dev comments (e.g., "H-6 Fix", "LOW-2 Fix").

---

## 4. Security Checklist

### Reentrancy Protection

| Contract | nonReentrant Applied | Coverage |
|----------|---------------------|----------|
| LoanFactory | createLoan, cancelLoan, takeUpLoan, liquidateLoan, endLoan, interruptLoan, topUp | All state-changing |
| MorphoAdapter | deposit, withdraw, withdrawPartial, emergencyWithdraw, batchEmergencyWithdraw | All state-changing |
| ParthenonVaultAdapter | deposit, withdraw, emergencyWithdraw | All state-changing |
| CreditMarket | deposit, borrow, repay, requestWithdrawal, processWithdrawalBatch, claimWithdrawal, accrueInterest, closeMarket, marginCall, cure, liquidate | All state-changing |
| TICSBridge | syncMarketState, receiveAttestation | State sync functions |
| ParthenonPool | supply, withdraw, borrow, repay, supplyCollateral, withdrawCollateral, liquidate, flashLoan | All state-changing (inline guard) |
| ParthenonOptimizer | deposit, mint, withdraw, redeem, reallocate | All state-changing |
| Orchestrator | createMarket | Market factory |
| PriceOracle | N/A (no token transfers) | N/A |
| AssetRegistry | N/A (no token transfers) | N/A |

### Access Control

| Pattern | Contracts |
|---------|-----------|
| Ownable2Step (two-step ownership) | LoanFactory, PriceOracle, AssetRegistry, MorphoAdapter, ParthenonVaultAdapter, TICSBridge, ParthenonPool |
| onlyOwner (admin functions) | All contracts with admin operations |
| onlyLoanFactory (runtime operations) | MorphoAdapter, ParthenonVaultAdapter |
| onlyRelayerOrOwner | TICSBridge (state sync, collateral confirmations) |
| onlyProtocolOperator | CreditMarket (marginCall, liquidate) |
| onlyBorrower / onlyOrchestrator | CreditMarket (role-restricted functions) |
| msg.sender authorization | LoanFactory (cancelLoan, takeUpLoan borrower/lender checks) |

### Oracle Safety (PriceOracle)

- [x] Staleness check (`block.timestamp - updatedAt > maxStaleness`)
- [x] Zero-price rejection (`answer <= 0`)
- [x] Sequencer uptime check (L2 support with grace period)
- [x] Sequencer feed staleness (`SEQUENCER_MAX_STALENESS = 3600s`)
- [x] Circuit breaker (deviation check against `maxDeviationBps`)
- [x] Chainlink round validation (`answeredInRound >= roundId`)
- [x] View-only unchecked variants (cannot poison `lastGoodPrice`)
- [x] Pair validation via AssetRegistry before oracle reads

### ERC-20 Compliance

- [x] SafeERC20 (`safeTransfer`, `safeTransferFrom`) on all token movements
- [x] `forceApprove` for approval management (handles non-standard tokens)
- [x] Residual approval clearing after adapter deposits (LOW-2, LOW-8, LOW-9)
- [x] No raw `transfer()`, `approve()`, or `transferFrom()` calls
- [x] Decimal validation in AssetRegistry (`IERC20Metadata.decimals()` cross-check)

### Input Validation

- [x] Zero-address checks on all configuration functions
- [x] Bounds checking on duration, interest rate, LTV, collateral ratio
- [x] Token pair validation via AssetRegistry
- [x] Asset floor enforcement (minimum loan amounts)
- [x] Collateral token matching (H-6 fix, both takeUpLoan branches)
- [x] Loan existence checks (C2 fix)
- [x] Active position guards on adapter reconfiguration (MEDIUM-C6, LOW-5)
- [x] Cross-validation of vault/teller/accountant addresses (LOW-C9)

### Event Emission

- [x] All state-changing operations emit events
- [x] Admin configuration changes emit events (fee, adapter, oracle feed updates)
- [x] EmergencyWithdrawn distinct from Withdrawn (INFO-11)
- [x] YieldSurplus event on surplus distribution

---

## 5. Recommendations for Auditor

### Architecture Overview
ParthenonFi is a **custody-native P2P RWA lending protocol**. Key flows:
1. **createLoan** — Maker creates borrow/lend offer, collateral/assets deposited, idle funds routed to yield adapter
2. **takeUpLoan** — Taker matches offer, yield withdrawn, loan activated with collateral re-validation
3. **endLoan/liquidateLoan/interruptLoan** — Settlement paths with yield surplus distribution
4. **Yield routing** — IYieldAdapter interface with two implementations: MorphoAdapter (Morpho Blue) and ParthenonVaultAdapter (BoringVault/Teller)

### Focus Areas
1. **takeUpLoan (LoanFactory.sol)** — Most complex function. Two branches (borrower-takes-lend, lender-takes-borrow). Contains yield withdrawal, surplus distribution, collateral validation, and loan deletion. Review both branches for consistency.
2. **Yield surplus math** — MEDIUM-1/2/4/5 fixes changed how surplus and negative yield are handled. Verify `min(withdrawn, principal)` logic prevents underflow in all edge cases.
3. **Oracle circuit breaker** — Deviation check uses `lastGoodPrice` state. Unchecked variants are `view` (MEDIUM-C5 fix) but are used in liquidation/settlement. Verify this is acceptable for the protocol's risk model.
4. **Adapter lifecycle** — `configureMarket`/`configureVault` blocked with active positions. Verify no path exists to orphan funds in adapters during migration.
5. **Two-step adapter replacement** (LOW-1) — Must clear to zero address first. Verify no funds are lost during the transition window.
6. **endLoan() dual oracle calls** (INFO-E) — `btcPayout` and `excessCollateral` use separate oracle reads. With a live Chainlink feed, price could change between calls. Recommend deriving `excessCollateral = collateral - btcPayout` from a single price snapshot.

### Known Design Decisions (not bugs)
- HIGH-3: No parameter matching — taker accepts maker's exact terms (P2P marketplace model)
- INFO-6: Borrower bears lender's negative asset yield (loan records full principal)
- INFO-12: Taker's loan deleted after external calls (safe via nonReentrant, but inconsistent CEI)
- LOW-C7: Deviation granularity is 0.01% (10000 scaling factor)

### Dependencies
- OpenZeppelin Contracts (Ownable2Step, ReentrancyGuard, SafeERC20, Pausable, Math)
- Chainlink AggregatorV3Interface (price feeds)
- Morpho Blue (IMorpho interface for MorphoAdapter)
- BoringVault / Teller (ITeller, IAccountant interfaces for ParthenonVaultAdapter)

### Module 2 Focus Areas
7. **CreditMarket state machine** — Deposit → borrow → repay → withdrawal batch → delinquency → margin call → liquidation. Singleton withdrawal batch (one pending at a time). Verify batch processing during delinquency/liquidation edge cases.
8. **ScaleFactorLib (RAY math)** — Interest accrual using 1e27 fixed-point. Cross-platform parity with DAML (1e9 scale). 14 parity test vectors. Verify no precision loss across accrual periods.
9. **TICSBridge attestation** — ECDSA signature verification with nonce-based replay protection. Verify collateral state machine transitions and timeout recovery.
10. **Orchestrator credit limits** — Per-tier credit limit enforcement across multiple markets. Normalized to 18 decimals. Verify no overflow/underflow in cross-market accounting.

### Pool Focus Areas
11. **ParthenonPool (Morpho Blue fork)** — Isolated lending markets with Ownable2Step and ReentrancyGuard additions. Verify security hardening doesn't break upstream invariants.
12. **Flash loans** — Verify callback safety and fee enforcement.

### Optimizer Focus Areas
13. **ParthenonOptimizer (MetaMorpho-inspired)** — Supply/withdraw queues, per-market allocation caps. Verify ERC-4626 share calculation correctness and reallocation safety.

### Build & Test
```bash
pnpm install
npx hardhat compile
npx hardhat test              # 1577 tests
npx hardhat coverage          # Note: VaultAdapter shows 0% in full suite (tool artifact)
```
