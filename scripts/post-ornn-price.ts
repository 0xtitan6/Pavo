import hre from "hardhat";

/**
 * Poster: fetch the latest OCPI values from Ornn and post them to OrnnFeedAdapters.
 *
 * OCPI settles daily by 20:00 UTC — run this on a cron shortly after, e.g.:
 *   5 20 * * *  cd /path/to/repo && ORNN_FEEDS="B200=0xabc...,H100 SXM=0xdef..." \
 *               npx hardhat run scripts/post-ornn-price.ts --network sepolia
 *
 * Env (use one):
 *   ORNN_FEEDS    comma-separated "GPU name=adapter address" pairs — posts each
 *   ORNN_ADAPTER  single adapter address (with ORNN_GPU, default "B200")
 */

const FEED_DECIMALS = 8;

async function fetchOcpiPrice(gpu: string): Promise<{ price: number; updated: string }> {
  const url = `https://api.ornnai.com/api/gpu/${encodeURIComponent(gpu)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Ornn API returned ${res.status} for ${gpu}`);
  const body = await res.json();
  if (!body?.success || typeof body.data?.index_value !== "number" || body.data.index_value <= 0) {
    throw new Error(`Unexpected Ornn API response for ${gpu}: ${JSON.stringify(body)}`);
  }
  return { price: body.data.index_value, updated: body.data.last_updated };
}

function parseFeeds(): { gpu: string; address: string }[] {
  if (process.env.ORNN_FEEDS) {
    return process.env.ORNN_FEEDS.split(",").map((pair) => {
      const idx = pair.lastIndexOf("=");
      if (idx < 1) throw new Error(`Bad ORNN_FEEDS entry: "${pair}" (want "GPU name=0xaddress")`);
      return { gpu: pair.slice(0, idx).trim(), address: pair.slice(idx + 1).trim() };
    });
  }
  if (process.env.ORNN_ADAPTER) {
    return [{ gpu: process.env.ORNN_GPU ?? "B200", address: process.env.ORNN_ADAPTER }];
  }
  throw new Error("Set ORNN_FEEDS (GPU=address pairs) or ORNN_ADAPTER");
}

async function main() {
  const { ethers } = hre;
  const [poster] = await ethers.getSigners();
  const feeds = parseFeeds();

  let failures = 0;
  for (const { gpu, address } of feeds) {
    try {
      const { price, updated } = await fetchOcpiPrice(gpu);
      const adapter = await ethers.getContractAt("OrnnFeedAdapter", address);
      const answer = ethers.parseUnits(price.toFixed(FEED_DECIMALS), FEED_DECIMALS);

      const tx = await adapter.connect(poster).postAnswer(answer);
      const receipt = await tx.wait();
      console.log(`${gpu}: $${price}/hr (updated ${updated}) → round ${await adapter.latestRoundId()} (tx ${receipt?.hash})`);
    } catch (err) {
      failures++;
      console.error(`${gpu}: FAILED — ${err instanceof Error ? err.message : err}`);
    }
  }

  if (failures > 0) throw new Error(`${failures}/${feeds.length} feed posts failed`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
