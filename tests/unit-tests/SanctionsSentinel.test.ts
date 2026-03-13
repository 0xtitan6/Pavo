import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("SanctionsSentinel", function () {
  async function deploySentinel() {
    const [owner, user, sanctionedUser, nonOwner] = await ethers.getSigners();

    const MockSanctionsList = await ethers.getContractFactory("MockSanctionsList");
    const mockSanctionsList = await MockSanctionsList.deploy();

    const SanctionsSentinel = await ethers.getContractFactory("SanctionsSentinel");
    const sentinel = await SanctionsSentinel.deploy(await mockSanctionsList.getAddress());

    return { sentinel, mockSanctionsList, owner, user, sanctionedUser, nonOwner };
  }

  async function deploySentinelWithoutOracle() {
    const [owner, user, nonOwner] = await ethers.getSigners();

    const SanctionsSentinel = await ethers.getContractFactory("SanctionsSentinel");
    const sentinel = await SanctionsSentinel.deploy(ethers.ZeroAddress);

    return { sentinel, owner, user, nonOwner };
  }

  describe("isSanctioned", function () {
    it("returns false for non-sanctioned address", async function () {
      const { sentinel, user } = await loadFixture(deploySentinel);
      expect(await sentinel.isSanctioned(user.address)).to.be.false;
    });

    it("returns true for sanctioned address", async function () {
      const { sentinel, mockSanctionsList, sanctionedUser } = await loadFixture(deploySentinel);

      await mockSanctionsList.setSanctioned(sanctionedUser.address, true);
      expect(await sentinel.isSanctioned(sanctionedUser.address)).to.be.true;
    });

    it("returns false when no oracle is set (safe default for testnet)", async function () {
      const { sentinel, user } = await loadFixture(deploySentinelWithoutOracle);
      expect(await sentinel.isSanctioned(user.address)).to.be.false;
    });
  });

  describe("overrideSanction", function () {
    it("allows sanctioned address via override (whitelist false positive)", async function () {
      const { sentinel, mockSanctionsList, sanctionedUser } = await loadFixture(deploySentinel);

      await mockSanctionsList.setSanctioned(sanctionedUser.address, true);
      expect(await sentinel.isSanctioned(sanctionedUser.address)).to.be.true;

      // Override to not sanctioned
      await sentinel.overrideSanction(sanctionedUser.address, false);
      expect(await sentinel.isSanctioned(sanctionedUser.address)).to.be.false;
    });

    it("can override to mark an address as sanctioned", async function () {
      const { sentinel, user } = await loadFixture(deploySentinel);

      expect(await sentinel.isSanctioned(user.address)).to.be.false;

      await sentinel.overrideSanction(user.address, true);
      expect(await sentinel.isSanctioned(user.address)).to.be.true;
    });

    it("emits SanctionOverride event", async function () {
      const { sentinel, user } = await loadFixture(deploySentinel);

      await expect(sentinel.overrideSanction(user.address, true))
        .to.emit(sentinel, "SanctionOverride")
        .withArgs(user.address, true);
    });

    it("only owner can override", async function () {
      const { sentinel, nonOwner, user } = await loadFixture(deploySentinel);

      await expect(sentinel.connect(nonOwner).overrideSanction(user.address, true))
        .to.be.revertedWithCustomError(sentinel, "OwnableUnauthorizedAccount");
    });
  });

  describe("setSanctionsList", function () {
    it("updates the sanctions list oracle address", async function () {
      const { sentinel } = await loadFixture(deploySentinel);

      const newOracle = ethers.Wallet.createRandom().address;
      await sentinel.setSanctionsList(newOracle);
      expect(await sentinel.sanctionsList()).to.equal(newOracle);
    });

    it("emits SanctionsListUpdated event", async function () {
      const { sentinel } = await loadFixture(deploySentinel);

      const newOracle = ethers.Wallet.createRandom().address;
      await expect(sentinel.setSanctionsList(newOracle))
        .to.emit(sentinel, "SanctionsListUpdated")
        .withArgs(newOracle);
    });

    it("only owner can set oracle", async function () {
      const { sentinel, nonOwner } = await loadFixture(deploySentinel);

      const newOracle = ethers.Wallet.createRandom().address;
      await expect(sentinel.connect(nonOwner).setSanctionsList(newOracle))
        .to.be.revertedWithCustomError(sentinel, "OwnableUnauthorizedAccount");
    });

    it("can disable oracle by setting to zero address", async function () {
      const { sentinel, mockSanctionsList, sanctionedUser } = await loadFixture(deploySentinel);

      await mockSanctionsList.setSanctioned(sanctionedUser.address, true);
      expect(await sentinel.isSanctioned(sanctionedUser.address)).to.be.true;

      // Disable oracle
      await sentinel.setSanctionsList(ethers.ZeroAddress);
      // Without override, returns false (safe default)
      expect(await sentinel.isSanctioned(sanctionedUser.address)).to.be.false;
    });
  });
});
