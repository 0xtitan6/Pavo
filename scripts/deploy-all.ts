/**
 * deploy-all.ts
 *
 * Deploys the full Parthenon stack in sequence:
 *   1. ParthenonPool + FixedRateIrm + PoolOracleAdapter + market creation
 *   2. ParthenonOptimizer configured with supply/withdraw queues
 *   3. OptimizerAdapter wired into LoanFactory
 *
 * Saves all addresses to deployments/<network>.json
 *
 * Required env vars (for testnet/mainnet):
 *   PRIVATE_KEY        — deployer private key (must be LoanFactory owner)
 *   SEPOLIA_URL        — RPC URL
 *   PRICE_ORACLE       — deployed PriceOracle address
 *   LOAN_TOKEN         — ERC-20 loan token address
 *   COLLATERAL_TOKEN   — ERC-20 collateral token address
 *   LOAN_FACTORY       — deployed LoanFactory address
 *
 * Optional env vars:
 *   ALLOCATION_CAP     — optimizer allocation cap (default: 0 = unlimited)
 *
 * Local testing (--network hardhat):
 *   No env vars required — mocks are auto-deployed.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-all.ts --network sepolia
 *   npx hardhat run scripts/deploy-all.ts --network hardhat
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const RATE_PER_SECOND = BigInt("1585489599"); // 5% APR per second (WAD)
const LLTV_80 = BigInt("800000000000000000"); // 80% LLTV (WAD)

// ─── Local mock setup ─────────────────────────────────────────────────────────

/**
 * Deploy all required mocks for local hardhat testing.
 * Returns addresses that the main deploy flow needs.
 */
async function deployLocalMocks(deployer: { address: string }) {
  console.log("\n[local] Deploying mocks for hardhat network...");

  // ERC20 tokens
  const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
  const usdc = await ERC20Mock.deploy(
    "USD Coin", "USDC", deployer.address, ethers.parseUnits("1000000", 6), 6
  );
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log(`[local]   USDC (mock): ${usdcAddress}`);

  const weth = await ERC20Mock.deploy(
    "Wrapped Ether", "WETH", deployer.address, ethers.parseEther("1000"), 18
  );
  await weth.waitForDeployment();
  const wethAddress = await weth.getAddress();
  console.log(`[local]   WETH (mock): ${wethAddress}`);

  // Chainlink mock feeds: USDC/USD = $1.00, WETH/USD = $2000.00
  const MockAgg = await ethers.getContractFactory("MockAggregatorV3");
  const usdcFeed = await MockAgg.deploy(8, BigInt("100000000")); // $1.00 (8 decimals)
  await usdcFeed.waitForDeployment();

  const wethFeed = await MockAgg.deploy(8, BigInt("200000000000")); // $2000.00 (8 decimals)
  await wethFeed.waitForDeployment();
  console.log(`[local]   MockAggregatorV3 feeds deployed`);

  // PriceOracle
  const PriceOracle = await ethers.getContractFactory("PriceOracle");
  const oracle = await PriceOracle.deploy(deployer.address);
  await oracle.waitForDeployment();
  const priceOracleAddress = await oracle.getAddress();
  console.log(`[local]   PriceOracle: ${priceOracleAddress}`);

  const maxStaleness = 86400; // 24 hours — generous for local testing
  await (await oracle.setFeed(usdcAddress, await usdcFeed.getAddress(), maxStaleness)).wait();
  await (await oracle.setFeed(wethAddress, await wethFeed.getAddress(), maxStaleness)).wait();
  console.log(`[local]   Feeds configured on PriceOracle`);

  // AssetRegistry
  const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
  const registry = await AssetRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`[local]   AssetRegistry: ${registryAddress}`);

  await (await registry.registerAsset(usdcAddress, "USDC", "USDC/USD", 6)).wait();
  await (await registry.registerAsset(wethAddress, "WETH", "ETH/USD", 18)).wait();
  await (await registry.setAssetSupported(usdcAddress, true)).wait();
  await (await registry.setAssetSupported(wethAddress, true)).wait();
  await (await registry.setPairSupported(wethAddress, usdcAddress, true)).wait();
  console.log(`[local]   Assets registered and pairs whitelisted`);

  // LoanFactory
  const LoanFactory = await ethers.getContractFactory("LoanFactory");
  const loanFactory = await LoanFactory.deploy(
    priceOracleAddress,
    registryAddress,
    deployer.address, // fee recipient
    0                 // 0% protocol fee
  );
  await loanFactory.waitForDeployment();
  const loanFactoryAddress = await loanFactory.getAddress();
  console.log(`[local]   LoanFactory: ${loanFactoryAddress}`);

  return {
    priceOracle: priceOracleAddress,
    loanToken: usdcAddress,
    collateralToken: wethAddress,
    loanFactory: loanFactoryAddress,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const isLocal = networkName === "hardhat";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deploying Parthenon stack on: ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}`);

  let priceOracle = process.env.PRICE_ORACLE;
  let loanToken = process.env.LOAN_TOKEN;
  let collateralToken = process.env.COLLATERAL_TOKEN;
  let loanFactoryAddress = process.env.LOAN_FACTORY;

  if (isLocal && (!priceOracle || !loanToken || !collateralToken || !loanFactoryAddress)) {
    const mocks = await deployLocalMocks(deployer);
    priceOracle = priceOracle ?? mocks.priceOracle;
    loanToken = loanToken ?? mocks.loanToken;
    collateralToken = collateralToken ?? mocks.collateralToken;
    loanFactoryAddress = loanFactoryAddress ?? mocks.loanFactory;
  } else if (!priceOracle || !loanToken || !collateralToken || !loanFactoryAddress) {
    throw new Error(
      "Missing env vars. Required: PRICE_ORACLE, LOAN_TOKEN, COLLATERAL_TOKEN, LOAN_FACTORY"
    );
  }

  const allocationCap = BigInt(process.env.ALLOCATION_CAP ?? "0");

  // ─── STEP 1: Pool stack ───────────────────────────────────────────────────

  console.log("\n[1/6] Deploying ParthenonPool...");
  const ParthenonPool = await ethers.getContractFactory("ParthenonPool");
  const pool = await ParthenonPool.deploy(deployer.address);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`      ParthenonPool: ${poolAddress}`);

  console.log("[2/6] Deploying FixedRateIrm (5% APR)...");
  const FixedRateIrm = await ethers.getContractFactory("FixedRateIrm");
  const irm = await FixedRateIrm.deploy(deployer.address, RATE_PER_SECOND);
  await irm.waitForDeployment();
  const irmAddress = await irm.getAddress();
  console.log(`      FixedRateIrm: ${irmAddress}`);

  console.log("[3/6] Deploying PoolOracleAdapter...");
  const PoolOracleAdapter = await ethers.getContractFactory("PoolOracleAdapter");
  const oracle = await PoolOracleAdapter.deploy(priceOracle, loanToken, collateralToken);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log(`      PoolOracleAdapter: ${oracleAddress}`);

  console.log("[4/6] Enabling IRM + LLTV + creating market...");
  await (await pool.enableIrm(irmAddress)).wait();
  await (await pool.enableLltv(LLTV_80)).wait();

  const marketParams = {
    loanToken,
    collateralToken,
    oracle: oracleAddress,
    irm: irmAddress,
    lltv: LLTV_80,
  };
  await (await pool.createMarket(marketParams)).wait();

  // Compute market ID
  const marketId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [loanToken, collateralToken, oracleAddress, irmAddress, LLTV_80]
    )
  );
  console.log(`      Market created. ID: ${marketId}`);

  // ─── STEP 2: Optimizer ────────────────────────────────────────────────────

  console.log("[5/6] Deploying ParthenonOptimizer...");
  const ParthenonOptimizer = await ethers.getContractFactory("ParthenonOptimizer");
  const optimizer = await ParthenonOptimizer.deploy(
    poolAddress,
    loanToken,
    "Parthenon Optimizer",
    "pOPT",
    deployer.address
  );
  await optimizer.waitForDeployment();
  const optimizerAddress = await optimizer.getAddress();
  console.log(`      ParthenonOptimizer: ${optimizerAddress}`);

  await (await optimizer.setSupplyQueue([marketId])).wait();
  await (await optimizer.setWithdrawQueue([marketId])).wait();
  await (await optimizer.setAllocationCap(marketId, allocationCap)).wait();
  console.log("      Queues configured.");

  // ─── STEP 3: Adapter ──────────────────────────────────────────────────────

  console.log("[6/6] Deploying OptimizerAdapter...");
  const OptimizerAdapter = await ethers.getContractFactory("OptimizerAdapter");
  const adapter = await OptimizerAdapter.deploy(loanFactoryAddress);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`      OptimizerAdapter: ${adapterAddress}`);

  await (await adapter.configureOptimizer(loanToken, optimizerAddress)).wait();
  console.log(`      Optimizer configured for token ${loanToken}`);

  // Wire adapter into LoanFactory if caller is owner
  const loanFactory = await ethers.getContractAt(
    ["function setYieldAdapter(address) external", "function owner() external view returns (address)"],
    loanFactoryAddress
  );

  const loanFactoryOwner: string = await loanFactory.owner();
  let adapterWired = false;
  if (loanFactoryOwner.toLowerCase() === deployer.address.toLowerCase()) {
    await (await loanFactory.setYieldAdapter(adapterAddress)).wait();
    adapterWired = true;
    console.log(`      LoanFactory.yieldAdapter = ${adapterAddress}`);
  } else {
    console.warn(
      `      WARNING: Deployer is not LoanFactory owner (${loanFactoryOwner}). Skipping setYieldAdapter.`
    );
  }

  // ─── Save deployment ──────────────────────────────────────────────────────

  const deployment = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      ParthenonPool: poolAddress,
      FixedRateIrm: irmAddress,
      PoolOracleAdapter: oracleAddress,
      ParthenonOptimizer: optimizerAddress,
      OptimizerAdapter: adapterAddress,
    },
    config: {
      marketId,
      marketParams: {
        loanToken: marketParams.loanToken,
        collateralToken: marketParams.collateralToken,
        oracle: marketParams.oracle,
        irm: marketParams.irm,
        lltv: marketParams.lltv.toString(),
      },
      ratePerSecond: RATE_PER_SECOND.toString(),
      lltv: LLTV_80.toString(),
      allocationCap: allocationCap.toString(),
      loanFactory: loanFactoryAddress,
      priceOracle,
      adapterWired,
      loanFactoryOwner,
    },
  };

  const outDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${networkName}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log("DEPLOYMENT COMPLETE");
  console.log(`${"=".repeat(60)}`);
  console.log(`ParthenonPool:       ${poolAddress}`);
  console.log(`FixedRateIrm:        ${irmAddress}`);
  console.log(`PoolOracleAdapter:   ${oracleAddress}`);
  console.log(`ParthenonOptimizer:  ${optimizerAddress}`);
  console.log(`OptimizerAdapter:    ${adapterAddress}`);
  console.log(`Market ID:           ${marketId}`);
  console.log(`Adapter wired:       ${adapterWired}`);
  console.log(`\nSaved to: deployments/${networkName}.json`);

  if (!adapterWired) {
    console.log("\nACTION REQUIRED (as LoanFactory owner):");
    console.log(`  loanFactory.setYieldAdapter("${adapterAddress}")`);
  }

  return deployment;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
