# Attribution

## Morpho Blue Fork — ParthenonPool

The `contracts/pool/` directory contains a fork of [Morpho Blue](https://github.com/morpho-org/morpho-blue) by Morpho Labs.

- **Source:** `morpho-org/morpho-blue` (commit referenced at fork time)
- **License:** GPL-2.0-or-later
- **Original Authors:** Morpho Labs (security@morpho.org)

### Changes from upstream:
- Renamed `Morpho` → `ParthenonPool`
- Replaced `setOwner()` with two-step `Ownable2Step` pattern (`transferOwnership`/`acceptOwnership`)
- Added `ReentrancyGuard` (inline) on all state-changing functions
- Updated pragma from `0.8.19` to `^0.8.28`
- Renamed callback interfaces from `onMorpho*` to `onPool*`
- Renamed periphery libraries: `MorphoLib` → `PoolLib`, `MorphoBalancesLib` → `PoolBalancesLib`, `MorphoStorageLib` → `PoolStorageLib`
- Updated import paths to local `./interfaces/`, `./libraries/`
- `SafeTransferLib` operates on `address` instead of `IERC20` type (scoped to pool/ only)

### New contracts (not from upstream):
- `contracts/pool/oracles/PoolOracleAdapter.sol` — Wraps PriceOracle for IPoolOracle interface
- `contracts/pool/irm/FixedRateIrm.sol` — Simple fixed-rate IRM

## MetaMorpho Inspiration — ParthenonOptimizer

The `contracts/optimizer/` directory is inspired by [MetaMorpho](https://github.com/morpho-org/metamorpho) by Morpho Labs.

- **Source:** `morpho-org/metamorpho`
- **License:** GPL-2.0-or-later (original); check MetaMorpho repo for specific license
- **Original Authors:** Morpho Labs

### Relation to upstream:
- ParthenonOptimizer is a **clean-room reimplementation** of the MetaMorpho concept (ERC-4626 vault routing to isolated lending markets), not a line-by-line fork
- Key concepts borrowed: supply/withdraw queues, per-market allocation caps, reallocate function, guardian role
- Implementation uses OpenZeppelin ERC4626 base instead of custom ERC-4626

## Wildcat Finance — Module 2 Math and Patterns

The `contracts/module2/` directory adapts math and state machine patterns from [Wildcat Finance](https://github.com/wildcat-finance/v2-protocol).

- **Source:** `wildcat-finance/v2-protocol`
- **License:** Apache-2.0
- **Original Authors:** Wildcat Finance

### Adapted contracts:
- `contracts/module2/libraries/ScaleFactorLib.sol` — Adapted from Wildcat's `MathUtils.sol` + `FeeMath.sol`. Interest accrual, delinquency penalties, and scale factor updates using RAY (1e27) fixed-point arithmetic.
- `contracts/module2/libraries/CreditTypesLib.sol` — Type definitions mapped from Wildcat's market state model. Maps 1:1 to DAML `WildcatTypes.daml`.
- `contracts/module2/CreditMarket.sol` — State machine patterns (deposit → borrow → repay → withdrawal batching → delinquency → margin call → liquidation) adapted from Wildcat's `MarketState` patterns.

### Key differences from upstream:
- RAY constant: 1e27 (Wildcat uses 1e27 in Solidity, DAML uses 1e9 for Numeric 10 scale)
- Added TICSBridge integration for Canton/DAML cross-platform state sync
- Added sanctions screening via SanctionsSentinel (Chainalysis integration)
- Added LoanPositionToken (ERC-20 position tokens with transfer restrictions)
- Added Orchestrator for factory + governance + credit tier management
- Substantially different architecture: custody-native RWA lending vs. permissionless credit markets

## OptimizerAdapter

`contracts/adapters/OptimizerAdapter.sol` follows the same patterns as `MorphoAdapter.sol` (per-loanId share tracking, deposit caps, market pause/freeze, emergency withdrawal) but delegates to the ERC-4626 optimizer vault.
