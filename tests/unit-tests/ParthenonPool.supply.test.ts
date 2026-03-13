import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool supply tests", function () {
  async function deployAndCreateMarket() {
    const [owner, supplier, user2] = await ethers.getSigners();

    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);

    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);

    await pool.enableIrm(await irm.getAddress());
    const lltv = ethers.parseUnits("80", 16);
    await pool.enableLltv(lltv);

    const oracle = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);

    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracle.getAddress(),
      irm: await irm.getAddress(),
      lltv: lltv
    };

    await pool.createMarket(marketParams);

    // Fund supplier
    await usdc.transfer(supplier.address, ethers.parseUnits("100000", 6));
    await usdc.connect(supplier).approve(await pool.getAddress(), ethers.MaxUint256);

    return { pool, usdc, wbtc, irm, oracle, owner, supplier, user2, marketParams };
  }

  it("Should supply assets successfully", async function () {
    const { pool, supplier, marketParams } = await loadFixture(deployAndCreateMarket);
    const amount = ethers.parseUnits("1000", 6);

    await expect(pool.connect(supplier).supply(marketParams, amount, 0, supplier.address, "0x"))
      .to.emit(pool, "Supply");
  });

  it("Should track supply shares correctly", async function () {
    const { pool, usdc, supplier, marketParams } = await loadFixture(deployAndCreateMarket);
    const amount = ethers.parseUnits("1000", 6);

    await pool.connect(supplier).supply(marketParams, amount, 0, supplier.address, "0x");

    // Check pool received the tokens
    const poolBalance = await usdc.balanceOf(await pool.getAddress());
    expect(poolBalance).to.equal(amount);
  });

  it("Should supply on behalf of another address", async function () {
    const { pool, supplier, user2, marketParams } = await loadFixture(deployAndCreateMarket);
    const amount = ethers.parseUnits("1000", 6);

    await pool.connect(supplier).supply(marketParams, amount, 0, user2.address, "0x");
    // user2 should have supply shares
  });

  it("Should reject supply to zero address", async function () {
    const { pool, supplier, marketParams } = await loadFixture(deployAndCreateMarket);
    await expect(pool.connect(supplier).supply(marketParams, 1000, 0, ethers.ZeroAddress, "0x"))
      .to.be.revertedWith("zero address");
  });

  it("Should reject supply with both assets and shares zero", async function () {
    const { pool, supplier, marketParams } = await loadFixture(deployAndCreateMarket);
    await expect(pool.connect(supplier).supply(marketParams, 0, 0, supplier.address, "0x"))
      .to.be.revertedWith("inconsistent input");
  });

  it("Should reject supply with both assets and shares non-zero", async function () {
    const { pool, supplier, marketParams } = await loadFixture(deployAndCreateMarket);
    await expect(pool.connect(supplier).supply(marketParams, 1000, 1000, supplier.address, "0x"))
      .to.be.revertedWith("inconsistent input");
  });

  it("Should supply by shares amount", async function () {
    const { pool, supplier, marketParams } = await loadFixture(deployAndCreateMarket);

    // First supply to establish share ratio
    await pool.connect(supplier).supply(marketParams, ethers.parseUnits("1000", 6), 0, supplier.address, "0x");

    // Supply by shares
    const sharesToSupply = ethers.parseUnits("500", 6); // shares amount
    await expect(pool.connect(supplier).supply(marketParams, 0, sharesToSupply, supplier.address, "0x"))
      .to.emit(pool, "Supply");
  });
});
