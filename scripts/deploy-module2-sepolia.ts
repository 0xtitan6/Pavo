/**
 * deploy-module2-sepolia.ts
 *
 * Deploys the Module 2 undercollateralized lending stack to Sepolia testnet:
 *   1. Pre-flight checks (env vars, deployer balance)
 *   2. Deploy Orchestrator
 *   3. Deploy SanctionsSentinel (mock sanctions list for testnet)
 *   4. Deploy PriceFeedAdapter (with Sepolia Chainlink ETH/USD feed)
 *   5. Deploy TICSBridge
 *   6. Wire up: orchestrator.setSanctionsSentinel + setPriceFeedAdapter
 *   7. Authorize borrower and create market via Orchestrator
 *   8. Verify all contracts on Etherscan
 *   9. Save deployment manifest to deployments/module2-sepolia.json
 *
 * Required env vars:
 *   PRIVATE_KEY        - deployer private key
 *   SEPOLIA_URL        - Sepolia RPC URL
 *   ETHERSCAN_API_KEY  - Etherscan API key for verification
 *   ASSET_TOKEN        - ERC-20 asset token address (e.g., Sepolia USDC)
 *   BORROWER_ADDRESS   - borrower to authorize
 *
 * Optional env vars:
 *   FEE_RECIPIENT      - protocol fee recipient (default: deployer)
 *   RELAYER_ADDRESS    - custody-integration relayer EOA for TICSBridge (default: deployer)
 *   ATTESTER_ADDRESS   - Canton attestation verifier for TICSBridge (default: deployer)
 *   LENDER_ADDRESS     - initial lender to register
 *   BORROWER_TIER      - credit tier 0-3 (default: 1 = TIER_2 $500K)
 *   INTEREST_BIPS      - annual interest rate in bips (default: 500 = 5%)
 *   RESERVE_BIPS       - reserve ratio in bips (default: 2000 = 20%)
 *   MAX_SUPPLY         - max total supply in token units (default: 1000000)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-module2-sepolia.ts --network sepolia
 */

import hre, { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ─── Pre-flight checks ──────────────────────────────────────────────────────

function checkEnvVars(): void {
  const required = ["PRIVATE_KEY", "SEPOLIA_URL", "ASSET_TOKEN", "BORROWER_ADDRESS"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join("\n  ")}\n\n` +
        "Copy .env.example to .env and fill in the values."
    );
  }
}

async function checkDeployerBalance(deployer: { address: string }): Promise<void> {
  const balance = await ethers.provider.getBalance(deployer.address);
  const balanceEth = ethers.formatEther(balance);
  console.log(`Deployer balance: ${balanceEth} ETH`);

  const minBalance = ethers.parseEther("0.01");
  if (balance < minBalance) {
    throw new Error(
      `Deployer balance too low (${balanceEth} ETH). Need at least 0.01 ETH for deployment gas.\n` +
        `Fund ${deployer.address} on Sepolia before deploying.`
    );
  }
}

// ─── Verification helper ────────────────────────────────────────────────────

async function verifyContract(
  address: string,
  constructorArguments: unknown[],
  contractName?: string
): Promise<void> {
  if (!process.env.ETHERSCAN_API_KEY) {
    console.log(`  [skip] No ETHERSCAN_API_KEY — skipping verification for ${contractName ?? address}`);
    return;
  }

  console.log(`  Verifying ${contractName ?? address}...`);
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
    });
    console.log(`  Verified: ${contractName ?? address}`);
  } catch (err: any) {
    if (err.message?.includes("Already Verified") || err.message?.includes("already verified")) {
      console.log(`  Already verified: ${contractName ?? address}`);
    } else {
      console.warn(`  Verification failed for ${contractName ?? address}: ${err.message}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Pre-flight
  checkEnvVars();

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  if (Number(network.chainId) !== 11155111) {
    throw new Error(
      `Expected Sepolia (chainId 11155111), got chainId ${network.chainId}.\n` +
        "Run with: npx hardhat run scripts/deploy-module2-sepolia.ts --network sepolia"
    );
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deploying Module 2 stack on: Sepolia (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}`);

  await checkDeployerBalance(deployer);

  // ─── Resolve configuration ─────────────────────────────────────────────────

  const feeRecipient = process.env.FEE_RECIPIENT ?? deployer.address;
  const relayerAddress = process.env.RELAYER_ADDRESS ?? deployer.address;
  const attesterAddress = process.env.ATTESTER_ADDRESS ?? deployer.address;
  const assetToken = process.env.ASSET_TOKEN!;
  const borrowerAddress = process.env.BORROWER_ADDRESS!;
  const lenderAddress = process.env.LENDER_ADDRESS;
  const borrowerTier = parseInt(process.env.BORROWER_TIER ?? "1", 10);
  const interestBips = parseInt(process.env.INTEREST_BIPS ?? "500", 10);
  const reserveBips = parseInt(process.env.RESERVE_BIPS ?? "2000", 10);
  const maxSupply = ethers.parseUnits(process.env.MAX_SUPPLY ?? "1000000", 18);

  const marketParams = {
    annualInterestBips: interestBips,
    delinquencyFeeBips: 1000,
    withdrawalBatchDuration: 604800,     // 7 days
    reserveRatioBips: reserveBips,
    delinquencyGracePeriod: 604800,      // 7 days
    protocolFeeBips: 100,                // 1%
    maxDelinquencyPeriod: 2592000,       // 30 days
    maxTotalSupply: maxSupply,
  };

  // ─── STEP 1: Deploy Orchestrator ──────────────────────────────────────────

  console.log("\n[1/7] Deploying Orchestrator...");
  const Orchestrator = await ethers.getContractFactory("Orchestrator");
  const orchestrator = await Orchestrator.deploy(feeRecipient);
  await orchestrator.waitForDeployment();
  const orchestratorAddress = await orchestrator.getAddress();
  console.log(`      Orchestrator: ${orchestratorAddress}`);
  console.log(`      Fee recipient: ${feeRecipient}`);

  // ─── STEP 2: Deploy SanctionsSentinel ────────────────────────────────────

  console.log("\n[2/7] Deploying SanctionsSentinel...");
  const SanctionsSentinel = await ethers.getContractFactory("SanctionsSentinel");
  // Use address(0) for sanctions list on testnet (safe default: always returns false)
  const sanctionsSentinel = await SanctionsSentinel.deploy(ethers.ZeroAddress);
  await sanctionsSentinel.waitForDeployment();
  const sentinelAddress = await sanctionsSentinel.getAddress();
  console.log(`      SanctionsSentinel: ${sentinelAddress}`);
  console.log(`      Sanctions list: address(0) (testnet mock — all addresses pass)`);

  // ─── STEP 3: Deploy PriceFeedAdapter ───────────────────────────────────

  console.log("\n[3/7] Deploying PriceFeedAdapter...");
  const PriceFeedAdapter = await ethers.getContractFactory("PriceFeedAdapter");
  const priceFeedAdapter = await PriceFeedAdapter.deploy();
  await priceFeedAdapter.waitForDeployment();
  const adapterAddress = await priceFeedAdapter.getAddress();
  console.log(`      PriceFeedAdapter: ${adapterAddress}`);

  // Configure Sepolia Chainlink ETH/USD feed
  // Sepolia ETH/USD: 0x694AA1769357215DE4FAC081bf1f309aDC325306
  const SEPOLIA_ETH_USD_FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
  const WETH_PLACEHOLDER = process.env.WETH_ADDRESS ?? ethers.ZeroAddress;
  if (WETH_PLACEHOLDER !== ethers.ZeroAddress) {
    const txFeed = await priceFeedAdapter.setFeed(WETH_PLACEHOLDER, SEPOLIA_ETH_USD_FEED);
    await txFeed.wait();
    console.log(`      ETH/USD feed set: ${SEPOLIA_ETH_USD_FEED}`);
  } else {
    console.log(`      [skip] No WETH_ADDRESS set — configure feeds post-deployment`);
    console.log(`      Sepolia ETH/USD feed: ${SEPOLIA_ETH_USD_FEED}`);
  }

  // Set per-chain staleness threshold
  const chainId = Number(network.chainId);
  let stalenessThreshold = 3600; // default: 1 hour (Ethereum mainnet)
  if (chainId === 11155111) stalenessThreshold = 86400; // Sepolia: 24 hours (generous for testnet)
  else if (chainId === 42161 || chainId === 8453) stalenessThreshold = 120; // L2: 2 minutes

  const txStaleness = await priceFeedAdapter.setStalenessThreshold(stalenessThreshold);
  await txStaleness.wait();
  console.log(`      PriceFeedAdapter staleness threshold set to ${stalenessThreshold}s for chainId ${chainId}`);

  // ─── STEP 4: Deploy TICSBridge ─────────────────────────────────────────

  console.log("\n[4/7] Deploying TICSBridge...");
  const TICSBridge = await ethers.getContractFactory("TICSBridge");
  const ticsBridge = await TICSBridge.deploy(relayerAddress, attesterAddress);
  await ticsBridge.waitForDeployment();
  const ticsBridgeAddress = await ticsBridge.getAddress();
  console.log(`      TICSBridge: ${ticsBridgeAddress}`);
  console.log(`      Relayer: ${relayerAddress}`);
  console.log(`      Attester: ${attesterAddress}`);

  // ─── STEP 4b: Wire up Orchestrator with Sentinel and Adapter ───────────

  console.log("\n      Wiring up Orchestrator...");
  const txSentinel = await orchestrator.setSanctionsSentinel(sentinelAddress);
  await txSentinel.wait();
  console.log(`      orchestrator.setSanctionsSentinel(${sentinelAddress})`);

  const txAdapter = await orchestrator.setPriceFeedAdapter(adapterAddress);
  await txAdapter.wait();
  console.log(`      orchestrator.setPriceFeedAdapter(${adapterAddress})`);

  // ─── STEP 3: Authorize Borrower ──────────────────────────────────────────

  console.log(`\n[5/7] Authorizing borrower (tier ${borrowerTier})...`);
  const tx1 = await orchestrator.authorizeBorrower(borrowerAddress, borrowerTier);
  await tx1.wait();
  console.log(`      Borrower: ${borrowerAddress}`);

  const tierLimits: Record<number, string> = {
    0: "$100,000", 1: "$500,000", 2: "$2,000,000", 3: "$10,000,000"
  };
  console.log(`      Credit limit: ${tierLimits[borrowerTier] ?? "unknown"}`);

  // ─── STEP 4: Create Market ────────────────────────────────────────────────

  console.log("\n[6/7] Creating credit market...");
  const tx2 = await orchestrator.createMarket(borrowerAddress, assetToken, marketParams);
  const receipt = await tx2.wait();

  const marketAddress = await orchestrator.getMarket(borrowerAddress, assetToken);
  console.log(`      CreditMarket: ${marketAddress}`);
  console.log(`      Asset: ${assetToken}`);
  console.log(`      Interest: ${interestBips} bips (${interestBips / 100}% APR)`);
  console.log(`      Reserve: ${reserveBips} bips (${reserveBips / 100}%)`);
  console.log(`      Max supply: ${ethers.formatUnits(maxSupply, 18)}`);
  console.log(`      Gas used: ${receipt?.gasUsed.toString()}`);

  // Register lender if provided
  let lenderRegistered = false;
  if (lenderAddress) {
    console.log("\n      Registering lender...");
    const tx3 = await orchestrator.registerLender(marketAddress, lenderAddress);
    await tx3.wait();
    lenderRegistered = true;
    console.log(`      Lender: ${lenderAddress}`);
  }

  // ─── STEP 5: Verify Contracts ─────────────────────────────────────────────

  console.log("\n[7/7] Verifying contracts on Etherscan...");

  // Wait for Etherscan to index
  console.log("  Waiting 30s for Etherscan indexing...");
  await new Promise((r) => setTimeout(r, 30000));

  await verifyContract(orchestratorAddress, [feeRecipient], "Orchestrator");
  await verifyContract(sentinelAddress, [ethers.ZeroAddress], "SanctionsSentinel");
  await verifyContract(adapterAddress, [], "PriceFeedAdapter");
  await verifyContract(ticsBridgeAddress, [relayerAddress, attesterAddress], "TICSBridge");
  await verifyContract(marketAddress, [], "CreditMarket (proxy via Orchestrator)");

  // ─── Save deployment manifest ─────────────────────────────────────────────

  const deployment = {
    network: "sepolia",
    chainId: 11155111,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      Orchestrator: orchestratorAddress,
      SanctionsSentinel: sentinelAddress,
      PriceFeedAdapter: adapterAddress,
      TICSBridge: ticsBridgeAddress,
      CreditMarket: marketAddress,
    },
    config: {
      feeRecipient,
      borrowerAddress,
      borrowerTier,
      assetToken,
      relayer: relayerAddress,
      attester: attesterAddress,
      marketParams: {
        annualInterestBips: marketParams.annualInterestBips,
        delinquencyFeeBips: marketParams.delinquencyFeeBips,
        withdrawalBatchDuration: marketParams.withdrawalBatchDuration,
        reserveRatioBips: marketParams.reserveRatioBips,
        delinquencyGracePeriod: marketParams.delinquencyGracePeriod,
        protocolFeeBips: marketParams.protocolFeeBips,
        maxDelinquencyPeriod: marketParams.maxDelinquencyPeriod,
        maxTotalSupply: maxSupply.toString(),
      },
      lenderRegistered,
      lenderAddress: lenderAddress ?? null,
    },
  };

  const outDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "module2-sepolia.json");
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log("MODULE 2 SEPOLIA DEPLOYMENT COMPLETE");
  console.log(`${"=".repeat(60)}`);
  console.log(`Orchestrator:       ${orchestratorAddress}`);
  console.log(`SanctionsSentinel:  ${sentinelAddress}`);
  console.log(`PriceFeedAdapter:   ${adapterAddress}`);
  console.log(`TICSBridge:         ${ticsBridgeAddress}`);
  console.log(`CreditMarket:       ${marketAddress}`);
  console.log(`Borrower:        ${borrowerAddress} (tier ${borrowerTier})`);
  console.log(`Asset:           ${assetToken}`);
  console.log(`Lender:          ${lenderAddress ?? "none"}`);
  console.log(`\nEtherscan:`);
  console.log(`  https://sepolia.etherscan.io/address/${orchestratorAddress}`);
  console.log(`  https://sepolia.etherscan.io/address/${sentinelAddress}`);
  console.log(`  https://sepolia.etherscan.io/address/${adapterAddress}`);
  console.log(`  https://sepolia.etherscan.io/address/${ticsBridgeAddress}`);
  console.log(`  https://sepolia.etherscan.io/address/${marketAddress}`);
  console.log(`\nSaved to: deployments/module2-sepolia.json`);

  return deployment;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
