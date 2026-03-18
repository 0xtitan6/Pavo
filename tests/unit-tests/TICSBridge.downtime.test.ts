/**
 * TICSBridge.downtime.test.ts
 *
 * Tests for keeper/relayer downtime recovery scenarios.
 * Simulates extended periods without relayer activity and verifies
 * correct recovery behavior.
 *
 * Run: npx hardhat test --grep "keeper downtime"
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const ATTESTER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ONE_HOUR = 3600;
const ONE_DAY = 86400;

describe("TICSBridge keeper downtime recovery", function () {
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
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint64", "uint256", "bytes"],
      [stateHash, cantonTimestamp, nonce, sig]
    );
  }

  async function deployDowntimeFixture() {
    const [owner, relayer, borrower, lender, nonOwner] = await ethers.getSigners();
    const attesterWallet = new ethers.Wallet(ATTESTER_PRIVATE_KEY, ethers.provider);

    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6,
    ]);
    await usdc.waitForDeployment();

    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);
    await orchestrator.waitForDeployment();
    await orchestrator.authorizeBorrower(borrower.address, 1);

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

    const TICSBridge = await ethers.getContractFactory("TICSBridge");
    const bridge = await TICSBridge.deploy(relayer.address, attesterWallet.address);
    await bridge.waitForDeployment();

    const marketId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address"],
        [borrower.address, await usdc.getAddress()]
      )
    );

    await bridge.registerMarket(marketId, marketAddress);
    await orchestrator.registerLender(marketAddress, lender.address);
    await usdc.transfer(lender.address, ethers.parseUnits("100000", 6));
    await usdc.transfer(borrower.address, ethers.parseUnits("50000", 6));

    return {
      bridge, market, usdc, orchestrator,
      owner, relayer, borrower, lender, nonOwner,
      marketId, marketAddress, attesterWallet,
    };
  }

  it("isInSync returns false after MAX_DIVERGENCE_AGE without relayer", async function () {
    const { bridge, market, usdc, relayer, lender, borrower, marketId, marketAddress } =
      await loadFixture(deployDowntimeFixture);

    // Deposit and borrow to create activity
    await usdc.connect(lender).approve(marketAddress, ethers.parseUnits("50000", 6));
    await market.connect(lender).deposit(ethers.parseUnits("50000", 6), lender.address);
    await market.connect(borrower).borrow(ethers.parseUnits("10000", 6));

    // Sync and attest — should be in sync
    await bridge.connect(relayer).syncMarketState(marketId);
    const stateHash = await bridge.getMarketStateHash(marketId);
    const ts = await time.latest();
    const attestation = await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash, ts, 1);
    await bridge.connect(relayer).receiveAttestation(marketId, attestation);
    expect(await bridge.isInSync(marketId)).to.be.true;

    // Simulate 24h downtime — no relayer activity
    await time.increase(24 * ONE_HOUR);

    // isInSync should return false (attestation older than MAX_DIVERGENCE_AGE)
    expect(await bridge.isInSync(marketId)).to.be.false;
  });

  it("relayer restart triggers successful catchup sync after 24h gap", async function () {
    const { bridge, market, usdc, relayer, lender, borrower, marketId, marketAddress } =
      await loadFixture(deployDowntimeFixture);

    // Initial setup: deposit, borrow, sync, attest
    await usdc.connect(lender).approve(marketAddress, ethers.parseUnits("50000", 6));
    await market.connect(lender).deposit(ethers.parseUnits("50000", 6), lender.address);
    await market.connect(borrower).borrow(ethers.parseUnits("10000", 6));

    await bridge.connect(relayer).syncMarketState(marketId);
    const stateHash1 = await bridge.getMarketStateHash(marketId);
    const ts1 = await time.latest();
    await bridge.connect(relayer).receiveAttestation(
      marketId,
      await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash1, ts1, 1)
    );
    expect(await bridge.isInSync(marketId)).to.be.true;

    // 24h downtime
    await time.increase(24 * ONE_HOUR);
    expect(await bridge.isInSync(marketId)).to.be.false;

    // Accrue interest during downtime changes state
    await market.accrueInterest();

    // Relayer restarts — catchup sync
    await bridge.connect(relayer).syncMarketState(marketId);
    const stateHash2 = await bridge.getMarketStateHash(marketId);
    expect(stateHash2).to.not.equal(stateHash1); // State changed during downtime

    // Fresh attestation with incremented nonce
    const ts2 = await time.latest();
    await bridge.connect(relayer).receiveAttestation(
      marketId,
      await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash2, ts2, 2)
    );

    // Should be back in sync
    expect(await bridge.isInSync(marketId)).to.be.true;
    expect(await bridge.getLastNonce(marketId)).to.equal(2);
  });

  it("attestation with fresh nonce succeeds after prolonged gap", async function () {
    const { bridge, relayer, marketId } = await loadFixture(deployDowntimeFixture);

    // First attestation
    const hash1 = ethers.keccak256(ethers.toUtf8Bytes("state-1"));
    const ts1 = await time.latest();
    await bridge.connect(relayer).receiveAttestation(
      marketId,
      await signAttestation(ATTESTER_PRIVATE_KEY, marketId, hash1, ts1, 1)
    );
    expect(await bridge.getLastNonce(marketId)).to.equal(1);

    // 24h gap
    await time.increase(24 * ONE_HOUR);

    // Nonce 2 should succeed (nonce must only be strictly increasing, no continuity required)
    const hash2 = ethers.keccak256(ethers.toUtf8Bytes("state-2"));
    const ts2 = await time.latest();
    await bridge.connect(relayer).receiveAttestation(
      marketId,
      await signAttestation(ATTESTER_PRIVATE_KEY, marketId, hash2, ts2, 2)
    );
    expect(await bridge.getLastNonce(marketId)).to.equal(2);

    // Skipping nonces should also work (nonce 10 after nonce 2)
    const hash3 = ethers.keccak256(ethers.toUtf8Bytes("state-3"));
    const ts3 = await time.latest();
    await bridge.connect(relayer).receiveAttestation(
      marketId,
      await signAttestation(ATTESTER_PRIVATE_KEY, marketId, hash3, ts3, 10)
    );
    expect(await bridge.getLastNonce(marketId)).to.equal(10);
  });

  it("Reserved collateral times out via releaseTimedOutReservation after downtime", async function () {
    const { bridge, relayer, borrower, marketId } = await loadFixture(deployDowntimeFixture);
    const amount = ethers.parseUnits("10000", 6);

    // Reserve collateral
    await bridge.connect(relayer).requestCollateralReserve(marketId, borrower.address, amount);
    let cs = await bridge.getCollateralState(marketId);
    expect(cs.status).to.equal(1); // Reserved

    // Simulate downtime — advance past LOCK_TIMEOUT (1 hour)
    await time.increase(ONE_HOUR + 1);

    // Release timed-out reservation
    await expect(bridge.connect(relayer).releaseTimedOutReservation(marketId))
      .to.emit(bridge, "CollateralReservationTimedOut");

    cs = await bridge.getCollateralState(marketId);
    expect(cs.status).to.equal(0); // None (reset)
    expect(cs.amount).to.equal(0);
  });

  it("multiple sync-attest cycles work correctly after recovery", async function () {
    const { bridge, market, usdc, relayer, lender, borrower, marketId, marketAddress } =
      await loadFixture(deployDowntimeFixture);

    await usdc.connect(lender).approve(marketAddress, ethers.parseUnits("50000", 6));
    await market.connect(lender).deposit(ethers.parseUnits("50000", 6), lender.address);

    // 3 sequential sync-attest cycles simulating intermittent connectivity
    for (let i = 1; i <= 3; i++) {
      // Some activity
      if (i === 1) {
        await market.connect(borrower).borrow(ethers.parseUnits("5000", 6));
      } else {
        await market.accrueInterest();
      }

      // Brief downtime between cycles
      await time.increase(2 * ONE_HOUR);

      // Sync and attest
      await bridge.connect(relayer).syncMarketState(marketId);
      const stateHash = await bridge.getMarketStateHash(marketId);
      const ts = await time.latest();
      await bridge.connect(relayer).receiveAttestation(
        marketId,
        await signAttestation(ATTESTER_PRIVATE_KEY, marketId, stateHash, ts, i)
      );

      expect(await bridge.isInSync(marketId)).to.be.true;
      expect(await bridge.getLastNonce(marketId)).to.equal(i);
    }
  });
});
