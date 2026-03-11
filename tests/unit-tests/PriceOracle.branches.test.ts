/**
 * PriceOracle.branches.test.ts
 *
 * Targets uncovered branches in PriceOracle.sol to improve coverage:
 * - answeredInRound < roundId (stale round detection)
 * - Downward price deviation circuit breaker trigger
 * - Actual tx calls for getOraclePrice (not staticCall) to register coverage
 * - setSequencerUptimeFeed, setMaxDeviation, transferOwnership, acceptOwnership
 * - getOraclePriceView and getInverseOraclePriceView body lines
 */
import hre from "hardhat";
import { expect } from "chai";
import {
  deployContracts,
  usdcMock,
  btcMock,
  owner,
  lender,
  borrower,
  priceOracle,
  mockAggregator,
  MOCK_BTC_PRICE,
} from "../utils/deployments";

const USDC_DECIMALS = 6;

describe("PriceOracle — branch coverage", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // ── answeredInRound < roundId (stale round) ─────────────────────────────

  describe("Stale round detection (answeredInRound < roundId)", function () {
    it("Should revert StalePrice when answeredInRound < roundId", async function () {
      // Deploy a fresh oracle with tight staleness
      const freshOracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
      await freshOracle.waitForDeployment();

      // Deploy mock aggregator and set answeredInRound to lag behind roundId
      const staleMock = await hre.ethers.deployContract("MockAggregatorV3", [
        8, MOCK_BTC_PRICE,
      ]);
      await staleMock.waitForDeployment();
      // roundId is 1, set answeredInRound to 0 (lagging)
      await staleMock.setAnsweredInRound(0);

      await freshOracle.setFeed(
        await btcMock.getAddress(),
        await staleMock.getAddress(),
        400 * 24 * 3600, // very generous staleness
      );

      const oneBtc = hre.ethers.parseUnits("1", 8);
      await expect(
        freshOracle.getOraclePrice(oneBtc, await btcMock.getAddress(), USDC_DECIMALS)
      ).to.be.revertedWithCustomError(freshOracle, "StalePrice");
    });
  });

  // ── Actual transaction calls for coverage registration ────────────────

  describe("getOraclePrice as actual tx (coverage registration)", function () {
    it("Should execute getOraclePrice and update lastGoodPrice", async function () {
      const btcAddr = await btcMock.getAddress();
      const oneBtc = hre.ethers.parseUnits("1", 8);

      // First call — sets lastGoodPrice
      await priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS);
      expect(await priceOracle.lastGoodPrice(btcAddr)).to.equal(MOCK_BTC_PRICE);

      // Second call with same price — deviation is 0, passes circuit breaker
      await priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS);
      expect(await priceOracle.lastGoodPrice(btcAddr)).to.equal(MOCK_BTC_PRICE);
    });

    it("Should execute getOraclePrice with small price increase", async function () {
      const btcAddr = await btcMock.getAddress();
      const oneBtc = hre.ethers.parseUnits("1", 8);

      // Set baseline
      await priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS);

      // Small 5% increase — within 50% threshold
      const newPrice = 52_500n * 10n ** 8n;
      await mockAggregator.setAnswer(newPrice);

      await priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS);
      expect(await priceOracle.lastGoodPrice(btcAddr)).to.equal(newPrice);
    });

    it("Should execute getOraclePrice with small price decrease", async function () {
      const btcAddr = await btcMock.getAddress();
      const oneBtc = hre.ethers.parseUnits("1", 8);

      // Set baseline
      await priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS);

      // Small 5% decrease
      const newPrice = 47_500n * 10n ** 8n;
      await mockAggregator.setAnswer(newPrice);

      await priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS);
      expect(await priceOracle.lastGoodPrice(btcAddr)).to.equal(newPrice);
    });

    it("Should revert on downward deviation exceeding threshold via actual tx", async function () {
      const btcAddr = await btcMock.getAddress();
      const oneBtc = hre.ethers.parseUnits("1", 8);

      // Set baseline
      await priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS);

      // 60% drop — exceeds 50% threshold
      const crashPrice = 20_000n * 10n ** 8n;
      await mockAggregator.setAnswer(crashPrice);

      await expect(
        priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS)
      ).to.be.revertedWithCustomError(priceOracle, "PriceDeviationTooLarge");
    });

    it("Should revert on upward deviation exceeding threshold via actual tx", async function () {
      const btcAddr = await btcMock.getAddress();
      const oneBtc = hre.ethers.parseUnits("1", 8);

      // Set baseline
      await priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS);

      // 60% spike
      const spikePrice = 80_000n * 10n ** 8n;
      await mockAggregator.setAnswer(spikePrice);

      await expect(
        priceOracle.getOraclePrice(oneBtc, btcAddr, USDC_DECIMALS)
      ).to.be.revertedWithCustomError(priceOracle, "PriceDeviationTooLarge");
    });
  });

  // ── getInverseOraclePrice as actual tx ────────────────────────────────

  describe("getInverseOraclePrice as actual tx", function () {
    it("Should execute getInverseOraclePrice and update lastGoodPrice", async function () {
      const btcAddr = await btcMock.getAddress();
      const usdcAmount = hre.ethers.parseUnits("50000", 6);

      await priceOracle.getInverseOraclePrice(usdcAmount, btcAddr, USDC_DECIMALS);
      expect(await priceOracle.lastGoodPrice(btcAddr)).to.equal(MOCK_BTC_PRICE);
    });
  });

  // ── Admin functions as actual txs ─────────────────────────────────────

  describe("Admin functions (actual txs for coverage)", function () {
    it("setSequencerUptimeFeed should set the feed", async function () {
      const addr = lender.address;
      await priceOracle.setSequencerUptimeFeed(addr);
      expect(await priceOracle.sequencerUptimeFeed()).to.equal(addr);
    });

    it("setMaxDeviation should update maxDeviationBps", async function () {
      await priceOracle.setMaxDeviation(2000);
      expect(await priceOracle.maxDeviationBps()).to.equal(2000);
    });

    it("transferOwnership + acceptOwnership should transfer ownership", async function () {
      await priceOracle.transferOwnership(lender.address);
      expect(await priceOracle.pendingOwner()).to.equal(lender.address);
      expect(await priceOracle.owner()).to.equal(owner.address);

      await priceOracle.connect(lender).acceptOwnership();
      expect(await priceOracle.owner()).to.equal(lender.address);
      expect(await priceOracle.pendingOwner()).to.equal(hre.ethers.ZeroAddress);
    });

    it("transferOwnership should emit OwnershipTransferProposed", async function () {
      await expect(priceOracle.transferOwnership(lender.address))
        .to.emit(priceOracle, "OwnershipTransferProposed")
        .withArgs(owner.address, lender.address);
    });

    it("acceptOwnership should emit OwnershipTransferred", async function () {
      await priceOracle.transferOwnership(lender.address);
      await expect(priceOracle.connect(lender).acceptOwnership())
        .to.emit(priceOracle, "OwnershipTransferred")
        .withArgs(owner.address, lender.address);
    });
  });

  // ── Sequencer checks via actual tx ────────────────────────────────────

  describe("Sequencer checks (actual txs)", function () {
    let sequencerFeed: any;
    let oracleWithSeq: any;

    beforeEach(async function () {
      sequencerFeed = await hre.ethers.deployContract("MockAggregatorV3", [0, 0]);
      await sequencerFeed.waitForDeployment();

      const block = await hre.ethers.provider.getBlock("latest");
      await sequencerFeed.setStartedAt(block!.timestamp - 7200);

      oracleWithSeq = await hre.ethers.deployContract("PriceOracle", [owner.address]);
      await oracleWithSeq.waitForDeployment();
      await oracleWithSeq.setSequencerUptimeFeed(await sequencerFeed.getAddress());
      await oracleWithSeq.setFeed(
        await btcMock.getAddress(),
        await mockAggregator.getAddress(),
        400 * 24 * 3600,
      );
    });

    it("Should succeed via actual tx when sequencer is up", async function () {
      const oneBtc = hre.ethers.parseUnits("1", 8);
      // Actual tx, not staticCall — registers coverage
      await oracleWithSeq.getOraclePrice(oneBtc, await btcMock.getAddress(), USDC_DECIMALS);
      expect(await oracleWithSeq.lastGoodPrice(await btcMock.getAddress())).to.equal(MOCK_BTC_PRICE);
    });

    it("Should revert SequencerDown via actual tx", async function () {
      await sequencerFeed.setAnswer(1);
      const oneBtc = hre.ethers.parseUnits("1", 8);
      await expect(
        oracleWithSeq.getOraclePrice(oneBtc, await btcMock.getAddress(), USDC_DECIMALS)
      ).to.be.revertedWithCustomError(oracleWithSeq, "SequencerDown");
    });

    it("Should revert SequencerFeedStale via actual tx", async function () {
      await sequencerFeed.setUpdatedAt(1000);
      const oneBtc = hre.ethers.parseUnits("1", 8);
      await expect(
        oracleWithSeq.getOraclePrice(oneBtc, await btcMock.getAddress(), USDC_DECIMALS)
      ).to.be.revertedWithCustomError(oracleWithSeq, "SequencerFeedStale");
    });

    it("Should revert GracePeriodNotOver via actual tx", async function () {
      const block = await hre.ethers.provider.getBlock("latest");
      await sequencerFeed.setStartedAt(block!.timestamp);
      const oneBtc = hre.ethers.parseUnits("1", 8);
      await expect(
        oracleWithSeq.getOraclePrice(oneBtc, await btcMock.getAddress(), USDC_DECIMALS)
      ).to.be.revertedWithCustomError(oracleWithSeq, "GracePeriodNotOver");
    });
  });

  // ── setFeed edge cases ────────────────────────────────────────────────

  describe("setFeed edge cases", function () {
    it("Should allow updating an existing feed", async function () {
      // Deploy new mock with different price
      const newMock = await hre.ethers.deployContract("MockAggregatorV3", [
        8, 60_000n * 10n ** 8n,
      ]);
      await newMock.waitForDeployment();

      await priceOracle.setFeed(await btcMock.getAddress(), await newMock.getAddress(), 7200);

      const oneBtc = hre.ethers.parseUnits("1", 8);
      await priceOracle.getOraclePrice(oneBtc, await btcMock.getAddress(), USDC_DECIMALS);
      expect(await priceOracle.lastGoodPrice(await btcMock.getAddress())).to.equal(60_000n * 10n ** 8n);
    });
  });
});
