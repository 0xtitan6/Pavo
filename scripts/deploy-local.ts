import fs from "fs";
import path from "path";
import hre from "hardhat";

/**
 * Local POC deployment: full protocol stack + GPU compute-hour collateral.
 *
 * Deploys AssetRegistry, PriceOracle, LoanFactory, a mock USDC, a mock WBTC
 * with a mock Chainlink feed, and one compute-hour token + PostedPriceFeed per
 * OCPI GPU (seeded from Ornn's live current-price endpoint, with offline
 * fallbacks). Mints test balances to the first three Hardhat accounts and
 * writes a contract-address manifest the frontend can load.
 *
 * Run against a local node:
 *   npx hardhat node                                     # terminal 1
 *   npx hardhat run scripts/deploy-local.ts --network localhost
 *
 * Manifest: deployments/localhost.json (same shape as the frontend's
 * src/deployments/*.ts deployment objects).
 */

const FEED_DECIMALS = 8; // Chainlink-standard feed decimals
const GPU_MAX_STALENESS = 2 * 3600; // hourly OCPI cadence + missed-post headroom
const BTC_MAX_STALENESS = 24 * 3600; // mock feed; generous for local use

// All five GPUs tracked by OCPI; fallback = Sep 2026 values (used if API unreachable)
const GPUS = [
  { name: "H100 SXM",  symbol: "H100H",  fallback: 2.65 },
  { name: "H200",      symbol: "H200H",  fallback: 4.19 },
  { name: "A100 SXM4", symbol: "A100H",  fallback: 0.99 },
  { name: "RTX 5090",  symbol: "R5090H", fallback: 0.63 },
  { name: "B200",      symbol: "B200H",  fallback: 6.51 },
];

async function fetchOcpiPrice(gpu: string, fallback: number): Promise<{ price: number; live: boolean }> {
  try {
    const url = `https://api.ornnai.com/api/gpu/${encodeURIComponent(gpu)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    if (body?.success && typeof body.data?.index_value === "number" && body.data.index_value > 0) {
      return { price: body.data.index_value, live: true };
    }
  } catch { /* fall through to fallback */ }
  return { price: fallback, live: false };
}

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const [deployer] = signers;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`Deploying to ${network.name} (chainId ${chainId}) as ${deployer.address}\n`);

  // ── 1. Shared infra ──
  const registry = await ethers.deployContract("AssetRegistry");
  await registry.waitForDeployment();

  const oracle = await ethers.deployContract("PriceOracle", [deployer.address]);
  await oracle.waitForDeployment();

  const factory = await ethers.deployContract("LoanFactory", [
    await oracle.getAddress(), await registry.getAddress(), ethers.ZeroAddress, 0,
  ]);
  await factory.waitForDeployment();

  // ── 2. USDC (loan asset) ──
  const usdc = await ethers.deployContract("ERC20Mock", [
    "USD Coin", "USDC", deployer.address, ethers.parseUnits("10000000", 6), 6,
  ]);
  await usdc.waitForDeployment();
  await registry.registerAsset(await usdc.getAddress(), "USDC", "", 6);
  await registry.setAssetSupported(await usdc.getAddress(), true);

  // ── 3. WBTC + mock Chainlink feed (majors collateral) ──
  const wbtc = await ethers.deployContract("ERC20Mock", [
    "Wrapped BTC", "WBTC", deployer.address, ethers.parseUnits("1000", 8), 8,
  ]);
  await wbtc.waitForDeployment();

  const btcFeed = await ethers.deployContract("MockAggregatorV3", [
    FEED_DECIMALS, ethers.parseUnits("109000", FEED_DECIMALS),
  ]);
  await btcFeed.waitForDeployment();

  await registry.registerAsset(await wbtc.getAddress(), "WBTC", "BTC/USD", 8);
  await registry.setAssetSupported(await wbtc.getAddress(), true);
  await registry.setPairSupported(await wbtc.getAddress(), await usdc.getAddress(), true);
  await oracle.setFeed(await wbtc.getAddress(), await btcFeed.getAddress(), BTC_MAX_STALENESS);

  // ── 4. Per GPU: compute-hour token + PostedPriceFeed, registered and fed ──
  const prices = await Promise.all(GPUS.map((g) => fetchOcpiPrice(g.name, g.fallback)));
  const gpuDeployments: { name: string; symbol: string; token: string; feed: string; price: number; live: boolean }[] = [];

  for (const [i, gpu] of GPUS.entries()) {
    const token = await ethers.deployContract("ERC20Mock", [
      `${gpu.name} Compute Hour`, gpu.symbol, deployer.address, ethers.parseUnits("1000000", 18), 18,
    ]);
    await token.waitForDeployment();

    const feed = await ethers.deployContract("PostedPriceFeed", [
      deployer.address, FEED_DECIMALS, `OCPI ${gpu.name} / USD`,
    ]);
    await feed.waitForDeployment();
    await feed.setBounds(ethers.parseUnits("0.1", FEED_DECIMALS), ethers.parseUnits("100", FEED_DECIMALS));
    await feed.postAnswer(ethers.parseUnits(prices[i].price.toFixed(FEED_DECIMALS), FEED_DECIMALS));

    await registry.registerAsset(await token.getAddress(), gpu.symbol, `OCPI-${gpu.name}/USD`, 18);
    await registry.setAssetSupported(await token.getAddress(), true);
    await registry.setPairSupported(await token.getAddress(), await usdc.getAddress(), true);
    await oracle.setFeed(await token.getAddress(), await feed.getAddress(), GPU_MAX_STALENESS);

    gpuDeployments.push({
      name: gpu.name,
      symbol: gpu.symbol,
      token: await token.getAddress(),
      feed: await feed.getAddress(),
      price: prices[i].price,
      live: prices[i].live,
    });
    console.log(`${gpu.name.padEnd(10)} $${prices[i].price}/hr${prices[i].live ? "" : " (offline fallback)"}  token ${await token.getAddress()}`);
  }

  // ── 5. Test balances for the first three Hardhat accounts ──
  for (const signer of signers.slice(0, 3)) {
    if (signer.address !== deployer.address) {
      await usdc.mint(signer.address, ethers.parseUnits("100000", 6));
      await wbtc.mint(signer.address, ethers.parseUnits("10", 8));
      for (const g of gpuDeployments) {
        const token = await ethers.getContractAt("ERC20Mock", g.token);
        await token.mint(signer.address, ethers.parseUnits("10000", 18));
      }
    }
  }

  // ── 6. Manifest ──
  const manifest = {
    network: network.name,
    chainId,
    contracts: {
      LoanFactory: await factory.getAddress(),
      PriceOracle: await oracle.getAddress(),
      AssetRegistry: await registry.getAddress(),
      MockUSDC: await usdc.getAddress(),
      MockWBTC: await wbtc.getAddress(),
      BtcUsdFeed: await btcFeed.getAddress(),
      ...Object.fromEntries(gpuDeployments.map((g) => [`${g.symbol}Token`, g.token])),
      ...Object.fromEntries(gpuDeployments.map((g) => [`${g.symbol}Feed`, g.feed])),
    },
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    pairs: ["WBTC/USDC", ...gpuDeployments.map((g) => `${g.symbol}/USDC`)],
    gpus: gpuDeployments,
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\nDeployed LoanFactory ${manifest.contracts.LoanFactory}`);
  console.log(`Manifest written to ${path.relative(process.cwd(), outFile)}`);
  console.log(`\nHourly poster env for these feeds:\nORNN_FEEDS="${gpuDeployments.map((g) => `${g.name}=${g.feed}`).join(",")}"`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
