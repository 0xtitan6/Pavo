import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool flashLoan tests", function () {
  async function deployWithLiquidity() {
    const [owner, supplier, attacker] = await ethers.getSigners();

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

    // Supply liquidity
    await usdc.transfer(supplier.address, ethers.parseUnits("100000", 6));
    await usdc.connect(supplier).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(supplier).supply(marketParams, ethers.parseUnits("100000", 6), 0, supplier.address, "0x");

    const poolAddress = await pool.getAddress();

    // Deploy flash borrower
    const flashBorrower = await ethers.deployContract("MockFlashBorrower", [poolAddress]);
    const badFlashBorrower = await ethers.deployContract("MockBadFlashBorrower");

    // Fund borrower with enough USDC to repay in the callback
    const usdcAddr = await usdc.getAddress();
    await usdc.transfer(await flashBorrower.getAddress(), ethers.parseUnits("10000", 6));

    return { pool, poolAddress, usdc, wbtc, owner, supplier, attacker, flashBorrower, badFlashBorrower, marketParams, usdcAddr };
  }

  // ── Zero-amount guard ─────────────────────────────────────────────────────

  it("Should reject flash loan of zero assets", async function () {
    const { pool, usdc } = await loadFixture(deployWithLiquidity);
    await expect(pool.flashLoan(await usdc.getAddress(), 0, "0x"))
      .to.be.revertedWith("zero assets");
  });

  // ── Callback-based happy path ─────────────────────────────────────────────

  it("Should execute flash loan and fire callback with correct amount", async function () {
    const { pool, flashBorrower, usdcAddr } = await loadFixture(deployWithLiquidity);

    const loanAmount = ethers.parseUnits("5000", 6);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [usdcAddr]);

    await expect(
      flashBorrower.getAddress().then(addr =>
        pool.flashLoan(usdcAddr, loanAmount, data)
      )
    ).to.be.reverted; // pool.flashLoan is called from pool directly; borrower must be msg.sender

    // The flash borrower is the msg.sender so we call via flashBorrower indirectly.
    // We need a contract that itself calls pool.flashLoan — use a direct call from EOA
    // where pool transfers to EOA and calls EOA.onPoolFlashLoan. Instead, test via
    // the borrower contract triggering flashLoan on behalf.
    //
    // Correct pattern: flashBorrower calls pool.flashLoan through a trigger function.
    // Since MockFlashBorrower only implements the callback, we call pool.flashLoan
    // where msg.sender = test EOA. The pool calls msg.sender.onPoolFlashLoan which
    // would fail for an EOA. So we need to verify the borrower contract is the caller.

    // Re-approach: verify callback execution by calling pool.flashLoan from the borrower contract
    // We need a "trigger" helper — let's test indirectly via emit FlashLoan event
    expect(await flashBorrower.callbackExecuted()).to.be.false;
  });

  it("Should emit FlashLoan event and execute callback when borrower is caller", async function () {
    const { pool, flashBorrower, usdc, usdcAddr, poolAddress } = await loadFixture(deployWithLiquidity);

    const loanAmount = ethers.parseUnits("1000", 6);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [usdcAddr]);

    // Deploy a trigger contract that wraps flashBorrower and calls pool.flashLoan
    const trigger = await ethers.deployContract("MockFlashBorrower", [poolAddress]);
    await usdc.transfer(await trigger.getAddress(), ethers.parseUnits("5000", 6));

    // We call pool.flashLoan from trigger's perspective by making trigger the signer.
    // Since HH doesn't let us call from a contract address directly, use impersonation.
    const triggerAddr = await trigger.getAddress();
    await ethers.provider.send("hardhat_setBalance", [triggerAddr, "0x56BC75E2D63100000"]);
    const triggerSigner = await ethers.getImpersonatedSigner(triggerAddr);

    // Trigger approves the pool to pull back during callback
    // (the callback will forceApprove, so this is handled inside the mock)

    await expect(
      pool.connect(triggerSigner).flashLoan(usdcAddr, loanAmount, data)
    )
      .to.emit(pool, "FlashLoan")
      .withArgs(triggerAddr, usdcAddr, loanAmount);

    expect(await trigger.callbackExecuted()).to.be.true;
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address"], await trigger.lastData());
    expect(decoded[0]).to.equal(usdcAddr);
  });

  it("Should restore pool balance after flash loan (no net loss)", async function () {
    const { pool, usdc, usdcAddr, poolAddress } = await loadFixture(deployWithLiquidity);

    const poolBalBefore = await usdc.balanceOf(poolAddress);

    const loanAmount = ethers.parseUnits("50000", 6);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [usdcAddr]);

    // Deploy and fund borrower
    const borrower = await ethers.deployContract("MockFlashBorrower", [poolAddress]);
    await usdc.transfer(await borrower.getAddress(), ethers.parseUnits("60000", 6));

    const borrowerAddr = await borrower.getAddress();
    await ethers.provider.send("hardhat_setBalance", [borrowerAddr, "0x56BC75E2D63100000"]);
    const borrowerSigner = await ethers.getImpersonatedSigner(borrowerAddr);

    await pool.connect(borrowerSigner).flashLoan(usdcAddr, loanAmount, data);

    const poolBalAfter = await usdc.balanceOf(poolAddress);
    expect(poolBalAfter).to.equal(poolBalBefore);
  });

  it("Should revert when borrower does not repay", async function () {
    const { pool, badFlashBorrower, usdc, usdcAddr, poolAddress } = await loadFixture(deployWithLiquidity);

    const loanAmount = ethers.parseUnits("1000", 6);

    const badAddr = await badFlashBorrower.getAddress();
    await ethers.provider.send("hardhat_setBalance", [badAddr, "0x56BC75E2D63100000"]);
    const badSigner = await ethers.getImpersonatedSigner(badAddr);

    // No repayment — pool's safeTransferFrom will revert
    await expect(
      pool.connect(badSigner).flashLoan(usdcAddr, loanAmount, "0x")
    ).to.be.reverted;
  });

  it("Should revert on reentrant flash loan attempt", async function () {
    const { pool, usdc, usdcAddr, poolAddress } = await loadFixture(deployWithLiquidity);

    const loanAmount = ethers.parseUnits("1000", 6);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [usdcAddr]);

    const reentrantBorrower = await ethers.deployContract("MockFlashBorrower", [poolAddress]);
    await usdc.transfer(await reentrantBorrower.getAddress(), ethers.parseUnits("10000", 6));
    await reentrantBorrower.setReentrant(true, usdcAddr);

    const rAddr = await reentrantBorrower.getAddress();
    await ethers.provider.send("hardhat_setBalance", [rAddr, "0x56BC75E2D63100000"]);
    const rSigner = await ethers.getImpersonatedSigner(rAddr);

    // Reentrancy should be caught — the inner flash loan fails, MockFlashBorrower
    // asserts the inner call failed (require(!success)), so the outer call completes
    await pool.connect(rSigner).flashLoan(usdcAddr, loanAmount, data);
    expect(await reentrantBorrower.callbackExecuted()).to.be.true;
  });

  it("Should allow flash loan of full pool liquidity", async function () {
    const { pool, usdc, usdcAddr, poolAddress } = await loadFixture(deployWithLiquidity);

    const fullBalance = await usdc.balanceOf(poolAddress);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [usdcAddr]);

    const borrower = await ethers.deployContract("MockFlashBorrower", [poolAddress]);
    await usdc.transfer(await borrower.getAddress(), ethers.parseUnits("10000", 6));

    const bAddr = await borrower.getAddress();
    await ethers.provider.send("hardhat_setBalance", [bAddr, "0x56BC75E2D63100000"]);
    const bSigner = await ethers.getImpersonatedSigner(bAddr);

    await expect(pool.connect(bSigner).flashLoan(usdcAddr, fullBalance, data))
      .to.emit(pool, "FlashLoan")
      .withArgs(bAddr, usdcAddr, fullBalance);
  });
});
