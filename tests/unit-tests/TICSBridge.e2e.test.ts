/**
 * TICSBridge.e2e.test.ts
 *
 * End-to-end integration test for TICSBridge — full lifecycle covering:
 *   1. Deploy Orchestrator, authorize borrower, create CreditMarket
 *   2. Deploy TICSBridge with relayer + attester, register market
 *   3. Lender deposits into market
 *   4. Borrower borrows from market
 *   5. syncMarketState() => capture state hash
 *   6. Sign attestation with ECDSA, call receiveAttestation
 *   7. Assert isInSync() == true
 *   8. State change (repay) => assert isInSync() == false
 *   9. Re-sync + re-attest => assert isInSync() == true again
 *
 * Run: npx hardhat test --grep "TICSBridge.*E2E"
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// Deterministic private key for the attester wallet (test only)
const ATTESTER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("TICSBridge E2E Integration", function () {
  // ─── Helper: create a signed attestation ─────────────────────────────

  async function signAttestation(
    signerKey: string,
    marketId: string,
    stateHash: string,
    cantonTimestamp: number
  ): Promise<string> {
    const wallet = new ethers.Wallet(signerKey, ethers.provider);
    const msgHash = ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32", "uint64"],
      [marketId, stateHash, cantonTimestamp]
    );
    const sig = await wallet.signMessage(ethers.getBytes(msgHash));
    const attestation = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint64", "bytes"],
      [stateHash, cantonTimestamp, sig]
    );
    return attestation;
  }

  // ─── Fixture: full deployment ────────────────────────────────────────

  async function deployFullStackFixture() {
    const [owner, relayer, borrower, lender, extra] =
      await ethers.getSigners();

    // Attester wallet from deterministic key
    const attesterWallet = new ethers.Wallet(
      ATTESTER_PRIVATE_KEY,
      ethers.provider
    );

    // 1. Deploy mock USDC (6 decimals)
    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin",
      "USDC",
      owner.address,
      ethers.parseUnits("10000000", 6),
      6,
    ]);
    await usdc.waitForDeployment();

    // 2. Deploy Orchestrator
    const orchestrator = await ethers.deployContract("Orchestrator", [
      owner.address,
    ]);
    await orchestrator.waitForDeployment();

    // 3. Authorize borrower (TIER_2 = 1)
    await orchestrator.authorizeBorrower(borrower.address, 1);

    // 4. Create CreditMarket via Orchestrator
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

    const createTx = await orchestrator.createMarket(
      borrower.address,
      await usdc.getAddress(),
      marketParams
    );
    await createTx.wait();

    const marketAddress = await orchestrator.getMarket(
      borrower.address,
      await usdc.getAddress()
    );
    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    // 5. Deploy TICSBridge
    const TICSBridge = await ethers.getContractFactory("TICSBridge");
    const bridge = await TICSBridge.deploy(
      relayer.address,
      attesterWallet.address
    );
    await bridge.waitForDeployment();

    // 6. Compute marketId — keccak256(borrower, asset)
    const marketId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address"],
        [borrower.address, await usdc.getAddress()]
      )
    );

    // 7. Register market on bridge
    await bridge.registerMarket(marketId, marketAddress);

    // 8. Register lender on orchestrator
    await orchestrator.registerLender(marketAddress, lender.address);

    // 9. Fund lender with USDC
    await usdc.transfer(lender.address, ethers.parseUnits("100000", 6));

    // 10. Fund borrower with USDC (for repayments)
    await usdc.transfer(borrower.address, ethers.parseUnits("50000", 6));

    return {
      bridge,
      orchestrator,
      market,
      usdc,
      owner,
      relayer,
      borrower,
      lender,
      extra,
      marketId,
      marketAddress,
      attesterWallet,
    };
  }

  // ─── Full Lifecycle E2E ──────────────────────────────────────────────

  describe("Full Lifecycle E2E", function () {
    it("completes the full sync-attest-desync-resync lifecycle", async function () {
      const {
        bridge,
        market,
        usdc,
        relayer,
        borrower,
        lender,
        marketId,
        marketAddress,
      } = await loadFixture(deployFullStackFixture);

      // ── Step 1: Initial state — not in sync (no state or attestation)
      expect(await bridge.isInSync(marketId)).to.be.false;

      // ── Step 2: Lender deposits into market
      const depositAmount = ethers.parseUnits("50000", 6);
      await usdc
        .connect(lender)
        .approve(marketAddress, depositAmount);
      await market
        .connect(lender)
        .deposit(depositAmount, lender.address);

      // ── Step 3: Borrower borrows from market
      const borrowAmount = ethers.parseUnits("10000", 6);
      await market.connect(borrower).borrow(borrowAmount);

      // ── Step 4: syncMarketState() — capture state hash
      await bridge.connect(relayer).syncMarketState(marketId);
      const stateHashAfterBorrow = await bridge.getMarketStateHash(marketId);
      expect(stateHashAfterBorrow).to.not.equal(ethers.ZeroHash);

      // ── Step 5: Sign attestation with ECDSA and submit
      const ts1 = await time.latest();
      const attestation1 = await signAttestation(
        ATTESTER_PRIVATE_KEY,
        marketId,
        stateHashAfterBorrow,
        ts1
      );

      await expect(
        bridge.connect(relayer).receiveAttestation(marketId, attestation1)
      )
        .to.emit(bridge, "AttestationReceived")
        .withArgs(marketId, stateHashAfterBorrow, ts1);

      // ── Step 6: Assert isInSync() == true
      expect(await bridge.isInSync(marketId)).to.be.true;

      // ── Step 7: State change (borrower repays) — desync
      const repayAmount = ethers.parseUnits("5000", 6);
      await usdc
        .connect(borrower)
        .approve(marketAddress, repayAmount);
      await market.connect(borrower).repay(repayAmount);

      // The on-chain market state changed, but the bridge still has the old
      // state hash and attestation. Re-syncing will compute a new state hash
      // that no longer matches the attestation.
      await bridge.connect(relayer).syncMarketState(marketId);
      const stateHashAfterRepay = await bridge.getMarketStateHash(marketId);

      // State hash must differ after repayment
      expect(stateHashAfterRepay).to.not.equal(stateHashAfterBorrow);

      // ── Step 8: Assert isInSync() == false (state hash changed, attestation stale)
      expect(await bridge.isInSync(marketId)).to.be.false;

      // ── Step 9: Re-attest with new state hash => back in sync
      const ts2 = await time.latest();
      const attestation2 = await signAttestation(
        ATTESTER_PRIVATE_KEY,
        marketId,
        stateHashAfterRepay,
        ts2
      );

      await bridge.connect(relayer).receiveAttestation(marketId, attestation2);

      // ── Step 10: Assert isInSync() == true again
      expect(await bridge.isInSync(marketId)).to.be.true;
    });
  });

  // ─── Edge Cases in E2E Context ───────────────────────────────────────

  describe("E2E Edge Cases", function () {
    it("sync before any market activity produces a valid state hash", async function () {
      const { bridge, relayer, marketId } = await loadFixture(
        deployFullStackFixture
      );

      // Sync on a fresh market with no deposits or borrows
      await bridge.connect(relayer).syncMarketState(marketId);
      const stateHash = await bridge.getMarketStateHash(marketId);
      expect(stateHash).to.not.equal(ethers.ZeroHash);
    });

    it("multiple deposits and borrows produce distinct state hashes", async function () {
      const { bridge, market, usdc, relayer, borrower, lender, marketId, marketAddress } =
        await loadFixture(deployFullStackFixture);

      // Sync initial state
      await bridge.connect(relayer).syncMarketState(marketId);
      const hash0 = await bridge.getMarketStateHash(marketId);

      // Deposit
      await usdc
        .connect(lender)
        .approve(marketAddress, ethers.parseUnits("20000", 6));
      await market
        .connect(lender)
        .deposit(ethers.parseUnits("20000", 6), lender.address);
      await bridge.connect(relayer).syncMarketState(marketId);
      const hash1 = await bridge.getMarketStateHash(marketId);
      expect(hash1).to.not.equal(hash0);

      // Borrow
      await market
        .connect(borrower)
        .borrow(ethers.parseUnits("5000", 6));
      await bridge.connect(relayer).syncMarketState(marketId);
      const hash2 = await bridge.getMarketStateHash(marketId);
      expect(hash2).to.not.equal(hash1);

      // Second deposit
      await usdc
        .connect(lender)
        .approve(marketAddress, ethers.parseUnits("10000", 6));
      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);
      await bridge.connect(relayer).syncMarketState(marketId);
      const hash3 = await bridge.getMarketStateHash(marketId);
      expect(hash3).to.not.equal(hash2);
    });

    it("attestation with wrong state hash does not achieve sync", async function () {
      const { bridge, market, usdc, relayer, lender, marketId, marketAddress } =
        await loadFixture(deployFullStackFixture);

      // Deposit + sync
      await usdc
        .connect(lender)
        .approve(marketAddress, ethers.parseUnits("10000", 6));
      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);
      await bridge.connect(relayer).syncMarketState(marketId);

      // Attest with a fabricated (wrong) state hash
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("wrong-data"));
      const ts = await time.latest();
      const attestation = await signAttestation(
        ATTESTER_PRIVATE_KEY,
        marketId,
        wrongHash,
        ts
      );
      await bridge.connect(relayer).receiveAttestation(marketId, attestation);

      // Should NOT be in sync
      expect(await bridge.isInSync(marketId)).to.be.false;
    });

    it("owner can also sync and attest (not just relayer)", async function () {
      const { bridge, market, usdc, owner, lender, marketId, marketAddress } =
        await loadFixture(deployFullStackFixture);

      // Deposit
      await usdc
        .connect(lender)
        .approve(marketAddress, ethers.parseUnits("5000", 6));
      await market
        .connect(lender)
        .deposit(ethers.parseUnits("5000", 6), lender.address);

      // Owner syncs
      await bridge.connect(owner).syncMarketState(marketId);
      const stateHash = await bridge.getMarketStateHash(marketId);

      // Owner attests
      const ts = await time.latest();
      const attestation = await signAttestation(
        ATTESTER_PRIVATE_KEY,
        marketId,
        stateHash,
        ts
      );
      await bridge.connect(owner).receiveAttestation(marketId, attestation);

      expect(await bridge.isInSync(marketId)).to.be.true;
    });

    it("interest accrual changes state hash over time", async function () {
      const { bridge, market, usdc, relayer, borrower, lender, marketId, marketAddress } =
        await loadFixture(deployFullStackFixture);

      // Deposit + borrow to activate interest
      await usdc
        .connect(lender)
        .approve(marketAddress, ethers.parseUnits("50000", 6));
      await market
        .connect(lender)
        .deposit(ethers.parseUnits("50000", 6), lender.address);
      await market
        .connect(borrower)
        .borrow(ethers.parseUnits("10000", 6));

      // Sync now
      await bridge.connect(relayer).syncMarketState(marketId);
      const hashBefore = await bridge.getMarketStateHash(marketId);

      // Advance time to accrue interest
      await time.increase(30 * 24 * 3600); // 30 days

      // Trigger interest accrual
      await market.accrueInterest();

      // Re-sync
      await bridge.connect(relayer).syncMarketState(marketId);
      const hashAfter = await bridge.getMarketStateHash(marketId);

      expect(hashAfter).to.not.equal(hashBefore);
    });
  });
});
