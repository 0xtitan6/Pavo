import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool edge case tests", function () {
  async function deployBase() {
    const [owner, supplier, borrower, otherUser] = await ethers.getSigners();

    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);

    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);
    const poolAddress = await pool.getAddress();

    const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);
    await pool.enableIrm(await irm.getAddress());
    await pool.enableIrm(ethers.ZeroAddress); // zero address = no-interest IRM

    const lltv = ethers.parseUnits("80", 16);
    await pool.enableLltv(lltv);
    const oracle = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);

    // Market with normal IRM
    const marketParamsNormal = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracle.getAddress(),
      irm: await irm.getAddress(),
      lltv
    };

    // Market with zero IRM (address(0) = no interest, always enabled)
    const marketParamsZeroIrm = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracle.getAddress(),
      irm: ethers.ZeroAddress,
      lltv
    };

    await pool.createMarket(marketParamsNormal);
    await pool.createMarket(marketParamsZeroIrm);

    // Supply liquidity to normal market
    await usdc.transfer(supplier.address, ethers.parseUnits("100000", 6));
    await usdc.connect(supplier).approve(poolAddress, ethers.MaxUint256);
    await pool.connect(supplier).supply(marketParamsNormal, ethers.parseUnits("100000", 6), 0, supplier.address, "0x");

    // Supply liquidity to zero IRM market
    await usdc.transfer(otherUser.address, ethers.parseUnits("100000", 6));
    await usdc.connect(otherUser).approve(poolAddress, ethers.MaxUint256);
    await pool.connect(otherUser).supply(marketParamsZeroIrm, ethers.parseUnits("100000", 6), 0, otherUser.address, "0x");

    // Fund borrower with collateral
    await wbtc.transfer(borrower.address, ethers.parseUnits("10", 8));
    await wbtc.connect(borrower).approve(poolAddress, ethers.MaxUint256);

    return { pool, poolAddress, usdc, wbtc, irm, oracle, owner, supplier, borrower, otherUser, marketParamsNormal, marketParamsZeroIrm, lltv };
  }

  // ── Zero-IRM market ───────────────────────────────────────────────────────

  describe("zero-IRM market (address(0) IRM = no interest)", function () {
    it("Should create market with zero IRM successfully", async function () {
      const { pool, marketParamsZeroIrm } = await loadFixture(deployBase);

      // Market should have been created — verify by checking it has a lastUpdate
      const id = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "uint256"],
          [marketParamsZeroIrm.loanToken, marketParamsZeroIrm.collateralToken,
           marketParamsZeroIrm.oracle, marketParamsZeroIrm.irm, marketParamsZeroIrm.lltv]
        )
      );
      const mkt = await pool.market(id);
      expect(mkt.lastUpdate).to.be.gt(0n);
    });

    it("Should allow borrowing in zero-IRM market", async function () {
      const { pool, borrower, marketParamsZeroIrm } = await loadFixture(deployBase);

      await pool.connect(borrower).supplyCollateral(marketParamsZeroIrm, ethers.parseUnits("1", 8), borrower.address, "0x");

      await expect(
        pool.connect(borrower).borrow(marketParamsZeroIrm, ethers.parseUnits("10000", 6), 0, borrower.address, borrower.address)
      ).to.emit(pool, "Borrow");
    });

    it("Should not accrue interest in zero-IRM market over time", async function () {
      const { pool, borrower, usdc, marketParamsZeroIrm } = await loadFixture(deployBase);

      await pool.connect(borrower).supplyCollateral(marketParamsZeroIrm, ethers.parseUnits("1", 8), borrower.address, "0x");
      const borrowAmount = ethers.parseUnits("10000", 6);
      await pool.connect(borrower).borrow(marketParamsZeroIrm, borrowAmount, 0, borrower.address, borrower.address);

      const id = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "uint256"],
          [marketParamsZeroIrm.loanToken, marketParamsZeroIrm.collateralToken,
           marketParamsZeroIrm.oracle, marketParamsZeroIrm.irm, marketParamsZeroIrm.lltv]
        )
      );

      const mktBefore = await pool.market(id);
      const borrowBefore = mktBefore.totalBorrowAssets;

      // Advance 30 days
      await time.increase(30 * 24 * 3600);
      await pool.accrueInterest(marketParamsZeroIrm);

      const mktAfter = await pool.market(id);
      // Zero IRM = no interest should accrue
      expect(mktAfter.totalBorrowAssets).to.equal(borrowBefore);
    });
  });

  // ── Fee recipient changes ─────────────────────────────────────────────────

  describe("fee recipient changes", function () {
    it("Should allow owner to set fee recipient", async function () {
      const { pool, owner } = await loadFixture(deployBase);

      const newFeeRecipient = ethers.Wallet.createRandom().address;
      await expect(pool.connect(owner).setFeeRecipient(newFeeRecipient))
        .to.emit(pool, "SetFeeRecipient")
        .withArgs(newFeeRecipient);

      expect(await pool.feeRecipient()).to.equal(newFeeRecipient);
    });

    it("Should revert on unauthorized fee recipient change", async function () {
      const { pool, borrower } = await loadFixture(deployBase);

      await expect(
        pool.connect(borrower).setFeeRecipient(ethers.Wallet.createRandom().address)
      ).to.be.revertedWith("not owner");
    });

    it("Should allow owner to set and collect a protocol fee", async function () {
      const { pool, owner, borrower, supplier, usdc, wbtc, marketParamsNormal } = await loadFixture(deployBase);

      const feeRecipient = ethers.Wallet.createRandom().address;
      await pool.connect(owner).setFeeRecipient(feeRecipient);

      // Set 10% fee on the market
      await pool.connect(owner).setFee(marketParamsNormal, ethers.parseUnits("10", 16));

      // Borrow to generate interest
      await pool.connect(borrower).supplyCollateral(marketParamsNormal, ethers.parseUnits("1", 8), borrower.address, "0x");
      await pool.connect(borrower).borrow(marketParamsNormal, ethers.parseUnits("20000", 6), 0, borrower.address, borrower.address);

      // Advance 30 days
      await time.increase(30 * 24 * 3600);
      await pool.accrueInterest(marketParamsNormal);

      // Fee recipient should have accrued shares
      const id = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "uint256"],
          [marketParamsNormal.loanToken, marketParamsNormal.collateralToken,
           marketParamsNormal.oracle, marketParamsNormal.irm, marketParamsNormal.lltv]
        )
      );
      const recipientPos = await pool.position(id, feeRecipient);
      expect(recipientPos.supplyShares).to.be.gt(0n);
    });
  });

  // ── Reentrancy protection ─────────────────────────────────────────────────

  describe("reentrancy protection", function () {
    it("Should block reentrant flash loan call inside flash loan callback", async function () {
      const { pool, poolAddress, usdc } = await loadFixture(deployBase);

      const usdcAddr = await usdc.getAddress();
      const loanAmount = ethers.parseUnits("1000", 6);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [usdcAddr]);

      // Deploy MockFlashBorrower with reentrancy enabled
      const borrower = await ethers.deployContract("MockFlashBorrower", [poolAddress]);
      await usdc.transfer(await borrower.getAddress(), ethers.parseUnits("10000", 6));
      await borrower.setReentrant(true, usdcAddr);

      const bAddr = await borrower.getAddress();
      await ethers.provider.send("hardhat_setBalance", [bAddr, "0x56BC75E2D63100000"]);
      const bSigner = await ethers.getImpersonatedSigner(bAddr);

      // The outer flash loan should succeed but the inner reentrant call should fail
      // MockFlashBorrower.onPoolFlashLoan asserts the reentrant call reverted
      await pool.connect(bSigner).flashLoan(usdcAddr, loanAmount, data);
      expect(await borrower.callbackExecuted()).to.be.true;
    });
  });

  // ── Boundary conditions ───────────────────────────────────────────────────

  describe("boundary conditions", function () {
    it("Should handle very small borrow amount (1 wei)", async function () {
      const { pool, borrower, marketParamsNormal } = await loadFixture(deployBase);

      await pool.connect(borrower).supplyCollateral(marketParamsNormal, ethers.parseUnits("1", 8), borrower.address, "0x");
      await expect(
        pool.connect(borrower).borrow(marketParamsNormal, 1n, 0, borrower.address, borrower.address)
      ).to.emit(pool, "Borrow");
    });

    it("Should revert zero collateral withdrawal", async function () {
      const { pool, borrower, marketParamsNormal } = await loadFixture(deployBase);

      await pool.connect(borrower).supplyCollateral(marketParamsNormal, ethers.parseUnits("1", 8), borrower.address, "0x");
      await expect(
        pool.connect(borrower).withdrawCollateral(marketParamsNormal, 0, borrower.address, borrower.address)
      ).to.be.revertedWith("zero assets");
    });

    it("Should revert borrow when no liquidity", async function () {
      const [owner, borrower] = await ethers.getSigners();

      const usdc = await ethers.deployContract("ERC20Mock", [
        "USD Coin", "USDC", owner.address, ethers.parseUnits("100", 6), 6
      ]);
      const wbtc = await ethers.deployContract("ERC20Mock", [
        "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("10", 8), 8
      ]);
      const pool = await ethers.deployContract("ParthenonPool", [owner.address]);
      const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
      const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);
      await pool.enableIrm(await irm.getAddress());
      await pool.enableLltv(ethers.parseUnits("80", 16));
      const oracle = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);
      const mp = {
        loanToken: await usdc.getAddress(),
        collateralToken: await wbtc.getAddress(),
        oracle: await oracle.getAddress(),
        irm: await irm.getAddress(),
        lltv: ethers.parseUnits("80", 16)
      };
      await pool.createMarket(mp);

      await wbtc.transfer(borrower.address, ethers.parseUnits("5", 8));
      await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(borrower).supplyCollateral(mp, ethers.parseUnits("1", 8), borrower.address, "0x");

      await expect(
        pool.connect(borrower).borrow(mp, ethers.parseUnits("100", 6), 0, borrower.address, borrower.address)
      ).to.be.revertedWith("insufficient liquidity");
    });

    it("Should revert supply with zero assets", async function () {
      const { pool, supplier, marketParamsNormal } = await loadFixture(deployBase);
      await expect(
        pool.connect(supplier).supply(marketParamsNormal, 0, 0, supplier.address, "0x")
      ).to.be.reverted;
    });
  });
});
