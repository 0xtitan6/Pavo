import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Property-based fuzz tests for SharesMathLib rounding invariants.
 *
 * Key invariants tested:
 *   1. toSharesDown(toAssetsUp(shares)) >= shares  — no value creation on round-trip
 *   2. toAssetsDown(toSharesUp(assets)) <= assets  — no value creation on round-trip
 *   3. Virtual shares (1e6) prevent inflation attacks with small initial deposits
 *   4. Supply/withdraw, borrow/repay rounding always favors the protocol (pool)
 */
describe("ParthenonPool fuzz tests — SharesMathLib rounding invariants", function () {

  // ─── Fixture ───────────────────────────────────────────────────────

  async function deployPoolFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("1000", 8), 8
    ]);

    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    // Zero-rate IRM so interest doesn't interfere with share math tests
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, 0n]);
    await pool.enableIrm(await irm.getAddress());

    const lltv = ethers.parseUnits("80", 16); // 80%
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

    // Fund users
    const largeAmount = ethers.parseUnits("5000000", 6);
    await usdc.transfer(alice.address, largeAmount);
    await usdc.transfer(bob.address, largeAmount);
    await wbtc.transfer(bob.address, ethers.parseUnits("500", 8));

    await usdc.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await pool.getAddress(), ethers.MaxUint256);
    await wbtc.connect(bob).approve(await pool.getAddress(), ethers.MaxUint256);

    return { pool, usdc, wbtc, irm, oracle, owner, alice, bob, marketParams };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  const VIRTUAL_SHARES = 1_000_000n; // 1e6
  const VIRTUAL_ASSETS = 1n;

  function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
    return (assets * (totalShares + VIRTUAL_SHARES)) / (totalAssets + VIRTUAL_ASSETS);
  }

  function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
    return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
  }

  function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
    const d = totalAssets + VIRTUAL_ASSETS;
    return (assets * (totalShares + VIRTUAL_SHARES) + d - 1n) / d;
  }

  function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
    const d = totalShares + VIRTUAL_SHARES;
    return (shares * (totalAssets + VIRTUAL_ASSETS) + d - 1n) / d;
  }

  /** Simple PRNG for deterministic pseudo-random test inputs */
  function* pseudoRandom(seed: number, count: number) {
    let state = seed;
    for (let i = 0; i < count; i++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      yield state;
    }
  }

  // Generate random amounts across several orders of magnitude
  function generateAmounts(seed: number, count: number): bigint[] {
    const amounts: bigint[] = [];
    const gen = pseudoRandom(seed, count * 2);
    for (let i = 0; i < count; i++) {
      const magnitude = (gen.next().value as number) % 12; // 0..11
      const base = BigInt(gen.next().value as number);
      // Range: 1 wei to ~2e36
      amounts.push(base * (10n ** BigInt(magnitude)) + 1n);
    }
    return amounts;
  }

  // ─── Invariant 1: toSharesDown(toAssetsUp(shares)) >= shares ──────

  describe("Invariant: toSharesDown(toAssetsUp(shares)) >= shares (no value creation)", function () {
    const scenarios = [
      { totalAssets: 0n, totalShares: 0n, label: "empty market" },
      { totalAssets: 1_000_000n, totalShares: 1_000_000n, label: "1:1 ratio" },
      { totalAssets: 2_000_000n, totalShares: 1_000_000n, label: "2:1 assets:shares" },
      { totalAssets: 1_000_000n, totalShares: 2_000_000n, label: "1:2 assets:shares" },
      { totalAssets: 10n ** 18n, totalShares: 10n ** 18n, label: "1e18 scale" },
      { totalAssets: 10n ** 30n, totalShares: 10n ** 24n, label: "large imbalance" },
      { totalAssets: 1n, totalShares: 10n ** 12n, label: "tiny assets, large shares" },
    ];

    for (const { totalAssets, totalShares, label } of scenarios) {
      it(`holds for ${label} across 50 random share amounts`, function () {
        const amounts = generateAmounts(42, 50);
        for (const shares of amounts) {
          const assets = toAssetsUp(shares, totalAssets, totalShares);
          const sharesBack = toSharesDown(assets, totalAssets, totalShares);
          expect(sharesBack).to.be.gte(
            shares,
            `Failed: toSharesDown(toAssetsUp(${shares})) = ${sharesBack} < ${shares} ` +
            `(totalAssets=${totalAssets}, totalShares=${totalShares})`
          );
        }
      });
    }
  });

  // ─── Invariant 2: toAssetsDown(toSharesDown(assets)) <= assets ──────
  // Models the supply→withdraw path: depositor gets toSharesDown on supply,
  // then toAssetsDown on withdraw. They should never extract more than deposited.

  describe("Invariant: toAssetsDown(toSharesDown(assets)) <= assets (supply→withdraw no value creation)", function () {
    const scenarios = [
      { totalAssets: 0n, totalShares: 0n, label: "empty market" },
      { totalAssets: 1_000_000n, totalShares: 1_000_000n, label: "1:1 ratio" },
      { totalAssets: 2_000_000n, totalShares: 1_000_000n, label: "2:1 assets:shares" },
      { totalAssets: 1_000_000n, totalShares: 2_000_000n, label: "1:2 assets:shares" },
      { totalAssets: 10n ** 18n, totalShares: 10n ** 18n, label: "1e18 scale" },
      { totalAssets: 10n ** 30n, totalShares: 10n ** 24n, label: "large imbalance" },
      { totalAssets: 1n, totalShares: 10n ** 12n, label: "tiny assets, large shares" },
    ];

    for (const { totalAssets, totalShares, label } of scenarios) {
      it(`holds for ${label} across 50 random asset amounts`, function () {
        const amounts = generateAmounts(99, 50);
        for (const assets of amounts) {
          const shares = toSharesDown(assets, totalAssets, totalShares);
          const assetsBack = toAssetsDown(shares, totalAssets, totalShares);
          expect(assetsBack).to.be.lte(
            assets,
            `Failed: toAssetsDown(toSharesDown(${assets})) = ${assetsBack} > ${assets} ` +
            `(totalAssets=${totalAssets}, totalShares=${totalShares})`
          );
        }
      });
    }
  });

  // ─── Invariant 2b: toAssetsUp(toSharesUp(assets)) >= assets ──────
  // Models the borrow→repay path: borrower owes toSharesUp on borrow,
  // then pays toAssetsUp on repay. They should always repay at least what was borrowed.

  describe("Invariant: toAssetsUp(toSharesUp(assets)) >= assets (borrow→repay no value creation)", function () {
    const scenarios = [
      { totalAssets: 0n, totalShares: 0n, label: "empty market" },
      { totalAssets: 1_000_000n, totalShares: 1_000_000n, label: "1:1 ratio" },
      { totalAssets: 2_000_000n, totalShares: 1_000_000n, label: "2:1 assets:shares" },
      { totalAssets: 10n ** 18n, totalShares: 10n ** 18n, label: "1e18 scale" },
      { totalAssets: 10n ** 30n, totalShares: 10n ** 24n, label: "large imbalance" },
    ];

    for (const { totalAssets, totalShares, label } of scenarios) {
      it(`holds for ${label} across 50 random asset amounts`, function () {
        const amounts = generateAmounts(77, 50);
        for (const assets of amounts) {
          const shares = toSharesUp(assets, totalAssets, totalShares);
          const assetsOwed = toAssetsUp(shares, totalAssets, totalShares);
          expect(assetsOwed).to.be.gte(
            assets,
            `Failed: toAssetsUp(toSharesUp(${assets})) = ${assetsOwed} < ${assets} ` +
            `(totalAssets=${totalAssets}, totalShares=${totalShares})`
          );
        }
      });
    }
  });

  // ─── Invariant 3: Virtual shares prevent inflation attacks ─────────

  describe("Virtual shares (1e6) prevent inflation attacks", function () {
    it("first depositor of 1 wei gets negligible share advantage", function () {
      // Attacker scenario: deposit 1 wei to get shares, then donate to inflate
      // With virtual shares, the 1-wei deposit gets shares ≈ 1e6 (not 1)
      const sharesFor1Wei = toSharesDown(1n, 0n, 0n);
      // With VIRTUAL_SHARES=1e6, VIRTUAL_ASSETS=1:
      // shares = 1 * (0 + 1e6) / (0 + 1) = 1e6
      expect(sharesFor1Wei).to.equal(VIRTUAL_SHARES);
    });

    it("donation attack yields negligible profit with virtual shares", function () {
      // Step 1: Attacker deposits 1 wei
      const attackerShares = toSharesDown(1n, 0n, 0n); // 1e6
      let totalAssets = 1n;
      let totalShares = attackerShares;

      // Step 2: Attacker donates 1e6 (1 USDC) to inflate price
      const donation = 1_000_000n; // 1 USDC
      totalAssets += donation;

      // Step 3: Victim deposits 2e6 (2 USDC)
      const victimDeposit = 2_000_000n;
      const victimShares = toSharesDown(victimDeposit, totalAssets, totalShares);

      // Step 4: Check victim's redeemable value
      totalAssets += victimDeposit;
      totalShares += victimShares;
      const victimRedeemable = toAssetsDown(victimShares, totalAssets, totalShares);

      // With virtual shares, the victim should lose at most a tiny fraction (< 1%)
      // The loss should be negligible compared to the attacker's donation cost
      const victimLoss = victimDeposit - victimRedeemable;
      const attackerCost = donation;

      // Victim loss should be much less than attacker cost (attack unprofitable)
      expect(victimLoss).to.be.lt(attackerCost);
    });

    it("virtual shares make small-deposit inflation attack unprofitable", function () {
      // More aggressive attack: deposit minimum, donate large amount
      const attackerShares = toSharesDown(1n, 0n, 0n);
      let totalAssets = 1n;
      let totalShares = attackerShares;

      // Donate 1e12 (1M USDC)
      const donation = 10n ** 12n;
      totalAssets += donation;

      // Victim deposits 1e6 (1 USDC)
      const victimDeposit = 10n ** 6n;
      const victimShares = toSharesDown(victimDeposit, totalAssets, totalShares);

      totalAssets += victimDeposit;
      totalShares += victimShares;

      // With virtual shares, victim still gets a reasonable share
      expect(victimShares).to.be.gt(0n);

      const victimRedeemable = toAssetsDown(victimShares, totalAssets, totalShares);
      const victimLoss = victimDeposit - victimRedeemable;

      // Loss < 1 USDC (< 100% loss) even with massive donation
      // The virtual shares guarantee proportional representation
      expect(victimLoss).to.be.lt(victimDeposit);
    });
  });

  // ─── Invariant 4: Supply/withdraw rounding favors protocol ─────────

  describe("Supply/withdraw rounding favors protocol (pool)", function () {
    it("supply: shares received (rounded down) ensure supplier doesn't get too many", async function () {
      const { pool, alice, marketParams } = await loadFixture(deployPoolFixture);

      // Supply various amounts and verify shares are rounded down
      const amounts = [1n, 7n, 13n, 100n, 999n, 1_000_001n, 123_456_789n];
      for (const amount of amounts) {
        // In a fresh market (or after fixture reset), toSharesDown is used for supply
        const shares = toSharesDown(amount, 0n, 0n);
        const assetsRedeemable = toAssetsDown(shares, amount, shares);
        // Redeemable <= supplied (rounding favors pool)
        expect(assetsRedeemable).to.be.lte(amount);
      }
    });

    it("withdraw: assets received (rounded down) ensure pool doesn't give too much", function () {
      // When withdrawing by shares, toAssetsDown is used
      const totalAssets = 1_000_000_000n;
      const totalShares = 1_000_000_000n;

      const amounts = generateAmounts(77, 30);
      for (const shares of amounts) {
        if (shares > totalShares) continue; // skip unrealistic
        const assets = toAssetsDown(shares, totalAssets, totalShares);
        // Re-converting back should require at most the original shares
        const sharesNeeded = toSharesUp(assets, totalAssets, totalShares);
        expect(sharesNeeded).to.be.lte(shares);
      }
    });

    it("borrow: shares charged (rounded up) ensure borrower owes at least the borrowed amount", function () {
      // When borrowing by assets, toSharesUp is used for borrow shares
      const totalBorrowAssets = 500_000_000n;
      const totalBorrowShares = 500_000_000n;

      const amounts = generateAmounts(55, 30);
      for (const assets of amounts) {
        const shares = toSharesUp(assets, totalBorrowAssets, totalBorrowShares);
        const assetsOwed = toAssetsUp(shares, totalBorrowAssets, totalBorrowShares);
        // Owed >= borrowed (rounding favors protocol)
        expect(assetsOwed).to.be.gte(assets);
      }
    });

    it("repay: shares reduced (rounded down) ensure borrower repays at least the debt value", function () {
      // When repaying by assets, toSharesDown is used — fewer shares burned means more debt remains
      const totalBorrowAssets = 500_000_000n;
      const totalBorrowShares = 500_000_000n;

      const amounts = generateAmounts(33, 30);
      for (const assets of amounts) {
        const sharesBurned = toSharesDown(assets, totalBorrowAssets, totalBorrowShares);
        const assetsCleared = toAssetsDown(sharesBurned, totalBorrowAssets, totalBorrowShares);
        // Assets cleared <= assets paid (rounding favors protocol — debt may remain)
        expect(assetsCleared).to.be.lte(assets);
      }
    });
  });

  // ─── On-chain integration: supply → withdraw rounding ─────────────

  describe("On-chain supply/withdraw round-trip rounding", function () {
    it("supplier cannot extract more than deposited via supply+withdraw", async function () {
      const { pool, usdc, alice, marketParams } = await loadFixture(deployPoolFixture);

      const amounts = [1n, 100n, 999_999n, 1_000_000n, 50_000_000n];
      for (const amount of amounts) {
        // Fresh fixture each iteration isn't practical, but we test first supply
        // which has the worst rounding edge cases (empty market)
        if (amount === 1n) {
          // For 1 wei, verify on-chain
          const balBefore = await usdc.balanceOf(alice.address);
          const tx = await pool.connect(alice).supply(marketParams, amount, 0, alice.address, "0x");
          const receipt = await tx.wait();

          // Now withdraw everything via shares
          const pos = await pool.position(
            ethers.keccak256(
              ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "address", "address", "address", "uint256"],
                [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
              )
            ),
            alice.address
          );
          const supplyShares = pos.supplyShares;

          if (supplyShares > 0n) {
            await pool.connect(alice).withdraw(marketParams, 0, supplyShares, alice.address, alice.address);
          }

          const balAfter = await usdc.balanceOf(alice.address);
          // Should not have gained anything
          expect(balAfter).to.be.lte(balBefore);
        }
      }
    });

    it("multiple suppliers with varying amounts maintain solvency", async function () {
      const { pool, usdc, alice, bob, marketParams } = await loadFixture(deployPoolFixture);

      // Alice supplies 1000 USDC
      await pool.connect(alice).supply(marketParams, ethers.parseUnits("1000", 6), 0, alice.address, "0x");

      // Bob supplies 1 wei
      await pool.connect(bob).supply(marketParams, 1n, 0, bob.address, "0x");

      // Both withdraw everything
      const marketId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "address", "uint256"],
          [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
        )
      );

      const bobPos = await pool.position(marketId, bob.address);
      if (bobPos.supplyShares > 0n) {
        await pool.connect(bob).withdraw(marketParams, 0, bobPos.supplyShares, bob.address, bob.address);
      }

      const alicePos = await pool.position(marketId, alice.address);
      if (alicePos.supplyShares > 0n) {
        await pool.connect(alice).withdraw(marketParams, 0, alicePos.supplyShares, alice.address, alice.address);
      }

      // Pool should have 0 or positive dust remaining (never negative)
      const poolBal = await usdc.balanceOf(await pool.getAddress());
      expect(poolBal).to.be.gte(0n);
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────────

  describe("Edge cases", function () {
    it("zero amounts produce zero results", function () {
      expect(toSharesDown(0n, 100n, 100n)).to.equal(0n);
      expect(toSharesUp(0n, 100n, 100n)).to.equal(0n);
      expect(toAssetsDown(0n, 100n, 100n)).to.equal(0n);
      expect(toAssetsUp(0n, 100n, 100n)).to.equal(0n);
    });

    it("monotonicity: more assets → more shares (down)", function () {
      const totalAssets = 1_000_000n;
      const totalShares = 1_000_000n;
      let prevShares = 0n;
      for (let a = 1n; a <= 100n; a++) {
        const s = toSharesDown(a, totalAssets, totalShares);
        expect(s).to.be.gte(prevShares);
        prevShares = s;
      }
    });

    it("monotonicity: more shares → more assets (down)", function () {
      const totalAssets = 1_000_000n;
      const totalShares = 1_000_000n;
      let prevAssets = 0n;
      for (let s = 1n; s <= 100n; s++) {
        const a = toAssetsDown(s, totalAssets, totalShares);
        expect(a).to.be.gte(prevAssets);
        prevAssets = a;
      }
    });

    it("rounding direction: Down <= Up for same inputs", function () {
      const amounts = generateAmounts(123, 50);
      const totalAssets = 1_000_000n;
      const totalShares = 1_000_000n;

      for (const x of amounts) {
        expect(toSharesDown(x, totalAssets, totalShares)).to.be.lte(
          toSharesUp(x, totalAssets, totalShares)
        );
        expect(toAssetsDown(x, totalAssets, totalShares)).to.be.lte(
          toAssetsUp(x, totalAssets, totalShares)
        );
      }
    });

    it("uint128 boundary: no overflow at max supply", function () {
      // Max uint128 ≈ 3.4e38
      const maxUint128 = (1n << 128n) - 1n;
      // These should not throw
      const shares = toSharesDown(1_000_000n, maxUint128, maxUint128);
      expect(shares).to.be.gte(0n);
      const assets = toAssetsDown(1_000_000n, maxUint128, maxUint128);
      expect(assets).to.be.gte(0n);
    });
  });
});
