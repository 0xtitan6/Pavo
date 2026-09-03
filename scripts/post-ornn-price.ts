import hre from "hardhat";
import { PostedPriceFeed__factory } from "../typechain-types";

/**
 * Poster: fetch Ornn's current hourly OCPI values and post them to PostedPriceFeeds.
 *
 * Run shortly after every hour, e.g.:
 *   5 * * * *  cd /path/to/repo && set -a && source .env && set +a && \
 *               npx hardhat run scripts/post-ornn-price.ts --network sepolia
 *
 * Env (use one):
 *   ORNN_FEEDS    comma-separated "GPU name=adapter address" pairs — posts each
 *   ORNN_ADAPTER  single adapter address (with ORNN_GPU, default "B200")
 *   ORNN_MAX_SOURCE_AGE_SECONDS  reject a stale source response (default: 5,400)
 *   ORNN_API_BASE_URL  API base URL (default: https://api.ornnai.com)
 *   ORNN_API_KEY, ORNN_API_KEY_HEADER, ORNN_API_KEY_PREFIX  credentials for
 *      a licensed endpoint, when supplied by Ornn
 *   DRY_RUN       "true" fetches and prints the proposed answers without
 *      sending any transactions
 *
 * A public on-chain feed republishes the index. Obtain the necessary Ornn data
 * licence before using this script outside a private test environment.
 */

const FEED_DECIMALS = 8;
const DEFAULT_MAX_SOURCE_AGE_SECONDS = 90 * 60;
const DEFAULT_ORNN_API_BASE_URL = "https://api.ornnai.com";

function maxSourceAgeSeconds(): number {
  const configured = process.env.ORNN_MAX_SOURCE_AGE_SECONDS;
  if (!configured) return DEFAULT_MAX_SOURCE_AGE_SECONDS;

  const seconds = Number(configured);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("ORNN_MAX_SOURCE_AGE_SECONDS must be a positive integer");
  }
  return seconds;
}

async function fetchOcpiPrice(gpu: string): Promise<{ price: number; updated: string; sourceAgeSeconds: number }> {
  const baseUrl = (process.env.ORNN_API_BASE_URL ?? DEFAULT_ORNN_API_BASE_URL).replace(/\/$/, "");
  const url = `${baseUrl}/api/gpu/${encodeURIComponent(gpu)}`;
  const apiKey = process.env.ORNN_API_KEY?.trim();
  const headers: Record<string, string> = {};
  if (apiKey) {
    const headerName = process.env.ORNN_API_KEY_HEADER?.trim() || "Authorization";
    const prefix = process.env.ORNN_API_KEY_PREFIX ?? "Bearer ";
    headers[headerName] = `${prefix}${apiKey}`;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Ornn API returned ${res.status} for ${gpu}`);
  const body = await res.json();
  if (
    !body?.success ||
    typeof body.data?.index_value !== "number" ||
    body.data.index_value <= 0 ||
    typeof body.data?.last_updated !== "string"
  ) {
    throw new Error(`Unexpected Ornn API response for ${gpu}: ${JSON.stringify(body)}`);
  }

  const updatedAt = Date.parse(body.data.last_updated);
  if (!Number.isFinite(updatedAt)) {
    throw new Error(`Invalid Ornn timestamp for ${gpu}: ${body.data.last_updated}`);
  }

  const sourceAgeSeconds = Math.floor((Date.now() - updatedAt) / 1_000);
  if (sourceAgeSeconds < -60) {
    throw new Error(`Ornn timestamp is unexpectedly in the future for ${gpu}`);
  }
  if (sourceAgeSeconds > maxSourceAgeSeconds()) {
    throw new Error(
      `Ornn source price is ${sourceAgeSeconds}s old for ${gpu}; refusing to republish stale data`,
    );
  }

  return { price: body.data.index_value, updated: body.data.last_updated, sourceAgeSeconds };
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
  const dryRun = process.env.DRY_RUN?.trim().toLowerCase() === "true";

  let failures = 0;
  for (const { gpu, address } of feeds) {
    try {
      const { price, updated, sourceAgeSeconds } = await fetchOcpiPrice(gpu);
      const adapter = PostedPriceFeed__factory.connect(address, poster);
      const answer = ethers.parseUnits(price.toFixed(FEED_DECIMALS), FEED_DECIMALS);

      if (dryRun) {
        console.log(
          `${gpu}: $${price}/GPU-hour (source ${sourceAgeSeconds}s old; updated ${updated}) ` +
          `→ DRY_RUN, would post ${answer} to ${address}`,
        );
        continue;
      }

      const tx = await adapter.postAnswer(answer);
      const receipt = await tx.wait();
      console.log(
        `${gpu}: $${price}/GPU-hour (source ${sourceAgeSeconds}s old; updated ${updated}) ` +
        `→ round ${await adapter.latestRoundId()} (tx ${receipt?.hash})`,
      );
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
