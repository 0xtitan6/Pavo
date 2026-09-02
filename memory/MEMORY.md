# Pavo Contracts — Project Memory

## Project Overview
- **Protocol**: Pavo — peer-to-peer fixed-rate lending, USDC lent against WBTC collateral
- **Stack**: Hardhat + Solidity ^0.8.28, pnpm, TypeScript tests
- **Test runner**: `pnpm test`

## Key Architecture
- `LoanFactory(oracle, assetRegistry, feeRecipient, protocolFeeBps)` — main contract; inherits Ownable
- `PriceOracle` — wraps Chainlink feeds; has checked and unchecked oracle variants
- `AssetRegistry` — token whitelist + pair validation (H-4 fix)
- `LoanCalculator` (library) — math + oracle wrappers; functions take `PriceOracle oracle` param
- Loan states: s1=lend offer, s2=borrow offer, s3=active, s4=terminated
- Protocol fee: taken at `createLoan` time (from USDC for lend, from BTC for borrow); loan stores net amount; fee=0 if feeRecipient=ZeroAddress or protocolFeeBps=0; max 500 bps (5%)

## Test Count
- **116 tests total, all passing** as of last run
- Includes protocol fee (13), pause (10), H-2/M-6 negative (2), H-5 two-step ownership (3) tests

## Test Infrastructure
- `tests/utils/deployments.ts` — deploys: ERC20Mock×2 (with decimals arg), MockAggregatorV3, AssetRegistry, PriceOracle, LoanFactory, LoanCalculatorTest
- `tests/utils/loanHelpers.ts` — all test helpers
- `tests/unit-tests/` — all test files (25 tests, all passing)
- ERC20Mock now accepts a 5th `decimals_` constructor param (patched to match AssetRegistry validation)
- maxStaleness in tests: 400 days (34,560,000s) to allow time-travel in tests
- Non-pure oracle calls in LoanCalculatorTest must use `.staticCall()` to get return values

## Critical Patterns
- All loans (both lend and borrow) need real token addresses for `assetAddress` and `collateralAddress` (not ZeroAddress) — AssetRegistry's `isValidPair` checks both
- Registered pair: `(btcMock, usdcMock)` — collateral=BTC, asset=USDC
- Liquidation tests: drop BTC price via `mockAggregator.setAnswer(newPrice)` rather than time-traveling past maturity
- `calculateExcessCollateralUnchecked` + derive `btcPayout = collateral - excessCollateral` (single oracle call)
- Unchecked oracle variants bypass circuit breaker for liquidation/settlement

## Security Fixes Applied
- **C-1**: `require(takeUpId != offerId)` in takeUpLoan (self-match aliasing guard)
- **C-2/CEI**: All lifecycle fns (cancel, liquidate, end, interrupt) read locals → delete → transfer
- **H-2**: takeUpLoan uses `getOraclePriceUnchecked` — circuit breaker can't block matching
- **H-3**: Fixed automatically by CEI (delete before transfers, revert restores state)
- **H-4**: `Pausable` added — `createLoan` + `takeUpLoan` blocked when paused; lifecycle ops unaffected
- **H-5**: Two-step ownership in PriceOracle — `transferOwnership` sets `pendingOwner`; `acceptOwnership` finalises
- **M-6**: `takeUpLoan` validates `assetAddress` + `collateralAddress` match between both offers

## Files Modified (Key)
- `contracts/LoanFactory.sol` — constructor(oracle, assetRegistry), full lifecycle, Pausable, all fixes
- `contracts/PriceOracle.sol` — checked+unchecked variants, two-step ownership (pendingOwner)
- `contracts/libraries/LoanCalculator.sol` — oracle functions take PriceOracle param
- `contracts/mocks/ERC20Mock.sol` — added decimals_ constructor param + override
- `contracts/mocks/MockAggregatorV3.sol` — NEW: implements AggregatorV3Interface for tests
- `contracts/mocks/LoanCalculatorTest.sol` — wrapper for testing library functions with oracle
- `tests/utils/deployments.ts` — full stack deployment
- `tests/utils/loanHelpers.ts` — all test helpers including verifyEndLoanTokenTransfers with staticCall
- `tests/unit-tests/LoanFactory.pause.test.ts` — NEW: H-4 pause tests (10 tests)
- `tests/unit-tests/LoanFactory.takeUpLoan.negative.test.ts` — added H-2, M-6, C-1 tests
