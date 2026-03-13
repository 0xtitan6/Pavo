import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonOptimizer multi-strategy tests", function () {
  async function deployTwoMarketFixture() {
    const [owner, depositor] = await ethers.getSigners();

    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);
    const weth = await ethers.deployContract("ERC20Mock", [
      "Wrapped Ether", "WETH", owner.address, ethers.parseUnits("1000", 18), 18
    ]);

    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
    const irm1 = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);
    const irm2Rate = ethers.parseUnits("8", 16) / (365n * 86400n);
    const irm2 = await ethers.deployContract("FixedRateIrm", [owner.address, irm2Rate]);

    await pool.enableIrm(await irm1.getAddress());
    await pool.enableIrm(await irm2.getAddress());
    const lltv = ethers.parseUnits("80", 16);
    await pool.enableLltv(lltv);

    const oracleBtc = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);
    const oracleEth = await ethers.deployContract("MockPoolOracle", [3000n * 10n ** 34n]);

    const marketParams1 = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracleBtc.getAddress(),
      irm: await irm1.getAddress(),
      lltv: lltv
    };
    await pool.createMarket(marketParams1);

    const marketParams2 = {
      loanToken: await usdc.getAddress(),
      collateralToken: await weth.getAddress(),
      oracle: await oracleEth.getAddress(),
      irm: await irm2.getAddress(),
      lltv: lltv
    };
    await pool.createMarket(marketParams2);

    const id1 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams1.loanToken, marketParams1.collateralToken, marketParams1.oracle, marketParams1.irm, marketParams1.lltv]
    ));
    const id2 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams2.loanToken, marketParams2.collateralToken, marketParams2.oracle, marketParams2.irm, marketParams2.lltv]
    ));

    const optimizer = await ethers.deployContract("ParthenonOptimizer", [
      await pool.getAddress(),
      await usdc.getAddress(),
      "ParthenonOptimizer USDC",
      "poUSDC",
      owner.address
    ]);

    await usdc.transfer(depositor.address, ethers.parseUnits("200000", 6));
    await usdc.connect(depositor).approve(await optimizer.getAddress(), ethers.MaxUint256);

    return { pool, optimizer, usdc, wbtc, weth, owner, depositor, id1, id2, marketParams1, marketParams2 };
  }

  it("Should allocate deposit across two markets in supply queue order", async function () {
    const { pool, optimizer, depositor, id1, id2 } = await loadFixture(deployTwoMarketFixture);

    // Both markets in supply queue
    await optimizer.setSupplyQueue([id1, id2]);
    await optimizer.setWithdrawQueue([id1, id2]);

    const depositAmount = ethers.parseUnits("10000", 6);
    await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

    // All should go to market 1 (first in queue, no cap)
    const pos1 = await pool.position(id1, await optimizer.getAddress());
    const pos2 = await pool.position(id2, await optimizer.getAddress());
    expect(pos1.supplyShares).to.be.gt(0);
    expect(pos2.supplyShares).to.equal(0); // market 2 never reached
  });

  it("Should spill to market 2 when market 1 is at cap", async function () {
    const { pool, optimizer, depositor, id1, id2 } = await loadFixture(deployTwoMarketFixture);

    await optimizer.setSupplyQueue([id1, id2]);
    await optimizer.setWithdrawQueue([id1, id2]);

    const cap1 = ethers.parseUnits("3000", 6);
    await optimizer.setAllocationCap(id1, cap1);

    const depositAmount = ethers.parseUnits("5000", 6);
    await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

    const pos1 = await pool.position(id1, await optimizer.getAddress());
    const pos2 = await pool.position(id2, await optimizer.getAddress());

    // Market 1 capped at 3000; rest (2000) should go to market 2
    expect(pos1.supplyShares).to.be.gt(0);
    expect(pos2.supplyShares).to.be.gt(0);
  });

  it("Should read totalAssets correctly across both markets", async function () {
    const { optimizer, depositor, id1, id2 } = await loadFixture(deployTwoMarketFixture);

    await optimizer.setSupplyQueue([id1, id2]);
    await optimizer.setWithdrawQueue([id1, id2]);

    const cap1 = ethers.parseUnits("4000", 6);
    await optimizer.setAllocationCap(id1, cap1);

    const depositAmount = ethers.parseUnits("7000", 6);
    await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

    const total = await optimizer.totalAssets();
    // Should account for both markets
    expect(total).to.be.gte(depositAmount - 10n);
    expect(total).to.be.lte(depositAmount + 10n);
  });

  it("Should withdraw from multiple markets in withdraw queue order", async function () {
    const { optimizer, usdc, depositor, id1, id2 } = await loadFixture(deployTwoMarketFixture);

    await optimizer.setSupplyQueue([id1, id2]);
    await optimizer.setWithdrawQueue([id1, id2]);

    const cap1 = ethers.parseUnits("3000", 6);
    await optimizer.setAllocationCap(id1, cap1);

    // Deposit 5000 → 3000 in market1, 2000 in market2
    await optimizer.connect(depositor).deposit(ethers.parseUnits("5000", 6), depositor.address);

    const balBefore = await usdc.balanceOf(depositor.address);

    // Redeem all shares
    const shares = await optimizer.balanceOf(depositor.address);
    await optimizer.connect(depositor).redeem(shares, depositor.address, depositor.address);

    const balAfter = await usdc.balanceOf(depositor.address);
    // Should have recovered close to original 5000
    expect(balAfter - balBefore).to.be.gte(ethers.parseUnits("4999", 6));
  });

  it("Should reflect correct supplyQueueLength and withdrawQueueLength", async function () {
    const { optimizer, id1, id2 } = await loadFixture(deployTwoMarketFixture);

    await optimizer.setSupplyQueue([id1, id2]);
    await optimizer.setWithdrawQueue([id1]);

    expect(await optimizer.supplyQueueLength()).to.equal(2);
    expect(await optimizer.withdrawQueueLength()).to.equal(1);
    expect(await optimizer.supplyQueue(0)).to.equal(id1);
    expect(await optimizer.supplyQueue(1)).to.equal(id2);
    expect(await optimizer.withdrawQueue(0)).to.equal(id1);
  });

  it("Should allow multiple depositors and correctly attribute shares", async function () {
    const { optimizer, usdc, owner, depositor, id1, id2 } = await loadFixture(deployTwoMarketFixture);

    await optimizer.setSupplyQueue([id1, id2]);
    await optimizer.setWithdrawQueue([id1, id2]);

    const cap1 = ethers.parseUnits("3000", 6);
    await optimizer.setAllocationCap(id1, cap1);

    await usdc.approve(await optimizer.getAddress(), ethers.MaxUint256);

    // Owner deposits 5000, depositor deposits 5000
    await optimizer.connect(owner).deposit(ethers.parseUnits("5000", 6), owner.address);
    await optimizer.connect(depositor).deposit(ethers.parseUnits("5000", 6), depositor.address);

    const sharesOwner = await optimizer.balanceOf(owner.address);
    const sharesDepositor = await optimizer.balanceOf(depositor.address);

    expect(sharesOwner).to.be.gt(0);
    expect(sharesDepositor).to.be.gt(0);

    const total = await optimizer.totalAssets();
    expect(total).to.be.gte(ethers.parseUnits("9999", 6));
  });
});
