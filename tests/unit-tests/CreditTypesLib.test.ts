import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

describe('CreditTypesLib', function () {
  async function deployFixture() {
    const factory = await ethers.getContractFactory('CreditTypesLibHarness')
    const lib = await factory.deploy()
    return { lib }
  }

  describe('tierToLimit', function () {
    it('TIER_1 = $100,000', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.tierToLimit(0)).to.equal(ethers.parseEther('100000'))
    })

    it('TIER_2 = $500,000', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.tierToLimit(1)).to.equal(ethers.parseEther('500000'))
    })

    it('TIER_3 = $2,000,000', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.tierToLimit(2)).to.equal(ethers.parseEther('2000000'))
    })

    it('TIER_4 = $10,000,000', async function () {
      const { lib } = await loadFixture(deployFixture)
      expect(await lib.tierToLimit(3)).to.equal(ethers.parseEther('10000000'))
    })
  })
})
