# ParthenonFi Contracts

Smart contracts for ParthenonFi — a peer-to-peer fixed-rate lending protocol where lenders deposit stablecoins and borrowers post volatile or RWA collateral (BTC, ETH, etc.).

## Overview

ParthenonFi is a peer-to-peer marketplace for fixed-rate, fixed-duration loans. In contrast to pool-based protocols (Aave, Compound) with variable interest rates subject to manipulation, ParthenonFi offers:

- **Fixed interest rates** impervious to third-party manipulation
- **Fixed durations** — from 1 day to 365 days
- **Peer-to-peer matching** on a first-come-first-served basis
- **Multi-stablecoin support** — any ERC20 stablecoin (USDC, USDT, DAI, etc.) can be used as the lent asset
- **Multi-collateral support** — any whitelisted volatile or RWA token (WBTC, WETH, etc.) can be used as collateral
- **Chainlink price feeds** for live collateral valuation with staleness, zero-price, and sequencer checks
- **Token whitelisting** via `AssetRegistry` to prevent fake-token attacks
- **Performance guarantees** — probabilistic bounds on repayment and collateral return derived from a geometric random walk model of collateral/asset valuation

Lenders and borrowers discover competitive rates through tâtonnement (competitive offer/cancel dynamics), rather than rates set by a central authority or utilization curve.

## Protocol

Anyone can post an **offer to lend** (deposit stablecoin) or an **offer to borrow** (deposit collateral). Offers are matched peer-to-peer. Once matched, the borrower receives the stablecoin and the collateral is held in the contract.

At maturity, the lender is repaid in collateral equivalent to `(1 + r)^d * v` (principal + interest), and any excess collateral is returned to the borrower. If the collateral health score drops below the liquidation threshold before maturity, the lender may liquidate and claim all collateral.

## Contracts

### [contracts/LoanFactory.sol](contracts/LoanFactory.sol)
Core contract managing the full loan lifecycle. Takes `PriceOracle` and `AssetRegistry` as constructor arguments.

| Function | Who | Whitepaper | Description |
|---|---|---|---|
| `createLoan` | Lender or Borrower | eq. 33–34, 40–41 | Post a lend offer (deposit stablecoin) or borrow offer (deposit collateral) |
| `cancelLoan` | Lender or Borrower | eq. 45–48 | Cancel an unmatched offer and reclaim deposited tokens |
| `takeUpLoan` | Lender or Borrower | eq. 35–38, 42–44 | Match two opposing offers into an active loan |
| `liquidateLoan` | Anyone | eq. 56–58 | Liquidate when health score drops below threshold; lender claims all collateral |
| `endLoan` | Anyone | eq. 53–55 | Settle a matured loan — lender receives collateral payout, borrower receives excess |
| `interruptLoan` | Borrower | eq. 49–52 | Repay early with full-term interest in stablecoin and reclaim collateral |
| `topUp` | Borrower | eq. 59–60 | Add collateral to improve health score |
| `pause` / `unpause` | Owner | — | Emergency halt of `createLoan` and `takeUpLoan`; exits always remain open |

### [contracts/PriceOracle.sol](contracts/PriceOracle.sol)
Wraps Chainlink price feeds with safety checks. Implements `ϕ_t(H_t, v)` from whitepaper equation 23.

| Feature | Description |
|---|---|
| Staleness check | Reverts if price is older than `maxStaleness` (e.g., heartbeat + 60s) |
| Zero/negative price guard | Reverts on invalid feed data |
| Sequencer uptime check | L2 sequencer check with 1-hour grace period (Arbitrum, Base) |
| Circuit breaker | Reverts if price moves more than `maxDeviationBps` (default 50%) between reads |
| Unchecked variants | `getOraclePriceUnchecked` bypasses circuit breaker for liquidations and loan matching — never blocks exits |
| View variants | `getOraclePriceView` / `getInverseOraclePriceView` for off-chain reads without state changes |
| Multi-stablecoin | `assetDecimals` parameter threads the lent token's decimals through all oracle calls — supports USDC (6), USDT (6), DAI (18), etc. |
| Two-step ownership | `transferOwnership` proposes, `acceptOwnership` completes — prevents accidental key rotation |

### [contracts/AssetRegistry.sol](contracts/AssetRegistry.sol)
Manages whitelisted tokens and valid collateral/asset pairs.

| Feature | Description |
|---|---|
| `registerAsset` | Register a token with symbol, Chainlink feed key, and decimals (validated against ERC20) |
| `setAssetSupported` | Enable or disable a token for new loans |
| `setPairSupported` | Whitelist a collateral/asset pair (e.g., WBTC/USDC) |
| `isValidPair` | Used by `LoanFactory` on every `createLoan` — blocks unlisted tokens |

### [contracts/libraries/LoanCalculator.sol](contracts/libraries/LoanCalculator.sol)
Pure math library implementing formulas from the ParthenonFi whitepaper.

| Function | Formula | Description |
|---|---|---|
| `calculateTotalRepayment` | `(1 + r_daily)^d * v` | Total stablecoin repayment at maturity |
| `calculateHealthScore` | `ϕ_t(z) / ((1+r)^t * v)` in bps | Current collateral health (hourly granularity) |
| `calculateBTCPayout` | `min(ϕ⁻¹((1+r)^d * v), z)` | Collateral paid to lender at maturity |
| `calculateExcessCollateral` | `z - collateralPayout` | Excess collateral returned to borrower |

### [contracts/interfaces/ILoanFactory.sol](contracts/interfaces/ILoanFactory.sol)
Defines the `Loan` struct, `Status` enum, events, and function signatures.

### [contracts/interfaces/IAssetRegistry.sol](contracts/interfaces/IAssetRegistry.sol)
Interface for `AssetRegistry`.

### [contracts/deploy/DeployReference.sol](contracts/deploy/DeployReference.sol)
Reference deployment script with addresses for Ethereum mainnet, Sepolia, Arbitrum, Polygon, and Base. Includes a configuration checklist and an example Foundry deploy script.

## Loan Parameters

**Duration options** (index 0–5): 1, 7, 30, 90, 180, 365 days

**Interest rates** (index 0–7, annual): 4%, 5%, 6%, 7%, 8%, 9%, 10%, 11%

**Collateral constraints:**
- Liquidation threshold: 100%–150% (basis points: 10000–15000)
- Initial collateral ratio: 110%–500% (basis points: 11000–50000), must exceed liquidation threshold
- Minimum loan asset: 100 units in the asset token's own decimals
- Minimum collateral value: equivalent of 100 asset units at current oracle price

## Loan States

```
s1 — offer to lend    (stablecoin held in contract)
s2 — offer to borrow  (collateral held in contract)
s3 — active loan      (collateral held, stablecoin sent to borrower)
s4 — terminated
```

## Health Score & Liquidation

The health score (whitepaper eq. 58) is:

```
health = ϕ_t(z) / ((1 + r)^t * v)   [in basis points]
```

where `ϕ_t(z)` is the live Chainlink stablecoin value of the collateral and `(1 + r)^t * v` is the prorated loan value at time `t` (hours elapsed). Liquidation is allowed when `health < liquidationThreshold`, but only before maturity — after maturity, `endLoan` must be used for the fair collateral split.

## Deployment Order

```
1. Deploy AssetRegistry
2. registerAsset(WBTC, ...) + registerAsset(USDC, ...)
3. setAssetSupported(WBTC, true) + setAssetSupported(USDC, true)
4. setPairSupported(WBTC, USDC, true)
5. Deploy PriceOracle(owner)
6. oracle.setFeed(WBTC, CHAINLINK_BTC_USD, 3660)
7. Deploy LoanFactory(oracle, assetRegistry, feeRecipient, feeBps)
```

See [contracts/deploy/DeployReference.sol](contracts/deploy/DeployReference.sol) for chain-specific Chainlink addresses and a full Foundry deploy script example.

## Development

Install dependencies:
```shell
pnpm install
```

Compile contracts:
```shell
pnpm compile
```

Run tests:
```shell
pnpm test
```

Run tests with gas reporting:
```shell
REPORT_GAS=true pnpm test
```

Start a local node:
```shell
npx hardhat node
```

## Tech Stack

- [Hardhat](https://hardhat.org/) — development framework
- [OpenZeppelin Contracts v5](https://docs.openzeppelin.com/contracts/5.x/) — `SafeERC20`, `ReentrancyGuard`, `Ownable`, `Pausable`, `Math`
- [Chainlink](https://docs.chain.link/) — `AggregatorV3Interface` price feeds
- Solidity `^0.8.28`
- TypeScript test suite with Chai
