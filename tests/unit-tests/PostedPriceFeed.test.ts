import { expect } from "chai";
import hre from "hardhat";

// OCPI B200 at $6.51/hr with 8 feed decimals
const OCPI_PRICE = hre.ethers.parseUnits("6.51", 8);
const FEED_DECIMALS = 8;
const USDC_DECIMALS = 6;

describe("PostedPriceFeed tests", function () {
  let adapter: any;
  let owner: any;
  let poster: any;
  let stranger: any;

  beforeEach(async function () {
    [owner, poster, stranger] = await hre.ethers.getSigners();
    adapter = await hre.ethers.deployContract("PostedPriceFeed", [
      owner.address, FEED_DECIMALS, "OCPI B200 / USD"
    ]);
    await adapter.waitForDeployment();
  });

  // ── Posting ───────────────────────────────────────────────────────────────

  it("Should let the owner post an answer and expose it via latestRoundData", async function () {
    await adapter.postAnswer(OCPI_PRICE);

    const [roundId, answer, , updatedAt] = await adapter.latestRoundData();
    expect(roundId).to.equal(1);
    expect(answer).to.equal(OCPI_PRICE);
    expect(updatedAt).to.be.greaterThan(0);
  });

  it("Should increment roundId on each post and serve historical rounds", async function () {
    await adapter.postAnswer(OCPI_PRICE);
    await adapter.postAnswer(OCPI_PRICE * 2n);

    expect(await adapter.latestRoundId()).to.equal(2);

    const [, firstAnswer] = await adapter.getRoundData(1);
    const [, secondAnswer] = await adapter.getRoundData(2);
    expect(firstAnswer).to.equal(OCPI_PRICE);
    expect(secondAnswer).to.equal(OCPI_PRICE * 2n);
  });

  it("Should revert postAnswer from an unauthorized address", async function () {
    await expect(
      adapter.connect(stranger).postAnswer(OCPI_PRICE)
    ).to.be.revertedWithCustomError(adapter, "Unauthorized");
  });

  it("Should allow posting from an authorized poster and revert after revocation", async function () {
    await adapter.setPoster(poster.address, true);
    await adapter.connect(poster).postAnswer(OCPI_PRICE);
    expect(await adapter.latestRoundId()).to.equal(1);

    await adapter.setPoster(poster.address, false);
    await expect(
      adapter.connect(poster).postAnswer(OCPI_PRICE)
    ).to.be.revertedWithCustomError(adapter, "Unauthorized");
  });

  it("Should revert on zero or negative answers", async function () {
    await expect(adapter.postAnswer(0)).to.be.revertedWithCustomError(adapter, "InvalidAnswer");
    await expect(adapter.postAnswer(-1)).to.be.revertedWithCustomError(adapter, "InvalidAnswer");
  });

  // ── Bounds ────────────────────────────────────────────────────────────────

  it("Should enforce sanity bounds on posted answers", async function () {
    // Plausible OCPI range: $0.50–$50/hr
    await adapter.setBounds(hre.ethers.parseUnits("0.5", 8), hre.ethers.parseUnits("50", 8));

    await adapter.postAnswer(OCPI_PRICE); // in range

    // Fat-finger: $651 instead of $6.51
    await expect(
      adapter.postAnswer(hre.ethers.parseUnits("651", 8))
    ).to.be.revertedWithCustomError(adapter, "AnswerOutOfBounds");

    await expect(
      adapter.postAnswer(hre.ethers.parseUnits("0.01", 8))
    ).to.be.revertedWithCustomError(adapter, "AnswerOutOfBounds");
  });

  it("Should revert setBounds with max below min", async function () {
    await expect(
      adapter.setBounds(hre.ethers.parseUnits("50", 8), hre.ethers.parseUnits("0.5", 8))
    ).to.be.revertedWithCustomError(adapter, "InvalidBounds");
  });

  it("Should only let the owner set posters and bounds", async function () {
    await expect(
      adapter.connect(stranger).setPoster(stranger.address, true)
    ).to.be.revertedWithCustomError(adapter, "Unauthorized");
    await expect(
      adapter.connect(stranger).setBounds(0, 0)
    ).to.be.revertedWithCustomError(adapter, "Unauthorized");
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it("Should revert latestRoundData before the first post", async function () {
    await expect(adapter.latestRoundData()).to.be.revertedWithCustomError(adapter, "RoundNotFound");
  });

  it("Should revert getRoundData for a nonexistent round", async function () {
    await adapter.postAnswer(OCPI_PRICE);
    await expect(adapter.getRoundData(2)).to.be.revertedWithCustomError(adapter, "RoundNotFound");
  });

  // ── Ownership ─────────────────────────────────────────────────────────────

  it("Should transfer ownership in two steps", async function () {
    await adapter.transferOwnership(poster.address);
    expect(await adapter.owner()).to.equal(owner.address); // not yet

    await adapter.connect(poster).acceptOwnership();
    expect(await adapter.owner()).to.equal(poster.address);
  });

  it("Should revert acceptOwnership from a non-pending owner", async function () {
    await adapter.transferOwnership(poster.address);
    await expect(
      adapter.connect(stranger).acceptOwnership()
    ).to.be.revertedWithCustomError(adapter, "Unauthorized");
  });

  // ── Integration with PriceOracle ──────────────────────────────────────────

  it("Should serve prices to PriceOracle end to end", async function () {
    // GPUH token (18 dec) priced by the adapter, valued in USDC (6 dec)
    const gpuh = await hre.ethers.deployContract("ERC20Mock", [
      "B200 Compute Hour", "GPUH", owner.address, hre.ethers.parseUnits("100000", 18), 18
    ]);
    await gpuh.waitForDeployment();

    const oracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
    await oracle.waitForDeployment();
    await oracle.setFeed(await gpuh.getAddress(), await adapter.getAddress(), 26 * 3600);

    await adapter.postAnswer(OCPI_PRICE);

    // 1,000 GPUH at $6.51/hr = 6,510 USDC
    const value = await oracle.getOraclePriceView(
      hre.ethers.parseUnits("1000", 18), await gpuh.getAddress(), USDC_DECIMALS
    );
    expect(value).to.equal(hre.ethers.parseUnits("6510", 6));
  });

  it("Should trip PriceOracle staleness when no post within maxStaleness", async function () {
    const gpuh = await hre.ethers.deployContract("ERC20Mock", [
      "B200 Compute Hour", "GPUH", owner.address, hre.ethers.parseUnits("100000", 18), 18
    ]);
    await gpuh.waitForDeployment();

    const oracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
    await oracle.waitForDeployment();
    await oracle.setFeed(await gpuh.getAddress(), await adapter.getAddress(), 26 * 3600);

    await adapter.postAnswer(OCPI_PRICE);

    // Miss a settle: advance past 26h without a new post
    await hre.network.provider.send("evm_increaseTime", [27 * 3600]);
    await hre.network.provider.send("evm_mine");

    await expect(
      oracle.getOraclePriceView(hre.ethers.parseUnits("1000", 18), await gpuh.getAddress(), USDC_DECIMALS)
    ).to.be.revertedWithCustomError(oracle, "StalePrice");
  });
});
