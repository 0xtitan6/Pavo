# ParthenonFi Contracts

Smart contracts for ParthenonFi — a peer-to-peer fixed-rate lending protocol where lenders deposit USDC and borrowers post BTC collateral.

## Overview

ParthenonFi is a peer-to-peer marketplace for fixed-rate, fixed-duration loans — like Facebook Marketplace for lending. In contrast to pool-based protocols (Aave, Compound) with variable interest rates subject to manipulation, ParthenonFi offers:

- **Fixed interest rates** impervious to third-party manipulation
- **Fixed durations** — from 1 day to 365 days
- **Peer-to-peer matching** on a first-come-first-served basis
- **Performance guarantees** — probabilistic bounds on repayment and collateral return derived from a geometric random walk model of BTC/USDC valuation

Lenders and borrowers discover competitive rates through tâtonnement (competitive offer/cancel dynamics), rather than rates set by a central authority or utilization curve.

## Protocol

Anyone can post an **offer to lend** (deposit USDC) or an **offer to borrow** (deposit BTC collateral). Offers are matched peer-to-peer. Once matched, the loan is live: the borrower receives USDC and the BTC collateral is held in the contract until the loan ends.

At maturity, the lender is repaid in BTC equivalent to `(1 + r)^d * v` (principal + interest), and any excess collateral is returned to the borrower. If the collateral health score drops below the liquidation threshold before maturity, the lender may liquidate and claim the full BTC collateral.

## Contracts

### [contracts/LoanFactory.sol](contracts/LoanFactory.sol)
Core contract managing the full loan lifecycle:

| Function | Who | Description |
|---|---|---|
| `createLoan` | Lender or Borrower | Post a lend offer (deposit USDC) or borrow offer (deposit BTC collateral) |
| `cancelLoan` | Lender or Borrower | Cancel an unmatched offer and reclaim deposited tokens |
| `takeUpLoan` | Lender or Borrower | Match two opposing offers into an active loan |
| `liquidateLoan` | Lender | Liquidate a loan whose health score drops below the liquidation threshold |
| `endLoan` | Anyone | Settle a matured loan — lender receives BTC (principal + interest), borrower receives excess collateral |
| `interruptLoan` | Borrower | Repay early with full-term interest in USDC and reclaim BTC collateral |
| `topUp` | Borrower | Add BTC collateral to improve health score and reduce liquidation risk |

### [contracts/libraries/LoanCalculator.sol](contracts/libraries/LoanCalculator.sol)
Pure math library implementing formulas from the ParthenonFi whitepaper:

| Function | Formula | Description |
|---|---|---|
| `calculateTotalRepayment` | `(1 + r_daily)^d * v` | Total USDC repayment at maturity |
| `calculateHealthScore` | `φ_t(z) / ((1+r)^t * v)` in bps | Current collateral health score |
| `calculateBTCPayout` | `min(φ⁻¹((1+r)^d * v), z)` | BTC paid to lender at maturity |
| `calculateExcessCollateral` | `max(z - φ⁻¹((1+r)^d * v), 0)` | Excess BTC returned to borrower |

> **Note:** Oracle pricing (`φ_t`) is currently mocked at 1 BTC = 50,000 USDC. Chainlink integration is planned.

### [contracts/interfaces/ILoanFactory.sol](contracts/interfaces/ILoanFactory.sol)
Interface defining the `Loan` struct, `Status` enum, events, and function signatures.

## Loan Parameters

**Duration options** (index 0–5): 1, 7, 30, 90, 180, 365 days

**Interest rates** (index 0–7, annual): 4%, 5%, 6%, 7%, 8%, 9%, 10%, 11%

**Collateral constraints:**
- Liquidation threshold: 100%–150% (basis points: 10000–15000)
- Initial collateral ratio: 110%–500% (basis points: 11000–50000)
- Minimum loan asset: 100 USDC

## Loan States

```
s1 — offer to lend    (USDC held in contract)
s2 — offer to borrow  (BTC held in contract)
s3 — active loan      (BTC held, USDC sent to borrower)
s4 — terminated
```

## Health Score & Liquidation

The health score (from whitepaper equation 58) is:

```
health = φ_t(z) / ((1 + r)^t * v)
```

where `φ_t(z)` is the current USDC value of BTC collateral and `(1 + r)^t * v` is the prorated loan value at time `t`. Liquidation is allowed when `health < liquidation_threshold`.

Note: this differs from Aave-style health factors — the denominator uses prorated (elapsed) loan value, not the final maturity value.

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
- [OpenZeppelin Contracts v5](https://docs.openzeppelin.com/contracts/5.x/) — `SafeERC20`, `ReentrancyGuard`, `Math`
- Solidity `^0.8.28`
- TypeScript test suite with Chai
