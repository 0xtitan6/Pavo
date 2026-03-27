/**
 * deploy-module1-sepolia.ts
 *
 * Deploys the Module 1 P2P lending stack to Sepolia testnet:
 *   1. Pre-flight checks (env vars, deployer balance)
 *   2. Deploy AssetRegistry
 *   3. Register assets (WBTC, WETH, USDC, USDT) and enable pairs
 *   4. Deploy PriceOracle
 *   5. Configure Chainlink BTC/USD and ETH/USD feeds
 *   6. Deploy LoanFactory
 *   7. Post-deploy validation (pairs, price reads)
 *   8. Verify all contracts on Etherscan
 *   9. Save deployment manifest to deployments/module1-sepolia.json
 *
 * Required env vars:
 *   PRIVATE_KEY        - deployer private key
 *   SEPOLIA_URL        - Sepolia RPC URL
 *
 * Optional env vars:
 *   WBTC_ADDRESS       - Sepolia WBTC token address (omit to deploy mock)
 *   WETH_ADDRESS       - Sepolia WETH token address (omit to deploy mock)
 *   USDC_ADDRESS       - Sepolia USDC token address (omit to deploy mock)
 *   USDT_ADDRESS       - Sepolia USDT token address (omit to deploy mock)
 *   ETHERSCAN_API_KEY  - Etherscan API key for verification
 *   FEE_RECIPIENT      - protocol fee recipient (default: deployer)
 *   PROTOCOL_FEE_BPS   - protocol fee in basis points (default: 500 = 5%)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-module1-sepolia.ts --network sepolia
 */

import hre, { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ─── Sepolia Chainlink feed addresses ────────────────────────────────────────

const SEPOLIA_BTC_USD_FEED = "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";
const SEPOLIA_ETH_USD_FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
const SEPOLIA_MAX_STALENESS = 86400; // 24 hours — generous for testnet

// ─── Pre-flight checks ──────────────────────────────────────────────────────

function checkEnvVars(): void {
  const required = ["PRIVATE_KEY", "SEPOLIA_URL"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join("\n  ")}\n\n` +
        "Copy .env.example to .env and fill in the values."
    );
  }
}

// ─── Mock token deployment ──────────────────────────────────────────────────

interface TokenAddresses {
  wbtc: string;
  weth: string;
  usdc: string;
  usdt: string;
  mocksDeployed: boolean;
}

async function resolveTokenAddresses(deployer: { address: string }): Promise<TokenAddresses> {
  const wbtc = process.env.WBTC_ADDRESS;
  const weth = process.env.WETH_ADDRESS;
  const usdc = process.env.USDC_ADDRESS;
  const usdt = process.env.USDT_ADDRESS;

  // If all addresses provided, use them directly
  if (wbtc && weth && usdc && usdt) {
    return { wbtc, weth, usdc, usdt, mocksDeployed: false };
  }

  // Deploy mocks for any missing tokens
  console.log("\n[0/7] Deploying mock ERC20 tokens for missing addresses...");
  const ERC20Mock = await ethers.getContractFactory("ERC20Mock");

  let wbtcAddress = wbtc;
  if (!wbtcAddress) {
    const mock = await ERC20Mock.deploy(
      "Wrapped Bitcoin", "WBTC", deployer.address, ethers.parseUnits("100", 8), 8
    );
    await mock.waitForDeployment();
    wbtcAddress = await mock.getAddress();
    console.log(`      Mock WBTC deployed: ${wbtcAddress}`);
  }

  let wethAddress = weth;
  if (!wethAddress) {
    const mock = await ERC20Mock.deploy(
      "Wrapped Ether", "WETH", deployer.address, ethers.parseEther("10000"), 18
    );
    await mock.waitForDeployment();
    wethAddress = await mock.getAddress();
    console.log(`      Mock WETH deployed: ${wethAddress}`);
  }

  let usdcAddress = usdc;
  if (!usdcAddress) {
    const mock = await ERC20Mock.deploy(
      "USD Coin", "USDC", deployer.address, ethers.parseUnits("10000000", 6), 6
    );
    await mock.waitForDeployment();
    usdcAddress = await mock.getAddress();
    console.log(`      Mock USDC deployed: ${usdcAddress}`);
  }

  let usdtAddress = usdt;
  if (!usdtAddress) {
    const mock = await ERC20Mock.deploy(
      "Tether USD", "USDT", deployer.address, ethers.parseUnits("10000000", 6), 6
    );
    await mock.waitForDeployment();
    usdtAddress = await mock.getAddress();
    console.log(`      Mock USDT deployed: ${usdtAddress}`);
  }

  return {
    wbtc: wbtcAddress,
    weth: wethAddress,
    usdc: usdcAddress,
    usdt: usdtAddress,
    mocksDeployed: true,
  };
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
        "Run with: npx hardhat run scripts/deploy-module1-sepolia.ts --network sepolia"
    );
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deploying Module 1 (P2P Lending) on: Sepolia (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}`);

  await checkDeployerBalance(deployer);

  // ─── Resolve configuration ─────────────────────────────────────────────────

  const feeRecipient = process.env.FEE_RECIPIENT ?? deployer.address;
  const protocolFeeBps = parseInt(process.env.PROTOCOL_FEE_BPS ?? "500", 10);
  const tokens = await resolveTokenAddresses(deployer);
  const wbtcAddress = tokens.wbtc;
  const wethAddress = tokens.weth;
  const usdcAddress = tokens.usdc;
  const usdtAddress = tokens.usdt;

  console.log(`\nConfiguration:`);
  console.log(`  WBTC:            ${wbtcAddress}`);
  console.log(`  WETH:            ${wethAddress}`);
  console.log(`  USDC:            ${usdcAddress}`);
  console.log(`  USDT:            ${usdtAddress}`);
  console.log(`  Fee recipient:   ${feeRecipient}`);
  console.log(`  Protocol fee:    ${protocolFeeBps} bps (${protocolFeeBps / 100}%)`);

  // ─── STEP 1: Deploy AssetRegistry ──────────────────────────────────────────

  console.log("\n[1/7] Deploying AssetRegistry...");
  const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
  const registry = await AssetRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`      AssetRegistry: ${registryAddress}`);

  // ─── STEP 2: Register assets and pairs ─────────────────────────────────────

  console.log("\n[2/7] Registering assets...");

  await (await registry.registerAsset(wbtcAddress, "WBTC", "BTC/USD", 8)).wait();
  console.log("      Registered WBTC (8 decimals, BTC/USD feed)");

  await (await registry.registerAsset(wethAddress, "WETH", "ETH/USD", 18)).wait();
  console.log("      Registered WETH (18 decimals, ETH/USD feed)");

  await (await registry.registerAsset(usdcAddress, "USDC", "", 6)).wait();
  console.log("      Registered USDC (6 decimals)");

  await (await registry.registerAsset(usdtAddress, "USDT", "", 6)).wait();
  console.log("      Registered USDT (6 decimals)");

  console.log("\n[3/7] Enabling assets and pairs...");

  await (await registry.setAssetSupported(wbtcAddress, true)).wait();
  await (await registry.setAssetSupported(wethAddress, true)).wait();
  await (await registry.setAssetSupported(usdcAddress, true)).wait();
  await (await registry.setAssetSupported(usdtAddress, true)).wait();
  console.log("      All assets enabled");

  await (await registry.setPairSupported(wbtcAddress, usdcAddress, true)).wait();
  console.log("      Pair enabled: WBTC/USDC");

  await (await registry.setPairSupported(wethAddress, usdcAddress, true)).wait();
  console.log("      Pair enabled: WETH/USDC");

  await (await registry.setPairSupported(wbtcAddress, usdtAddress, true)).wait();
  console.log("      Pair enabled: WBTC/USDT");

  await (await registry.setPairSupported(wethAddress, usdtAddress, true)).wait();
  console.log("      Pair enabled: WETH/USDT");

  // ─── STEP 3: Deploy PriceOracle ────────────────────────────────────────────

  console.log("\n[4/7] Deploying PriceOracle...");
  const PriceOracle = await ethers.getContractFactory("PriceOracle");
  const oracle = await PriceOracle.deploy(deployer.address);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log(`      PriceOracle: ${oracleAddress}`);

  // ─── STEP 4: Configure Chainlink feeds ─────────────────────────────────────

  console.log("\n[5/7] Configuring Chainlink feeds...");

  await (await oracle.setFeed(wbtcAddress, SEPOLIA_BTC_USD_FEED, SEPOLIA_MAX_STALENESS)).wait();
  console.log(`      BTC/USD feed: ${SEPOLIA_BTC_USD_FEED} (maxStaleness: ${SEPOLIA_MAX_STALENESS}s)`);

  await (await oracle.setFeed(wethAddress, SEPOLIA_ETH_USD_FEED, SEPOLIA_MAX_STALENESS)).wait();
  console.log(`      ETH/USD feed: ${SEPOLIA_ETH_USD_FEED} (maxStaleness: ${SEPOLIA_MAX_STALENESS}s)`);

  // ─── STEP 5: Deploy LoanFactory ────────────────────────────────────────────

  console.log("\n[6/7] Deploying LoanFactory...");
  const LoanFactory = await ethers.getContractFactory("LoanFactory");
  const loanFactory = await LoanFactory.deploy(
    oracleAddress,
    registryAddress,
    feeRecipient,
    protocolFeeBps
  );
  await loanFactory.waitForDeployment();
  const loanFactoryAddress = await loanFactory.getAddress();
  console.log(`      LoanFactory: ${loanFactoryAddress}`);
  console.log(`      Fee recipient: ${feeRecipient}`);
  console.log(`      Protocol fee: ${protocolFeeBps} bps`);

  // ─── STEP 6: Post-deploy validation ────────────────────────────────────────

  console.log("\n[7/7] Validating deployment...");

  const pairs = [
    { collateral: wbtcAddress, asset: usdcAddress, label: "WBTC/USDC" },
    { collateral: wethAddress, asset: usdcAddress, label: "WETH/USDC" },
    { collateral: wbtcAddress, asset: usdtAddress, label: "WBTC/USDT" },
    { collateral: wethAddress, asset: usdtAddress, label: "WETH/USDT" },
  ];

  for (const pair of pairs) {
    const valid = await registry.isValidPair(pair.collateral, pair.asset);
    console.log(`      isValidPair(${pair.label}): ${valid}`);
    if (!valid) throw new Error(`Pair validation failed for ${pair.label}`);
  }

  // Test price reads (1 unit of collateral → USDC value)
  const priceChecks = [
    { addr: wbtcAddress, amount: ethers.parseUnits("1", 8), label: "WBTC", decimals: 6 },
    { addr: wethAddress, amount: ethers.parseEther("1"), label: "WETH", decimals: 6 },
  ];

  for (const check of priceChecks) {
    try {
      const price = await oracle.getOraclePriceView(check.amount, check.addr, check.decimals);
      console.log(`      PriceOracle ${check.label} → USDC: ${ethers.formatUnits(price, 6)} USDC`);
    } catch (err: any) {
      console.warn(`      [warn] ${check.label} price read failed (expected on testnet if feed is stale): ${err.message}`);
    }
  }

  // ─── STEP 7: Verify contracts on Etherscan ────────────────────────────────

  console.log("\nVerifying contracts on Etherscan...");
  console.log("  Waiting 30s for Etherscan indexing...");
  await new Promise((r) => setTimeout(r, 30000));

  await verifyContract(registryAddress, [], "AssetRegistry");
  await verifyContract(oracleAddress, [deployer.address], "PriceOracle");
  await verifyContract(loanFactoryAddress, [oracleAddress, registryAddress, feeRecipient, protocolFeeBps], "LoanFactory");

  // ─── Save deployment manifest ─────────────────────────────────────────────

  const deployment = {
    network: "sepolia",
    chainId: 11155111,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      AssetRegistry: registryAddress,
      PriceOracle: oracleAddress,
      LoanFactory: loanFactoryAddress,
      ...(tokens.mocksDeployed ? {
        MockWBTC: wbtcAddress,
        MockWETH: wethAddress,
        MockUSDC: usdcAddress,
        MockUSDT: usdtAddress,
      } : {}),
    },
    config: {
      feeRecipient,
      protocolFeeBps,
      assets: {
        WBTC: wbtcAddress,
        WETH: wethAddress,
        USDC: usdcAddress,
        USDT: usdtAddress,
      },
      pairs: ["WBTC/USDC", "WETH/USDC", "WBTC/USDT", "WETH/USDT"],
      feeds: {
        "BTC/USD": SEPOLIA_BTC_USD_FEED,
        "ETH/USD": SEPOLIA_ETH_USD_FEED,
      },
      maxStaleness: SEPOLIA_MAX_STALENESS,
    },
  };

  const outDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "module1-sepolia.json");
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

  // ─── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log("MODULE 1 SEPOLIA DEPLOYMENT COMPLETE");
  console.log(`${"=".repeat(60)}`);
  console.log(`AssetRegistry:   ${registryAddress}`);
  console.log(`PriceOracle:     ${oracleAddress}`);
  console.log(`LoanFactory:     ${loanFactoryAddress}`);
  console.log(`\nAssets: WBTC, WETH, USDC, USDT`);
  console.log(`Pairs:  WBTC/USDC, WETH/USDC, WBTC/USDT, WETH/USDT`);
  console.log(`Fee:    ${protocolFeeBps} bps (${protocolFeeBps / 100}%)`);
  console.log(`\nEtherscan:`);
  console.log(`  https://sepolia.etherscan.io/address/${registryAddress}`);
  console.log(`  https://sepolia.etherscan.io/address/${oracleAddress}`);
  console.log(`  https://sepolia.etherscan.io/address/${loanFactoryAddress}`);
  console.log(`\nSaved to: deployments/module1-sepolia.json`);

  console.log(`\nNEXT STEPS:`);
  console.log(`  1. Deploy Module 2 (Pool + Optimizer + Adapter):`);
  console.log(`     PRICE_ORACLE=${oracleAddress} LOAN_FACTORY=${loanFactoryAddress} \\`);
  console.log(`       npx hardhat run scripts/deploy-all.ts --network sepolia`);
  console.log(`  2. Or transfer ownership to multisig:`);
  console.log(`     registry.transferOwnership(<multisig>)`);
  console.log(`     oracle.transferOwnership(<multisig>)`);
  console.log(`     loanFactory.transferOwnership(<multisig>)`);

  return deployment;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
