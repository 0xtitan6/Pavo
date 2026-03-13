import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool createMarket tests", function () {
  async function deployPoolFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    // Deploy mock tokens
    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);

    // Deploy ParthenonPool
    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    // Deploy FixedRateIrm (5% APR)
    const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n); // ~1.585e9
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);

    // Enable IRM and LLTV
    await pool.enableIrm(await irm.getAddress());
    const lltv = ethers.parseUnits("80", 16); // 80% LLTV
    await pool.enableLltv(lltv);

    // Deploy mock oracle (returns 50000 USDC per BTC in ORACLE_PRICE_SCALE format)
    // price = 50000 * 1e(36 + 6 - 8) = 50000 * 1e34
    const MockOracle = await ethers.getContractFactory("MockPoolOracle");
    const oracle = await MockOracle.deploy(50000n * 10n ** 34n);

    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracle.getAddress(),
      irm: await irm.getAddress(),
      lltv: lltv
    };

    return { pool, usdc, wbtc, irm, oracle, owner, user1, user2, marketParams, lltv, ratePerSecond };
  }

  it("Should create a market successfully", async function () {
    const { pool, marketParams } = await loadFixture(deployPoolFixture);

    await expect(pool.createMarket(marketParams))
      .to.emit(pool, "CreateMarket");
  });

  it("Should reject duplicate market creation", async function () {
    const { pool, marketParams } = await loadFixture(deployPoolFixture);

    await pool.createMarket(marketParams);
    await expect(pool.createMarket(marketParams))
      .to.be.revertedWith("market already created");
  });

  it("Should reject market with disabled IRM", async function () {
    const { pool, marketParams, usdc, wbtc, oracle } = await loadFixture(deployPoolFixture);

    const badParams = {
      ...marketParams,
      irm: ethers.ZeroAddress // Not enabled
    };
    await expect(pool.createMarket(badParams))
      .to.be.revertedWith("IRM not enabled");
  });

  it("Should reject market with disabled LLTV", async function () {
    const { pool, marketParams } = await loadFixture(deployPoolFixture);

    const badParams = {
      ...marketParams,
      lltv: ethers.parseUnits("90", 16) // Not enabled
    };
    await expect(pool.createMarket(badParams))
      .to.be.revertedWith("LLTV not enabled");
  });

  it("Should enable IRM only by owner", async function () {
    const { pool, user1 } = await loadFixture(deployPoolFixture);
    await expect(pool.connect(user1).enableIrm(ethers.ZeroAddress))
      .to.be.revertedWith("not owner");
  });

  it("Should enable LLTV only by owner", async function () {
    const { pool, user1 } = await loadFixture(deployPoolFixture);
    await expect(pool.connect(user1).enableLltv(ethers.parseUnits("50", 16)))
      .to.be.revertedWith("not owner");
  });

  it("Should reject LLTV >= 100%", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    await expect(pool.enableLltv(ethers.parseEther("1")))
      .to.be.revertedWith("max LLTV exceeded");
  });

  it("Should reject duplicate IRM enablement", async function () {
    const { pool, irm } = await loadFixture(deployPoolFixture);
    await expect(pool.enableIrm(await irm.getAddress()))
      .to.be.revertedWith("already set");
  });
});
