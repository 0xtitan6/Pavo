import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("ParthenonPool authorization tests", function () {
  async function deployPoolFixture() {
    const [owner, alice, bob, charlie] = await ethers.getSigners();

    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);
    const poolAddress = await pool.getAddress();

    // Build the domain separator exactly as the contract does
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domainSeparator = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "address"],
        [
          ethers.keccak256(ethers.toUtf8Bytes("EIP712Domain(uint256 chainId,address verifyingContract)")),
          chainId,
          poolAddress,
        ]
      )
    );

    const AUTHORIZATION_TYPEHASH = ethers.keccak256(
      ethers.toUtf8Bytes(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
      )
    );

      const domain = {
      chainId,
      verifyingContract: poolAddress,
    };

    const authorizationTypes = {
      Authorization: [
        { name: "authorizer", type: "address" },
        { name: "authorized", type: "address" },
        { name: "isAuthorized", type: "bool" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    async function buildSig(
      signer: any,
      authorizer: string,
      authorized: string,
      isAuthorized: boolean,
      nonce: bigint,
      deadline: bigint
    ) {
      // Use EIP-712 signTypedData — ethers v6 handles domain separator construction
      const raw = await signer.signTypedData(domain, authorizationTypes, {
        authorizer,
        authorized,
        isAuthorized,
        nonce,
        deadline,
      });
      const sig = ethers.Signature.from(raw);
      return { v: sig.v, r: sig.r, s: sig.s };
    }

    return { pool, poolAddress, owner, alice, bob, charlie, domainSeparator, AUTHORIZATION_TYPEHASH, buildSig };
  }

  // ── setAuthorization (direct) ─────────────────────────────────────────────

  describe("setAuthorization (direct)", function () {
    it("Should authorize an address", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      await pool.connect(alice).setAuthorization(bob.address, true);
      expect(await pool.isAuthorized(alice.address, bob.address)).to.be.true;
    });

    it("Should revoke authorization", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      await pool.connect(alice).setAuthorization(bob.address, true);
      await pool.connect(alice).setAuthorization(bob.address, false);
      expect(await pool.isAuthorized(alice.address, bob.address)).to.be.false;
    });

    it("Should emit SetAuthorization event", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      await expect(pool.connect(alice).setAuthorization(bob.address, true))
        .to.emit(pool, "SetAuthorization")
        .withArgs(alice.address, alice.address, bob.address, true);
    });

    it("Should revert if already set to same value", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      // Default is false — setting false again should revert
      await expect(pool.connect(alice).setAuthorization(bob.address, false))
        .to.be.revertedWith("already set");
    });
  });

  // ── setAuthorizationWithSig ───────────────────────────────────────────────

  describe("setAuthorizationWithSig", function () {
    it("Should authorize via valid EIP-712 signature", async function () {
      const { pool, alice, bob, buildSig } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await pool.nonce(alice.address);
      const sig = await buildSig(alice, alice.address, bob.address, true, nonce, deadline);

      await pool.setAuthorizationWithSig(
        { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce, deadline },
        sig
      );

      expect(await pool.isAuthorized(alice.address, bob.address)).to.be.true;
    });

    it("Should increment the nonce after a valid sig", async function () {
      const { pool, alice, bob, buildSig } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await pool.nonce(alice.address);
      const sig = await buildSig(alice, alice.address, bob.address, true, nonce, deadline);

      await pool.setAuthorizationWithSig(
        { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce, deadline },
        sig
      );

      expect(await pool.nonce(alice.address)).to.equal(nonce + 1n);
    });

    it("Should emit IncrementNonce and SetAuthorization events", async function () {
      const { pool, alice, bob, buildSig } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await pool.nonce(alice.address);
      const sig = await buildSig(alice, alice.address, bob.address, true, nonce, deadline);

      const authorization = { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce, deadline };

      await expect(pool.setAuthorizationWithSig(authorization, sig))
        .to.emit(pool, "IncrementNonce")
        .and.to.emit(pool, "SetAuthorization");
    });

    it("Should revert if signature is expired", async function () {
      const { pool, alice, bob, buildSig } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) - 1n; // already expired
      const nonce = await pool.nonce(alice.address);
      const sig = await buildSig(alice, alice.address, bob.address, true, nonce, deadline);

      await expect(
        pool.setAuthorizationWithSig(
          { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce, deadline },
          sig
        )
      ).to.be.revertedWith("signature expired");
    });

    it("Should revert if nonce is invalid (already used)", async function () {
      const { pool, alice, bob, buildSig } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await pool.nonce(alice.address);
      const sig = await buildSig(alice, alice.address, bob.address, true, nonce, deadline);
      const authorization = { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce, deadline };

      // First use succeeds
      await pool.setAuthorizationWithSig(authorization, sig);

      // Replay should revert (nonce is now stale)
      const sig2 = await buildSig(alice, alice.address, bob.address, true, nonce, deadline);
      await expect(
        pool.setAuthorizationWithSig(authorization, sig2)
      ).to.be.revertedWith("invalid nonce");
    });

    it("Should revert if wrong signer (signature from bob, authorizer is alice)", async function () {
      const { pool, alice, bob, buildSig } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await pool.nonce(alice.address);
      // Bob signs but authorizer is alice
      const sig = await buildSig(bob, alice.address, bob.address, true, nonce, deadline);

      await expect(
        pool.setAuthorizationWithSig(
          { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce, deadline },
          sig
        )
      ).to.be.revertedWith("invalid signature");
    });

    it("Should revert on invalid v/r/s (ecrecover returns zero)", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await pool.nonce(alice.address);

      await expect(
        pool.setAuthorizationWithSig(
          { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce, deadline },
          { v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash }
        )
      ).to.be.revertedWith("invalid signature");
    });

    it("Should allow third party to submit a valid signature on behalf of authorizer", async function () {
      const { pool, alice, bob, charlie, buildSig } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await pool.nonce(alice.address);
      const sig = await buildSig(alice, alice.address, bob.address, true, nonce, deadline);

      // Charlie submits the sig on behalf of alice
      await pool.connect(charlie).setAuthorizationWithSig(
        { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce, deadline },
        sig
      );

      expect(await pool.isAuthorized(alice.address, bob.address)).to.be.true;
    });

    it("Should revoke authorization via sig", async function () {
      const { pool, alice, bob, buildSig } = await loadFixture(deployPoolFixture);

      // First authorize directly
      await pool.connect(alice).setAuthorization(bob.address, true);
      expect(await pool.isAuthorized(alice.address, bob.address)).to.be.true;

      // Then revoke via sig
      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await pool.nonce(alice.address);
      const sig = await buildSig(alice, alice.address, bob.address, false, nonce, deadline);

      await pool.setAuthorizationWithSig(
        { authorizer: alice.address, authorized: bob.address, isAuthorized: false, nonce, deadline },
        sig
      );

      expect(await pool.isAuthorized(alice.address, bob.address)).to.be.false;
    });

    it("Should handle multiple sequential authorizations (nonce increments correctly)", async function () {
      const { pool, alice, bob, charlie, buildSig } = await loadFixture(deployPoolFixture);

      const deadline = BigInt(await time.latest()) + 3600n;

      // First sig: authorize bob
      const nonce0 = await pool.nonce(alice.address);
      const sig0 = await buildSig(alice, alice.address, bob.address, true, nonce0, deadline);
      await pool.setAuthorizationWithSig(
        { authorizer: alice.address, authorized: bob.address, isAuthorized: true, nonce: nonce0, deadline },
        sig0
      );

      // Second sig: authorize charlie
      const nonce1 = await pool.nonce(alice.address);
      expect(nonce1).to.equal(nonce0 + 1n);
      const sig1 = await buildSig(alice, alice.address, charlie.address, true, nonce1, deadline);
      await pool.setAuthorizationWithSig(
        { authorizer: alice.address, authorized: charlie.address, isAuthorized: true, nonce: nonce1, deadline },
        sig1
      );

      expect(await pool.isAuthorized(alice.address, bob.address)).to.be.true;
      expect(await pool.isAuthorized(alice.address, charlie.address)).to.be.true;
      expect(await pool.nonce(alice.address)).to.equal(nonce0 + 2n);
    });
  });

  // ── DOMAIN_SEPARATOR ─────────────────────────────────────────────────────

  describe("DOMAIN_SEPARATOR", function () {
    it("Should match the expected EIP-712 domain separator", async function () {
      const { pool, domainSeparator } = await loadFixture(deployPoolFixture);
      expect(await pool.DOMAIN_SEPARATOR()).to.equal(domainSeparator);
    });
  });

  // ── withdrawCollateral ──────────────────────────────────────────────────

  describe("withdrawCollateral", function () {
    async function deployWithMarketAndPositions() {
      const [owner, supplier, borrower, user2, relayer] = await ethers.getSigners();

      const usdc = await ethers.deployContract("ERC20Mock", [
        "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
      ]);
      const wbtc = await ethers.deployContract("ERC20Mock", [
        "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
      ]);

      const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

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
        lltv: lltv
      };

      await pool.createMarket(marketParams);

      // Supply liquidity
      await usdc.transfer(supplier.address, ethers.parseUnits("100000", 6));
      await usdc.connect(supplier).approve(await pool.getAddress(), ethers.MaxUint256);
      await pool.connect(supplier).supply(marketParams, ethers.parseUnits("100000", 6), 0, supplier.address, "0x");

      // Fund borrower with collateral
      await wbtc.transfer(borrower.address, ethers.parseUnits("10", 8));
      await wbtc.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);

      return { pool, usdc, wbtc, irm, oracle, owner, supplier, borrower, user2, relayer, marketParams };
    }

    it("Should allow owner to withdraw excess collateral (no borrow position)", async function () {
      const { pool, wbtc, borrower, marketParams } = await loadFixture(deployWithMarketAndPositions);

      const collateralAmount = ethers.parseUnits("1", 8);
      await pool.connect(borrower).supplyCollateral(marketParams, collateralAmount, borrower.address, "0x");

      const balanceBefore = await wbtc.balanceOf(borrower.address);

      // No borrow — can withdraw all collateral
      await pool.connect(borrower).withdrawCollateral(marketParams, collateralAmount, borrower.address, borrower.address);

      const balanceAfter = await wbtc.balanceOf(borrower.address);
      expect(balanceAfter - balanceBefore).to.equal(collateralAmount);
    });

    it("Should revert when withdrawal makes position unhealthy (has borrow)", async function () {
      const { pool, borrower, marketParams } = await loadFixture(deployWithMarketAndPositions);

      // Supply 1 BTC collateral (worth $50,000)
      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      // Borrow 30,000 USDC (within 80% LLTV of $50,000 = $40,000)
      await pool.connect(borrower).borrow(marketParams, ethers.parseUnits("30000", 6), 0, borrower.address, borrower.address);

      // Try to withdraw all collateral — should fail
      await expect(
        pool.connect(borrower).withdrawCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, borrower.address)
      ).to.be.revertedWith("insufficient collateral");
    });

    it("Should allow authorized third party to withdraw collateral on behalf", async function () {
      const { pool, wbtc, borrower, user2, marketParams } = await loadFixture(deployWithMarketAndPositions);

      const collateralAmount = ethers.parseUnits("1", 8);
      await pool.connect(borrower).supplyCollateral(marketParams, collateralAmount, borrower.address, "0x");

      // Authorize user2
      await pool.connect(borrower).setAuthorization(user2.address, true);

      // user2 withdraws collateral on behalf of borrower, sends to user2
      await pool.connect(user2).withdrawCollateral(marketParams, collateralAmount, borrower.address, user2.address);

      expect(await wbtc.balanceOf(user2.address)).to.equal(collateralAmount);
    });

    it("Should revert with zero assets", async function () {
      const { pool, borrower, marketParams } = await loadFixture(deployWithMarketAndPositions);

      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      await expect(
        pool.connect(borrower).withdrawCollateral(marketParams, 0, borrower.address, borrower.address)
      ).to.be.revertedWith("zero assets");
    });

    it("Should revert with zero receiver", async function () {
      const { pool, borrower, marketParams } = await loadFixture(deployWithMarketAndPositions);

      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      await expect(
        pool.connect(borrower).withdrawCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, ethers.ZeroAddress)
      ).to.be.revertedWith("zero address");
    });

    it("Should revert when unauthorized", async function () {
      const { pool, borrower, user2, marketParams } = await loadFixture(deployWithMarketAndPositions);

      await pool.connect(borrower).supplyCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, "0x");

      // user2 tries to withdraw borrower's collateral without authorization
      await expect(
        pool.connect(user2).withdrawCollateral(marketParams, ethers.parseUnits("1", 8), borrower.address, user2.address)
      ).to.be.revertedWith("unauthorized");
    });

    it("Should allow partial collateral withdrawal when position stays healthy", async function () {
      const { pool, wbtc, borrower, marketParams } = await loadFixture(deployWithMarketAndPositions);

      // Supply 2 BTC collateral (worth $100,000)
      const collateralAmount = ethers.parseUnits("2", 8);
      await pool.connect(borrower).supplyCollateral(marketParams, collateralAmount, borrower.address, "0x");

      // Borrow 30,000 USDC (needs $37,500 collateral at 80% LLTV => 0.75 BTC)
      await pool.connect(borrower).borrow(marketParams, ethers.parseUnits("30000", 6), 0, borrower.address, borrower.address);

      // Withdraw 1 BTC — still have 1 BTC ($50,000), borrow is $30,000, LLTV 80% => max $40,000 — healthy
      const withdrawAmount = ethers.parseUnits("1", 8);
      const balanceBefore = await wbtc.balanceOf(borrower.address);

      await pool.connect(borrower).withdrawCollateral(marketParams, withdrawAmount, borrower.address, borrower.address);

      const balanceAfter = await wbtc.balanceOf(borrower.address);
      expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);
    });
  });
});
