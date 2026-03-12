import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool security tests", function () {
  async function deployWithSupply() {
    const [owner, supplier, borrower, attacker] = await ethers.getSigners();

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

    // Fund borrower
    await wbtc.transfer(borrower.address, ethers.parseUnits("10", 8));
    await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);

    await wbtc.transfer(attacker.address, ethers.parseUnits("10", 8));
    await wbtc.connect(attacker).approve(await pool.getAddress(), ethers.MaxUint256);

    return { pool, usdc, wbtc, irm, oracle, owner, supplier, borrower, attacker, marketParams };
  }

  describe("access control", function () {
    it("Should only allow owner to enable IRM", async function () {
      const { pool, attacker } = await loadFixture(deployWithSupply);

      const newIrm = await ethers.deployContract("FixedRateIrm", [attacker.address, 0]);

      await expect(pool.connect(attacker).enableIrm(await newIrm.getAddress()))
        .to.be.revertedWith("not owner");
    });

    it("Should only allow owner to enable LLTV", async function () {
      const { pool, attacker } = await loadFixture(deployWithSupply);

      await expect(pool.connect(attacker).enableLltv(ethers.parseUnits("90", 16)))
        .to.be.revertedWith("not owner");
    });

    it("Should only allow owner to set fee recipient", async function () {
      const { pool, attacker } = await loadFixture(deployWithSupply);

      await expect(pool.connect(attacker).setFeeRecipient(attacker.address))
        .to.be.revertedWith("not owner");
    });

    it("Should allow owner to set fee recipient", async function () {
      const { pool, owner } = await loadFixture(deployWithSupply);

      const newFeeRecipient = ethers.Wallet.createRandom().address;
      await expect(pool.setFeeRecipient(newFeeRecipient))
        .to.emit(pool, "SetFeeRecipient");
    });
  });

  describe("unauthorized withdrawal prevention", function () {
    it("Should prevent attacker from withdrawing borrower collateral", async function () {
      const { pool, borrower, attacker, marketParams } = await loadFixture(deployWithSupply);

      // Borrower supplies collateral
      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      // Attacker tries to withdraw borrower's collateral to themselves
      await expect(pool.connect(attacker).withdrawCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, attacker.address))
        .to.be.reverted;
    });
  });

  describe("basic security", function () {
    it("Should work with healthy collateral", async function () {
      const { pool, borrower, marketParams } = await loadFixture(deployWithSupply);

      // Supply collateral: 1 BTC
      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      // Borrow: $10,000 (well under 80% LTV)
      await pool.connect(borrower).borrow(marketParams, ethers.parseUnits("10000", 6), 0, borrower.address, borrower.address);
    });

    it("Should handle zero-amount operations gracefully", async function () {
      const { pool, borrower, marketParams } = await loadFixture(deployWithSupply);

      // Supply zero collateral - should work
      // supplying zero collateral reverts with 'zero assets' — expect revert
      await expect(pool.connect(borrower).supplyCollateral(marketParams, 0, borrower.address, "0x")).to.be.reverted;
    });
  });
});
