import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import testVectors from '../../test-vectors/module2-math.json'

describe('ScaleFactorLib', function () {
  const RAY = 10n ** 27n
  const HALF_RAY = RAY / 2n
  const BIP = 10_000n
  const BIP_RAY_RATIO = 10n ** 23n
  const SECONDS_IN_365_DAYS = 365n * 24n * 60n * 60n

  async function deployFixture() {
    const factory = await ethers.getContractFactory('ScaleFactorLibHarness')
    const lib = await factory.deploy()
    return { lib }
  }

  // ──────────────────────── Constants ────────────────────────

  describe('constants', function () {
    it('RAY = 1e27', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.RAY()).to.equal(RAY)
    })

    it('BIP = 1e4', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.BIP()).to.equal(BIP)
    })
  })

  // ──────────────────────── rayMul ────────────────────────

  describe('rayMul', function () {
    it('1 RAY * 1 RAY = 1 RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.rayMul(RAY, RAY)).to.equal(RAY)
    })

    it('2 RAY * 3 RAY = 6 RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.rayMul(2n * RAY, 3n * RAY)).to.equal(6n * RAY)
    })

    it('0 * anything = 0', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.rayMul(0n, RAY)).to.equal(0n)
      expect(await lib.rayMul(RAY, 0n)).to.equal(0n)
    })

    it('rounds correctly with HALF_RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      // 1 * 1 should round: (1*1 + HALF_RAY) / RAY = 1 (rounds up)
      expect(await lib.rayMul(1n, 1n)).to.equal(0n) // too small
      // HALF_RAY * 2 = (HALF_RAY * 2 + HALF_RAY) / RAY = (1.5 * HALF_RAY ... actually let's compute)
      // rayMul(HALF_RAY, 2) = (HALF_RAY*2 + HALF_RAY) / RAY = (RAY + HALF_RAY) / RAY = 1
      expect(await lib.rayMul(HALF_RAY, 2n)).to.equal(1n)
    })

    it('reverts on overflow', async function () {
      const { lib } = await loadFixture(deployFixture)
      const huge = ethers.MaxUint256
      await expect(lib.rayMul(huge, 2n * RAY)).to.be.reverted
    })
  })

  // ──────────────────────── rayDiv ────────────────────────

  describe('rayDiv', function () {
    it('1 RAY / 1 RAY = 1 RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.rayDiv(RAY, RAY)).to.equal(RAY)
    })

    it('6 RAY / 2 RAY = 3 RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.rayDiv(6n * RAY, 2n * RAY)).to.equal(3n * RAY)
    })

    it('0 / RAY = 0', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.rayDiv(0n, RAY)).to.equal(0n)
    })

    it('reverts on division by zero', async function () {
      const { lib } = await loadFixture(deployFixture)
      await expect(lib.rayDiv(RAY, 0n)).to.be.reverted
    })

    it('reverts on overflow', async function () {
      const { lib } = await loadFixture(deployFixture)
      await expect(lib.rayDiv(ethers.MaxUint256, 1n)).to.be.reverted
    })
  })

  // ──────────────────────── bipToRay ────────────────────────

  describe('bipToRay', function () {
    it('10000 bips = 1 RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.bipToRay(10_000n)).to.equal(RAY)
    })

    it('500 bips = 0.05 RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.bipToRay(500n)).to.equal(500n * BIP_RAY_RATIO)
    })

    it('0 bips = 0', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.bipToRay(0n)).to.equal(0n)
    })

    it('1 bip = 1e23', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.bipToRay(1n)).to.equal(BIP_RAY_RATIO)
    })
  })

  // ──────────────────────── bipMul ────────────────────────

  describe('bipMul', function () {
    it('10000 bipMul x = x (identity)', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.bipMul(1_000_000n, 10_000n)).to.equal(1_000_000n)
    })

    it('5000 bipMul x = x/2', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.bipMul(1_000_000n, 5_000n)).to.equal(500_000n)
    })

    it('0 bipMul x = 0', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.bipMul(0n, 10_000n)).to.equal(0n)
    })

    it('reverts on overflow', async function () {
      const { lib } = await loadFixture(deployFixture)
      await expect(lib.bipMul(ethers.MaxUint256, ethers.MaxUint256)).to.be.reverted
    })
  })

  // ──────────────────────── scaleAmount / normalizeAmount ────────────────────────

  describe('scaleAmount & normalizeAmount', function () {
    for (const vec of testVectors.scale_conversions) {
      if (vec.normalizedAmount && vec.expectedScaledAmount) {
        it(`scaleAmount: ${vec.testId}`, async function () {
          const { lib } = await loadFixture(deployFixture)
          const result = await lib.scaleAmount(
            BigInt(vec.normalizedAmount),
            BigInt(vec.scaleFactor27)
          )
          expect(result).to.equal(BigInt(vec.expectedScaledAmount))
        })
      }

      if (vec.scaledAmount && vec.expectedNormalizedAmount) {
        it(`normalizeAmount: ${vec.testId}`, async function () {
          const { lib } = await loadFixture(deployFixture)
          const result = await lib.normalizeAmount(
            BigInt(vec.scaledAmount),
            BigInt(vec.scaleFactor27)
          )
          expect(result).to.equal(BigInt(vec.expectedNormalizedAmount))
        })
      }
    }

    it('scale then normalize round-trips within 1 wei', async function () {
      const { lib } = await loadFixture(deployFixture)
      const amount = ethers.parseEther('1000')
      const sf = RAY + RAY / 10n // 1.1 RAY
      const scaled = await lib.scaleAmount(amount, sf)
      const normalized = await lib.normalizeAmount(scaled, sf)
      // Due to rounding, the round-trip may lose up to 1 unit
      const diff = amount > normalized ? amount - normalized : normalized - amount
      expect(diff).to.be.lte(1n)
    })
  })

  // ──────────────────────── calculateLinearInterestFromBips ────────────────────────

  describe('calculateLinearInterestFromBips — test vectors', function () {
    for (const vec of testVectors.interest_accrual) {
      it(vec.testId, async function () {
        const { lib } = await loadFixture(deployFixture)
        const interest = await lib.calculateLinearInterestFromBips(
          BigInt(vec.annualInterestBips),
          BigInt(vec.timeDeltaSeconds)
        )
        expect(interest).to.equal(BigInt(vec.expectedInterestRay27))
      })
    }
  })

  // ──────────────────────── applyInterestToScaleFactor ────────────────────────

  describe('applyInterestToScaleFactor — test vectors', function () {
    for (const vec of testVectors.interest_accrual) {
      if (vec.expectedNewScaleFactorRay27) {
        it(vec.testId, async function () {
          const { lib } = await loadFixture(deployFixture)
          const interest = BigInt(vec.expectedInterestRay27)
          const newSF = await lib.applyInterestToScaleFactor(RAY, interest)
          expect(newSF).to.equal(BigInt(vec.expectedNewScaleFactorRay27))
        })
      }
    }

    it('zero interest leaves scale factor unchanged', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.applyInterestToScaleFactor(RAY, 0n)).to.equal(RAY)
    })

    it('applies to non-unit scale factor', async function () {
      const { lib } = await loadFixture(deployFixture)
      const sf = 2n * RAY
      const interest = RAY / 10n // 10%
      // newSF = 2*RAY + rayMul(2*RAY, RAY/10) = 2*RAY + 0.2*RAY = 2.2*RAY
      const expected = 2n * RAY + (2n * RAY) / 10n
      expect(await lib.applyInterestToScaleFactor(sf, interest)).to.equal(expected)
    })
  })

  // ──────────────────────── updateTimeDelinquentAndGetPenaltyTime ────────────────────────

  describe('updateTimeDelinquentAndGetPenaltyTime', function () {
    it('delinquent after grace — test vector', async function () {
      const { lib } = await loadFixture(deployFixture)
      const vec = testVectors.delinquency_fee.find(
        (v) => v.testId === 'delinquency_after_grace'
      )!
      const [timeWithPenalty, newTimeDelinquent] =
        await lib.updateTimeDelinquentAndGetPenaltyTime(
          vec.isDelinquent,
          BigInt(vec.previousTimeDelinquent),
          BigInt(vec.gracePeriodSeconds),
          BigInt(vec.timeDeltaSeconds)
        )
      expect(timeWithPenalty).to.equal(BigInt(vec.expectedTimeWithPenalty))
      // newTimeDelinquent = 0 + 1209600 = 1209600
      expect(newTimeDelinquent).to.equal(
        BigInt(vec.previousTimeDelinquent) + BigInt(vec.timeDeltaSeconds)
      )
    })

    it('delinquent within grace — no penalty', async function () {
      const { lib } = await loadFixture(deployFixture)
      const vec = testVectors.delinquency_fee.find(
        (v) => v.testId === 'delinquency_within_grace'
      )!
      const [timeWithPenalty, newTimeDelinquent] =
        await lib.updateTimeDelinquentAndGetPenaltyTime(
          vec.isDelinquent,
          BigInt(vec.previousTimeDelinquent),
          BigInt(vec.gracePeriodSeconds),
          BigInt(vec.timeDeltaSeconds)
        )
      expect(timeWithPenalty).to.equal(BigInt(vec.expectedTimeWithPenalty))
      expect(newTimeDelinquent).to.equal(
        BigInt(vec.previousTimeDelinquent) + BigInt(vec.timeDeltaSeconds)
      )
    })

    it('continued delinquency — all time penalized', async function () {
      const { lib } = await loadFixture(deployFixture)
      const vec = testVectors.delinquency_fee.find(
        (v) => v.testId === 'delinquency_continued'
      )!
      const [timeWithPenalty, newTimeDelinquent] =
        await lib.updateTimeDelinquentAndGetPenaltyTime(
          vec.isDelinquent,
          BigInt(vec.previousTimeDelinquent),
          BigInt(vec.gracePeriodSeconds),
          BigInt(vec.timeDeltaSeconds)
        )
      expect(timeWithPenalty).to.equal(BigInt(vec.expectedTimeWithPenalty))
      expect(newTimeDelinquent).to.equal(
        BigInt(vec.previousTimeDelinquent) + BigInt(vec.timeDeltaSeconds)
      )
    })

    it('recovery from delinquency — decreasing timeDelinquent', async function () {
      const { lib } = await loadFixture(deployFixture)
      const vec = testVectors.delinquency_fee.find(
        (v) => v.testId === 'recovery_from_delinquency'
      )!
      const [timeWithPenalty, newTimeDelinquent] =
        await lib.updateTimeDelinquentAndGetPenaltyTime(
          vec.isDelinquent,
          BigInt(vec.previousTimeDelinquent),
          BigInt(vec.gracePeriodSeconds),
          BigInt(vec.timeDeltaSeconds)
        )
      expect(timeWithPenalty).to.equal(BigInt(vec.expectedTimeWithPenalty))
      // Recovery: newTimeDelinquent = satSub(864000, 432000) = 432000
      expect(newTimeDelinquent).to.equal(BigInt(vec.expectedNewTimeDelinquent!))
    })

    it('not delinquent with zero previous — no penalty, stays zero', async function () {
      const { lib } = await loadFixture(deployFixture)
      const [timeWithPenalty, newTimeDelinquent] =
        await lib.updateTimeDelinquentAndGetPenaltyTime(false, 0n, 604800n, 100000n)
      expect(timeWithPenalty).to.equal(0n)
      expect(newTimeDelinquent).to.equal(0n)
    })

    it('delinquent with zero grace period — all time penalized', async function () {
      const { lib } = await loadFixture(deployFixture)
      const [timeWithPenalty] = await lib.updateTimeDelinquentAndGetPenaltyTime(
        true,
        0n,
        0n,
        86400n
      )
      expect(timeWithPenalty).to.equal(86400n)
    })
  })

  // ──────────────────────── updateScaleFactorAndFees ────────────────────────

  describe('updateScaleFactorAndFees', function () {
    it('basic interest accrual — no delinquency, no protocol fee', async function () {
      const { lib } = await loadFixture(deployFixture)
      const vec = testVectors.interest_accrual[1] // 10% 1 year
      const [newSF, baseInterest, delinquencyFee, protocolFee, newTimeDel] =
        await lib.updateScaleFactorAndFees(
          RAY, // scaleFactor
          BigInt(vec.annualInterestBips),
          0n, // delinquencyFeeBips
          0n, // protocolFeeBips
          ethers.parseEther('100000'), // scaledTotalSupply
          false, // isDelinquent
          0n, // timeDelinquent
          604800n, // gracePeriod
          2592000n, // maxDelinquencyPeriod
          BigInt(vec.timeDeltaSeconds)
        )
      expect(newSF).to.equal(BigInt(vec.expectedNewScaleFactorRay27!))
      expect(baseInterest).to.equal(BigInt(vec.expectedInterestRay27))
      expect(delinquencyFee).to.equal(0n)
      expect(protocolFee).to.equal(0n)
      expect(newTimeDel).to.equal(0n)
    })

    it('with protocol fee — takes cut of base interest', async function () {
      const { lib } = await loadFixture(deployFixture)
      const supply = ethers.parseEther('100000')
      const [, , , protocolFee] = await lib.updateScaleFactorAndFees(
        RAY,
        1000n, // 10% APR
        0n,
        1000n, // 10% protocol fee
        supply,
        false,
        0n,
        604800n,
        2592000n,
        SECONDS_IN_365_DAYS // 1 year
      )
      // base interest = 0.1 RAY
      // protocol fee ray = bipMul(1000, 0.1 RAY) = 0.01 RAY
      // protocolFee = normalizeAmount(supply, rayMul(RAY, 0.01 RAY)) = supply * 0.01 = 1000e18
      expect(protocolFee).to.equal(ethers.parseEther('1000'))
    })

    it('with delinquency fee past grace', async function () {
      const { lib } = await loadFixture(deployFixture)
      const [, , delinquencyFee, , newTimeDel] = await lib.updateScaleFactorAndFees(
        RAY,
        500n, // 5% base
        1000n, // 10% penalty
        0n,
        ethers.parseEther('100000'),
        true,
        0n,
        604800n, // 7 day grace
        2592000n, // 30 day max
        1209600n // 14 days elapsed
      )
      // 14 days delinquent, 7 day grace -> 7 days penalty (604800s)
      // penalty = calculateLinearInterestFromBips(1000, 604800) = 1000 * 1e23 * 604800 / 31536000
      const expectedPenalty = await lib.calculateLinearInterestFromBips(1000n, 604800n)
      expect(delinquencyFee).to.equal(expectedPenalty)
      expect(delinquencyFee).to.be.gt(0n)
      expect(newTimeDel).to.equal(1209600n)
    })

    it('zero time delta — no changes', async function () {
      const { lib } = await loadFixture(deployFixture)
      const [newSF, baseInterest, delinquencyFee, protocolFee] =
        await lib.updateScaleFactorAndFees(
          RAY,
          1000n,
          1000n,
          1000n,
          ethers.parseEther('100000'),
          true,
          0n,
          604800n,
          2592000n,
          0n
        )
      expect(newSF).to.equal(RAY)
      expect(baseInterest).to.equal(0n)
      expect(delinquencyFee).to.equal(0n)
      expect(protocolFee).to.equal(0n)
    })

    it('recovery path reduces timeDelinquent', async function () {
      const { lib } = await loadFixture(deployFixture)
      const [, , , , newTimeDel] = await lib.updateScaleFactorAndFees(
        RAY,
        500n,
        1000n,
        0n,
        ethers.parseEther('100000'),
        false, // not delinquent anymore
        864000n, // was 10 days delinquent
        604800n,
        2592000n,
        432000n // 5 days pass
      )
      // satSub(864000, 432000) = 432000
      expect(newTimeDel).to.equal(432000n)
    })

    it('delinquency capped at maxDelinquencyPeriod', async function () {
      const { lib } = await loadFixture(deployFixture)
      const maxPeriod = 604800n // 7 days max
      const [, , delinquencyFee] = await lib.updateScaleFactorAndFees(
        RAY,
        500n,
        1000n,
        0n,
        ethers.parseEther('100000'),
        true,
        604800n, // already at max
        0n, // no grace
        maxPeriod,
        86400n // 1 more day
      )
      // Already at max, cappedTimeDelta = satSub(maxPeriod, timeDelinquent) = 0
      expect(delinquencyFee).to.equal(0n)
    })
  })

  // ──────────────────────── liquidityRequired — test vectors ────────────────────────

  describe('liquidityRequired — test vectors', function () {
    for (const vec of testVectors.liquidity_required) {
      it(vec.testId, async function () {
        const { lib } = await loadFixture(deployFixture)
        const result = await lib.liquidityRequired(
          BigInt(vec.scaledTotalSupply),
          BigInt(vec.scaledPendingWithdrawals),
          BigInt(vec.normalizedUnclaimedWithdrawals),
          BigInt(vec.accruedProtocolFees),
          BigInt(vec.reserveRatioBips),
          BigInt(vec.scaleFactor27)
        )
        expect(result).to.equal(BigInt(vec.expectedLiquidityRequired))
      })
    }

    it('includes unclaimed withdrawals and protocol fees', async function () {
      const { lib } = await loadFixture(deployFixture)
      const unclaimed = ethers.parseEther('5000')
      const fees = ethers.parseEther('2000')
      const result = await lib.liquidityRequired(
        ethers.parseEther('100000'),
        0n,
        unclaimed,
        fees,
        2000n, // 20%
        RAY
      )
      // 20% of 100K = 20K + 5K unclaimed + 2K fees = 27K
      expect(result).to.equal(ethers.parseEther('27000'))
    })
  })

  // ──────────────────────── Utility functions ────────────────────────

  describe('utility functions', function () {
    it('satSub(5, 3) = 2', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.satSub(5n, 3n)).to.equal(2n)
    })

    it('satSub(3, 5) = 0', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.satSub(3n, 5n)).to.equal(0n)
    })

    it('min returns smaller', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.min(3n, 7n)).to.equal(3n)
      expect(await lib.min(7n, 3n)).to.equal(3n)
    })

    it('max returns larger', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.max(3n, 7n)).to.equal(7n)
      expect(await lib.max(7n, 3n)).to.equal(7n)
    })

    it('toUint112 passes for valid value', async function () {
      const { lib } = await loadFixture(deployFixture)
      const val = 2n ** 112n - 1n
      expect(await lib.toUint112(val)).to.equal(val)
    })

    it('toUint112 reverts on overflow', async function () {
      const { lib } = await loadFixture(deployFixture)
      await expect(lib.toUint112(2n ** 112n)).to.be.reverted
    })

    it('toUint128 passes for valid value', async function () {
      const { lib } = await loadFixture(deployFixture)
      const val = 2n ** 128n - 1n
      expect(await lib.toUint128(val)).to.equal(val)
    })

    it('toUint128 reverts on overflow', async function () {
      const { lib } = await loadFixture(deployFixture)
      await expect(lib.toUint128(2n ** 128n)).to.be.reverted
    })

    it('toUint104 passes for valid value', async function () {
      const { lib } = await loadFixture(deployFixture)
      const val = 2n ** 104n - 1n
      expect(await lib.toUint104(val)).to.equal(val)
    })

    it('toUint104 reverts on overflow', async function () {
      const { lib } = await loadFixture(deployFixture)
      await expect(lib.toUint104(2n ** 104n)).to.be.reverted
    })

    it('toUint32 passes for valid value', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.toUint32(2n ** 32n - 1n)).to.equal(2n ** 32n - 1n)
    })

    it('toUint32 reverts on overflow', async function () {
      const { lib } = await loadFixture(deployFixture)
      await expect(lib.toUint32(2n ** 32n)).to.be.reverted
    })
  })

  // ──────────────────────── Edge cases ────────────────────────

  describe('edge cases', function () {
    it('rayMul with max safe values', async function () {
      const { lib } = await loadFixture(deployFixture)
      // RAY * (max_uint / RAY) should not overflow
      const maxA = ethers.MaxUint256 / RAY
      // Should not revert
      await lib.rayMul(maxA, RAY)
    })

    it('rayDiv precision — 1 / 3 RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      const result = await lib.rayDiv(RAY, 3n * RAY)
      // 1/3 * RAY = 333...333 with rounding
      const expected = (RAY * RAY + (3n * RAY) / 2n) / (3n * RAY)
      expect(result).to.equal(expected)
    })

    it('calculateLinearInterestFromBips — max bips 10000 over 1 year = RAY', async function () {
      const { lib } = await loadFixture(deployFixture)
      const interest = await lib.calculateLinearInterestFromBips(10_000n, SECONDS_IN_365_DAYS)
      expect(interest).to.equal(RAY)
    })

    it('liquidityRequired with zero supply', async function () {
      const { lib } = await loadFixture(deployFixture)
      const result = await lib.liquidityRequired(0n, 0n, 0n, 0n, 2000n, RAY)
      expect(result).to.equal(0n)
    })
  })
})
