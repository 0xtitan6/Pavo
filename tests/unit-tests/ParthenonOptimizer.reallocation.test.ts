import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonOptimizer reallocation tests", function () {
  async function deployWithTwoMarkets() {
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
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);
    const irm2Rate = ethers.parseUnits("8", 16) / (365n * 86400n);
    const irm2 = await ethers.deployContract("FixedRateIrm", [owner.address, irm2Rate]);

    await pool.enableIrm(await irm.getAddress());
    await pool.enableIrm(await irm2.getAddress());
    const lltv = ethers.parseUnits("80", 16);
    await pool.enableLltv(lltv);

    const oracleBtc = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);
    const oracleEth = await ethers.deployContract("MockPoolOracle", [3000n * 10n ** 34n]);

    // Market 1: USDC/BTC
    const marketParams1 = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracleBtc.getAddress(),
      irm: await irm.getAddress(),
      lltv: lltv
    };
    await pool.createMarket(marketParams1);

    // Market 2: USDC/ETH (different IRM for higher yield)
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

    await optimizer.setSupplyQueue([id1]);
    await optimizer.setWithdrawQueue([id1, id2]);

    // Deposit
    await usdc.transfer(depositor.address, ethers.parseUnits("100000", 6));
    await usdc.connect(depositor).approve(await optimizer.getAddress(), ethers.MaxUint256);
    await optimizer.connect(depositor).deposit(ethers.parseUnits("10000", 6), depositor.address);

    return { pool, optimizer, usdc, owner, depositor, id1, id2 };
  }

  it("Should reallocate funds between markets", async function () {
    const { pool, optimizer, owner, id1, id2 } = await loadFixture(deployWithTwoMarkets);

    // All funds should be in market 1 (supply queue)
    const pos1Before = await pool.position(id1, await optimizer.getAddress());
    expect(pos1Before.supplyShares).to.be.gt(0);

    // Reallocate 5000 from market 1 to market 2
    const amount = ethers.parseUnits("5000", 6);
    await optimizer.reallocate(
      [id1], [amount],
      [id2], [amount]
    );

    // Market 2 should now have funds
    const pos2After = await pool.position(id2, await optimizer.getAddress());
    expect(pos2After.supplyShares).to.be.gt(0);
  });

  it("Should reject reallocation from non-owner/guardian", async function () {
    const { optimizer, depositor, id1, id2 } = await loadFixture(deployWithTwoMarkets);

    await expect(optimizer.connect(depositor).reallocate(
      [id1], [1000],
      [id2], [1000]
    )).to.be.revertedWith("Not authorized");
  });

  it("Should allow guardian to reallocate", async function () {
    const { optimizer, depositor, owner, id1, id2 } = await loadFixture(deployWithTwoMarkets);

    // Set depositor as guardian
    await optimizer.setGuardian(depositor.address);

    const amount = ethers.parseUnits("1000", 6);
    await expect(optimizer.connect(depositor).reallocate(
      [id1], [amount],
      [id2], [amount]
    )).to.not.be.reverted;
  });

  it("Should reject mismatched array lengths", async function () {
    const { optimizer, id1, id2 } = await loadFixture(deployWithTwoMarkets);

    await expect(optimizer.reallocate(
      [id1], [1000, 2000], // length mismatch
      [id2], [1000]
    )).to.be.revertedWith("Length mismatch");
  });
});
