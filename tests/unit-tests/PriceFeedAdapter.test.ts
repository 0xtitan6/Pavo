import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("PriceFeedAdapter", function () {
  async function deployAdapter() {
    const [owner, nonOwner] = await ethers.getSigners();

    const PriceFeedAdapter = await ethers.getContractFactory("PriceFeedAdapter");
    const adapter = await PriceFeedAdapter.deploy();

    // Deploy mock aggregators for two assets
    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // ETH @ $2000, 8 decimals
    const btcFeed = await MockAggregator.deploy(8, 5000000000000n); // BTC @ $50000, 8 decimals

    const assetETH = ethers.Wallet.createRandom().address;
    const assetBTC = ethers.Wallet.createRandom().address;

    return { adapter, ethFeed, btcFeed, assetETH, assetBTC, owner, nonOwner };
  }

  describe("setFeed", function () {
    it("sets a price feed for an asset", async function () {
      const { adapter, ethFeed, assetETH } = await loadFixture(deployAdapter);

      await adapter.setFeed(assetETH, await ethFeed.getAddress());

      const [price, decimals] = await adapter.getPrice(assetETH);
      expect(price).to.equal(200000000000n);
      expect(decimals).to.equal(8);
    });

    it("emits FeedUpdated event", async function () {
      const { adapter, ethFeed, assetETH } = await loadFixture(deployAdapter);

      await expect(adapter.setFeed(assetETH, await ethFeed.getAddress()))
        .to.emit(adapter, "FeedUpdated")
        .withArgs(assetETH, await ethFeed.getAddress());
    });

    it("only owner can set feed", async function () {
      const { adapter, ethFeed, assetETH, nonOwner } = await loadFixture(deployAdapter);

      await expect(adapter.connect(nonOwner).setFeed(assetETH, await ethFeed.getAddress()))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero asset address", async function () {
      const { adapter, ethFeed } = await loadFixture(deployAdapter);

      await expect(adapter.setFeed(ethers.ZeroAddress, await ethFeed.getAddress()))
        .to.be.revertedWithCustomError(adapter, "ZeroAddress");
    });

    it("reverts on zero feed address", async function () {
      const { adapter, assetETH } = await loadFixture(deployAdapter);

      await expect(adapter.setFeed(assetETH, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(adapter, "ZeroAddress");
    });
  });

  describe("getPrice", function () {
    it("returns correct price and decimals", async function () {
      const { adapter, ethFeed, assetETH } = await loadFixture(deployAdapter);

      await adapter.setFeed(assetETH, await ethFeed.getAddress());

      const [price, decimals] = await adapter.getPrice(assetETH);
      expect(price).to.equal(200000000000n); // $2000 with 8 decimals
      expect(decimals).to.equal(8);
    });

    it("reverts on zero price", async function () {
      const { adapter, assetETH } = await loadFixture(deployAdapter);

      const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
      const zeroFeed = await MockAggregator.deploy(8, 0);

      await adapter.setFeed(assetETH, await zeroFeed.getAddress());

      await expect(adapter.getPrice(assetETH))
        .to.be.revertedWithCustomError(adapter, "InvalidPrice");
    });

    it("reverts on negative price", async function () {
      const { adapter, assetETH } = await loadFixture(deployAdapter);

      const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
      const negativeFeed = await MockAggregator.deploy(8, -100);

      await adapter.setFeed(assetETH, await negativeFeed.getAddress());

      await expect(adapter.getPrice(assetETH))
        .to.be.revertedWithCustomError(adapter, "InvalidPrice");
    });

    it("reverts when feed not set", async function () {
      const { adapter, assetETH } = await loadFixture(deployAdapter);

      await expect(adapter.getPrice(assetETH))
        .to.be.revertedWithCustomError(adapter, "FeedNotSet");
    });

    it("supports multiple assets with different feeds", async function () {
      const { adapter, ethFeed, btcFeed, assetETH, assetBTC } = await loadFixture(deployAdapter);

      await adapter.setFeed(assetETH, await ethFeed.getAddress());
      await adapter.setFeed(assetBTC, await btcFeed.getAddress());

      const [ethPrice] = await adapter.getPrice(assetETH);
      const [btcPrice] = await adapter.getPrice(assetBTC);

      expect(ethPrice).to.equal(200000000000n);  // $2000
      expect(btcPrice).to.equal(5000000000000n);  // $50000
    });
  });

  describe("isStale", function () {
    it("returns false for fresh price", async function () {
      const { adapter, ethFeed, assetETH } = await loadFixture(deployAdapter);

      await adapter.setFeed(assetETH, await ethFeed.getAddress());

      expect(await adapter.isStale(assetETH)).to.be.false;
    });

    it("returns true for stale price", async function () {
      const { adapter, ethFeed, assetETH } = await loadFixture(deployAdapter);

      await adapter.setFeed(assetETH, await ethFeed.getAddress());

      // Advance time beyond default staleness threshold (3600 seconds)
      await time.increase(3601);

      expect(await adapter.isStale(assetETH)).to.be.true;
    });

    it("reverts when feed not set", async function () {
      const { adapter, assetETH } = await loadFixture(deployAdapter);

      await expect(adapter.isStale(assetETH))
        .to.be.revertedWithCustomError(adapter, "FeedNotSet");
    });
  });

  describe("setStalenessThreshold", function () {
    it("updates the staleness threshold", async function () {
      const { adapter } = await loadFixture(deployAdapter);

      await adapter.setStalenessThreshold(7200);
      expect(await adapter.stalenessThreshold()).to.equal(7200);
    });

    it("emits StalenessThresholdUpdated event", async function () {
      const { adapter } = await loadFixture(deployAdapter);

      await expect(adapter.setStalenessThreshold(7200))
        .to.emit(adapter, "StalenessThresholdUpdated")
        .withArgs(7200);
    });

    it("only owner can set threshold", async function () {
      const { adapter, nonOwner } = await loadFixture(deployAdapter);

      await expect(adapter.connect(nonOwner).setStalenessThreshold(7200))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("respects custom staleness threshold", async function () {
      const { adapter, ethFeed, assetETH } = await loadFixture(deployAdapter);

      await adapter.setFeed(assetETH, await ethFeed.getAddress());
      await adapter.setStalenessThreshold(100); // 100 seconds

      // Advance 101 seconds — should be stale with custom threshold
      await time.increase(101);
      expect(await adapter.isStale(assetETH)).to.be.true;
    });
  });

  describe("default values", function () {
    it("has default staleness threshold of 3600 seconds", async function () {
      const { adapter } = await loadFixture(deployAdapter);
      expect(await adapter.stalenessThreshold()).to.equal(3600);
    });
  });
});
