import { expect } from "chai";
import { ethers } from "hardhat";
import { ScaleFactorLibHarness } from "../../../typechain-types/contracts/module2/test/ScaleFactorLibHarness.sol";

const RAY = ethers.parseUnits("1", 27);
const BIP = 10000n;

describe("ScaleFactorLib property tests", function () {
  let harness: ScaleFactorLibHarness;

  before(async function () {
    harness = await ethers.deployContract("ScaleFactorLibHarness");
  });

  const testValues = [
    RAY,
    BigInt(2) * RAY,
    BigInt(10) * RAY,
    BigInt(100) * RAY,
    BigInt(1000) * RAY,
  ];

  const amountValues = [
    BigInt(1000000),
    BigInt(100000000),
    BigInt(1000000000),
    BigInt(10000000000),
    BigInt(100000000000),
  ];

  describe("property tests - fixed values", function () {
    it("Property 1: rayMul(a, RAY) == a (identity)", async function () {
      for (const a of testValues) {
        const result = await harness.rayMul(a, RAY);
        expect(result).to.equal(a);
      }
    });

    it("Property 2: rayMul(a, b) == rayMul(b, a) (commutativity)", async function () {
      for (const a of testValues) {
        for (const b of testValues) {
          const result1 = await harness.rayMul(a, b);
          const result2 = await harness.rayMul(b, a);
          const diff = result1 > result2 ? result1 - result2 : result2 - result1;
          expect(diff).to.lte(1n);
        }
      }
    });

    it("Property 3: scaleAmount(normalizeAmount(x, sf), sf) ~= x", async function () {
      for (const x of amountValues) {
        for (const sf of testValues) {
          const normalized = await harness.normalizeAmount(x, sf);
          if (normalized === 0n) continue;
          const scaledBack = await harness.scaleAmount(normalized, sf);
          const tolerance = x / 100n;
          const diff = scaledBack > x ? scaledBack - x : x - scaledBack;
          expect(diff).to.lte(tolerance + 1n);
        }
      }
    });

    it("Property 4: normalizeAmount(scaleAmount(x, sf), sf) ~= x", async function () {
      for (const x of amountValues) {
        for (const sf of testValues) {
          const scaled = await harness.scaleAmount(x, sf);
          if (scaled === 0n) continue;
          const normalizedBack = await harness.normalizeAmount(scaled, sf);
          const tolerance = x / 100n;
          const diff = normalizedBack > x ? normalizedBack - x : x - normalizedBack;
          expect(diff).to.lte(tolerance + 1n);
        }
      }
    });

    it("Property 5: calculateLinearInterestFromBips returns delta (0 when rate=0)", async function () {
      // When rate=0, interest delta should be 0 regardless of time
      const times = [1n, 1000n, 1000000n, 31536000n];
      for (const time of times) {
        const result = await harness.calculateLinearInterestFromBips(0n, time);
        expect(result).to.equal(0n);
      }
    });

    it("Property 6: calculateLinearInterestFromBips returns delta (0 when time=0)", async function () {
      // When time=0, interest delta should be 0 regardless of rate
      const rates = [100n, 1000n, 5000n, 10000n];
      for (const rate of rates) {
        const result = await harness.calculateLinearInterestFromBips(rate, 0n);
        expect(result).to.equal(0n);
      }
    });

    it("Property 7: interest rate is monotonic in time", async function () {
      const rates = [100n, 1000n, 5000n];
      const times = [1n, 1000n, 100000n, 1000000n];
      for (const rate of rates) {
        for (const t1 of times) {
          for (const t2 of times) {
            if (t2 === 0n) continue;
            const interest1 = await harness.calculateLinearInterestFromBips(rate, t1);
            const interest2 = await harness.calculateLinearInterestFromBips(rate, t1 + t2);
            expect(interest2).to.be.gte(interest1);
          }
        }
      }
    });

    it("Property 8: applyInterestToScaleFactor(sf, interest) >= sf", async function () {
      for (const sf of testValues) {
        for (const interest of testValues) {
          const result = await harness.applyInterestToScaleFactor(sf, interest);
          expect(result).to.be.gte(sf);
        }
      }
    });

    it("Property 9: liquidityRequired >= minimum", async function () {
      const supply = BigInt(1000000000000);
      const pending = BigInt(100000000000);
      const unclaimed = BigInt(50000000000);
      const fees = BigInt(1000000000);
      const reserves = [0n, 1000n, 2500n, 5000n];
      for (const reserve of reserves) {
        const result = await harness.liquidityRequired(supply, pending, unclaimed, fees, reserve, RAY);
        const minimum = unclaimed + fees;
        expect(result).to.be.gte(minimum);
      }
    });
  });

  describe("edge case properties", function () {
    it("rayMul(0, anything) == 0", async function () {
      expect(await harness.rayMul(0n, RAY)).to.equal(0n);
    });

    it("rayMul(anything, 0) == 0", async function () {
      expect(await harness.rayMul(RAY, 0n)).to.equal(0n);
    });

    it("normalizeAmount(0, sf) == 0", async function () {
      expect(await harness.normalizeAmount(0n, RAY)).to.equal(0n);
    });

    it("scaleAmount(0, sf) == 0", async function () {
      expect(await harness.scaleAmount(0n, RAY)).to.equal(0n);
    });

    it("bipMul(a, 0) == 0", async function () {
      expect(await harness.bipMul(1000n, 0n)).to.equal(0n);
    });

    it("bipMul(0, b) == 0", async function () {
      expect(await harness.bipMul(0n, 1000n)).to.equal(0n);
    });

    it("bipToRay(0) == 0", async function () {
      expect(await harness.bipToRay(0n)).to.equal(0n);
    });

    it("bipToRay(BIP) == RAY", async function () {
      expect(await harness.bipToRay(BIP)).to.equal(RAY);
    });
  });
});
