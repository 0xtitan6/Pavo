import hre from "hardhat";
import { expect } from "chai";

describe("ParthenonVaultAdapter", function () {
  let mockTeller: any;
  let mockAccountant: any;
  let adapter: any;
  let usdcMock: any;
  let btcMock: any;
  let owner: any;
  let loanFactory: any;
  let recipient: any;
  let usdcAddress: string;
  let btcAddress: string;

  beforeEach(async function () {
    [owner, loanFactory, recipient] = await hre.ethers.getSigners();

    // Deploy ERC20 mocks
    usdcMock = await hre.ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, hre.ethers.parseUnits("1000000", 6), 6,
    ]);
    btcMock = await hre.ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, hre.ethers.parseUnits("100", 8), 8,
    ]);
    await usdcMock.waitForDeployment();
    await btcMock.waitForDeployment();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();

    // Deploy mock vault components
    mockTeller = await hre.ethers.deployContract("MockTeller");
    mockAccountant = await hre.ethers.deployContract("MockAccountant");
    await mockTeller.waitForDeployment();
    await mockAccountant.waitForDeployment();

    // Deploy adapter with loanFactory as authorized caller
    adapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
      loanFactory.address,
    ]);
    await adapter.waitForDeployment();

    // LOW-C9: Set vault/accountant on MockTeller for cross-validation
    await mockTeller.setVault(loanFactory.address); // dummy vault address
    await mockTeller.setAccountant(await mockAccountant.getAddress());

    // Configure vault for USDC
    await adapter.connect(owner).configureVault(
      usdcAddress,
      loanFactory.address, // dummy vault address (not used by mock)
      await mockTeller.getAddress(),
      await mockAccountant.getAddress(),
    );

    // Fund MockTeller with extra USDC to cover 1% yield payouts
    await usdcMock.connect(owner).transfer(
      await mockTeller.getAddress(),
      hre.ethers.parseUnits("100000", 6),
    );

    // Fund loanFactory signer with USDC for deposits
    await usdcMock.connect(owner).transfer(
      loanFactory.address,
      hre.ethers.parseUnits("100000", 6),
    );

    // Approve adapter to pull from loanFactory
    await usdcMock.connect(loanFactory).approve(
      await adapter.getAddress(),
      hre.ethers.MaxUint256,
    );
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe("Constructor", function () {
    it("Should set loanFactory correctly", async function () {
      expect(await adapter.loanFactory()).to.equal(loanFactory.address);
    });

    it("Should reject zero LoanFactory address", async function () {
      await expect(
        hre.ethers.deployContract("ParthenonVaultAdapter", [hre.ethers.ZeroAddress]),
      ).to.be.revertedWith("LoanFactory address cannot be zero");
    });
  });

  // ── Admin: configureVault ────────────────────────────────────────────

  describe("configureVault", function () {
    it("Should configure a vault and emit event", async function () {
      const tellerAddr = await mockTeller.getAddress();
      const accountantAddr = await mockAccountant.getAddress();

      // MockTeller already has vault=loanFactory.address and accountant set from beforeEach
      await expect(
        adapter.connect(owner).configureVault(btcAddress, loanFactory.address, tellerAddr, accountantAddr),
      )
        .to.emit(adapter, "VaultConfigured")
        .withArgs(btcAddress, loanFactory.address, tellerAddr, accountantAddr);

      expect(await adapter.hasMarket(btcAddress)).to.be.true;
    });

    it("Should reject configuration from non-owner", async function () {
      await expect(
        adapter.connect(loanFactory).configureVault(
          btcAddress, loanFactory.address,
          await mockTeller.getAddress(), await mockAccountant.getAddress(),
        ),
      ).to.be.reverted;
    });

    it("Should reject zero asset address", async function () {
      await expect(
        adapter.connect(owner).configureVault(
          hre.ethers.ZeroAddress, loanFactory.address,
          await mockTeller.getAddress(), await mockAccountant.getAddress(),
        ),
      ).to.be.revertedWith("Asset cannot be zero");
    });

    it("Should reject zero vault address", async function () {
      await expect(
        adapter.connect(owner).configureVault(
          btcAddress, hre.ethers.ZeroAddress,
          await mockTeller.getAddress(), await mockAccountant.getAddress(),
        ),
      ).to.be.revertedWith("Vault cannot be zero");
    });

    it("Should reject zero teller address", async function () {
      await expect(
        adapter.connect(owner).configureVault(
          btcAddress, loanFactory.address,
          hre.ethers.ZeroAddress, await mockAccountant.getAddress(),
        ),
      ).to.be.revertedWith("Teller cannot be zero");
    });

    it("Should reject vault/teller mismatch (LOW-C9)", async function () {
      const tellerAddr = await mockTeller.getAddress();
      const accountantAddr = await mockAccountant.getAddress();

      // Pass a different vault address than what mockTeller.vault() returns
      await expect(
        adapter.connect(owner).configureVault(
          btcAddress, recipient.address, // wrong vault — teller.vault() returns loanFactory.address
          tellerAddr, accountantAddr,
        ),
      ).to.be.revertedWith("Teller vault mismatch");
    });

    it("Should reject teller/accountant mismatch (LOW-C9)", async function () {
      const tellerAddr = await mockTeller.getAddress();

      // Deploy a second accountant that doesn't match mockTeller.accountant()
      const otherAccountant = await hre.ethers.deployContract("MockAccountant");
      await otherAccountant.waitForDeployment();

      await expect(
        adapter.connect(owner).configureVault(
          btcAddress, loanFactory.address,
          tellerAddr, await otherAccountant.getAddress(), // wrong accountant
        ),
      ).to.be.revertedWith("Teller accountant mismatch");
    });

    it("Should reject zero accountant address", async function () {
      await expect(
        adapter.connect(owner).configureVault(
          btcAddress, loanFactory.address,
          await mockTeller.getAddress(), hre.ethers.ZeroAddress,
        ),
      ).to.be.revertedWith("Accountant cannot be zero");
    });
  });

  // ── Admin: disableVault ──────────────────────────────────────────────

  describe("disableVault", function () {
    it("Should disable an enabled vault", async function () {
      expect(await adapter.hasMarket(usdcAddress)).to.be.true;

      await expect(adapter.connect(owner).disableVault(usdcAddress))
        .to.emit(adapter, "VaultDisabled")
        .withArgs(usdcAddress);

      expect(await adapter.hasMarket(usdcAddress)).to.be.false;
    });

    it("Should reject disabling an unconfigured vault", async function () {
      await expect(
        adapter.connect(owner).disableVault(btcAddress),
      ).to.be.revertedWith("Vault not configured");
    });

    it("Should reject non-owner caller", async function () {
      await expect(adapter.connect(loanFactory).disableVault(usdcAddress)).to.be.reverted;
    });
  });

  // ── Deposit (IYieldAdapter) ──────────────────────────────────────────

  describe("deposit (IYieldAdapter)", function () {
    const AMOUNT = hre.ethers.parseUnits("10000", 6);
    const LOAN_ID = 1n;

    it("Should deposit into vault and track shares per loanId", async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);

      const shares = await adapter.sharesOf(LOAN_ID, usdcAddress);
      expect(shares).to.equal(AMOUNT); // 1:1 in mock
    });

    it("Should emit Deposited event", async function () {
      await expect(adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID))
        .to.emit(adapter, "Deposited")
        .withArgs(LOAN_ID, usdcAddress, AMOUNT, AMOUNT);
    });

    it("Should reject deposit from non-loanFactory", async function () {
      await expect(
        adapter.connect(owner).deposit(usdcAddress, AMOUNT, LOAN_ID),
      ).to.be.revertedWith("Only LoanFactory");
    });

    it("Should reject deposit for unconfigured asset", async function () {
      await expect(
        adapter.connect(loanFactory).deposit(btcAddress, 100n, LOAN_ID),
      ).to.be.revertedWith("No vault configured for asset");
    });

    it("Should reject zero amount deposit", async function () {
      await expect(
        adapter.connect(loanFactory).deposit(usdcAddress, 0n, LOAN_ID),
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should accumulate shares across multiple deposits for same loanId", async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);

      const shares = await adapter.sharesOf(LOAN_ID, usdcAddress);
      expect(shares).to.equal(AMOUNT * 2n);
    });
  });

  // ── Withdraw (IYieldAdapter) ─────────────────────────────────────────

  describe("withdraw (IYieldAdapter)", function () {
    const AMOUNT = hre.ethers.parseUnits("10000", 6);
    const LOAN_ID = 1n;

    beforeEach(async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);
    });

    it("Should withdraw and send assets + yield to recipient", async function () {
      const balanceBefore = await usdcMock.balanceOf(recipient.address);

      await adapter.connect(loanFactory).withdraw(usdcAddress, LOAN_ID, recipient.address);

      const balanceAfter = await usdcMock.balanceOf(recipient.address);
      // Mock adds 1% yield: 10000 * 1.01 = 10100 USDC
      const expectedYield = AMOUNT / 100n;
      expect(balanceAfter - balanceBefore).to.equal(AMOUNT + expectedYield);
    });

    it("Should clear shares after withdrawal", async function () {
      await adapter.connect(loanFactory).withdraw(usdcAddress, LOAN_ID, recipient.address);
      expect(await adapter.sharesOf(LOAN_ID, usdcAddress)).to.equal(0n);
    });

    it("Should emit Withdrawn event", async function () {
      const expectedAssets = AMOUNT + AMOUNT / 100n;
      await expect(
        adapter.connect(loanFactory).withdraw(usdcAddress, LOAN_ID, recipient.address),
      )
        .to.emit(adapter, "Withdrawn")
        .withArgs(LOAN_ID, usdcAddress, expectedAssets, AMOUNT, recipient.address);
    });

    it("Should reject withdraw from non-loanFactory", async function () {
      await expect(
        adapter.connect(owner).withdraw(usdcAddress, LOAN_ID, recipient.address),
      ).to.be.revertedWith("Only LoanFactory");
    });

    it("Should reject withdraw with zero recipient", async function () {
      await expect(
        adapter.connect(loanFactory).withdraw(usdcAddress, LOAN_ID, hre.ethers.ZeroAddress),
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should reject withdraw with no position", async function () {
      await expect(
        adapter.connect(loanFactory).withdraw(usdcAddress, 999n, recipient.address),
      ).to.be.revertedWith("No position for loan");
    });

    it("Should reject double withdrawal", async function () {
      await adapter.connect(loanFactory).withdraw(usdcAddress, LOAN_ID, recipient.address);

      await expect(
        adapter.connect(loanFactory).withdraw(usdcAddress, LOAN_ID, recipient.address),
      ).to.be.revertedWith("No position for loan");
    });
  });

  // ── hasMarket ────────────────────────────────────────────────────────

  describe("hasMarket", function () {
    it("Should return true for configured asset", async function () {
      expect(await adapter.hasMarket(usdcAddress)).to.be.true;
    });

    it("Should return false for unconfigured asset", async function () {
      expect(await adapter.hasMarket(btcAddress)).to.be.false;
    });
  });

  // ── Emergency withdraw ───────────────────────────────────────────────

  describe("emergencyWithdraw", function () {
    const AMOUNT = hre.ethers.parseUnits("10000", 6);
    const LOAN_ID = 1n;

    beforeEach(async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);
    });

    it("Should allow owner to emergency withdraw", async function () {
      const balanceBefore = await usdcMock.balanceOf(owner.address);
      await adapter.connect(owner).emergencyWithdraw(usdcAddress, LOAN_ID, owner.address);
      const balanceAfter = await usdcMock.balanceOf(owner.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
      expect(await adapter.sharesOf(LOAN_ID, usdcAddress)).to.equal(0n);
    });

    it("Should emit EmergencyWithdrawn event (INFO-11)", async function () {
      const expectedAssets = AMOUNT + AMOUNT / 100n; // 1% yield
      await expect(
        adapter.connect(owner).emergencyWithdraw(usdcAddress, LOAN_ID, owner.address),
      )
        .to.emit(adapter, "EmergencyWithdrawn")
        .withArgs(LOAN_ID, usdcAddress, expectedAssets, AMOUNT, owner.address);
    });

    it("Should reject emergency withdraw from non-owner", async function () {
      await expect(
        adapter.connect(loanFactory).emergencyWithdraw(usdcAddress, LOAN_ID, loanFactory.address),
      ).to.be.reverted;
    });

    it("Should reject emergency withdraw with zero recipient", async function () {
      await expect(
        adapter.connect(owner).emergencyWithdraw(usdcAddress, LOAN_ID, hre.ethers.ZeroAddress),
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should reject emergency withdraw with no position", async function () {
      await expect(
        adapter.connect(owner).emergencyWithdraw(usdcAddress, 999n, owner.address),
      ).to.be.revertedWith("No position for loan");
    });
  });

  // ── View functions ───────────────────────────────────────────────────

  describe("View functions", function () {
    const AMOUNT = hre.ethers.parseUnits("10000", 6);
    const LOAN_ID = 1n;

    it("previewWithdraw returns 0 for empty position", async function () {
      expect(await adapter.previewWithdraw(LOAN_ID, usdcAddress)).to.equal(0n);
    });

    it("previewWithdraw returns expected value after deposit", async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);
      // Mock rate is 1e18 (1:1), shares = AMOUNT, so preview = AMOUNT * 1e18 / 1e18 = AMOUNT
      expect(await adapter.previewWithdraw(LOAN_ID, usdcAddress)).to.equal(AMOUNT);
    });

    it("getSharePrice returns rate from accountant", async function () {
      expect(await adapter.getSharePrice(usdcAddress)).to.equal(hre.ethers.parseUnits("1", 18));
    });

    it("getSharePrice reverts for unconfigured asset", async function () {
      await expect(adapter.getSharePrice(btcAddress)).to.be.revertedWith(
        "No vault configured for asset",
      );
    });
  });

  // ── Slippage configuration ─────────────────────────────────────────

  describe("setSlippageBps", function () {
    it("Should allow owner to update slippage", async function () {
      await expect(adapter.connect(owner).setSlippageBps(200))
        .to.emit(adapter, "SlippageUpdated")
        .withArgs(100, 200);
      expect(await adapter.slippageBps()).to.equal(200);
    });

    it("Should reject slippage > 1000 bps (10%)", async function () {
      await expect(
        adapter.connect(owner).setSlippageBps(1001),
      ).to.be.revertedWith("Slippage too high");
    });

    it("Should reject non-owner caller", async function () {
      await expect(
        adapter.connect(loanFactory).setSlippageBps(200),
      ).to.be.reverted;
    });

    it("Should allow setting slippage to 0", async function () {
      await adapter.connect(owner).setSlippageBps(0);
      expect(await adapter.slippageBps()).to.equal(0);
    });
  });

  // ── Active position tracking ───────────────────────────────────────

  describe("activePositions tracking", function () {
    const AMOUNT = hre.ethers.parseUnits("10000", 6);

    it("Should increment activePositions on deposit", async function () {
      expect(await adapter.activePositions(usdcAddress)).to.equal(0);

      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      expect(await adapter.activePositions(usdcAddress)).to.equal(1);

      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 2n);
      expect(await adapter.activePositions(usdcAddress)).to.equal(2);
    });

    it("Should not double-count deposits to same loanId", async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      expect(await adapter.activePositions(usdcAddress)).to.equal(1);
    });

    it("Should decrement activePositions on withdraw", async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 2n);
      expect(await adapter.activePositions(usdcAddress)).to.equal(2);

      await adapter.connect(loanFactory).withdraw(usdcAddress, 1n, recipient.address);
      expect(await adapter.activePositions(usdcAddress)).to.equal(1);
    });

    it("Should decrement activePositions on emergencyWithdraw", async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      expect(await adapter.activePositions(usdcAddress)).to.equal(1);

      await adapter.connect(owner).emergencyWithdraw(usdcAddress, 1n, owner.address);
      expect(await adapter.activePositions(usdcAddress)).to.equal(0);
    });
  });

  // ── configureVault with active positions guard ─────────────────────

  describe("configureVault active positions guard", function () {
    const AMOUNT = hre.ethers.parseUnits("10000", 6);

    it("Should reject reconfiguration when active positions exist", async function () {
      // Deposit creates an active position
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);

      // Try to reconfigure — should fail
      await expect(
        adapter.connect(owner).configureVault(
          usdcAddress,
          loanFactory.address,
          await mockTeller.getAddress(),
          await mockAccountant.getAddress(),
        ),
      ).to.be.revertedWith("Active positions exist for asset");
    });

    it("Should allow reconfiguration after all positions withdrawn", async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      await adapter.connect(loanFactory).withdraw(usdcAddress, 1n, recipient.address);

      // Now reconfigure should succeed
      await expect(
        adapter.connect(owner).configureVault(
          usdcAddress,
          loanFactory.address,
          await mockTeller.getAddress(),
          await mockAccountant.getAddress(),
        ),
      ).to.emit(adapter, "VaultConfigured");
    });
  });

  // ── Rate = 0 edge case (INFO-9: slippage degrades to zero) ─────────

  describe("Rate = 0 slippage degradation", function () {
    const AMOUNT = hre.ethers.parseUnits("10000", 6);
    const LOAN_ID = 100n;

    let zeroRateAdapter: any;
    let configurableAccountant: any;

    beforeEach(async function () {
      // Deploy configurable accountant with rate=0
      configurableAccountant = await hre.ethers.deployContract("MockAccountantConfigurable", [0n]);
      await configurableAccountant.waitForDeployment();

      // Deploy fresh adapter and configure with zero-rate accountant
      zeroRateAdapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
        loanFactory.address,
      ]);
      await zeroRateAdapter.waitForDeployment();

      // Set teller's accountant to match the configurable one for cross-validation
      await mockTeller.setAccountant(await configurableAccountant.getAddress());

      await zeroRateAdapter.connect(owner).configureVault(
        usdcAddress,
        loanFactory.address,
        await mockTeller.getAddress(),
        await configurableAccountant.getAddress(),
      );

      // Fund teller and approve
      await usdcMock.connect(owner).transfer(
        await mockTeller.getAddress(),
        hre.ethers.parseUnits("100000", 6),
      );
      await usdcMock.connect(loanFactory).approve(
        await zeroRateAdapter.getAddress(),
        hre.ethers.MaxUint256,
      );
    });

    it("Should deposit with minimumMint=0 when rate=0", async function () {
      // When rate=0, minimumMint becomes 0 (no slippage protection)
      await zeroRateAdapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);
      const shares = await zeroRateAdapter.sharesOf(LOAN_ID, usdcAddress);
      expect(shares).to.equal(AMOUNT); // 1:1 in mock
    });

    it("Should withdraw with minimumAssets=0 when rate=0", async function () {
      await zeroRateAdapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);

      const balanceBefore = await usdcMock.balanceOf(recipient.address);
      await zeroRateAdapter.connect(loanFactory).withdraw(usdcAddress, LOAN_ID, recipient.address);
      const balanceAfter = await usdcMock.balanceOf(recipient.address);

      // Should still work, just no slippage protection
      expect(balanceAfter - balanceBefore).to.be.gt(0n);
    });

    it("Should emergency withdraw with minimumAssets=0 when rate=0", async function () {
      await zeroRateAdapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);

      const balanceBefore = await usdcMock.balanceOf(owner.address);
      await zeroRateAdapter.connect(owner).emergencyWithdraw(usdcAddress, LOAN_ID, owner.address);
      const balanceAfter = await usdcMock.balanceOf(owner.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  // ── Checkpoint failure (INFO-7: silent swallow) ─────────────────────

  describe("Checkpoint failure handling", function () {
    const AMOUNT = hre.ethers.parseUnits("10000", 6);
    const LOAN_ID = 200n;

    let failAdapter: any;
    let failAccountant: any;

    beforeEach(async function () {
      // Deploy configurable accountant that reverts on checkpoint
      failAccountant = await hre.ethers.deployContract("MockAccountantConfigurable", [
        hre.ethers.parseUnits("1", 18),
      ]);
      await failAccountant.waitForDeployment();
      await failAccountant.setCheckpointShouldRevert(true);

      failAdapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
        loanFactory.address,
      ]);
      await failAdapter.waitForDeployment();

      // Set teller's accountant to match the fail accountant for cross-validation
      await mockTeller.setAccountant(await failAccountant.getAddress());

      await failAdapter.connect(owner).configureVault(
        usdcAddress,
        loanFactory.address,
        await mockTeller.getAddress(),
        await failAccountant.getAddress(),
      );

      await usdcMock.connect(owner).transfer(
        await mockTeller.getAddress(),
        hre.ethers.parseUnits("100000", 6),
      );
      await usdcMock.connect(loanFactory).approve(
        await failAdapter.getAddress(),
        hre.ethers.MaxUint256,
      );
    });

    it("Should deposit successfully even when checkpoint reverts", async function () {
      await failAdapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);
      const shares = await failAdapter.sharesOf(LOAN_ID, usdcAddress);
      expect(shares).to.equal(AMOUNT);
    });

    it("Should withdraw successfully even when checkpoint reverts", async function () {
      await failAdapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, LOAN_ID);

      const balanceBefore = await usdcMock.balanceOf(recipient.address);
      await failAdapter.connect(loanFactory).withdraw(usdcAddress, LOAN_ID, recipient.address);
      const balanceAfter = await usdcMock.balanceOf(recipient.address);

      expect(balanceAfter - balanceBefore).to.be.gt(0n);
    });
  });

  // ── Multi-loan position tracking ────────────────────────────────────

  describe("Multi-loan position tracking", function () {
    const AMOUNT = hre.ethers.parseUnits("5000", 6);

    it("Should track totalActivePositions across multiple loans", async function () {
      expect(await adapter.totalActivePositions()).to.equal(0);

      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      expect(await adapter.totalActivePositions()).to.equal(1);

      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 2n);
      expect(await adapter.totalActivePositions()).to.equal(2);

      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 3n);
      expect(await adapter.totalActivePositions()).to.equal(3);

      // Withdraw loan 2 — should decrement
      await adapter.connect(loanFactory).withdraw(usdcAddress, 2n, recipient.address);
      expect(await adapter.totalActivePositions()).to.equal(2);
      expect(await adapter.activePositions(usdcAddress)).to.equal(2);

      // Withdraw remaining
      await adapter.connect(loanFactory).withdraw(usdcAddress, 1n, recipient.address);
      await adapter.connect(loanFactory).withdraw(usdcAddress, 3n, recipient.address);
      expect(await adapter.totalActivePositions()).to.equal(0);
      expect(await adapter.activePositions(usdcAddress)).to.equal(0);
    });

    it("Should isolate positions across different tokens", async function () {
      // Configure BTC vault
      await adapter.connect(owner).configureVault(
        btcAddress,
        loanFactory.address,
        await mockTeller.getAddress(),
        await mockAccountant.getAddress(),
      );

      // Fund BTC to teller and approve
      await btcMock.connect(owner).transfer(
        await mockTeller.getAddress(),
        hre.ethers.parseUnits("50", 8),
      );
      await btcMock.connect(owner).transfer(
        loanFactory.address,
        hre.ethers.parseUnits("10", 8),
      );
      await btcMock.connect(loanFactory).approve(
        await adapter.getAddress(),
        hre.ethers.MaxUint256,
      );

      const btcAmount = hre.ethers.parseUnits("1", 8);

      // Deposit USDC and BTC
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      await adapter.connect(loanFactory).deposit(btcAddress, btcAmount, 2n);

      expect(await adapter.activePositions(usdcAddress)).to.equal(1);
      expect(await adapter.activePositions(btcAddress)).to.equal(1);
      expect(await adapter.totalActivePositions()).to.equal(2);

      // Withdraw USDC — BTC should be unaffected
      await adapter.connect(loanFactory).withdraw(usdcAddress, 1n, recipient.address);
      expect(await adapter.activePositions(usdcAddress)).to.equal(0);
      expect(await adapter.activePositions(btcAddress)).to.equal(1);
      expect(await adapter.totalActivePositions()).to.equal(1);
    });

    it("previewWithdraw returns 0 for disabled vault", async function () {
      await adapter.connect(loanFactory).deposit(usdcAddress, AMOUNT, 1n);
      await adapter.connect(owner).disableVault(usdcAddress);

      // After disabling, previewWithdraw should return 0
      const preview = await adapter.previewWithdraw(1n, usdcAddress);
      expect(preview).to.equal(0n);
    });
  });
});
