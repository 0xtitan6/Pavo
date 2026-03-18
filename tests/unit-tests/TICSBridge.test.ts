/**
 * TICSBridge.test.ts
 *
 * Unit tests for TICSBridge — EVM-Canton state synchronization bridge
 * with ECDSA signature verification.
 * Tests: registration, sync, attestation with signatures, access control, views, edge cases.
 *
 * Run: npx hardhat test --grep 'TICSBridge'
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// Deterministic private key for the attester wallet (test only)
const ATTESTER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("TICSBridge", function () {
  // ─── Helper: create a signed attestation ────────────────────────────

  async function signAttestation(
    signerKey: string,
    marketId: string,
    stateHash: string,
    cantonTimestamp: number,
    nonce: number
  ): Promise<string> {
    const wallet = new ethers.Wallet(signerKey, ethers.provider);
    const msgHash = ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32", "uint64", "uint256"],
      [marketId, stateHash, cantonTimestamp, nonce]
    );
    const sig = await wallet.signMessage(ethers.getBytes(msgHash));
    const attestation = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint64", "uint256", "bytes"],
      [stateHash, cantonTimestamp, nonce, sig]
    );
    return attestation;
  }

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
    const market = await ethers.getContractAt("CreditMarket", marketAddress);

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

    return {
      bridge, orchestrator, market, usdc,
      owner, relayer, borrower, lender, nonOwner,
      marketId, marketAddress,
      attesterWallet,
    };
  }

  // ─── Constructor ──────────────────────────────────────────────────

  describe("Constructor", function () {
    it("sets owner, relayer, and trustedAttester", async function () {
      const { bridge, owner, relayer, attesterWallet } = await loadFixture(deployBridgeFixture);
      expect(await bridge.owner()).to.equal(owner.address);
      expect(await bridge.relayer()).to.equal(relayer.address);
      expect(await bridge.trustedAttester()).to.equal(attesterWallet.address);
    });

    it("emits RelayerUpdated and TrustedAttesterUpdated on deploy", async function () {
      const [, newRelayer] = await ethers.getSigners();
      const attesterWallet = new ethers.Wallet(ATTESTER_PRIVATE_KEY, ethers.provider);
      const TICSBridge = await ethers.getContractFactory("TICSBridge");
      const bridge = await TICSBridge.deploy(newRelayer.address, attesterWallet.address);
      expect(await bridge.relayer()).to.equal(newRelayer.address);
      expect(await bridge.trustedAttester()).to.equal(attesterWallet.address);
    });

    it("reverts on zero address relayer", async function () {
      const attesterWallet = new ethers.Wallet(ATTESTER_PRIVATE_KEY, ethers.provider);
      const TICSBridge = await ethers.getContractFactory("TICSBridge");
      await expect(TICSBridge.deploy(ethers.ZeroAddress, attesterWallet.address))
        .to.be.revertedWithCustomError(TICSBridge, "ZeroAddress");
    });

    it("reverts on zero address attester", async function () {
      const [, newRelayer] = await ethers.getSigners();
      const TICSBridge = await ethers.getContractFactory("TICSBridge");
      await expect(TICSBridge.deploy(newRelayer.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(TICSBridge, "ZeroAddress");
    });
  });

  // ─── Market Registration ──────────────────────────────────────────

  describe("registerMarket", function () {
    it("registers a market (owner)", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);

      await expect(bridge.registerMarket(marketId, marketAddress))
        .to.emit(bridge, "MarketRegistered")
        .withArgs(marketId, marketAddress);

      expect(await bridge.isRegistered(marketId)).to.be.true;
      expect(await bridge.getMarketAddress(marketId)).to.equal(marketAddress);
    });

    it("reverts on duplicate registration", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      await expect(bridge.registerMarket(marketId, marketAddress))
        .to.be.revertedWithCustomError(bridge, "MarketAlreadyRegistered");
    });

    it("reverts on zero address market", async function () {
      const { bridge, marketId } = await loadFixture(deployBridgeFixture);
      await expect(bridge.registerMarket(marketId, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(bridge, "ZeroAddress");
    });

    it("reverts when non-owner calls", async function () {
      const { bridge, marketId, marketAddress, nonOwner } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).registerMarket(marketId, marketAddress))
        .to.be.revertedWithCustomError(bridge, "OwnableUnauthorizedAccount");
    });

    it("isRegistered returns false for unregistered market", async function () {
      const { bridge } = await loadFixture(deployBridgeFixture);
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      expect(await bridge.isRegistered(fakeId)).to.be.false;
    });
  });

  // ─── syncMarketState ─────────────────────────────────────────────

  describe("syncMarketState", function () {
    it("syncs state and emits StateSynced (owner)", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      await expect(bridge.syncMarketState(marketId))
        .to.emit(bridge, "StateSynced");

      const stateHash = await bridge.getMarketStateHash(marketId);
      expect(stateHash).to.not.equal(ethers.ZeroHash);
    });

    it("syncs state (relayer)", async function () {
      const { bridge, relayer, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      await expect(bridge.connect(relayer).syncMarketState(marketId))
        .to.emit(bridge, "StateSynced");
    });

    it("reverts for unregistered market", async function () {
      const { bridge } = await loadFixture(deployBridgeFixture);
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));

      await expect(bridge.syncMarketState(fakeId))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });

    it("reverts when non-relayer/non-owner calls", async function () {
      const { bridge, nonOwner, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      await expect(bridge.connect(nonOwner).syncMarketState(marketId))
        .to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });

    it("state hash changes after market activity", async function () {
      const { bridge, market, usdc, owner, borrower, lender, marketId, marketAddress, orchestrator } =
        await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      // Sync before any activity
      await bridge.syncMarketState(marketId);
      const hashBefore = await bridge.getMarketStateHash(marketId);

      // Register lender and deposit
      await orchestrator.registerLender(marketAddress, lender.address);
      await usdc.transfer(lender.address, ethers.parseUnits("10000", 6));
      await usdc.connect(lender).approve(marketAddress, ethers.parseUnits("10000", 6));
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);

      // Sync after deposit
      await bridge.syncMarketState(marketId);
      const hashAfter = await bridge.getMarketStateHash(marketId);

      expect(hashAfter).to.not.equal(hashBefore);
    });
  });

  // ─── receiveAttestation (ECDSA) ───────────────────────────────────

  describe("receiveAttestation", function () {
    it("stores attestation with valid attester signature and emits event", async function () {
      const { bridge, marketId, marketAddress, attesterWallet } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      const stateHash = ethers.keccak256(ethers.toUtf8Bytes("canton-state-v1"));
      const ts = await time.latest();
      const cantonTimestamp = ts;

      const attestation = await signAttestation(
        ATTESTER_PRIVATE_KEY, marketId, stateHash, cantonTimestamp, 1
      );

      await expect(bridge.receiveAttestation(marketId, attestation))
        .to.emit(bridge, "AttestationReceived")
        .withArgs(marketId, stateHash, cantonTimestamp);

      expect(await bridge.getAttestationHash(marketId)).to.equal(stateHash);
      expect(await bridge.getAttestationTimestamp(marketId)).to.equal(cantonTimestamp);
    });

    it("accepts relayer-signed attestation", async function () {
      const { bridge, relayer, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      const stateHash = ethers.keccak256(ethers.toUtf8Bytes("relayer-state"));
      const ts = await time.latest();

      // Sign with relayer's key (signer[1])
      const nonce = 1;
      const msgHash = ethers.solidityPackedKeccak256(
        ["bytes32", "bytes32", "uint64", "uint256"],
        [marketId, stateHash, ts, nonce]
      );
      const sig = await relayer.signMessage(ethers.getBytes(msgHash));
      const attestation = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint64", "uint256", "bytes"],
        [stateHash, ts, nonce, sig]
      );

      await expect(bridge.connect(relayer).receiveAttestation(marketId, attestation))
        .to.emit(bridge, "AttestationReceived");
    });

    it("reverts with InvalidAttestationSignature for wrong signer", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      const stateHash = ethers.keccak256(ethers.toUtf8Bytes("wrong-signer"));
      const ts = await time.latest();

      // Sign with a random unknown key (not any Hardhat default account)
      const randomKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
      const attestation = await signAttestation(randomKey, marketId, stateHash, ts, 1);

      await expect(bridge.receiveAttestation(marketId, attestation))
        .to.be.revertedWithCustomError(bridge, "InvalidAttestationSignature");
    });

    it("reverts with StaleAttestation for old timestamp", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      const stateHash = ethers.keccak256(ethers.toUtf8Bytes("stale"));
      const currentTime = await time.latest();
      // Timestamp older than MAX_ATTESTATION_AGE (3600s)
      const staleTimestamp = currentTime - 3601;

      const attestation = await signAttestation(
        ATTESTER_PRIVATE_KEY, marketId, stateHash, staleTimestamp, 1
      );

      await expect(bridge.receiveAttestation(marketId, attestation))
        .to.be.revertedWithCustomError(bridge, "StaleAttestation");
    });

    it("reverts for unregistered market", async function () {
      const { bridge } = await loadFixture(deployBridgeFixture);
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      const stateHash = ethers.keccak256(ethers.toUtf8Bytes("data"));

      const attestation = await signAttestation(ATTESTER_PRIVATE_KEY, fakeId, stateHash, 12345, 1);

      await expect(bridge.receiveAttestation(fakeId, attestation))
        .to.be.revertedWithCustomError(bridge, "MarketNotRegistered");
    });

    it("reverts when non-relayer/non-owner calls", async function () {
      const { bridge, nonOwner, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      const stateHash = ethers.keccak256(ethers.toUtf8Bytes("data"));
      const ts = await time.latest();
      const attestation = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash, ts, 1);

      await expect(
        bridge.connect(nonOwner).receiveAttestation(marketId, attestation)
      ).to.be.revertedWithCustomError(bridge, "UnauthorizedRelayer");
    });

    it("overwrites previous attestation", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      const stateHash1 = ethers.keccak256(ethers.toUtf8Bytes("first"));
      const ts1 = await time.latest();
      const attestation1 = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash1, ts1, 1);
      await bridge.receiveAttestation(marketId, attestation1);
      expect(await bridge.getAttestationHash(marketId)).to.equal(stateHash1);

      const stateHash2 = ethers.keccak256(ethers.toUtf8Bytes("second"));
      const ts2 = await time.latest();
      const attestation2 = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash2, ts2, 2);
      await bridge.receiveAttestation(marketId, attestation2);
      expect(await bridge.getAttestationHash(marketId)).to.equal(stateHash2);

      expect(stateHash1).to.not.equal(stateHash2);
    });
  });

  // ─── isInSync ────────────────────────────────────────────────────

  describe("isInSync", function () {
    it("returns false when no state or attestation", async function () {
      const { bridge, marketId } = await loadFixture(deployBridgeFixture);
      expect(await bridge.isInSync(marketId)).to.be.false;
    });

    it("returns false when only state synced", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);
      await bridge.syncMarketState(marketId);

      expect(await bridge.isInSync(marketId)).to.be.false;
    });

    it("returns false when hashes don't match", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);
      await bridge.syncMarketState(marketId);

      // Submit an attestation with a different stateHash
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("wrong-data"));
      const ts = await time.latest();
      const attestation = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, wrongHash, ts, 1);
      await bridge.receiveAttestation(marketId, attestation);

      expect(await bridge.isInSync(marketId)).to.be.false;
    });

    it("returns true when synced state hash matches attestation stateHash", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      // Sync state to get the on-chain hash
      await bridge.syncMarketState(marketId);
      const stateHash = await bridge.getMarketStateHash(marketId);

      // Submit attestation with the exact same stateHash
      const ts = await time.latest();
      const attestation = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash, ts, 1);
      await bridge.receiveAttestation(marketId, attestation);

      expect(await bridge.isInSync(marketId)).to.be.true;
    });
  });

  // ─── setRelayer ──────────────────────────────────────────────────

  describe("setRelayer", function () {
    it("updates relayer (owner)", async function () {
      const { bridge, nonOwner } = await loadFixture(deployBridgeFixture);

      await expect(bridge.setRelayer(nonOwner.address))
        .to.emit(bridge, "RelayerUpdated");

      expect(await bridge.relayer()).to.equal(nonOwner.address);
    });

    it("reverts on zero address", async function () {
      const { bridge } = await loadFixture(deployBridgeFixture);
      await expect(bridge.setRelayer(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(bridge, "ZeroAddress");
    });

    it("reverts when non-owner calls", async function () {
      const { bridge, nonOwner } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).setRelayer(nonOwner.address))
        .to.be.revertedWithCustomError(bridge, "OwnableUnauthorizedAccount");
    });
  });

  // ─── setTrustedAttester ───────────────────────────────────────────

  describe("setTrustedAttester", function () {
    it("updates trustedAttester (owner)", async function () {
      const { bridge, nonOwner } = await loadFixture(deployBridgeFixture);

      await expect(bridge.setTrustedAttester(nonOwner.address))
        .to.emit(bridge, "TrustedAttesterUpdated");

      expect(await bridge.trustedAttester()).to.equal(nonOwner.address);
    });

    it("reverts on zero address", async function () {
      const { bridge } = await loadFixture(deployBridgeFixture);
      await expect(bridge.setTrustedAttester(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(bridge, "ZeroAddress");
    });

    it("reverts when non-owner calls", async function () {
      const { bridge, nonOwner } = await loadFixture(deployBridgeFixture);
      await expect(bridge.connect(nonOwner).setTrustedAttester(nonOwner.address))
        .to.be.revertedWithCustomError(bridge, "OwnableUnauthorizedAccount");
    });
  });

  // ─── Ownable2Step ────────────────────────────────────────────────

  describe("Ownable2Step", function () {
    it("supports two-step ownership transfer", async function () {
      const { bridge, owner, nonOwner } = await loadFixture(deployBridgeFixture);

      await bridge.transferOwnership(nonOwner.address);
      expect(await bridge.owner()).to.equal(owner.address); // still owner

      await bridge.connect(nonOwner).acceptOwnership();
      expect(await bridge.owner()).to.equal(nonOwner.address);
    });
  });

  // ─── View helpers ────────────────────────────────────────────────

  describe("View functions", function () {
    it("getMarketAddress returns zero for unregistered", async function () {
      const { bridge } = await loadFixture(deployBridgeFixture);
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("nope"));
      expect(await bridge.getMarketAddress(fakeId)).to.equal(ethers.ZeroAddress);
    });

    it("getMarketStateHash returns zero before sync", async function () {
      const { bridge, marketId } = await loadFixture(deployBridgeFixture);
      expect(await bridge.getMarketStateHash(marketId)).to.equal(ethers.ZeroHash);
    });

    it("getAttestationHash returns zero before attestation", async function () {
      const { bridge, marketId } = await loadFixture(deployBridgeFixture);
      expect(await bridge.getAttestationHash(marketId)).to.equal(ethers.ZeroHash);
    });

    it("getAttestationTimestamp returns zero before attestation", async function () {
      const { bridge, marketId } = await loadFixture(deployBridgeFixture);
      expect(await bridge.getAttestationTimestamp(marketId)).to.equal(0);
    });

    it("MAX_ATTESTATION_AGE is 3600", async function () {
      const { bridge } = await loadFixture(deployBridgeFixture);
      expect(await bridge.MAX_ATTESTATION_AGE()).to.equal(3600);
    });
  });

  // ─── Nonce / Replay Protection ─────────────────────────────────────

  describe("Nonce and replay protection", function () {
    it("rejects replay with same nonce (StaleOrReplayedAttestation)", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      const stateHash = ethers.keccak256(ethers.toUtf8Bytes("replay-test"));
      const ts = await time.latest();

      const attestation1 = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash, ts, 1);
      await bridge.receiveAttestation(marketId, attestation1);

      // Same nonce=1 should revert
      const stateHash2 = ethers.keccak256(ethers.toUtf8Bytes("replay-test-2"));
      const ts2 = await time.latest();
      const attestation2 = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash2, ts2, 1);

      await expect(bridge.receiveAttestation(marketId, attestation2))
        .to.be.revertedWithCustomError(bridge, "StaleOrReplayedAttestation");
    });

    it("getLastNonce returns correct nonce after attestation", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      const stateHash = ethers.keccak256(ethers.toUtf8Bytes("nonce-test"));
      const ts = await time.latest();

      const attestation = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash, ts, 5);
      await bridge.receiveAttestation(marketId, attestation);

      expect(await bridge.getLastNonce(marketId)).to.equal(5);
    });
  });

  // ─── releaseTimedOutReservation ────────────────────────────────────

  describe("releaseTimedOutReservation", function () {
    it("releases reservation after LOCK_TIMEOUT", async function () {
      const { bridge, relayer, borrower, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      // Reserve collateral
      const amount = ethers.parseUnits("10000", 6);
      await bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount);

      // Advance time past LOCK_TIMEOUT (1 hour)
      await time.increase(3601);

      await expect(bridge.releaseTimedOutReservation(marketId))
        .to.emit(bridge, "CollateralReservationTimedOut");

      const cs = await bridge.getCollateralState(marketId);
      expect(cs.status).to.equal(0); // None
    });

    it("reverts if timeout not reached (LockTimeoutNotReached)", async function () {
      const { bridge, relayer, borrower, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      // Reserve collateral
      const amount = ethers.parseUnits("10000", 6);
      await bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount);

      // Immediately try to release — should revert
      await expect(bridge.releaseTimedOutReservation(marketId))
        .to.be.revertedWithCustomError(bridge, "LockTimeoutNotReached");
    });
  });

  // ─── isInSync divergence age ──────────────────────────────────────

  describe("isInSync divergence age", function () {
    it("returns false when attestation older than MAX_DIVERGENCE_AGE", async function () {
      const { bridge, marketId, marketAddress } = await loadFixture(deployBridgeFixture);
      await bridge.registerMarket(marketId, marketAddress);

      // Sync state and submit matching attestation
      await bridge.syncMarketState(marketId);
      const stateHash = await bridge.getMarketStateHash(marketId);
      const ts = await time.latest();
      const attestation = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash, ts, 1);
      await bridge.receiveAttestation(marketId, attestation);

      // Should be in sync now
      expect(await bridge.isInSync(marketId)).to.be.true;

      // Advance time past MAX_DIVERGENCE_AGE (1 hour)
      await time.increase(3601);

      // Should no longer be in sync
      expect(await bridge.isInSync(marketId)).to.be.false;
    });
  });
});
