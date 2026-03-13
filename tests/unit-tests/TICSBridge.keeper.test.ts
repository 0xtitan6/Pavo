/**
 * TICSBridge.keeper.test.ts
 *
 * Unit tests for TICSBridge keeper workflow events and confirmation functions.
 * Tests: collateral lifecycle, liquidation lifecycle, margin calls,
 *        state machine enforcement, access control, unregistered market reverts.
 *
 * Run: npx hardhat test --grep "TICSBridge.*keeper|keeper.*TICSBridge"
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// Deterministic private key for the attester wallet (test only)
const ATTESTER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("TICSBridge keeper workflows", function () {
  // ─── Fixture ────────────────────────────────────────────────────────

  async function deployBridgeFixture() {
    const [owner, relayer, borrower, lender, nonOwner] = await ethers.getSigners();

    // Attester wallet from deterministic key
    const attesterWallet = new ethers.Wallet(ATTESTER_PRIVATE_KEY, ethers.provider);

    // Deploy mock USDC
    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6,
    ]);
    await usdc.waitForDeployment();

    // Deploy Orchestrator + create a real CreditMarket
    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);
    await orchestrator.waitForDeployment();

    await orchestrator.authorizeBorrower(borrower.address, 1); // TIER_2

    const marketParams = {
      annualInterestBips: 500,
      delinquencyFeeBips: 1000,
      withdrawalBatchDuration: 604800,
      reserveRatioBips: 2000,
      delinquencyGracePeriod: 604800,
      protocolFeeBips: 100,
      maxDelinquencyPeriod: 2592000,
      maxTotalSupply: ethers.parseUnits("1000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0,
    };

    const tx = await orchestrator.createMarket(borrower.address, await usdc.getAddress(), marketParams);
    await tx.wait();

    const marketAddress = await orchestrator.getMarket(borrower.address, await usdc.getAddress());

    // Deploy TICSBridge with attester
    const TICSBridge = await ethers.getContractFactory("TICSBridge");
    const bridge = await TICSBridge.deploy(relayer.address, attesterWallet.address);
    await bridge.waitForDeployment();

    // Market ID — keccak256(borrower, asset)
    const marketId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address"],
        [borrower.address, await usdc.getAddress()]
      )
    );

    // Register the market
    await bridge.registerMarket(marketId, marketAddress);

    // Deterministic IDs for testing
    const reservationId = ethers.keccak256(ethers.toUtf8Bytes("reservation-1"));
    const lockId = ethers.keccak256(ethers.toUtf8Bytes("lock-1"));
    const liquidationId = ethers.keccak256(ethers.toUtf8Bytes("liquidation-1"));

    return {
      bridge, orchestrator, usdc,
      owner, relayer, borrower, lender, nonOwner,
      marketId, marketAddress, attesterWallet,
      reservationId, lockId, liquidationId,
    };
  }

  // ─── Full collateral lifecycle ─────────────────────────────────────

  describe("Full collateral lifecycle", function () {
    it("requestReserve -> confirmReservation -> confirmLock -> confirmRelease with correct state transitions and events", async function () {
      const { bridge, relayer, borrower, marketId, reservationId, lockId } =
        await loadFixture(deployBridgeFixture);
      const amount = ethers.parseUnits("10000", 6);

      // 1. requestCollateralReserve
      await expect(bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount))
        .to.emit(bridge, "CollateralReserveRequested")
        .withArgs(marketId, borrower.address, amount);

      let cs = await bridge.getCollateralState(marketId);
      expect(cs.status).to.equal(1); // Reserved
      expect(cs.amount).to.equal(amount);

      // 2. confirmReservation
      const confirmedAmount = ethers.parseUnits("9500", 6);
      await bridge.connect(relayer).confirmReservation(marketId, reservationId, confirmedAmount);

      cs = await bridge.getCollateralState(marketId);
      expect(cs.status).to.equal(1); // Still Reserved
      expect(cs.lockId).to.equal(reservationId);
      expect(cs.amount).to.equal(confirmedAmount);

      // 3. confirmLock
      await expect(bridge.connect(relayer).confirmLock(marketId, lockId, confirmedAmount))
        .to.emit(bridge, "CollateralLockConfirmed")
        .withArgs(marketId, lockId, confirmedAmount);

      cs = await bridge.getCollateralState(marketId);
      expect(cs.status).to.equal(2); // Locked
      expect(cs.lockId).to.equal(lockId);

      // 4. confirmRelease
      await expect(bridge.connect(relayer).confirmRelease(marketId, lockId, confirmedAmount))
        .to.emit(bridge, "CollateralReleased")
        .withArgs(marketId, lockId, confirmedAmount);

      cs = await bridge.getCollateralState(marketId);
      expect(cs.status).to.equal(4); // Released
      expect(cs.amount).to.equal(0);
    });
  });

  // ─── Liquidation lifecycle ─────────────────────────────────────────

  describe("Liquidation lifecycle", function () {
    it("requestReserve -> confirmLock -> signalLiquidation -> confirmLiquidation", async function () {
      const { bridge, relayer, borrower, marketId, lockId, liquidationId } =
        await loadFixture(deployBridgeFixture);
      const amount = ethers.parseUnits("10000", 6);

      // 1. requestCollateralReserve
      await bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount);

      // 2. confirmLock (skipping confirmReservation — still in Reserved state)
      await bridge.connect(relayer).confirmLock(marketId, lockId, amount);

      let cs = await bridge.getCollateralState(marketId);
      expect(cs.status).to.equal(2); // Locked

      // 3. signalLiquidation
      await expect(bridge.connect(relayer).signalLiquidation(marketId, borrower.address, amount))
        .to.emit(bridge, "LiquidationInstructed")
        .withArgs(marketId, borrower.address, amount);

      cs = await bridge.getCollateralState(marketId);
      expect(cs.status).to.equal(3); // Liquidating

      // 4. confirmLiquidation
      const proceeds = ethers.parseUnits("9800", 6);
      await expect(bridge.connect(relayer).confirmLiquidation(marketId, liquidationId, proceeds))
        .to.emit(bridge, "CollateralReleased")
        .withArgs(marketId, liquidationId, proceeds);

      cs = await bridge.getCollateralState(marketId);
      expect(cs.status).to.equal(4); // Released
      expect(cs.amount).to.equal(0);
    });
  });

  // ─── Margin call signal ────────────────────────────────────────────

  describe("Margin call signal", function () {
    it("signalMarginCall emits MarginCallTriggered with correct params", async function () {
      const { bridge, relayer, borrower, marketId } = await loadFixture(deployBridgeFixture);
      const deficit = ethers.parseUnits("5000", 6);

      await expect(bridge.connect(relayer).signalMarginCall(marketId, borrower.address, deficit))
        .to.emit(bridge, "MarginCallTriggered")
        .withArgs(marketId, borrower.address, deficit);
    });
  });

  // ─── State machine enforcement ─────────────────────────────────────

  describe("State machine enforcement", function () {
    it("confirmLock reverts if not in Reserved state", async function () {
      const { bridge, relayer, marketId, lockId } = await loadFixture(deployBridgeFixture);
      const amount = ethers.parseUnits("10000", 6);

      // Status is None — should revert
      await expect(bridge.connect(relayer).confirmLock(marketId, lockId, amount))
        .to.be.revertedWithCustomError(bridge, "InvalidCollateralState");
    });

    it("confirmRelease reverts if not in Locked state", async function () {
      const { bridge, relayer, borrower, marketId, lockId } = await loadFixture(deployBridgeFixture);
      const amount = ethers.parseUnits("10000", 6);

      // Status is None — should revert
      await expect(bridge.connect(relayer).confirmRelease(marketId, lockId, amount))
        .to.be.revertedWithCustomError(bridge, "InvalidCollateralState");

      // Move to Reserved — should still revert
      await bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount);
      await expect(bridge.connect(relayer).confirmRelease(marketId, lockId, amount))
        .to.be.revertedWithCustomError(bridge, "InvalidCollateralState");
    });

    it("confirmLiquidation reverts if not in Liquidating state", async function () {
      const { bridge, relayer, borrower, marketId, liquidationId } = await loadFixture(deployBridgeFixture);
      const amount = ethers.parseUnits("10000", 6);

      // Status is None — should revert
      await expect(bridge.connect(relayer).confirmLiquidation(marketId, liquidationId, amount))
        .to.be.revertedWithCustomError(bridge, "InvalidCollateralState");

      // Move to Reserved — should still revert
      await bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount);
      await expect(bridge.connect(relayer).confirmLiquidation(marketId, liquidationId, amount))
        .to.be.revertedWithCustomError(bridge, "InvalidCollateralState");
    });

    it("requestCollateralReserve reverts if in Locked state", async function () {
      const { bridge, relayer, borrower, marketId, lockId } = await loadFixture(deployBridgeFixture);
      const amount = ethers.parseUnits("10000", 6);

      // Move to Reserved -> Locked
      await bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount);
      await bridge.connect(relayer).confirmLock(marketId, lockId, amount);

      // Try to reserve again — should revert (status is Locked, not None or Released)
      await expect(bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount))
        .to.be.revertedWithCustomError(bridge, "InvalidCollateralState");
    });

    it("confirmReservation reverts if not in Reserved state", async function () {
      const { bridge, relayer, marketId, reservationId } = await loadFixture(deployBridgeFixture);
      const amount = ethers.parseUnits("10000", 6);

      // Status is None — should revert
      await expect(bridge.connect(relayer).confirmReservation(marketId, reservationId, amount))
        .to.be.revertedWithCustomError(bridge, "InvalidCollateralState");
    });
  });

  // ─── Only relayer/owner can call ───────────────────────────────────

  describe("Only relayer/owner can call", function () {
    it("non-relayer calling requestCollateralReserve reverts", async function () {
      const { bridge, nonOwner, borrower, marketId } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).requestCollateralReserve(marketId, borrower.address, 1000))
        .to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });

    it("non-relayer calling signalMarginCall reverts", async function () {
      const { bridge, nonOwner, borrower, marketId } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).signalMarginCall(marketId, borrower.address, 1000))
        .to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });

    it("non-relayer calling signalLiquidation reverts", async function () {
      const { bridge, nonOwner, borrower, marketId } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).signalLiquidation(marketId, borrower.address, 1000))
        .to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });

    it("non-relayer calling confirmReservation reverts", async function () {
      const { bridge, nonOwner, marketId, reservationId } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).confirmReservation(marketId, reservationId, 1000))
        .to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });

    it("non-relayer calling confirmLock reverts", async function () {
      const { bridge, nonOwner, marketId, lockId } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).confirmLock(marketId, lockId, 1000))
        .to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });

    it("non-relayer calling confirmLiquidation reverts", async function () {
      const { bridge, nonOwner, marketId, liquidationId } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).confirmLiquidation(marketId, liquidationId, 1000))
        .to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });

    it("non-relayer calling confirmRelease reverts", async function () {
      const { bridge, nonOwner, marketId, lockId } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).confirmRelease(marketId, lockId, 1000))
        .to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });
  });

  // ─── Unregistered market reverts ───────────────────────────────────

  describe("Unregistered market reverts", function () {
    const fakeMarketId = ethers.keccak256(ethers.toUtf8Bytes("unregistered"));
    const dummyId = ethers.keccak256(ethers.toUtf8Bytes("dummy"));

    it("requestCollateralReserve reverts for unregistered market", async function () {
      const { bridge, relayer, borrower } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(relayer).requestCollateralReserve(fakeMarketId, borrower.address, 1000))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });

    it("signalMarginCall reverts for unregistered market", async function () {
      const { bridge, relayer, borrower } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(relayer).signalMarginCall(fakeMarketId, borrower.address, 1000))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });

    it("signalLiquidation reverts for unregistered market", async function () {
      const { bridge, relayer, borrower } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(relayer).signalLiquidation(fakeMarketId, borrower.address, 1000))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });

    it("confirmReservation reverts for unregistered market", async function () {
      const { bridge, relayer } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(relayer).confirmReservation(fakeMarketId, dummyId, 1000))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });

    it("confirmLock reverts for unregistered market", async function () {
      const { bridge, relayer } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(relayer).confirmLock(fakeMarketId, dummyId, 1000))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });

    it("confirmLiquidation reverts for unregistered market", async function () {
      const { bridge, relayer } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(relayer).confirmLiquidation(fakeMarketId, dummyId, 1000))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });

    it("confirmRelease reverts for unregistered market", async function () {
      const { bridge, relayer } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(relayer).confirmRelease(fakeMarketId, dummyId, 1000))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });
  });
});
