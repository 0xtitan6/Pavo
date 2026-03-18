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

## Module 2 — Credit Markets

The `contracts/module2/` directory contains original contracts for custody-native RWA lending. The interest accrual math in `ScaleFactorLib.sol` references standard DeFi scale factor patterns (RAY 1e27 fixed-point arithmetic).

## OptimizerAdapter

`contracts/adapters/OptimizerAdapter.sol` follows the same patterns as `MorphoAdapter.sol` (per-loanId share tracking, deposit caps, market pause/freeze, emergency withdrawal) but delegates to the ERC-4626 optimizer vault.
