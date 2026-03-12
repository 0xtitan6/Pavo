import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool withdraw tests", function () {
  async function deployWithSupply() {
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

    const supplyAmount = ethers.parseUnits("10000", 6);
    await usdc.transfer(supplier.address, supplyAmount);
    await usdc.connect(supplier).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(supplier).supply(marketParams, supplyAmount, 0, supplier.address, "0x");

    return { pool, usdc, wbtc, oracle, owner, supplier, user2, marketParams, supplyAmount };
  }

  it("Should withdraw supplied assets", async function () {
    const { pool, usdc, supplier, marketParams } = await loadFixture(deployWithSupply);

    const withdrawAmount = ethers.parseUnits("5000", 6);
    const balanceBefore = await usdc.balanceOf(supplier.address);

    await pool.connect(supplier).withdraw(marketParams, withdrawAmount, 0, supplier.address, supplier.address);

    const balanceAfter = await usdc.balanceOf(supplier.address);
    expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);
  });

  it("Should withdraw to a different receiver", async function () {
    const { pool, usdc, supplier, user2, marketParams } = await loadFixture(deployWithSupply);

    const withdrawAmount = ethers.parseUnits("1000", 6);
    await pool.connect(supplier).withdraw(marketParams, withdrawAmount, 0, supplier.address, user2.address);

    expect(await usdc.balanceOf(user2.address)).to.equal(withdrawAmount);
  });

  it("Should reject withdrawal by unauthorized user", async function () {
    const { pool, supplier, user2, marketParams } = await loadFixture(deployWithSupply);

    await expect(pool.connect(user2).withdraw(marketParams, 1000, 0, supplier.address, user2.address))
      .to.be.revertedWith("unauthorized");
  });

  it("Should allow authorized withdrawal", async function () {
    const { pool, usdc, supplier, user2, marketParams } = await loadFixture(deployWithSupply);

    // Authorize user2 to manage supplier's positions
    await pool.connect(supplier).setAuthorization(user2.address, true);

    const withdrawAmount = ethers.parseUnits("1000", 6);
    await pool.connect(user2).withdraw(marketParams, withdrawAmount, 0, supplier.address, user2.address);
    expect(await usdc.balanceOf(user2.address)).to.equal(withdrawAmount);
  });

  it("Should reject withdrawal to zero receiver", async function () {
    const { pool, supplier, marketParams } = await loadFixture(deployWithSupply);
    await expect(pool.connect(supplier).withdraw(marketParams, 1000, 0, supplier.address, ethers.ZeroAddress))
      .to.be.revertedWith("zero address");
  });
});
