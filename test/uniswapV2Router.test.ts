import { expect } from "chai";
import { ethers } from "hardhat";
import type { UniswapV2Router02 } from "../typechain-types";
import { UniswapV2Router02__factory } from "../typechain-types";

function quote(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  return amountA * reserveB / reserveA;
}

function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const numerator = reserveIn * amountOut * 1000n;
  const denominator = (reserveOut - amountOut) * 997n;
  return numerator / denominator + 1n;
}

describe("UniswapV2Router02 — static functions", function () {
  let owner: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let router: UniswapV2Router02;
  let factoryAddr: string;
  let wethAddr: string;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("WETH9");
    const weth = await WETH.deploy();
    await weth.waitForDeployment();
    wethAddr = await weth.getAddress();

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    const factory = await Factory.deploy(owner.address);
    await factory.waitForDeployment();
    factoryAddr = await factory.getAddress();

    router = await new UniswapV2Router02__factory(owner).deploy(factoryAddr, wethAddr);
    await router.waitForDeployment();
  });

  describe("factory", function () {
    it("returns the factory address from constructor", async function () {
      expect(await router.factory()).to.equal(factoryAddr);
    });
  });

  describe("WETH", function () {
    it("returns the WETH address from constructor", async function () {
      expect(await router.WETH()).to.equal(wethAddr);
    });
  });

  describe("quote (pure)", function () {
    it("computes correct quote amount", async function () {
      const amountA = ethers.parseEther("1");
      const reserveA = ethers.parseEther("100");
      const reserveB = ethers.parseEther("200");
      const expected = quote(amountA, reserveA, reserveB);
      expect(await router.quote(amountA, reserveA, reserveB)).to.equal(expected);
    });

    it("handles small amounts", async function () {
      expect(await router.quote(1n, 100n, 200n)).to.equal(2n);
    });

    it("handles zero amounts (reverts)", async function () {
      await expect(
        router.quote(0n, ethers.parseEther("100"), ethers.parseEther("200"))
      ).to.be.reverted;
    });
  });

  describe("getAmountOut (pure)", function () {
    it("computes correct output with 0.3% fee", async function () {
      const amountIn = ethers.parseEther("1");
      const reserveIn = ethers.parseEther("100");
      const reserveOut = ethers.parseEther("200");
      const expected = getAmountOut(amountIn, reserveIn, reserveOut);
      expect(await router.getAmountOut(amountIn, reserveIn, reserveOut)).to.equal(expected);
    });

    it("handles small amounts", async function () {
      const expected = getAmountOut(1n, 100n, 200n);
      expect(await router.getAmountOut(1n, 100n, 200n)).to.equal(expected);
    });

    it("reverts on zero input", async function () {
      await expect(
        router.getAmountOut(0n, ethers.parseEther("100"), ethers.parseEther("200"))
      ).to.be.reverted;
    });
  });

  describe("getAmountIn (pure)", function () {
    it("computes correct input with 0.3% fee", async function () {
      const amountOut = ethers.parseEther("1");
      const reserveIn = ethers.parseEther("100");
      const reserveOut = ethers.parseEther("200");
      const expected = getAmountIn(amountOut, reserveIn, reserveOut);
      expect(await router.getAmountIn(amountOut, reserveIn, reserveOut)).to.equal(expected);
    });

    it("round-trip: getAmountIn(getAmountOut(x)) ≈ x", async function () {
      const amountIn = ethers.parseEther("1");
      const reserveIn = ethers.parseEther("100");
      const reserveOut = ethers.parseEther("200");

      const out = await router.getAmountOut(amountIn, reserveIn, reserveOut);
      const in_ = await router.getAmountIn(out, reserveIn, reserveOut);
      expect(in_).to.be.gte(amountIn);
      expect(in_ - amountIn).to.be.lte(1n);
    });

    it("round-trip: getAmountOut(getAmountIn(x)) ≈ x", async function () {
      const amountOut = ethers.parseEther("1");
      const reserveIn = ethers.parseEther("100");
      const reserveOut = ethers.parseEther("200");

      const in_ = await router.getAmountIn(amountOut, reserveIn, reserveOut);
      const out = await router.getAmountOut(in_, reserveIn, reserveOut);
      expect(out).to.be.gte(amountOut);
    });
  });

  describe("getAmountsOut (view)", function () {
    it("computes correct amounts with real token pair", async function () {
      const WETH = await ethers.getContractFactory("WETH9");
      const token0 = await WETH.deploy();
      await token0.waitForDeployment();
      const token1 = await WETH.deploy();
      await token1.waitForDeployment();

      const t0Addr = await token0.getAddress();
      const t1Addr = await token1.getAddress();
      const sortedT0 = t0Addr < t1Addr ? t0Addr : t1Addr;
      const sortedT1 = t0Addr < t1Addr ? t1Addr : t0Addr;

      const Factory = await ethers.getContractFactory("UniswapV2Factory");
      const factory = Factory.attach(factoryAddr);
      await factory.createPair(sortedT0, sortedT1);

      const pairAddr = await factory.getPair(sortedT0, sortedT1);
      const pair = await ethers.getContractAt("contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair", pairAddr);

      const amount0 = ethers.parseEther("1000");
      const amount1 = ethers.parseEther("2000");
      await token0.deposit({ value: amount0 });
      await token0.transfer(pairAddr, amount0);
      await token1.deposit({ value: amount1 });
      await token1.transfer(pairAddr, amount1);
      await pair.mint(owner.address);

      const [reserve0, reserve1] = await pair.getReserves();
      // pair.getReserves() returns (reserve0, reserve1) where reserve0 is for token0() (smaller address).
      // Since sortedT0 is the smaller address, it equals token0(), so reserve0 is the reserve of sortedT0.
      // path[0] = sortedT0 (input token), path[1] = sortedT1 (output token).
      const reserveIn = reserve0;
      const reserveOut = reserve1;

      const amountIn = reserveIn / 100n;
      const amounts = await router.getAmountsOut(amountIn, [sortedT0, sortedT1]);

      expect(amounts[0]).to.equal(amountIn);
      expect(amounts[1]).to.equal(getAmountOut(amountIn, reserveIn, reserveOut));
    });
  });

  describe("getAmountsIn (view)", function () {
    it("computes correct amounts with real token pair", async function () {
      const WETH = await ethers.getContractFactory("WETH9");
      const token0 = await WETH.deploy();
      await token0.waitForDeployment();
      const token1 = await WETH.deploy();
      await token1.waitForDeployment();

      const t0Addr = await token0.getAddress();
      const t1Addr = await token1.getAddress();
      const sortedT0 = t0Addr < t1Addr ? t0Addr : t1Addr;
      const sortedT1 = t0Addr < t1Addr ? t1Addr : t0Addr;

      const Factory = await ethers.getContractFactory("UniswapV2Factory");
      const factory = Factory.attach(factoryAddr);
      await factory.createPair(sortedT0, sortedT1);

      const pairAddr = await factory.getPair(sortedT0, sortedT1);
      const pair = await ethers.getContractAt("contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair", pairAddr);

      const amount0 = ethers.parseEther("1000");
      const amount1 = ethers.parseEther("2000");
      await token0.deposit({ value: amount0 });
      await token0.transfer(pairAddr, amount0);
      await token1.deposit({ value: amount1 });
      await token1.transfer(pairAddr, amount1);
      await pair.mint(owner.address);

      const [reserve0, reserve1] = await pair.getReserves();
      // pair.getReserves() returns (reserve0, reserve1) where reserve0 is for token0() (smaller address).
      // Since sortedT0 is the smaller address, reserve0 = balance of sortedT0 (input), reserve1 = balance of sortedT1 (output).
      const reserveIn = reserve0;
      const reserveOut = reserve1;

      const amountOut = reserveOut / 100n;
      const amounts = await router.getAmountsIn(amountOut, [sortedT0, sortedT1]);

      expect(amounts[amounts.length - 1]).to.equal(amountOut);
      expect(amounts[0]).to.equal(getAmountIn(amountOut, reserveIn, reserveOut));
    });
  });
});
