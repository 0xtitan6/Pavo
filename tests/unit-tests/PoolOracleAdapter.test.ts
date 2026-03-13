import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("PoolOracleAdapter tests", function () {
  async function deployOracleAdapter() {
    const [owner] = await ethers.getSigners();

    // Deploy mock tokens
    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);

    // Deploy MockAggregatorV3 (BTC/USD, 8 decimals, $50,000)
    const mockAggregator = await ethers.deployContract("MockAggregatorV3", [
      8, 50_000n * 10n ** 8n
    ]);

    // Deploy PriceOracle
    const priceOracle = await ethers.deployContract("PriceOracle", [owner.address]);
    await priceOracle.setFeed(await wbtc.getAddress(), await mockAggregator.getAddress(), 400 * 24 * 3600);

    // Deploy PoolOracleAdapter
    const adapter = await ethers.deployContract("PoolOracleAdapter", [
      await priceOracle.getAddress(),
      await usdc.getAddress(),
      await wbtc.getAddress()
    ]);

    return { adapter, priceOracle, usdc, wbtc, mockAggregator, owner };
  }

  it("Should return price in ORACLE_PRICE_SCALE format", async function () {
    const { adapter } = await loadFixture(deployOracleAdapter);

    const price = await adapter.price();
    // 1 BTC = 50,000 USDC
    // Expected: 50,000 * 1e(36 + 6 - 8) = 50,000 * 1e34
    const expected = 50000n * 10n ** 34n;
    expect(price).to.equal(expected);
  });

  it("Should update price when underlying oracle changes", async function () {
    const { adapter, mockAggregator } = await loadFixture(deployOracleAdapter);

    // Change BTC price to $60,000
    await mockAggregator.setAnswer(60_000n * 10n ** 8n);

    const price = await adapter.price();
    const expected = 60000n * 10n ** 34n;
    expect(price).to.equal(expected);
  });

  it("Should store correct immutables", async function () {
    const { adapter, priceOracle, usdc, wbtc } = await loadFixture(deployOracleAdapter);

    expect(await adapter.oracle()).to.equal(await priceOracle.getAddress());
    expect(await adapter.loanToken()).to.equal(await usdc.getAddress());
    expect(await adapter.collateralToken()).to.equal(await wbtc.getAddress());
    expect(await adapter.loanTokenDecimals()).to.equal(6);
    expect(await adapter.collateralTokenDecimals()).to.equal(8);
  });

  it("Should reject zero oracle address", async function () {
    const { usdc, wbtc } = await loadFixture(deployOracleAdapter);
    await expect(ethers.deployContract("PoolOracleAdapter", [
      ethers.ZeroAddress,
      await usdc.getAddress(),
      await wbtc.getAddress()
    ])).to.be.revertedWith("Zero oracle");
  });

  it("Should reject zero token addresses", async function () {
    const { priceOracle, usdc, wbtc } = await loadFixture(deployOracleAdapter);

    await expect(ethers.deployContract("PoolOracleAdapter", [
      await priceOracle.getAddress(),
      ethers.ZeroAddress,
      await wbtc.getAddress()
    ])).to.be.revertedWith("Zero loan token");

    await expect(ethers.deployContract("PoolOracleAdapter", [
      await priceOracle.getAddress(),
      await usdc.getAddress(),
      ethers.ZeroAddress
    ])).to.be.revertedWith("Zero collateral token");
  });
});
