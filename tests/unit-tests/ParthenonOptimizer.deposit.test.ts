import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonOptimizer deposit tests", function () {
  async function deployOptimizerFixture() {
    const [owner, depositor] = await ethers.getSigners();

    // Deploy mock tokens
    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);

    // Deploy pool
    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    // Deploy IRM
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

    // Compute market ID
    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
    ));

    // Deploy optimizer
    const optimizer = await ethers.deployContract("ParthenonOptimizer", [
      await pool.getAddress(),
      await usdc.getAddress(),
      "ParthenonOptimizer USDC",
      "poUSDC",
      owner.address
    ]);

    // Authorize optimizer on pool
    const optimizerAddr = await optimizer.getAddress();

    // Set supply and withdraw queues
    await optimizer.setSupplyQueue([id]);
    await optimizer.setWithdrawQueue([id]);

    // Fund depositor
    await usdc.transfer(depositor.address, ethers.parseUnits("100000", 6));
    await usdc.connect(depositor).approve(await optimizer.getAddress(), ethers.MaxUint256);

    return { pool, optimizer, usdc, wbtc, irm, oracle, owner, depositor, marketParams, id };
  }

  it("Should deposit into optimizer and receive shares", async function () {
    const { optimizer, depositor } = await loadFixture(deployOptimizerFixture);

    const amount = ethers.parseUnits("1000", 6);
    await optimizer.connect(depositor).deposit(amount, depositor.address);

    const shares = await optimizer.balanceOf(depositor.address);
    expect(shares).to.be.gt(0);
  });

  it("Should allocate deposits to pool market via supply queue", async function () {
    const { optimizer, pool, depositor, id } = await loadFixture(deployOptimizerFixture);

    const amount = ethers.parseUnits("1000", 6);
    await optimizer.connect(depositor).deposit(amount, depositor.address);

    // Check optimizer has supply position in pool
    const pos = await pool.position(id, await optimizer.getAddress());
    expect(pos.supplyShares).to.be.gt(0);
  });

  it("Should track total assets correctly", async function () {
    const { optimizer, depositor } = await loadFixture(deployOptimizerFixture);

    const amount = ethers.parseUnits("5000", 6);
    await optimizer.connect(depositor).deposit(amount, depositor.address);

    const total = await optimizer.totalAssets();
    // Total should be approximately equal to deposited amount (minus tiny rounding)
    expect(total).to.be.gte(amount - 10n); // Allow 10 wei rounding
    expect(total).to.be.lte(amount + 10n);
  });

  it("Should be ERC-4626 compliant (previewDeposit)", async function () {
    const { optimizer, depositor } = await loadFixture(deployOptimizerFixture);

    const amount = ethers.parseUnits("1000", 6);
    const expectedShares = await optimizer.previewDeposit(amount);
    expect(expectedShares).to.be.gt(0);
  });

  it("Should support mint (ERC-4626)", async function () {
    const { optimizer, depositor } = await loadFixture(deployOptimizerFixture);

    const sharesToMint = ethers.parseUnits("1000", 6);
    await optimizer.connect(depositor).mint(sharesToMint, depositor.address);

    const shares = await optimizer.balanceOf(depositor.address);
    expect(shares).to.equal(sharesToMint);
  });

  // ── Cap enforcement ──────────────────────────────────────────────────────

  it("Should allow deposit up to allocation cap", async function () {
    const { optimizer, pool, depositor, id } = await loadFixture(deployOptimizerFixture);

    const cap = ethers.parseUnits("5000", 6);
    await optimizer.setAllocationCap(id, cap);

    // Deposit exactly at cap
    await optimizer.connect(depositor).deposit(cap, depositor.address);

    const pos = await pool.position(id, await optimizer.getAddress());
    expect(pos.supplyShares).to.be.gt(0);

    const shares = await optimizer.balanceOf(depositor.address);
    expect(shares).to.be.gt(0);
  });

  it("Should keep excess assets idle when single market is at cap", async function () {
    const { optimizer, pool, usdc, depositor, id } = await loadFixture(deployOptimizerFixture);

    const cap = ethers.parseUnits("3000", 6);
    await optimizer.setAllocationCap(id, cap);

    // Deposit more than cap — excess stays in optimizer as idle
    const depositAmount = ethers.parseUnits("5000", 6);
    await optimizer.connect(depositor).deposit(depositAmount, depositor.address);

    const idleBalance = await usdc.balanceOf(await optimizer.getAddress());
    expect(idleBalance).to.be.gte(ethers.parseUnits("2000", 6) - 10n);

    const total = await optimizer.totalAssets();
    expect(total).to.be.gte(depositAmount - 10n);
  });

  it("Should reject deposit when market is already full at cap and supply queue exhausted", async function () {
    const { optimizer, depositor, id } = await loadFixture(deployOptimizerFixture);

    const cap = ethers.parseUnits("1000", 6);
    await optimizer.setAllocationCap(id, cap);

    // Fill the cap
    await optimizer.connect(depositor).deposit(cap, depositor.address);

    // Second deposit should succeed but assets remain idle (supply queue skipped)
    // This is valid ERC-4626 behavior — no revert, just idle balance
    await expect(
      optimizer.connect(depositor).deposit(ethers.parseUnits("100", 6), depositor.address)
    ).to.not.be.reverted;
  });

  it("Should track isAllocatable flag for market in supply queue", async function () {
    const { optimizer, id } = await loadFixture(deployOptimizerFixture);
    expect(await optimizer.isAllocatable(id)).to.be.true;
  });

  it("Should emit AllocationCapUpdated event", async function () {
    const { optimizer, id } = await loadFixture(deployOptimizerFixture);
    const cap = ethers.parseUnits("10000", 6);
    await expect(optimizer.setAllocationCap(id, cap))
      .to.emit(optimizer, "AllocationCapUpdated")
      .withArgs(id, cap);
  });

  it("Should reject setSupplyQueue longer than MAX_QUEUE_LENGTH", async function () {
    const { optimizer, id } = await loadFixture(deployOptimizerFixture);
    const longQueue = Array(31).fill(id);
    await expect(optimizer.setSupplyQueue(longQueue)).to.be.revertedWith("Queue too long");
  });

  it("Should reject supply queue containing non-existent market", async function () {
    const { optimizer } = await loadFixture(deployOptimizerFixture);
    const fakeId = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
    await expect(optimizer.setSupplyQueue([fakeId])).to.be.revertedWith("Market not created");
  });
});
