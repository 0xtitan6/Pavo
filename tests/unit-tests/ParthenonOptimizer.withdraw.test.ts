import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonOptimizer withdraw tests", function () {
  async function deployWithDeposit() {
    const [owner, depositor] = await ethers.getSigners();

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

    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
    ));

    const optimizer = await ethers.deployContract("ParthenonOptimizer", [
      await pool.getAddress(),
      await usdc.getAddress(),
      "ParthenonOptimizer USDC",
      "poUSDC",
      owner.address
    ]);

    await optimizer.setSupplyQueue([id]);
    await optimizer.setWithdrawQueue([id]);

    await usdc.transfer(depositor.address, ethers.parseUnits("100000", 6));
    await usdc.connect(depositor).approve(await optimizer.getAddress(), ethers.MaxUint256);

    // Deposit 10,000 USDC
    await optimizer.connect(depositor).deposit(ethers.parseUnits("10000", 6), depositor.address);

    return { pool, optimizer, usdc, wbtc, owner, depositor, id };
  }

  it("Should withdraw assets from optimizer", async function () {
    const { optimizer, usdc, depositor } = await loadFixture(deployWithDeposit);

    const balanceBefore = await usdc.balanceOf(depositor.address);
    const withdrawAmount = ethers.parseUnits("5000", 6);

    await optimizer.connect(depositor).withdraw(withdrawAmount, depositor.address, depositor.address);

    const balanceAfter = await usdc.balanceOf(depositor.address);
    expect(balanceAfter - balanceBefore).to.be.gte(withdrawAmount - 10n);
  });

  it("Should redeem shares for assets", async function () {
    const { optimizer, usdc, depositor } = await loadFixture(deployWithDeposit);

    const shares = await optimizer.balanceOf(depositor.address);
    const halfShares = shares / 2n;

    const balanceBefore = await usdc.balanceOf(depositor.address);
    await optimizer.connect(depositor).redeem(halfShares, depositor.address, depositor.address);

    const balanceAfter = await usdc.balanceOf(depositor.address);
    expect(balanceAfter).to.be.gt(balanceBefore);
  });

  it("Should withdraw from pool markets via withdraw queue", async function () {
    const { optimizer, pool, usdc, depositor, id } = await loadFixture(deployWithDeposit);

    // Verify optimizer has position in pool before withdrawal
    const posBefore = await pool.position(id, await optimizer.getAddress());
    expect(posBefore.supplyShares).to.be.gt(0);

    // Full withdrawal
    const shares = await optimizer.balanceOf(depositor.address);
    await optimizer.connect(depositor).redeem(shares, depositor.address, depositor.address);

    // Optimizer should have no shares left
    expect(await optimizer.balanceOf(depositor.address)).to.equal(0);
  });
});
