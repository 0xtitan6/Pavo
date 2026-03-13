# Module 2 ABI Exports

Auto-generated ABI files for frontend integration with Module 2 contracts.

## Files

| File | Description |
|------|-------------|
| `Orchestrator.abi.json` | Central governance + market factory |
| `CreditMarket.abi.json` | Per-borrower credit facility |
| `LoanPositionToken.abi.json` | ERC-20 position tokens |
| `ITICSBridge.abi.json` | TICS oracle bridge interface |
| `index.ts` | TypeScript exports + address config |

## Usage

### Import ABIs in TypeScript

```typescript
import { ORCHESTRATOR_ABI, CREDIT_MARKET_ABI } from './abis/module2';
```

### Configuration

Set deployment addresses in your environment or config:

```typescript
import { CONTRACT_ADDRESSES } from './abis/module2';

const orchestrator = new ethers.Contract(
  CONTRACT_ADDRESSES.Orchestrator,
  ORCHESTRATOR_ABI,
  signer
);
```

### Environment Variables

- `ORCHESTRATOR_ADDRESS` - Orchestrator contract address
- `CREDIT_MARKET_ADDRESS` - CreditMarket instance address
- `LOAN_POSITION_TOKEN_ADDRESS` - LoanPositionToken address
- `TICS_BRIDGE_ADDRESS` - ITICSBridge address

## Regenerate

Run after contract changes:

```bash
npx hardhat run scripts/export-abis.ts
```

## Contract Addresses (Sepolia)

Update after deployment to `deployments/sepolia.json`.
