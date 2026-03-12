import { expect } from "chai";
import { ethers } from "hardhat";
import hre from "hardhat";
import {
  deployContracts,
  usdcMock,
  btcMock,
  lender,
  borrower,
  owner,
  assetRegistry,
} from "../utils/deployments";

describe("AssetRegistry — coverage gaps", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // ── registerAsset validation ──────────────────────────────────────────────

  it("Should reject registerAsset with zero address", async function () {
    await expect(
      assetRegistry.registerAsset(ethers.ZeroAddress, "TEST", "TEST/USD", 18)
    ).to.be.revertedWith("Asset address cannot be zero");
  });

  it("Should reject registering an already-registered asset", async function () {
    await expect(
      assetRegistry.registerAsset(await btcMock.getAddress(), "WBTC2", "BTC/USD2", 8)
    ).to.be.revertedWith("Asset already registered");
  });

  it("Should reject registering with an already-used symbol", async function () {
    // Deploy a new token to avoid "Asset already registered"
    const newToken = await hre.ethers.deployContract("ERC20Mock", [
      "New Token", "NEW", owner.address, 1000n, 8,
    ]);
    await newToken.waitForDeployment();

    // Try to register with symbol "WBTC" which is already taken
    await expect(
      assetRegistry.registerAsset(await newToken.getAddress(), "WBTC", "NEW/USD", 8)
    ).to.be.revertedWith("Symbol already in use");
  });

  it("Should reject registerAsset with wrong decimals", async function () {
    const newToken = await hre.ethers.deployContract("ERC20Mock", [
      "New Token", "NEW", owner.address, 1000n, 18,
    ]);
    await newToken.waitForDeployment();

    await expect(
      assetRegistry.registerAsset(await newToken.getAddress(), "NEW", "NEW/USD", 8) // wrong: token is 18
    ).to.be.revertedWith("Decimals mismatch with ERC20");
  });

  it("Should reject registerAsset from non-owner", async function () {
    const newToken = await hre.ethers.deployContract("ERC20Mock", [
      "New Token", "NEW", owner.address, 1000n, 18,
    ]);
    await newToken.waitForDeployment();

    await expect(
      assetRegistry.connect(borrower).registerAsset(await newToken.getAddress(), "NEW", "", 18)
    ).to.be.revertedWithCustomError(assetRegistry, "OwnableUnauthorizedAccount");
  });

  // ── setAssetSupported ─────────────────────────────────────────────────────

  it("Should reject setAssetSupported for unregistered asset", async function () {
    await expect(
      assetRegistry.setAssetSupported(ethers.ZeroAddress, true)
    ).to.be.revertedWith("Asset not registered");
  });

  it("Should allow disabling a supported asset", async function () {
    await assetRegistry.setAssetSupported(await btcMock.getAddress(), false);
    expect(await assetRegistry.isSupported(await btcMock.getAddress())).to.be.false;
  });

  // ── updateAsset ───────────────────────────────────────────────────────────

  it("Should update asset metadata", async function () {
    await assetRegistry.updateAsset(await btcMock.getAddress(), "WBTC", "BTC/USDT", 8);
    const asset = await assetRegistry.getAssetByAddress(await btcMock.getAddress());
    expect(asset.feedKey).to.equal("BTC/USDT");
  });

  it("Should reject updateAsset for unregistered asset", async function () {
    await expect(
      assetRegistry.updateAsset(ethers.ZeroAddress, "NONE", "", 8)
    ).to.be.revertedWith("Asset not registered");
  });

  it("Should reject updateAsset with wrong decimals", async function () {
    await expect(
      assetRegistry.updateAsset(await btcMock.getAddress(), "WBTC", "BTC/USD", 18) // wrong
    ).to.be.revertedWith("Decimals mismatch with ERC20");
  });

  it("Should reject updateAsset with already-used new symbol", async function () {
    // Try to rename WBTC to "USDC" (already taken)
    await expect(
      assetRegistry.updateAsset(await btcMock.getAddress(), "USDC", "BTC/USD", 8)
    ).to.be.revertedWith("New symbol already in use");
  });

  it("Should allow updateAsset with same symbol (no conflict)", async function () {
    // Update with same symbol — should not trigger "New symbol already in use"
    await assetRegistry.updateAsset(await btcMock.getAddress(), "WBTC", "BTC/EUR", 8);
    const asset = await assetRegistry.getAssetByAddress(await btcMock.getAddress());
    expect(asset.feedKey).to.equal("BTC/EUR");
  });

  it("Should allow updateAsset changing to a fresh symbol", async function () {
    await assetRegistry.updateAsset(await btcMock.getAddress(), "BTC2", "BTC/USD", 8);
    const asset = await assetRegistry.getAssetByAddress(await btcMock.getAddress());
    expect(asset.symbol).to.equal("BTC2");
  });

  it("Should reject updateAsset from non-owner", async function () {
    await expect(
      assetRegistry.connect(borrower).updateAsset(await btcMock.getAddress(), "WBTC", "BTC/USD", 8)
    ).to.be.revertedWithCustomError(assetRegistry, "OwnableUnauthorizedAccount");
  });

  // ── setPairSupported ──────────────────────────────────────────────────────

  it("Should reject setPairSupported with unregistered collateral", async function () {
    await expect(
      assetRegistry.setPairSupported(ethers.ZeroAddress, await usdcMock.getAddress(), true)
    ).to.be.revertedWith("Collateral not registered");
  });

  it("Should reject setPairSupported with unregistered asset", async function () {
    await expect(
      assetRegistry.setPairSupported(await btcMock.getAddress(), ethers.ZeroAddress, true)
    ).to.be.revertedWith("Asset not registered");
  });

  it("Should reject setPairSupported when collateral == asset", async function () {
    await expect(
      assetRegistry.setPairSupported(await btcMock.getAddress(), await btcMock.getAddress(), true)
    ).to.be.revertedWith("Collateral and asset must differ");
  });

  it("Should allow disabling a pair", async function () {
    await assetRegistry.setPairSupported(await btcMock.getAddress(), await usdcMock.getAddress(), false);
    expect(
      await assetRegistry.isValidPair(await btcMock.getAddress(), await usdcMock.getAddress())
    ).to.be.false;
  });

  it("Should reject setPairSupported from non-owner", async function () {
    await expect(
      assetRegistry
        .connect(borrower)
        .setPairSupported(await btcMock.getAddress(), await usdcMock.getAddress(), true)
    ).to.be.revertedWithCustomError(assetRegistry, "OwnableUnauthorizedAccount");
  });

  // ── Query functions ───────────────────────────────────────────────────────

  it("Should revert getAssetByAddress for unregistered asset", async function () {
    await expect(
      assetRegistry.getAssetByAddress(ethers.ZeroAddress)
    ).to.be.revertedWith("Asset not registered");
  });

  it("Should revert getAssetBySymbol for unknown symbol", async function () {
    await expect(
      assetRegistry.getAssetBySymbol("UNKNOWN")
    ).to.be.revertedWith("Asset not found for symbol");
  });

  it("Should return all assets from getAllAssets", async function () {
    const all = await assetRegistry.getAllAssets();
    expect(all.length).to.equal(2); // BTC + USDC
  });

  it("Should return correct asset by symbol", async function () {
    const asset = await assetRegistry.getAssetBySymbol("WBTC");
    expect(asset.decimals).to.equal(8);
  });

  // ── isValidPair: false when asset not supported ───────────────────────────

  it("Should return false for isValidPair when collateral not supported", async function () {
    await assetRegistry.setAssetSupported(await btcMock.getAddress(), false);
    expect(
      await assetRegistry.isValidPair(await btcMock.getAddress(), await usdcMock.getAddress())
    ).to.be.false;
  });

  it("Should return false for isValidPair when asset not supported", async function () {
    await assetRegistry.setAssetSupported(await usdcMock.getAddress(), false);
    expect(
      await assetRegistry.isValidPair(await btcMock.getAddress(), await usdcMock.getAddress())
    ).to.be.false;
  });

  it("Should return false for isValidPair when pair not set", async function () {
    // Register a new token and support it, but don't set pair
    const newToken = await hre.ethers.deployContract("ERC20Mock", [
      "DAI", "DAI", owner.address, 1000n * 10n ** 18n, 18,
    ]);
    await newToken.waitForDeployment();
    await assetRegistry.registerAsset(await newToken.getAddress(), "DAI", "", 18);
    await assetRegistry.setAssetSupported(await newToken.getAddress(), true);

    expect(
      await assetRegistry.isValidPair(await btcMock.getAddress(), await newToken.getAddress())
    ).to.be.false;
  });

  // ── isSupported ───────────────────────────────────────────────────────────

  it("Should return false for isSupported on unregistered address", async function () {
    expect(await assetRegistry.isSupported(ethers.ZeroAddress)).to.be.false;
  });

  // ── Two-step ownership (Ownable2Step) ─────────────────────────────────────

  it("Should support two-step ownership transfer", async function () {
    await assetRegistry.transferOwnership(lender.address);
    // Owner still the same
    expect(await assetRegistry.owner()).to.equal(owner.address);

    await assetRegistry.connect(lender).acceptOwnership();
    expect(await assetRegistry.owner()).to.equal(lender.address);
  });
});
