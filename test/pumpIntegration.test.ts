import { expect } from "chai";
import { ethers } from "hardhat";
import type {
  Pump,
  PumpToken,
  UniswapV2Factory,
  UniswapV2Router02,
  UniswapV2Pair,
} from "../typechain-types";
import {
  Pump__factory,
  PumpToken__factory,
  UniswapV2Factory__factory,
  UniswapV2Router02__factory,
  UniswapV2Pair__factory,
} from "../typechain-types";

describe("Pump × Uniswap V2 Router Integration", function () {
  let owner: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let user1: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let user2: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let weth: any;
  let factory: UniswapV2Factory;
  let router: UniswapV2Router02;
  let pump: Pump;
  let token: PumpToken;
  let tokenAddr: string;

  const GRADUATION_BPS = 8000;

  async function deployInfra() {
    [owner, user1, user2] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("WETH9");
    weth = await WETH.deploy();
    await weth.waitForDeployment();

    factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    router = await new UniswapV2Router02__factory(owner).deploy(
      await factory.getAddress(),
      await weth.getAddress()
    );
    await router.waitForDeployment();

    pump = await new Pump__factory(owner).deploy(await factory.getAddress(), await weth.getAddress());
    await pump.waitForDeployment();
  }

  async function createSale() {
    const tx = await pump.createSale("Pump Token", "PUMP", GRADUATION_BPS, ethers.parseEther("1000"));
    const receipt = await tx.wait();
    const log = receipt!.logs
      .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "SaleCreated");
    tokenAddr = log!.args.token as string;
    token = PumpToken__factory.connect(tokenAddr, owner);
  }

  describe("Full Lifecycle", function () {
    beforeEach(async function () {
      await deployInfra();
      await createSale();
    });

    it("should graduate and create a Uniswap V2 pair", async function () {
      // Buy until graduation (targetRaise = 1000 ETH)
      const sale = await pump.getSale(tokenAddr);
      const remaining = sale.targetRaise;
      const buyTx = await pump.connect(owner).buy(tokenAddr, 0n, { value: remaining });
      const receipt = await buyTx.wait();

      const gradLog = receipt!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");

      expect(gradLog).to.not.be.undefined;
      const pairAddr = gradLog!.args.pair as string;
      expect(pairAddr).to.not.equal(ethers.ZeroAddress);

      const pair = UniswapV2Pair__factory.connect(pairAddr, owner);
      expect(await pair.totalSupply()).to.be.gt(0n);

      const [res0, res1] = await pair.getReserves();
      const wethAddr = await weth.getAddress();
      const token0 = await pair.token0();
      // Verify both reserves are non-zero
      if (token0.toLowerCase() === wethAddr.toLowerCase()) {
        expect(res0).to.be.gt(0n);
        expect(res1).to.be.gt(0n);
      } else {
        expect(res1).to.be.gt(0n);
        expect(res0).to.be.gt(0n);
      }
    });

    it("should maintain price continuity between Pump AMM and Uniswap V2", async function () {
      // User1 buys some tokens
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const saleBeforeGrad = await pump.getSale(tokenAddr);

      // Owner graduates the pool
      const remaining = saleBeforeGrad.targetRaise - saleBeforeGrad.gasRaised;
      const gradTx = await pump.connect(owner).buy(tokenAddr, 0n, { value: remaining });
      const gradReceipt = await gradTx.wait();
      const gradLog = gradReceipt!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      const pairAddr = gradLog!.args.pair as string;
      const pair = UniswapV2Pair__factory.connect(pairAddr, owner);

      const saleGrad = await pump.getSale(tokenAddr);
      const tokensForLP = saleGrad.totalSupply - saleGrad.tokensSold;
      const bcGasReserve = saleGrad.virtualGas + saleGrad.gasRaised;
      const bcTokenReserve = saleGrad.virtualToken - saleGrad.tokensSold;

      // Pump closing price = bcGasReserve / bcTokenReserve
      // Uniswap opening price = gasReserve / tokenReserve
      const [res0, res1] = await pair.getReserves();
      const wethAddr = await weth.getAddress();
      const token0 = await pair.token0();
      const uniGasReserve = token0.toLowerCase() === wethAddr.toLowerCase() ? res0 : res1;
      const uniTokenReserve = token0.toLowerCase() === wethAddr.toLowerCase() ? res1 : res0;

      // Cross-multiply to compare prices: lhs ≈ rhs with tolerance
      const lhs = bcGasReserve * uniTokenReserve;
      const rhs = uniGasReserve * bcTokenReserve;
      const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
      expect(diff * 1000000n).to.be.lt(lhs + rhs);
    });

    it("should allow Uniswap V2 swaps after graduation", async function () {
      // User1 buys and graduates
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("50") });
      const saleBeforeGrad = await pump.getSale(tokenAddr);
      const remaining = saleBeforeGrad.targetRaise - saleBeforeGrad.gasRaised;
      const gradTx = await pump.connect(owner).buy(tokenAddr, 0n, { value: remaining });
      const gradReceipt = await gradTx.wait();
      const gradLog = gradReceipt!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      const pairAddr = gradLog!.args.pair as string;

      // User1 now swaps tokens for ETH on Uniswap V2
      const user1TokenBalance = await token.balanceOf(user1.address);
      const swapAmount = user1TokenBalance / 10n;
      await token.connect(user1).approve(await router.getAddress(), swapAmount);

      const deadline = ethers.MaxUint256;
      const amountsOut = await router.getAmountsOut(swapAmount, [tokenAddr, await weth.getAddress()]);
      const expectedGas = amountsOut[1];

      await router.connect(user1).swapExactTokensForETH(
        swapAmount,
        expectedGas * 999n / 1000n, // 0.1% slippage
        [tokenAddr, await weth.getAddress()],
        user1.address,
        deadline
      );

      expect(await token.balanceOf(user1.address)).to.equal(user1TokenBalance - swapAmount);
    });

    it("should allow buying tokens via Uniswap V2 after graduation", async function () {
      // Graduate the pool, capture pair from event
      const sale = await pump.getSale(tokenAddr);
      const remaining = sale.targetRaise;
      const gradTx = await pump.connect(owner).buy(tokenAddr, 0n, { value: remaining });
      const gradReceipt = await gradTx.wait();
      const gradLog = gradReceipt!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      expect(gradLog).to.not.be.undefined;
      const pairAddr = gradLog!.args.pair as string;
      expect(pairAddr).to.not.equal(ethers.ZeroAddress);

      const pair = UniswapV2Pair__factory.connect(pairAddr, owner);

      // User2 buys tokens via Uniswap
      const wethAddr = await weth.getAddress();
      const token0 = await pair.token0();
      const gasAmount = ethers.parseEther("10");

      // Wrap ETH to WETH
      await weth.connect(user2).deposit({ value: gasAmount });
      await weth.connect(user2).approve(await router.getAddress(), gasAmount);

      const amountsOut = await router.getAmountsOut(gasAmount, [wethAddr, tokenAddr]);
      const expectedTokens = amountsOut[1];

      if (token0.toLowerCase() === wethAddr.toLowerCase()) {
        await router.connect(user2).swapExactTokensForTokens(
          gasAmount,
          expectedTokens * 999n / 1000n,
          [wethAddr, tokenAddr],
          user2.address,
          ethers.MaxUint256
        );
        expect(await token.balanceOf(user2.address)).to.be.gt(0n);
      } else {
        await router.connect(user2).swapExactTokensForTokens(
          gasAmount,
          expectedTokens * 999n / 1000n,
          [wethAddr, tokenAddr],
          user2.address,
          ethers.MaxUint256
        );
        expect(await token.balanceOf(user2.address)).to.be.gt(0n);
      }
    });
  });

  describe("Multiple Users", function () {
    beforeEach(async function () {
      await deployInfra();
      await createSale();
    });

    it("should handle concurrent buy/sell from multiple users and graduate", async function () {
      // User1 buys
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      const u1Bal = await token.balanceOf(user1.address);
      expect(u1Bal).to.be.gt(0n);

      // User2 buys
      await pump.connect(user2).buy(tokenAddr, 0n, { value: ethers.parseEther("3") });
      const u2Bal = await token.balanceOf(user2.address);
      expect(u2Bal).to.be.gt(0n);

      // User1 sells half
      const sellAmount = u1Bal / 2n;
      await token.connect(user1).approve(await pump.getAddress(), sellAmount);
      await pump.connect(user1).sell(tokenAddr, sellAmount, 0n);
      expect(await token.balanceOf(user1.address)).to.equal(u1Bal - sellAmount);

      // Graduate
      const sale = await pump.getSale(tokenAddr);
      const remaining = sale.targetRaise - sale.gasRaised;
      await pump.connect(owner).buy(tokenAddr, 0n, { value: remaining });

      const gradSale = await pump.getSale(tokenAddr);
      expect(gradSale.graduated).to.equal(true);
    });
  });

  describe("Edge Cases", function () {
    beforeEach(async function () {
      await deployInfra();
      await createSale();
    });

    it("should revert graduated sale operations", async function () {
      const sale = await pump.getSale(tokenAddr);
      await pump.connect(owner).buy(tokenAddr, 0n, { value: sale.targetRaise });

      await expect(
        pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("SALE_GRADUATED");

      await expect(
        pump.connect(user1).sell(tokenAddr, 1n, 0n)
      ).to.be.revertedWith("SALE_GRADUATED");
    });

    it("should refund overpayment when buy exceeds graduation point", async function () {
      const sale = await pump.getSale(tokenAddr);
      const overpay = sale.targetRaise + ethers.parseEther("5");
      const balBefore = await ethers.provider.getBalance(owner.address);

      const tx = await pump.connect(owner).buy(tokenAddr, 0n, { value: overpay });
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(owner.address);
      const netSpent = balBefore - balAfter - gasCost;

      // Net spent should be less than overpay (refund issued)
      expect(netSpent).to.be.lt(overpay);
      expect(netSpent).to.equal(sale.targetRaise);
    });

    it("should reject zero-value buys", async function () {
      await expect(
        pump.connect(user1).buy(tokenAddr, 0n, { value: 0n })
      ).to.be.revertedWith("ZERO_GAS");
    });

    it("should reject sells with no approval", async function () {
      // Without approval, safeTransferFrom fails
      await expect(
        pump.connect(user1).sell(tokenAddr, 100n, 0n)
      ).to.be.reverted;
    });
  });

  describe("Different Graduation Ratios", function () {
    it("should work with minimum graduation ratio (P=5001)", async function () {
      await deployInfra();
      // Create sale with P = 5001 bps (minimum valid)
      const minBps = 5001;
      const tx = await pump.createSale("Min Grad", "MIN", minBps, ethers.parseEther("1000"));
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      const tAddr = log!.args.token as string;
      const t = PumpToken__factory.connect(tAddr, owner);

      // Graduate
      const sale = await pump.getSale(tAddr);
      await pump.connect(owner).buy(tAddr, 0n, { value: sale.targetRaise });

      const gradSale = await pump.getSale(tAddr);
      expect(gradSale.graduated).to.equal(true);
    });

    it("should work with maximum graduation ratio (P=8000)", async function () {
      await deployInfra();
      await createSale(); // Already uses 8000

      const sale = await pump.getSale(tokenAddr);
      await pump.connect(owner).buy(tokenAddr, 0n, { value: sale.targetRaise });

      const gradSale = await pump.getSale(tokenAddr);
      expect(gradSale.graduated).to.equal(true);
    });
  });
});
