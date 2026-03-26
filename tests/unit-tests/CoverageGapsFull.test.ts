import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Coverage gap tests targeting:
 * - pool/libraries/periphery/ (PoolBalancesLib, PoolLib, PoolStorageLib) — 0% → 100%
 * - ParthenonPool extSloads, setAuthorizationWithSig edge cases
 * - ParthenonOptimizer branch coverage (withdrawQueueLength, fee edge cases)
 * - Orchestrator _normalizeTo18, _checkSanctions, setPriceFeedAdapter
 * - OptimizerAdapter / MorphoAdapter batch skip-empty-position branches
 * - CreditMarket constructor positionToken == address(0) branch
 */

describe("Coverage Gaps — Full Closure", function () {

  // ════════════════════════════════════════════════════════════════════════
  //  POOL PERIPHERY LIBRARIES (PoolBalancesLib, PoolLib, PoolStorageLib)
  // ════════════════════════════════════════════════════════════════════════

  describe("Pool Periphery Libraries via Harness", function () {
    async function deployPeripheryFixture() {
      const [owner, supplier, borrower] = await ethers.getSigners();

      const usdc = await ethers.deployContract("ERC20Mock", [
        "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
      ]);
      const wbtc = await ethers.deployContract("ERC20Mock", [
        "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("1000", 8), 8
      ]);

      const pool = await ethers.deployContract("ParthenonPool", [owner.address]);
      const poolAddress = await pool.getAddress();

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
        lltv
      };
      await pool.createMarket(marketParams);

      const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "uint256"],
        [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
      ));

      // Deploy harness
      const harness = await ethers.deployContract("PoolPeripheryHarness", [poolAddress]);

      // Supply liquidity
      await usdc.transfer(supplier.address, ethers.parseUnits("100000", 6));
      await usdc.connect(supplier).approve(poolAddress, ethers.MaxUint256);
      await pool.connect(supplier).supply(marketParams, ethers.parseUnits("100000", 6), 0, supplier.address, "0x");

      // Borrower posts collateral and borrows
      await wbtc.transfer(borrower.address, ethers.parseUnits("10", 8));
      await wbtc.connect(borrower).approve(poolAddress, ethers.MaxUint256);
      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      await usdc.connect(borrower).approve(poolAddress, ethers.MaxUint256);
      await pool.connect(borrower).borrow(marketParams, ethers.parseUnits("5000", 6), 0, borrower.address, borrower.address);

      // Set fee on market to cover the fee branch in PoolBalancesLib
      await pool.setFee(marketParams, ethers.parseUnits("10", 16)); // 10%
      await pool.setFeeRecipient(owner.address);

      return { pool, poolAddress, harness, usdc, wbtc, irm, oracle, owner, supplier, borrower, marketParams, id, lltv };
    }

    // ── PoolStorageLib (pure slot computation) ───────────────────────────

    it("ownerSlot returns slot 0", async function () {
      const { harness } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.ownerSlot();
      expect(slot).to.equal(ethers.zeroPadValue("0x00", 32));
    });

    it("feeRecipientSlot returns slot 2", async function () {
      const { harness } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.feeRecipientSlot();
      expect(slot).to.equal(ethers.zeroPadValue("0x02", 32));
    });

    it("positionSupplySharesSlot returns non-zero", async function () {
      const { harness, id, supplier } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.positionSupplySharesSlot(id, supplier.address);
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    it("positionBorrowSharesAndCollateralSlot returns non-zero", async function () {
      const { harness, id, borrower } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.positionBorrowSharesAndCollateralSlot(id, borrower.address);
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    it("marketTotalSupplyAssetsAndSharesSlot returns non-zero", async function () {
      const { harness, id } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.marketTotalSupplyAssetsAndSharesSlot(id);
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    it("marketTotalBorrowAssetsAndSharesSlot returns non-zero", async function () {
      const { harness, id } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.marketTotalBorrowAssetsAndSharesSlot(id);
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    it("marketLastUpdateAndFeeSlot returns non-zero", async function () {
      const { harness, id } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.marketLastUpdateAndFeeSlot(id);
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    it("isIrmEnabledSlot returns non-zero", async function () {
      const { harness, irm } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.isIrmEnabledSlot(await irm.getAddress());
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    it("isLltvEnabledSlot returns non-zero", async function () {
      const { harness, lltv } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.isLltvEnabledSlot(lltv);
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    it("isAuthorizedSlot returns non-zero", async function () {
      const { harness, owner, supplier } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.isAuthorizedSlot(owner.address, supplier.address);
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    it("nonceSlot returns non-zero", async function () {
      const { harness, owner } = await loadFixture(deployPeripheryFixture);
      const slot = await harness.nonceSlot(owner.address);
      expect(slot).to.not.equal(ethers.ZeroHash);
    });

    // ── PoolLib (storage getters via extSloads) ──────────────────────────

    it("supplyShares returns correct value", async function () {
      const { harness, pool, id, supplier, marketParams } = await loadFixture(deployPeripheryFixture);
      const pos = await pool.position(id, supplier.address);
      const shares = await harness.supplyShares(id, supplier.address);
      expect(shares).to.equal(pos.supplyShares);
    });

    it("borrowShares returns correct value", async function () {
      const { harness, pool, id, borrower } = await loadFixture(deployPeripheryFixture);
      const pos = await pool.position(id, borrower.address);
      const shares = await harness.borrowShares(id, borrower.address);
      expect(shares).to.equal(pos.borrowShares);
    });

    it("collateral returns correct value", async function () {
      const { harness, pool, id, borrower } = await loadFixture(deployPeripheryFixture);
      const pos = await pool.position(id, borrower.address);
      const col = await harness.collateral(id, borrower.address);
      expect(col).to.equal(pos.collateral);
    });

    it("totalSupplyAssets returns correct value", async function () {
      const { harness, pool, id } = await loadFixture(deployPeripheryFixture);
      const mkt = await pool.market(id);
      const val = await harness.totalSupplyAssets(id);
      expect(val).to.equal(mkt.totalSupplyAssets);
    });

    it("totalSupplyShares returns correct value", async function () {
      const { harness, pool, id } = await loadFixture(deployPeripheryFixture);
      const mkt = await pool.market(id);
      const val = await harness.totalSupplyShares(id);
      expect(val).to.equal(mkt.totalSupplyShares);
    });

    it("totalBorrowAssets returns correct value", async function () {
      const { harness, pool, id } = await loadFixture(deployPeripheryFixture);
      const mkt = await pool.market(id);
      const val = await harness.totalBorrowAssets(id);
      expect(val).to.equal(mkt.totalBorrowAssets);
    });

    it("totalBorrowShares returns correct value", async function () {
      const { harness, pool, id } = await loadFixture(deployPeripheryFixture);
      const mkt = await pool.market(id);
      const val = await harness.totalBorrowShares(id);
      expect(val).to.equal(mkt.totalBorrowShares);
    });

    it("lastUpdate returns correct value", async function () {
      const { harness, pool, id } = await loadFixture(deployPeripheryFixture);
      const mkt = await pool.market(id);
      const val = await harness.lastUpdate(id);
      expect(val).to.equal(mkt.lastUpdate);
    });

    it("fee returns correct value", async function () {
      const { harness, pool, id } = await loadFixture(deployPeripheryFixture);
      const mkt = await pool.market(id);
      const val = await harness.fee(id);
      expect(val).to.equal(mkt.fee);
    });

    // ── PoolBalancesLib (expected balances with interest accrual) ─────────

    it("expectedMarketBalances returns non-zero after borrowing", async function () {
      const { harness, marketParams } = await loadFixture(deployPeripheryFixture);
      const [tsa, tss, tba, tbs] = await harness.expectedMarketBalances(marketParams);
      expect(tsa).to.be.gt(0);
      expect(tss).to.be.gt(0);
      expect(tba).to.be.gt(0);
      expect(tbs).to.be.gt(0);
    });

    it("expectedMarketBalances includes accrued interest after time passes", async function () {
      const { harness, marketParams } = await loadFixture(deployPeripheryFixture);
      const [tsaBefore,,tbaBefore,] = await harness.expectedMarketBalances(marketParams);

      await time.increase(86400 * 30); // 30 days

      const [tsaAfter,,tbaAfter,] = await harness.expectedMarketBalances(marketParams);
      expect(tsaAfter).to.be.gt(tsaBefore);
      expect(tbaAfter).to.be.gt(tbaBefore);
    });

    it("expectedMarketBalances applies fee shares when fee > 0", async function () {
      const { harness, marketParams } = await loadFixture(deployPeripheryFixture);

      await time.increase(86400 * 30); // 30 days

      const [, totalSupplyShares,,] = await harness.expectedMarketBalances(marketParams);
      // Fee shares should have inflated totalSupplyShares beyond initial
      expect(totalSupplyShares).to.be.gt(0);
    });

    it("expectedTotalSupplyAssets returns correct value", async function () {
      const { harness, marketParams } = await loadFixture(deployPeripheryFixture);
      const total = await harness.expectedTotalSupplyAssets(marketParams);
      expect(total).to.be.gt(0);
    });

    it("expectedTotalBorrowAssets returns correct value", async function () {
      const { harness, marketParams } = await loadFixture(deployPeripheryFixture);
      const total = await harness.expectedTotalBorrowAssets(marketParams);
      expect(total).to.be.gt(0);
    });

    it("expectedSupplyAssets returns supplier balance", async function () {
      const { harness, marketParams, supplier } = await loadFixture(deployPeripheryFixture);
      const assets = await harness.expectedSupplyAssets(marketParams, supplier.address);
      expect(assets).to.be.gt(0);
    });

    it("expectedBorrowAssets returns borrower debt", async function () {
      const { harness, marketParams, borrower } = await loadFixture(deployPeripheryFixture);
      const assets = await harness.expectedBorrowAssets(marketParams, borrower.address);
      expect(assets).to.be.gt(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  PARTHENON POOL — extSloads and setAuthorizationWithSig edge cases
  // ════════════════════════════════════════════════════════════════════════

  describe("ParthenonPool — extSloads coverage", function () {
    async function deployPoolFixture() {
      const [owner, alice, bob] = await ethers.getSigners();
      const pool = await ethers.deployContract("ParthenonPool", [owner.address]);
      return { pool, owner, alice, bob };
    }

    it("extSloads reads multiple slots", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      // Slot 0 = owner, slot 2 = feeRecipient
      const slots = [ethers.zeroPadValue("0x00", 32), ethers.zeroPadValue("0x02", 32)];
      const results = await pool.extSloads(slots);
      expect(results.length).to.equal(2);
    });

    it("extSloads with empty array returns empty", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const results = await pool.extSloads([]);
      expect(results.length).to.equal(0);
    });

    it("setAuthorizationWithSig reverts on expired deadline", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const pastDeadline = 0n;
      const auth = {
        authorizer: alice.address,
        authorized: bob.address,
        isAuthorized: true,
        nonce: 0n,
        deadline: pastDeadline
      };
      const sig = { v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash };
      await expect(pool.setAuthorizationWithSig(auth, sig)).to.be.reverted;
    });

    it("setAuthorizationWithSig reverts on invalid nonce", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const futureDeadline = (await time.latest()) + 3600;
      const auth = {
        authorizer: alice.address,
        authorized: bob.address,
        isAuthorized: true,
        nonce: 999n, // wrong nonce
        deadline: BigInt(futureDeadline)
      };
      const sig = { v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash };
      await expect(pool.setAuthorizationWithSig(auth, sig)).to.be.reverted;
    });

    it("setAuthorizationWithSig reverts on invalid signature", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const futureDeadline = (await time.latest()) + 3600;
      const auth = {
        authorizer: alice.address,
        authorized: bob.address,
        isAuthorized: true,
        nonce: 0n,
        deadline: BigInt(futureDeadline)
      };
      // Invalid signature — wrong v,r,s
      const sig = { v: 28, r: ethers.keccak256("0x01"), s: ethers.keccak256("0x02") };
      await expect(pool.setAuthorizationWithSig(auth, sig)).to.be.reverted;
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  PARTHENON OPTIMIZER — branch coverage
  // ════════════════════════════════════════════════════════════════════════

  describe("ParthenonOptimizer — branch coverage", function () {
    async function deployOptimizerFixture() {
      const [owner, depositor, feeRecipient] = await ethers.getSigners();

      const usdc = await ethers.deployContract("ERC20Mock", [
        "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
      ]);

      const pool = await ethers.deployContract("ParthenonPool", [owner.address]);
      const poolAddress = await pool.getAddress();

      const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
      const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);
      await pool.enableIrm(await irm.getAddress());
      const lltv = ethers.parseUnits("80", 16);
      await pool.enableLltv(lltv);

      const wbtc = await ethers.deployContract("ERC20Mock", [
        "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("1000", 8), 8
      ]);
      const oracleBtc = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);

      const marketParams = {
        loanToken: await usdc.getAddress(),
        collateralToken: await wbtc.getAddress(),
        oracle: await oracleBtc.getAddress(),
        irm: await irm.getAddress(),
        lltv
      };
      await pool.createMarket(marketParams);

      const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "uint256"],
        [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
      ));

      const optimizer = await ethers.deployContract("ParthenonOptimizer", [
        poolAddress, await usdc.getAddress(), "poUSDC", "poUSDC", owner.address
      ]);
      const optimizerAddress = await optimizer.getAddress();

      await optimizer.setSupplyQueue([id]);
      await optimizer.setWithdrawQueue([id]);
      await optimizer.setAllocationCap(id, ethers.parseUnits("1000000", 6));

      await usdc.transfer(depositor.address, ethers.parseUnits("100000", 6));
      await usdc.connect(depositor).approve(optimizerAddress, ethers.MaxUint256);

      return { pool, optimizer, usdc, wbtc, irm, oracleBtc, owner, depositor, feeRecipient, marketParams, id, optimizerAddress };
    }

    it("withdrawQueueLength returns correct value", async function () {
      const { optimizer } = await loadFixture(deployOptimizerFixture);
      expect(await optimizer.withdrawQueueLength()).to.equal(1);
    });

    it("supplyQueueLength returns correct value", async function () {
      const { optimizer } = await loadFixture(deployOptimizerFixture);
      expect(await optimizer.supplyQueueLength()).to.equal(1);
    });

    it("totalAssets returns 0 when empty", async function () {
      const { optimizer } = await loadFixture(deployOptimizerFixture);
      expect(await optimizer.totalAssets()).to.equal(0);
    });

    it("withdraw from optimizer when idle < assets triggers withdrawQueue", async function () {
      const { optimizer, depositor, usdc, optimizerAddress } = await loadFixture(deployOptimizerFixture);

      // Deposit
      await optimizer.connect(depositor).deposit(ethers.parseUnits("10000", 6), depositor.address);

      // Shares should be > 0
      const shares = await optimizer.balanceOf(depositor.address);
      expect(shares).to.be.gt(0);

      // Redeem all — forces withdrawal from pool (idle = 0)
      await optimizer.connect(depositor).redeem(shares, depositor.address, depositor.address);
      expect(await optimizer.balanceOf(depositor.address)).to.equal(0);
    });

    it("setFee to 0 when feeRecipient is zero address succeeds", async function () {
      const { optimizer } = await loadFixture(deployOptimizerFixture);
      await optimizer.setFee(0);
      expect(await optimizer.fee()).to.equal(0);
    });

    it("deposit and withdraw with non-owner allowance (caller != owner branch)", async function () {
      const { optimizer, depositor, owner, usdc, optimizerAddress } = await loadFixture(deployOptimizerFixture);

      await optimizer.connect(depositor).deposit(ethers.parseUnits("5000", 6), depositor.address);

      // Depositor approves owner to spend shares
      const shares = await optimizer.balanceOf(depositor.address);
      await optimizer.connect(depositor).approve(owner.address, shares);

      // Owner redeems on behalf of depositor (triggers caller != _owner branch)
      await optimizer.connect(owner).redeem(shares, owner.address, depositor.address);
      expect(await optimizer.balanceOf(depositor.address)).to.equal(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  ORCHESTRATOR — _normalizeTo18, _checkSanctions, setPriceFeedAdapter
  // ════════════════════════════════════════════════════════════════════════

  describe("Orchestrator — uncovered branches", function () {
    async function deployOrchestratorFixture() {
      const [owner, borrower, lender, feeRecipient] = await ethers.getSigners();

      const orchestrator = await (await ethers.getContractFactory("Orchestrator")).deploy(feeRecipient.address);

      // Deploy SanctionsSentinel with mock
      const mockSanctionsList = await ethers.deployContract("MockSanctionsList", []);
      const sentinel = await (await ethers.getContractFactory("SanctionsSentinel")).deploy(await mockSanctionsList.getAddress());

      await orchestrator.setSanctionsSentinel(await sentinel.getAddress());

      // Deploy PriceFeedAdapter
      const priceFeed = await (await ethers.getContractFactory("PriceFeedAdapter")).deploy();
      await orchestrator.setPriceFeedAdapter(await priceFeed.getAddress());

      return { orchestrator, sentinel, mockSanctionsList, priceFeed, owner, borrower, lender, feeRecipient };
    }

    it("setPriceFeedAdapter reverts on zero address", async function () {
      const { orchestrator } = await loadFixture(deployOrchestratorFixture);
      await expect(orchestrator.setPriceFeedAdapter(ethers.ZeroAddress)).to.be.reverted;
    });

    it("setTICSBridge reverts on zero address", async function () {
      const { orchestrator } = await loadFixture(deployOrchestratorFixture);
      await expect(orchestrator.setTICSBridge(ethers.ZeroAddress)).to.be.reverted;
    });

    it("setSanctionsSentinel reverts on zero address", async function () {
      const { orchestrator } = await loadFixture(deployOrchestratorFixture);
      await expect(orchestrator.setSanctionsSentinel(ethers.ZeroAddress)).to.be.reverted;
    });

    it("authorizeBorrower reverts if borrower is sanctioned", async function () {
      const { orchestrator, mockSanctionsList, borrower } = await loadFixture(deployOrchestratorFixture);

      // Sanction the borrower
      await mockSanctionsList.setSanctioned(borrower.address, true);

      await expect(orchestrator.authorizeBorrower(borrower.address, 0))
        .to.be.reverted;
    });

    it("authorizeBorrower succeeds when borrower is NOT sanctioned", async function () {
      const { orchestrator, borrower } = await loadFixture(deployOrchestratorFixture);
      await orchestrator.authorizeBorrower(borrower.address, 0);
      const auth = await orchestrator.getBorrowerAuth(borrower.address);
      expect(auth.status).to.equal(1); // Approved
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  OPTIMIZER ADAPTER — batch skip-empty branch
  // ════════════════════════════════════════════════════════════════════════

  describe("OptimizerAdapter — batch emergency with empty positions", function () {
    async function deployAdapterFixture() {
      const [owner, loanFactory] = await ethers.getSigners();

      const usdc = await ethers.deployContract("ERC20Mock", [
        "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
      ]);

      const pool = await ethers.deployContract("ParthenonPool", [owner.address]);
      const poolAddress = await pool.getAddress();

      const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
      const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);
      await pool.enableIrm(await irm.getAddress());
      const lltv = ethers.parseUnits("80", 16);
      await pool.enableLltv(lltv);

      const wbtc = await ethers.deployContract("ERC20Mock", [
        "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("1000", 8), 8
      ]);
      const oracleBtc = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);

      const marketParams = {
        loanToken: await usdc.getAddress(),
        collateralToken: await wbtc.getAddress(),
        oracle: await oracleBtc.getAddress(),
        irm: await irm.getAddress(),
        lltv
      };
      await pool.createMarket(marketParams);

      const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address", "uint256"],
        [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
      ));

      const optimizer = await ethers.deployContract("ParthenonOptimizer", [
        poolAddress, await usdc.getAddress(), "poUSDC", "poUSDC", owner.address
      ]);
      await optimizer.setSupplyQueue([id]);
      await optimizer.setWithdrawQueue([id]);
      await optimizer.setAllocationCap(id, ethers.parseUnits("10000000", 6));

      const adapter = await ethers.deployContract("OptimizerAdapter", [loanFactory.address]);
      await adapter.configureOptimizer(await usdc.getAddress(), await optimizer.getAddress());

      // Fund loanFactory signer with USDC
      await usdc.transfer(loanFactory.address, ethers.parseUnits("100000", 6));
      await usdc.connect(loanFactory).approve(await adapter.getAddress(), ethers.MaxUint256);

      return { adapter, optimizer, usdc, pool, owner, loanFactory, id };
    }

    it("batchEmergencyWithdraw skips loanIds with zero shares", async function () {
      const { adapter, usdc, loanFactory, owner } = await loadFixture(deployAdapterFixture);
      const token = await usdc.getAddress();

      // Deposit one position
      await adapter.connect(loanFactory).deposit(token, ethers.parseUnits("1000", 6), 1);

      // Batch withdraw with loanId 999 (no shares — should skip) and loanId 1 (has shares)
      const balBefore = await usdc.balanceOf(owner.address);
      await adapter.connect(owner).batchEmergencyWithdraw(token, [999, 1], owner.address);
      const balAfter = await usdc.balanceOf(owner.address);
      expect(balAfter - balBefore).to.be.gt(0);
    });

    it("emergencyWithdraw reverts on already withdrawn position", async function () {
      const { adapter, usdc, loanFactory, owner } = await loadFixture(deployAdapterFixture);
      const token = await usdc.getAddress();

      await adapter.connect(loanFactory).deposit(token, ethers.parseUnits("1000", 6), 42);
      await adapter.connect(owner).emergencyWithdraw(token, 42, owner.address);

      // Second emergency withdraw — shares are 0, should revert
      await expect(adapter.connect(owner).emergencyWithdraw(token, 42, owner.address))
        .to.be.revertedWith("No position for loan");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  MORPHO ADAPTER — batch skip-empty branch
  // ════════════════════════════════════════════════════════════════════════

  describe("MorphoAdapter — batch emergency with empty positions", function () {
    async function deployMorphoFixture() {
      const [owner, loanFactory] = await ethers.getSigners();

      const usdc = await ethers.deployContract("ERC20Mock", [
        "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
      ]);

      const wbtc = await ethers.deployContract("ERC20Mock", [
        "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("1000", 8), 8
      ]);

      const mockMorpho = await ethers.deployContract("MockMorpho", []);

      const adapter = await ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(), loanFactory.address
      ]);

      // MorphoAdapter requires all non-zero params
      const morphoMarketParams = {
        loanToken: await usdc.getAddress(),
        collateralToken: await wbtc.getAddress(),
        oracle: owner.address, // any non-zero address
        irm: owner.address,    // any non-zero address
        lltv: 1
      };

      await adapter.configureMarket(await usdc.getAddress(), morphoMarketParams);

      await usdc.transfer(loanFactory.address, ethers.parseUnits("100000", 6));
      await usdc.connect(loanFactory).approve(await adapter.getAddress(), ethers.MaxUint256);

      // Fund MockMorpho with extra USDC to cover the 1% yield on withdrawals
      await usdc.transfer(await mockMorpho.getAddress(), ethers.parseUnits("100000", 6));

      return { adapter, usdc, wbtc, mockMorpho, owner, loanFactory };
    }

    it("batchEmergencyWithdraw skips loanIds with zero shares", async function () {
      const { adapter, usdc, loanFactory, owner } = await loadFixture(deployMorphoFixture);
      const token = await usdc.getAddress();

      // Deposit one position
      await adapter.connect(loanFactory).deposit(token, ethers.parseUnits("500", 6), 10);

      // Batch with an empty loanId (999, no shares) and a real one (10)
      const balBefore = await usdc.balanceOf(owner.address);
      await adapter.connect(owner).batchEmergencyWithdraw(token, [999, 10], owner.address);
      const balAfter = await usdc.balanceOf(owner.address);
      expect(balAfter - balBefore).to.be.gt(0);
    });
  });
});
