# Module 1 — Sepolia Testnet Deployment

**Deployed:** 2026-03-27
**Network:** Ethereum Sepolia (chainId: 11155111)
**Deployer:** `0x0cd4d01358B71ecc330BC7278e609a4C1665d3C0`

## Core Contracts

| Contract | Address | Etherscan |
|----------|---------|-----------|
| AssetRegistry | `0xEaEfA2a3A43A62d2Ab2886116C8251b0db41948c` | [View](https://sepolia.etherscan.io/address/0xEaEfA2a3A43A62d2Ab2886116C8251b0db41948c) |
| PriceOracle | `0x5BA5F7b81267981a3DfcF99206c7d893680D7b9C` | [View](https://sepolia.etherscan.io/address/0x5BA5F7b81267981a3DfcF99206c7d893680D7b9C) |
| LoanFactory | `0x133C0681ABFF7632f5d24B6eB78E5da12FA9279E` | [View](https://sepolia.etherscan.io/address/0x133C0681ABFF7632f5d24B6eB78E5da12FA9279E) |

## Mock ERC-20 Tokens

These are mock tokens deployed for testnet use. They have public `mint()` functions for easy testing.

| Token | Decimals | Address | Etherscan |
|-------|----------|---------|-----------|
| WBTC | 8 | `0x796ff806405ff052f8DE717E0D936D6A25D44416` | [View](https://sepolia.etherscan.io/address/0x796ff806405ff052f8DE717E0D936D6A25D44416) |
| WETH | 18 | `0x79555413169b90Ecd8aCEa5D96aBEFa60Ec4e52C` | [View](https://sepolia.etherscan.io/address/0x79555413169b90Ecd8aCEa5D96aBEFa60Ec4e52C) |
| USDC | 6 | `0xE33E3E3cB84e38E9531387e69bf7352dEcd25e9b` | [View](https://sepolia.etherscan.io/address/0xE33E3E3cB84e38E9531387e69bf7352dEcd25e9b) |
| USDT | 6 | `0x895A91D8d79fdb6faCe6d27d3c414EE7A20B3F50` | [View](https://sepolia.etherscan.io/address/0x895A91D8d79fdb6faCe6d27d3c414EE7A20B3F50) |

## Supported Markets

| Collateral | Loan Asset | Pair |
|------------|-----------|------|
| WBTC | USDC | WBTC/USDC |
| WETH | USDC | WETH/USDC |
| WBTC | USDT | WBTC/USDT |
| WETH | USDT | WETH/USDT |

## Chainlink Price Feeds

Real Sepolia Chainlink feeds are used — prices reflect live market data.

| Feed | Address | Max Staleness |
|------|---------|---------------|
| BTC/USD | `0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43` | 86400s (24h) |
| ETH/USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` | 86400s (24h) |

Prices at deployment: BTC ~$68,892 / ETH ~$2,065

## Configuration

| Parameter | Value |
|-----------|-------|
| Protocol fee | 500 bps (5%) |
| Fee recipient | `0x0cd4d01358B71ecc330BC7278e609a4C1665d3C0` (deployer) |
| Max staleness | 86400s (24h, generous for testnet) |
| Owner (all contracts) | `0x0cd4d01358B71ecc330BC7278e609a4C1665d3C0` |

## LoanFactory Parameters

| Parameter | Value |
|-----------|-------|
| Min loan size | 100 units (in asset token decimals) |
| Duration options | 1, 7, 30, 90, 180, 365 days |
| Interest rates | 4%, 5%, 6%, 7%, 8%, 9%, 10%, 11% annual |
| Collateral ratio | 110% - 500% |
| Liquidation threshold | 100% - 150% |

## Testing Guide

### Mint test tokens

Mock tokens have a public `mint(address, uint256)` function:

```solidity
// Mint 10 WBTC to your address
WBTC.mint(yourAddress, 10e8);

// Mint 100,000 USDC
USDC.mint(yourAddress, 100_000e6);
```

### Create a lend offer

```solidity
// 1. Approve USDC spending
USDC.approve(loanFactoryAddress, amount);

// 2. Create lend offer (WBTC collateral, USDC loan, 7-day, 6% APR, 150% collateral ratio)
LoanFactory.createLendOffer(
    wbtcAddress,    // collateral token
    usdcAddress,    // loan token
    amount,         // loan amount in USDC (6 decimals)
    7,              // duration in days
    600,            // interest rate bps (6%)
    15000           // collateral ratio bps (150%)
);
```

### Create a borrow offer and take up loan

```solidity
// 1. Approve WBTC as collateral
WBTC.approve(loanFactoryAddress, collateralAmount);

// 2. Create borrow offer
LoanFactory.createBorrowOffer(
    wbtcAddress,    // collateral token
    usdcAddress,    // loan token
    amount,         // loan amount requested
    7,              // duration in days
    600,            // max interest rate bps
    15000           // collateral ratio bps
);

// 3. Match offers
LoanFactory.takeUpLoan(lendOfferId, borrowOfferId);
```

## Deployment Script

```bash
npx hardhat run scripts/deploy-module1-sepolia.ts --network sepolia
```

Full deployment manifest: [`deployments/module1-sepolia.json`](module1-sepolia.json)

## Next Steps

- **Verify contracts on Etherscan:** Add `ETHERSCAN_API_KEY` to `.env` and re-deploy, or verify manually
- **Deploy Module 2** (Pool + Optimizer + Adapter):
  ```bash
  PRICE_ORACLE=0x5BA5F7b81267981a3DfcF99206c7d893680D7b9C \
  LOAN_FACTORY=0x133C0681ABFF7632f5d24B6eB78E5da12FA9279E \
    npx hardhat run scripts/deploy-all.ts --network sepolia
  ```
- **Transfer ownership to multisig** (for production readiness)
