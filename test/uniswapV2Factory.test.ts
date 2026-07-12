import { expect } from "chai";
import { ethers } from "hardhat";
import type { UniswapV2Factory, UniswapV2Pair } from "../typechain-types";
import { UniswapV2Factory__factory, UniswapV2Pair__factory } from "../typechain-types";

describe("UniswapV2Factory — static functions", function () {
  let owner: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let user: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let factory: UniswapV2Factory;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();
    factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();
  });

  describe("feeToSetter", function () {
    it("returns the deployer as initial feeToSetter", async function () {
      expect(await factory.feeToSetter()).to.equal(owner.address);
    });

    it("reflects updates after setFeeToSetter", async function () {
      await factory.connect(owner).setFeeToSetter(user.address);
      expect(await factory.feeToSetter()).to.equal(user.address);
    });
  });

  describe("feeTo", function () {
    it("returns zero address initially", async function () {
      expect(await factory.feeTo()).to.equal(ethers.ZeroAddress);
    });

    it("reflects updates after setFeeTo", async function () {
      await factory.connect(owner).setFeeTo(user.address);
      expect(await factory.feeTo()).to.equal(user.address);
    });
  });

  describe("allPairsLength", function () {
    it("returns 0 when no pairs exist", async function () {
      expect(await factory.allPairsLength()).to.equal(0n);
    });

    it("returns correct count after creating pairs", async function () {
      const tokenA = await ethers.Wallet.createRandom().getAddress();
      const tokenB = await ethers.Wallet.createRandom().getAddress();
      const tokenC = await ethers.Wallet.createRandom().getAddress();

      const addr1 = tokenA < tokenB ? tokenA : tokenB;
      const addr2 = tokenA < tokenB ? tokenB : tokenA;

      if (addr1 < tokenC) {
        await factory.createPair(addr1, addr2);
        expect(await factory.allPairsLength()).to.equal(1n);

        await factory.createPair(addr1, tokenC);
        expect(await factory.allPairsLength()).to.equal(2n);
      } else {
        await factory.createPair(tokenC, addr1);
        expect(await factory.allPairsLength()).to.equal(1n);

        await factory.createPair(addr1, addr2);
        expect(await factory.allPairsLength()).to.equal(2n);
      }
    });
  });

  describe("allPairs", function () {
    it("returns pair addresses by index", async function () {
      const tokens = [
        await ethers.Wallet.createRandom().getAddress(),
        await ethers.Wallet.createRandom().getAddress(),
      ].sort() as [string, string];

      await factory.createPair(tokens[0], tokens[1]);
      const pairAddr = await factory.getPair(tokens[0], tokens[1]);
      expect(await factory.allPairs(0)).to.equal(pairAddr);
    });
  });

  describe("getPair", function () {
    it("returns zero address for non-existent pair", async function () {
      const t0 = await ethers.Wallet.createRandom().getAddress();
      const t1 = await ethers.Wallet.createRandom().getAddress();
      expect(await factory.getPair(t0, t1)).to.equal(ethers.ZeroAddress);
    });

    it("returns pair address after creation", async function () {
      const tokenA = await ethers.Wallet.createRandom().getAddress();
      const tokenB = await ethers.Wallet.createRandom().getAddress();
      const t0 = tokenA < tokenB ? tokenA : tokenB;
      const t1 = tokenA < tokenB ? tokenB : tokenA;

      await factory.createPair(t0, t1);
      const pairAddr = await factory.getPair(t0, t1);
      expect(pairAddr).to.not.equal(ethers.ZeroAddress);

      const pair: UniswapV2Pair = UniswapV2Pair__factory.connect(pairAddr, owner);
      expect(await pair.token0()).to.equal(t0);
      expect(await pair.token1()).to.equal(t1);
    });

    it("returns same address regardless of token order", async function () {
      const tokenA = await ethers.Wallet.createRandom().getAddress();
      const tokenB = await ethers.Wallet.createRandom().getAddress();
      const t0 = tokenA < tokenB ? tokenA : tokenB;
      const t1 = tokenA < tokenB ? tokenB : tokenA;

      await factory.createPair(t0, t1);
      expect(await factory.getPair(t0, t1)).to.equal(await factory.getPair(t1, t0));
    });
  });
});
