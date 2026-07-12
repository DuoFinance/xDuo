import { expect } from "chai";
import { ethers } from "hardhat";
import type { UniswapV2Factory, UniswapV2Pair } from "../typechain-types";
import { UniswapV2Factory__factory, UniswapV2Pair__factory } from "../typechain-types";

const ERC20_BYTECODE = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
];

describe("UniswapV2Pair — static functions", function () {
  let owner: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let user: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let factory: UniswapV2Factory;
  let pair: UniswapV2Pair;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    const tokenA = await ethers.Wallet.createRandom().getAddress();
    const tokenB = await ethers.Wallet.createRandom().getAddress();
    const t0 = tokenA < tokenB ? tokenA : tokenB;
    const t1 = tokenA < tokenB ? tokenB : tokenA;

    await factory.createPair(t0, t1);
    const pairAddr = await factory.getPair(t0, t1);
    pair = UniswapV2Pair__factory.connect(pairAddr, owner);
  });

  describe("getReserves", function () {
    it("returns zero reserves initially", async function () {
      const [r0, r1, blockTimestampLast] = await pair.getReserves();
      expect(r0).to.equal(0n);
      expect(r1).to.equal(0n);
      expect(blockTimestampLast).to.equal(0);
    });
  });

  describe("token0 / token1", function () {
    it("returns sorted token addresses", async function () {
      const t0 = await pair.token0();
      const t1 = await pair.token1();
      expect(t0).to.not.equal(t1);
      expect(BigInt(t0) < BigInt(t1)).to.be.true;
    });
  });

  describe("totalSupply", function () {
    it("returns 0 initially", async function () {
      expect(await pair.totalSupply()).to.equal(0n);
    });
  });

  describe("balanceOf", function () {
    it("returns 0 for accounts without LP tokens", async function () {
      expect(await pair.balanceOf(user.address)).to.equal(0n);
    });
  });

  describe("kLast", function () {
    it("returns 0 initially", async function () {
      expect(await pair.kLast()).to.equal(0n);
    });
  });
});
