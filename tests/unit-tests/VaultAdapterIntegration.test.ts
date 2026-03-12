/**
 * VaultAdapterIntegration.test.ts
 *
 * Integration tests for: LoanFactory → ParthenonVaultAdapter → MockTeller/MockAccountant
 *
 * Verifies the full lifecycle:
 *   createLoan → idle funds deposited into vault adapter
 *   cancelLoan → funds + yield returned from vault
 *   createLoan → takeUpLoan → funds withdrawn from vault, surplus distributed
 */
import hre from "hardhat";
import { expect } from "chai";

describe("VaultAdapter Integration (LoanFactory → ParthenonVaultAdapter → MockVault)", function () {
  let factory: any;
  let adapter: any;
  let mockTeller: any;
  let mockAccountant: any;
  let oracle: any;
  let registry: any;
  let usdc: any;
  let wbtc: any;
  let owner: any;
  let lender: any;
  let borrower: any;
  let usdcAddr: string;
  let wbtcAddr: string;

  beforeEach(async function () {
    [owner, lender, borrower] = await hre.ethers.getSigners();

    // Deploy ERC20 mocks
    usdc = await hre.ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, hre.ethers.parseUnits("10000000", 6), 6,
    ]);
    wbtc = await hre.ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, hre.ethers.parseUnits("1000", 8), 8,
    ]);
    await usdc.waitForDeployment();
    await wbtc.waitForDeployment();
    usdcAddr = await usdc.getAddress();
    wbtcAddr = await wbtc.getAddress();

    // Deploy Chainlink mock for WBTC/USD (price = $50,000)
    const mockFeed = await hre.ethers.deployContract("MockAggregatorV3", [
      8, 50000_00000000n,
    ]);
    await mockFeed.waitForDeployment();

    // Deploy AssetRegistry
    registry = await hre.ethers.deployContract("AssetRegistry");
    await registry.waitForDeployment();
    await registry.registerAsset(usdcAddr, "USDC", "USDC/USD", 6);
    await registry.setAssetSupported(usdcAddr, true);
    await registry.registerAsset(wbtcAddr, "WBTC", "BTC/USD", 8);
    await registry.setAssetSupported(wbtcAddr, true);
    await registry.setPairSupported(wbtcAddr, usdcAddr, true);

    // Deploy PriceOracle
    oracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
    await oracle.waitForDeployment();
    await oracle.setFeed(wbtcAddr, await mockFeed.getAddress(), 7200);

    // Deploy LoanFactory (no protocol fee for simplicity)
    factory = await hre.ethers.deployContract("LoanFactory", [
      await oracle.getAddress(),
      await registry.getAddress(),
      hre.ethers.ZeroAddress, // no fee recipient
      0, // no protocol fee
    ]);
    await factory.waitForDeployment();

    // Deploy vault adapter components
    mockTeller = await hre.ethers.deployContract("MockTeller");
    mockAccountant = await hre.ethers.deployContract("MockAccountant");
    await mockTeller.waitForDeployment();
    await mockAccountant.waitForDeployment();

    // Deploy ParthenonVaultAdapter with factory as authorized caller
    adapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
      await factory.getAddress(),
    ]);
    await adapter.waitForDeployment();

    // LOW-C9: Set vault/accountant on MockTeller for cross-validation
    await mockTeller.setVault(await mockTeller.getAddress()); // vault = teller address (dummy)
    await mockTeller.setAccountant(await mockAccountant.getAddress());

    // Configure vault for USDC
    await adapter.connect(owner).configureVault(
      usdcAddr,
      await mockTeller.getAddress(), // vault (not used by mock)
      await mockTeller.getAddress(),
      await mockAccountant.getAddress(),
    );

    // Set adapter on LoanFactory
    await factory.setYieldAdapter(await adapter.getAddress());

    // Fund MockTeller with extra USDC for 1% yield payouts
    await usdc.transfer(await mockTeller.getAddress(), hre.ethers.parseUnits("1000000", 6));

    // Fund lender and borrower
    await usdc.transfer(lender.address, hre.ethers.parseUnits("500000", 6));
    await wbtc.transfer(borrower.address, hre.ethers.parseUnits("100", 8));
  });

  // ── createLoan + cancelLoan lifecycle ────────────────────────────────

  describe("createLoan → cancelLoan (lend offer)", function () {
    it("Should route lend offer funds through vault adapter and return with yield on cancel", async function () {
      const amount = hre.ethers.parseUnits("10000", 6); // 10,000 USDC

      // Approve factory
      await usdc.connect(lender).approve(await factory.getAddress(), amount);

      // Create lend offer — funds should flow: lender → factory → adapter → mockTeller
      const lenderBefore = await usdc.balanceOf(lender.address);
      const tx = await factory.connect(lender).createLoan(
        amount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      const receipt = await tx.wait();

      // Adapter should hold shares for this loan
      const loanId = 1n;
      const shares = await adapter.sharesOf(loanId, usdcAddr);
      expect(shares).to.equal(amount); // 1:1 in mock

      // Cancel — funds should flow: mockTeller → adapter → lender (with 1% yield)
      const lenderBeforeCancel = await usdc.balanceOf(lender.address);
      await factory.connect(lender).cancelLoan(loanId);

      const lenderAfterCancel = await usdc.balanceOf(lender.address);
      const received = lenderAfterCancel - lenderBeforeCancel;

      // Mock adds 1% yield: 10000 * 1.01 = 10100 USDC
      const expectedYield = amount / 100n;
      expect(received).to.equal(amount + expectedYield);

      // Shares should be cleared
      expect(await adapter.sharesOf(loanId, usdcAddr)).to.equal(0n);
    });
  });

  // ── createLoan + takeUpLoan lifecycle ────────────────────────────────

  describe("createLoan → takeUpLoan (borrower takes lend offer)", function () {
    it("Should withdraw from vault adapter on match, surplus to lender", async function () {
      const lendAmount = hre.ethers.parseUnits("1000", 6); // 1,000 USDC
      const collateralAmount = hre.ethers.parseUnits("1", 8); // 1 BTC

      // Lender creates offer
      await usdc.connect(lender).approve(await factory.getAddress(), lendAmount);
      const lendId = await factory.connect(lender).createLoan.staticCall(
        lendAmount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      await factory.connect(lender).createLoan(
        lendAmount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // Verify funds in adapter
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.equal(lendAmount);

      // Borrower creates offer (collateral not routed to adapter since no WBTC vault configured)
      await wbtc.connect(borrower).approve(await factory.getAddress(), collateralAmount);
      const borrowId = await factory.connect(borrower).createLoan.staticCall(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      await factory.connect(borrower).createLoan(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // Track balances before match
      const lenderBefore = await usdc.balanceOf(lender.address);
      const borrowerBefore = await usdc.balanceOf(borrower.address);

      // Borrower takes up lend offer
      await factory.connect(borrower).takeUpLoan(borrowId, lendId);

      // Borrower should receive principal
      const borrowerAfter = await usdc.balanceOf(borrower.address);
      expect(borrowerAfter - borrowerBefore).to.equal(lendAmount);

      // Lender should receive yield surplus (1% of 1000 USDC = 10 USDC)
      const lenderAfter = await usdc.balanceOf(lender.address);
      const yieldSurplus = lendAmount / 100n;
      expect(lenderAfter - lenderBefore).to.equal(yieldSurplus);

      // Adapter shares should be cleared
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.equal(0n);
    });
  });

  // ── createLoan + takeUpLoan lifecycle (lender takes borrow offer) ────

  describe("createLoan → takeUpLoan (lender takes borrow offer)", function () {
    it("Should withdraw from vault adapter on match, surplus to lender", async function () {
      const lendAmount = hre.ethers.parseUnits("1000", 6); // 1,000 USDC
      const collateralAmount = hre.ethers.parseUnits("1", 8); // 1 BTC ($50,000 > 110% of 1000)

      // Lender creates offer first
      await usdc.connect(lender).approve(await factory.getAddress(), lendAmount);
      const lendId = await factory.connect(lender).createLoan.staticCall(
        lendAmount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      await factory.connect(lender).createLoan(
        lendAmount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // Verify funds in adapter
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.equal(lendAmount);

      // Borrower creates offer
      await wbtc.connect(borrower).approve(await factory.getAddress(), collateralAmount);
      const borrowId = await factory.connect(borrower).createLoan.staticCall(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      await factory.connect(borrower).createLoan(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // Track balances before match
      const lenderBefore = await usdc.balanceOf(lender.address);
      const borrowerBefore = await usdc.balanceOf(borrower.address);

      // Lender takes up borrow offer (reverse direction)
      await factory.connect(lender).takeUpLoan(lendId, borrowId);

      // Borrower should receive principal
      const borrowerAfter = await usdc.balanceOf(borrower.address);
      expect(borrowerAfter - borrowerBefore).to.equal(lendAmount);

      // Lender should receive yield surplus (1% of 1000 USDC = 10 USDC)
      const lenderAfter = await usdc.balanceOf(lender.address);
      const yieldSurplus = lendAmount / 100n;
      expect(lenderAfter - lenderBefore).to.equal(yieldSurplus);

      // Adapter shares should be cleared
      expect(await adapter.sharesOf(lendId, usdcAddr)).to.equal(0n);
    });

    it("Should handle negative yield on lender-takes-borrow path", async function () {
      // Deploy negative-yield adapter with MockYieldAdapter (yieldBps=9500 → -5%)
      const negAdapter = await hre.ethers.deployContract("MockYieldAdapter");
      await negAdapter.waitForDeployment();

      // Two-step adapter swap: clear, then set
      await factory.setYieldAdapter(hre.ethers.ZeroAddress);
      await factory.setYieldAdapter(await negAdapter.getAddress());

      // Configure USDC support on MockYieldAdapter
      await negAdapter.connect(owner).setSupported(usdcAddr, true);
      await negAdapter.connect(owner).setYieldBps(9500); // -5% yield

      // Fund MockYieldAdapter with USDC for payouts
      await usdc.transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("1000000", 6));

      const lendAmount = hre.ethers.parseUnits("1000", 6);
      const collateralAmount = hre.ethers.parseUnits("1", 8);

      // Lender creates offer
      await usdc.connect(lender).approve(await factory.getAddress(), lendAmount);
      const lendId = await factory.connect(lender).createLoan.staticCall(
        lendAmount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      await factory.connect(lender).createLoan(
        lendAmount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // Borrower creates offer
      await wbtc.connect(borrower).approve(await factory.getAddress(), collateralAmount);
      const borrowId = await factory.connect(borrower).createLoan.staticCall(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      await factory.connect(borrower).createLoan(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // Track balances
      const borrowerBefore = await usdc.balanceOf(borrower.address);

      // Lender takes up borrow offer
      await factory.connect(lender).takeUpLoan(lendId, borrowId);

      // Borrower should receive reduced amount (950 USDC = 1000 * 95%)
      const borrowerAfter = await usdc.balanceOf(borrower.address);
      const expectedReduced = (lendAmount * 9500n) / 10000n;
      expect(borrowerAfter - borrowerBefore).to.equal(expectedReduced);
    });

    it("Should handle collateral yield on lender-takes-borrow path", async function () {
      // Configure WBTC vault so collateral goes through adapter
      await adapter.connect(owner).configureVault(
        wbtcAddr,
        await mockTeller.getAddress(),
        await mockTeller.getAddress(),
        await mockAccountant.getAddress(),
      );

      // Fund teller with WBTC for yield payouts
      await wbtc.transfer(await mockTeller.getAddress(), hre.ethers.parseUnits("100", 8));

      const lendAmount = hre.ethers.parseUnits("1000", 6);
      const collateralAmount = hre.ethers.parseUnits("1", 8);

      // Lender creates offer
      await usdc.connect(lender).approve(await factory.getAddress(), lendAmount);
      const lendId = await factory.connect(lender).createLoan.staticCall(
        lendAmount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      await factory.connect(lender).createLoan(
        lendAmount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // Borrower creates offer — collateral now routed to adapter
      await wbtc.connect(borrower).approve(await factory.getAddress(), collateralAmount);
      const borrowId = await factory.connect(borrower).createLoan.staticCall(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );
      await factory.connect(borrower).createLoan(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // Track borrower BTC balance before match
      const borrowerBtcBefore = await wbtc.balanceOf(borrower.address);

      // Lender takes up borrow offer
      await factory.connect(lender).takeUpLoan(lendId, borrowId);

      // Borrower should receive collateral surplus (1% yield on 1 BTC = 0.01 BTC)
      const borrowerBtcAfter = await wbtc.balanceOf(borrower.address);
      const collateralYield = collateralAmount / 100n;
      expect(borrowerBtcAfter - borrowerBtcBefore).to.equal(collateralYield);
    });
  });

  // ── Adapter not configured for token ─────────────────────────────────

  describe("No adapter configured for token", function () {
    it("Should still work without adapter for tokens without vault config", async function () {
      const collateralAmount = hre.ethers.parseUnits("1", 8); // 1 BTC

      // WBTC has no vault configured — should deposit directly to factory
      await wbtc.connect(borrower).approve(await factory.getAddress(), collateralAmount);
      await factory.connect(borrower).createLoan(
        0, collateralAmount, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // No shares in adapter for WBTC
      expect(await adapter.sharesOf(1n, wbtcAddr)).to.equal(0n);

      // Cancel should return collateral directly
      const borrowerBefore = await wbtc.balanceOf(borrower.address);
      await factory.connect(borrower).cancelLoan(1n);
      const borrowerAfter = await wbtc.balanceOf(borrower.address);
      expect(borrowerAfter - borrowerBefore).to.equal(collateralAmount);
    });
  });

  // ── Adapter disabled mid-flow ────────────────────────────────────────

  describe("Adapter disabled", function () {
    it("Should not route to disabled vault", async function () {
      // Disable USDC vault
      await adapter.connect(owner).disableVault(usdcAddr);

      const amount = hre.ethers.parseUnits("10000", 6);
      await usdc.connect(lender).approve(await factory.getAddress(), amount);

      // createLoan should still work — hasMarket returns false, so funds stay in factory
      await factory.connect(lender).createLoan(
        amount, 0, 12000, 11000, usdcAddr, wbtcAddr, 1, 1,
      );

      // No shares in adapter
      expect(await adapter.sharesOf(1n, usdcAddr)).to.equal(0n);

      // Cancel returns from factory directly
      const lenderBefore = await usdc.balanceOf(lender.address);
      await factory.connect(lender).cancelLoan(1n);
      const lenderAfter = await usdc.balanceOf(lender.address);
      expect(lenderAfter - lenderBefore).to.equal(amount);
    });
  });

  // ── Two-step adapter swap ────────────────────────────────────────────

  describe("Two-step adapter swap (LOW-1)", function () {
    it("Should require clearing adapter before setting new one", async function () {
      const newAdapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
        await factory.getAddress(),
      ]);
      await newAdapter.waitForDeployment();

      // Direct swap should fail
      await expect(
        factory.setYieldAdapter(await newAdapter.getAddress()),
      ).to.be.revertedWith("Clear existing adapter first");

      // Clear first, then set new
      await factory.setYieldAdapter(hre.ethers.ZeroAddress);
      await factory.setYieldAdapter(await newAdapter.getAddress());
    });
  });
});
