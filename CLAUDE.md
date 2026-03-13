# Parthenon Fi Contracts

Solidity smart contracts for ParthenonFi custody-native RWA lending protocol.

## Commands
- `npx hardhat compile` — compile contracts
- `npx hardhat test` — run tests (946 tests)
- `npx hardhat test --grep "pattern"` — run specific tests

## Project Structure
```
contracts/
├── LoanFactory.sol              # Core P2P lending (centerpiece, unchanged)
├── PriceOracle.sol              # Chainlink oracle wrapper
├── AssetRegistry.sol            # Asset registry
├── interfaces/                  # Core interfaces (IYieldAdapter, ILoanFactory, etc.)
├── libraries/                   # Shared libraries (LoanCalculator)
├── adapters/                    # Protocol adapters
│   ├── MorphoAdapter.sol        # @deprecated — external Morpho Blue adapter
│   ├── ParthenonVaultAdapter.sol # Boring Vault adapter
│   ├── OptimizerAdapter.sol     # NEW — routes idle funds via ParthenonOptimizer
│   └── interfaces/              # Adapter interfaces (IMorpho, IBoringVault)
├── pool/                        # NEW — Morpho Blue fork (ParthenonPool)
│   ├── ParthenonPool.sol        # Isolated lending markets
│   ├── interfaces/              # IParthenonPool, IPoolCallbacks, IIrm, IPoolOracle
│   ├── libraries/               # ConstantsLib, ErrorsLib, MathLib, SharesMathLib, etc.
│   │   └── periphery/           # PoolLib, PoolBalancesLib, PoolStorageLib
│   ├── oracles/                 # PoolOracleAdapter (wraps PriceOracle)
│   └── irm/                     # FixedRateIrm
├── optimizer/                   # NEW — MetaMorpho-inspired optimizer
│   ├── ParthenonOptimizer.sol   # ERC-4626 vault routing to best yield
│   └── interfaces/              # IParthenonOptimizer
├── mocks/                       # Test mocks
├── test/                        # Solidity test helpers
└── deploy/                      # Deployment helpers
```

## Architecture
```
LoanFactory (P2P lending — centerpiece, unchanged)
  ↓ idle offers (unmatched capital)
OptimizerAdapter (IYieldAdapter — replaces MorphoAdapter)
  ↓
ParthenonOptimizer (ERC-4626 — routes to best yield)
  ├→ ParthenonPool markets (Morpho Blue fork — own isolated lending markets)
  ├→ ParthenonVault (Clearpool/Boring Vault fork — already done)
  └→ Future: external protocols
```

## Stack
- Hardhat 2.26.3 + TypeScript
- OpenZeppelin Contracts (v5.4.0)
- Chainlink price feeds (v1.5.0)
- pnpm package manager

## Key Design Decisions
- **pool/ uses Morpho's SafeTransferLib** (scoped to pool/ only; rest uses OZ SafeERC20)
- **LoanFactory unchanged** — IYieldAdapter interface is stable; just swap adapter at deployment
- **MorphoAdapter kept but @deprecated** — existing tests pass untouched
- **ParthenonPool has Ownable2Step** (transferOwnership/acceptOwnership) unlike Morpho's setOwner
- **ParthenonPool has ReentrancyGuard** on all state-changing functions

## Coding Standards
- NatSpec documentation on all public/external functions
- ReentrancyGuard on state-changing functions
- SafeERC20 for all token transfers (except pool/ which uses its own SafeTransferLib)
- 100% test coverage target for core contracts
- GPL-2.0-or-later for pool/ (Morpho fork); MIT for adapters
