import hre from "hardhat";

/**
 * Demo: pricing GPU compute collateral with Ornn's Compute Price Index (OCPI).
 *
 * Fetches live index values for all five OCPI GPUs from Ornn's public API,
 * posts each into its own PostedPriceFeed, and runs the full onboarding +
 * valuation flow through AssetRegistry/PriceOracle.
 *
 * Run: npx hardhat run scripts/demo-ornn-oracle.ts
 */

const FEED_DECIMALS = 8; // Chainlink-standard feed decimals

// All five GPUs tracked by OCPI; fallback = Sep 2026 settles (used if API unreachable)
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
    if (body?.success && typeof body.data?.index_value === "number") {
      return { price: body.data.index_value, live: true };
    }
  } catch { /* fall through to fallback */ }
  return { price: fallback, live: false };
}

async function main() {
  const { ethers } = hre;
  const [owner] = await ethers.getSigners();
  const fmt = (v: bigint, d: number) => ethers.formatUnits(v, d);

  // ── 1. Live OCPI values from Ornn (all five in parallel) ──
  const prices = await Promise.all(GPUS.map((g) => fetchOcpiPrice(g.name, g.fallback)));
  console.log("\nOCPI index values" + (prices.every((p) => p.live) ? " (live from api.ornnai.com):" : ":"));
  GPUS.forEach((g, i) => {
    console.log(`  ${g.name.padEnd(10)} $${prices[i].price}/hr${prices[i].live ? "" : " (offline fallback)"}`);
  });

  // ── 2. Shared infra: USDC, AssetRegistry, PriceOracle ──
  const usdc = await ethers.deployContract("ERC20Mock", [
    "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6,
  ]);
  await usdc.waitForDeployment();

  const registry = await ethers.deployContract("AssetRegistry");
  await registry.waitForDeployment();
  await registry.registerAsset(await usdc.getAddress(), "USDC", "", 6);
  await registry.setAssetSupported(await usdc.getAddress(), true);

  const oracle = await ethers.deployContract("PriceOracle", [owner.address]);
  await oracle.waitForDeployment();

  // ── 3. Per GPU: compute-hour token + PostedPriceFeed, registered and fed ──
  const tokens: any[] = [];
  for (const [i, gpu] of GPUS.entries()) {
    const token = await ethers.deployContract("ERC20Mock", [
      `${gpu.name} Compute Hour`, gpu.symbol, owner.address, ethers.parseUnits("100000", 18), 18,
    ]);
    await token.waitForDeployment();

    const feed = await ethers.deployContract("PostedPriceFeed", [
      owner.address, FEED_DECIMALS, `OCPI ${gpu.name} / USD`,
    ]);
    await feed.waitForDeployment();
    await feed.setBounds(ethers.parseUnits("0.1", FEED_DECIMALS), ethers.parseUnits("100", FEED_DECIMALS));
    await feed.postAnswer(ethers.parseUnits(prices[i].price.toFixed(FEED_DECIMALS), FEED_DECIMALS));

    await registry.registerAsset(await token.getAddress(), gpu.symbol, `OCPI-${gpu.name}/USD`, 18);
    await registry.setAssetSupported(await token.getAddress(), true);
    await registry.setPairSupported(await token.getAddress(), await usdc.getAddress(), true);

    // maxStaleness 2h fits the hourly OCPI current-price cadence
    await oracle.setFeed(await token.getAddress(), await feed.getAddress(), 2 * 3600);

    tokens.push({ ...gpu, token, feed });
  }
  console.log(`\nDeployed: USDC, AssetRegistry, PriceOracle + ${GPUS.length} compute tokens with OCPI feeds\n`);

  // ── 4. Valuations through the oracle: 1,000 compute-hours of each ──
  const hours = ethers.parseUnits("1000", 18);
  console.log("ϕ_t(z) — 1,000 compute-hours as collateral:");
  for (const t of tokens) {
    const value = await oracle.getOraclePriceView(hours, await t.token.getAddress(), 6);
    console.log(`  1,000 ${t.symbol.padEnd(6)} →  ${fmt(value, 6).padStart(10)} USDC`);
  }

  // ── 5. Inverse: what does 10,000 USDC buy? ──
  const budget = ethers.parseUnits("10000", 6);
  console.log("\nϕ_t⁻¹(v) — 10,000 USDC buys:");
  for (const t of tokens) {
    const bought = await oracle.getInverseOraclePriceView(budget, await t.token.getAddress(), 6);
    console.log(`  ${Number(fmt(bought, 18)).toFixed(2).padStart(10)} ${t.symbol} hours`);
  }

  // ── 6. Circuit breaker demo on B200: +3% settle passes, +60% spike trips ──
  const b200 = tokens[tokens.length - 1];
  const b200Addr = await b200.token.getAddress();
  const [, currentAnswer] = await b200.feed.latestRoundData();

  await (await oracle.getOraclePrice(hours, b200Addr, 6)).wait(); // seed lastGoodPrice
  const nextSettle = (currentAnswer * 103n) / 100n;
  await b200.feed.postAnswer(nextSettle);
  const valueAfter = await oracle.getOraclePriceView(hours, b200Addr, 6);
  console.log(`\nB200 next settle: $${fmt(nextSettle, FEED_DECIMALS)}/hr (+3%) → 1,000 B200H = ${fmt(valueAfter, 6)} USDC ✓`);

  await b200.feed.postAnswer((currentAnswer * 160n) / 100n);
  try {
    await oracle.getOraclePrice.staticCall(hours, b200Addr, 6);
    console.log("Circuit breaker FAILED to trip (unexpected)");
  } catch {
    console.log("B200 +60% spike:  reverted with PriceDeviationTooLarge — circuit breaker working ✓");
  }

  console.log("\nDemo complete.\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
