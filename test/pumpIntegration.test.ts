import { expect } from "chai";
import { ethers } from "hardhat";
import type {
  DuoLaunch,
  TokenTemplate,
  UniswapV2Factory,
  UniswapV2Router02,
  UniswapV2Pair,
} from "../typechain-types";
import {
  DuoLaunch__factory,
  TokenTemplate__factory,
  UniswapV2Factory__factory,
  UniswapV2Router02__factory,
  UniswapV2Pair__factory,
} from "../typechain-types";

describe("DuoLaunch × Uniswap V2 Router Integration", function () {
  let owner: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let user1: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let user2: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let weth: any;
  let factory: UniswapV2Factory;
  let router: UniswapV2Router02;
  let duoLaunch: DuoLaunch;
  let token: TokenTemplate;
  let tokenAddr: string;

  const GRADUATION_BPS = 8000;

  async function deployInfra() {
    [owner, user1, user2] = await ethers.getSigners();
    await ethers.provider.send("hardhat_setBalance", [owner.address, "0x152D02C7E14AF6800000"]);
    await ethers.provider.send("hardhat_setBalance", [user1.address, "0x152D02C7E14AF6800000"]);
    await ethers.provider.send("hardhat_setBalance", [user2.address, "0x152D02C7E14AF6800000"]);

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

    duoLaunch = await new DuoLaunch__factory(owner).deploy(await factory.getAddress(), await weth.getAddress());
    await duoLaunch.waitForDeployment();
  }

  async function createSale() {
    const tx = await duoLaunch.createSale("DuoLaunch Token", "PUMP", GRADUATION_BPS, ethers.parseEther("1000"), "", "", "", "");
    const receipt = await tx.wait();
    const log = receipt!.logs
      .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "SaleCreated");
    tokenAddr = log!.args.token as string;
    token = TokenTemplate__factory.connect(tokenAddr, owner);
  }

  describe("Full Lifecycle", function () {
    beforeEach(async function () {
      await deployInfra();
      await createSale();
    });

    it("should graduate and create a Uniswap V2 pair", async function () {
      // Buy until graduation (targetRaise = 1000 ETH)
      const sale = await duoLaunch.getSale(tokenAddr);
      const remaining = sale.targetRaise;
      const buyTx = await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: remaining });
      const receipt = await buyTx.wait();

      const gradLog = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
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

    it("should maintain price continuity between DuoLaunch AMM and Uniswap V2", async function () {
      // User1 buys some tokens
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const saleBeforeGrad = await duoLaunch.getSale(tokenAddr);

      // Owner graduates the pool
      const remaining = saleBeforeGrad.targetRaise - saleBeforeGrad.GASRaised;
      const gradTx = await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: remaining });
      const gradReceipt = await gradTx.wait();
      const gradLog = gradReceipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      const pairAddr = gradLog!.args.pair as string;
      const pair = UniswapV2Pair__factory.connect(pairAddr, owner);

      const saleGrad = await duoLaunch.getSale(tokenAddr);
      const tokensForLP = ethers.parseEther("1000000000") - saleGrad.tokensSold;
      const bcGASReserve = saleGrad.virtualGAS + saleGrad.GASRaised;
      const bcTokenReserve = saleGrad.virtualToken - saleGrad.tokensSold;

      // DuoLaunch closing price = bcGASReserve / bcTokenReserve
      // Uniswap opening price = GASReserve / tokenReserve
      const [res0, res1] = await pair.getReserves();
      const wethAddr = await weth.getAddress();
      const token0 = await pair.token0();
      const uniGasReserve = token0.toLowerCase() === wethAddr.toLowerCase() ? res0 : res1;
      const uniTokenReserve = token0.toLowerCase() === wethAddr.toLowerCase() ? res1 : res0;

      // Cross-multiply to compare prices: lhs ≈ rhs with tolerance
      const lhs = bcGASReserve * uniTokenReserve;
      const rhs = uniGasReserve * bcTokenReserve;
      const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
      expect(diff * 1000000n).to.be.lt(lhs + rhs);
    });

    it("should allow Uniswap V2 swaps after graduation", async function () {
      // User1 buys and graduates
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("50") });
      const saleBeforeGrad = await duoLaunch.getSale(tokenAddr);
      const remaining = saleBeforeGrad.targetRaise - saleBeforeGrad.GASRaised;
      const gradTx = await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: remaining });
      const gradReceipt = await gradTx.wait();
      const gradLog = gradReceipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      const pairAddr = gradLog!.args.pair as string;

      // User1 now swaps tokens for ETH on Uniswap V2
      const user1TokenBalance = await token.balanceOf(user1.address);
      const swapAmount = user1TokenBalance / 10n;
      await token.connect(user1).approve(await router.getAddress(), swapAmount);

      const deadline = ethers.MaxUint256;
      const amountsOut = await router.getAmountsOut(swapAmount, [tokenAddr, await weth.getAddress()]);
      const expectedGAS = amountsOut[1];

      await router.connect(user1).swapExactTokensForETH(
        swapAmount,
        expectedGAS * 999n / 1000n, // 0.1% slippage
        [tokenAddr, await weth.getAddress()],
        user1.address,
        deadline
      );

      expect(await token.balanceOf(user1.address)).to.equal(user1TokenBalance - swapAmount);
    });

    it("should allow buying tokens via Uniswap V2 after graduation", async function () {
      // Graduate the pool, capture pair from event
      const sale = await duoLaunch.getSale(tokenAddr);
      const remaining = sale.targetRaise;
      const gradTx = await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: remaining });
      const gradReceipt = await gradTx.wait();
      const gradLog = gradReceipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      expect(gradLog).to.not.be.undefined;
      const pairAddr = gradLog!.args.pair as string;
      expect(pairAddr).to.not.equal(ethers.ZeroAddress);

      const pair = UniswapV2Pair__factory.connect(pairAddr, owner);

      // User2 buys tokens via Uniswap
      const wethAddr = await weth.getAddress();
      const token0 = await pair.token0();
      const GASAmount = ethers.parseEther("10");

      // Wrap ETH to WETH
      await weth.connect(user2).deposit({ value: GASAmount });
      await weth.connect(user2).approve(await router.getAddress(), GASAmount);

      const amountsOut = await router.getAmountsOut(GASAmount, [wethAddr, tokenAddr]);
      const expectedTokens = amountsOut[1];

      if (token0.toLowerCase() === wethAddr.toLowerCase()) {
        await router.connect(user2).swapExactTokensForTokens(
          GASAmount,
          expectedTokens * 999n / 1000n,
          [wethAddr, tokenAddr],
          user2.address,
          ethers.MaxUint256
        );
        expect(await token.balanceOf(user2.address)).to.be.gt(0n);
      } else {
        await router.connect(user2).swapExactTokensForTokens(
          GASAmount,
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
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      const u1Bal = await token.balanceOf(user1.address);
      expect(u1Bal).to.be.gt(0n);

      // User2 buys
      await duoLaunch.connect(user2).buy(tokenAddr, 0n, { value: ethers.parseEther("3") });
      const u2Bal = await token.balanceOf(user2.address);
      expect(u2Bal).to.be.gt(0n);

      // User1 sells half
      const sellAmount = u1Bal / 2n;
      await token.connect(user1).approve(await duoLaunch.getAddress(), sellAmount);
      await duoLaunch.connect(user1).sell(tokenAddr, sellAmount, 0n);
      expect(await token.balanceOf(user1.address)).to.equal(u1Bal - sellAmount);

      // Graduate
      const sale = await duoLaunch.getSale(tokenAddr);
      const remaining = sale.targetRaise - sale.GASRaised;
      await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: remaining });

      const gradSale = await duoLaunch.getSale(tokenAddr);
      expect(gradSale.graduated).to.equal(true);
    });
  });

  describe("Edge Cases", function () {
    beforeEach(async function () {
      await deployInfra();
      await createSale();
    });

    it("should revert graduated sale operations", async function () {
      const sale = await duoLaunch.getSale(tokenAddr);
      await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: sale.targetRaise });

      await expect(
        duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("SALE_GRADUATED");

      await expect(
        duoLaunch.connect(user1).sell(tokenAddr, 1n, 0n)
      ).to.be.revertedWith("SALE_GRADUATED");
    });

    it("should refund overpayment when buy exceeds graduation point", async function () {
      const sale = await duoLaunch.getSale(tokenAddr);
      const overpay = sale.targetRaise + ethers.parseEther("5");
      const balBefore = await ethers.provider.getBalance(owner.address);

      const tx = await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: overpay });
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
        duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: 0n })
      ).to.be.revertedWith("ZERO_GAS");
    });

    it("should reject sells with no approval", async function () {
      // Without approval, safeTransferFrom fails
      await expect(
        duoLaunch.connect(user1).sell(tokenAddr, 100n, 0n)
      ).to.be.reverted;
    });
  });

  describe("Different Graduation Ratios", function () {
    it("should work with minimum graduation ratio (P=6001)", async function () {
      await deployInfra();
      const minBps = 6001;
      const tx = await duoLaunch.createSale("Min Grad", "MIN", minBps, ethers.parseEther("1000"), "", "", "", "");
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      const tAddr = log!.args.token as string;

      const sale = await duoLaunch.getSale(tAddr);
      await duoLaunch.connect(owner).buy(tAddr, 0n, { value: sale.targetRaise });

      const gradSale = await duoLaunch.getSale(tAddr);
      expect(gradSale.graduated).to.equal(true);
    });

    it("should work with maximum graduation ratio (P=8000)", async function () {
      await deployInfra();
      await createSale();

      const sale = await duoLaunch.getSale(tokenAddr);
      await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: sale.targetRaise });

      const gradSale = await duoLaunch.getSale(tokenAddr);
      expect(gradSale.graduated).to.equal(true);
    });
  });

  describe("Graduation fund flow to Pair", function () {
    let pairAddr: string;
    let pair: UniswapV2Pair;
    let saleGrad: Awaited<ReturnType<typeof duoLaunch.getSale>>;
    let gradLog: any;
    let rich: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;

    beforeEach(async function () {
      [owner, , , , rich] = await ethers.getSigners();
      await ethers.provider.send("hardhat_setBalance", [owner.address, "0x152D02C7E14AF6800000"]);
      await deployInfra();
      await createSale();

      await duoLaunch.connect(rich).buy(tokenAddr, 0n, { value: ethers.parseEther("30") });

      const sale = await duoLaunch.getSale(tokenAddr);
      const remaining = sale.targetRaise - sale.GASRaised;
      const gradTx = await duoLaunch.connect(rich).buy(tokenAddr, 0n, { value: remaining });
      const receipt = await gradTx.wait();
      gradLog = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      pairAddr = gradLog!.args.pair as string;
      pair = UniswapV2Pair__factory.connect(pairAddr, owner);
      saleGrad = await duoLaunch.getSale(tokenAddr);
    });

    it("pumps all remaining tokens and raised gas into the pair", async function () {
      const tokensForLP = ethers.parseEther("1000000000") - saleGrad.tokensSold;
      const GASForLP = saleGrad.GASRaised;

      expect(gradLog!.args.tokensForLP).to.equal(tokensForLP);
      expect(gradLog!.args.GASForLP).to.equal(GASForLP);

      const pumpTokenBalance = await token.balanceOf(await duoLaunch.getAddress());
      expect(pumpTokenBalance).to.equal(0n);

      const [res0, res1] = await pair.getReserves();
      expect(res0).to.be.gt(0n);
      expect(res1).to.be.gt(0n);

      const wethAddr = await weth.getAddress();
      const pairToken0 = await pair.token0();
      if (pairToken0.toLowerCase() === wethAddr.toLowerCase()) {
        expect(res0).to.equal(GASForLP);
        expect(res1).to.equal(tokensForLP);
      } else {
        expect(res0).to.equal(tokensForLP);
        expect(res1).to.equal(GASForLP);
      }
    });

    it("LP tokens are minted to address(0) and total supply is correct", async function () {
      expect(await pair.balanceOf(await duoLaunch.getAddress())).to.equal(0n);
      expect(await pair.totalSupply()).to.be.gt(0n);
    });
  });

  describe("Graduation via tokensSold cap", function () {
    it("graduation triggers via overpayment exceeding maxTokens cap", async function () {
      [owner, , , , user1] = await ethers.getSigners();
      await ethers.provider.send("hardhat_setBalance", [user1.address, "0x152D02C7E14AF6800000"]);

      const WETH = await ethers.getContractFactory("WETH9");
      const weth = await WETH.deploy();
      await weth.waitForDeployment();

      const Factory = await ethers.getContractFactory("UniswapV2Factory");
      const factory = await Factory.deploy(owner.address);
      await factory.waitForDeployment();

      const router = await new UniswapV2Router02__factory(owner).deploy(
        await factory.getAddress(), await weth.getAddress()
      );
      await router.waitForDeployment();

      const duoLaunch = await new DuoLaunch__factory(owner).deploy(
        await factory.getAddress(), await weth.getAddress()
      );
      await duoLaunch.waitForDeployment();

      const totalSupply = ethers.parseEther("1000000000");
      const gradBps = 8000n;
      const maxTokens = totalSupply * gradBps / 10000n;

      const tx = await duoLaunch.createSale("CapGrad", "CAP", gradBps, ethers.parseEther("1000"), "", "", "", "");
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      const tAddr = log!.args.token as string;

      const saleBefore = await duoLaunch.getSale(tAddr);

      const tokenReserve = saleBefore.virtualToken;
      const GASReserve = saleBefore.virtualGAS;
      const GASToHitCap = (maxTokens * GASReserve) / (tokenReserve - maxTokens) + 1n;

      const buyTx = await duoLaunch.connect(user1).buy(tAddr, 0n, { value: GASToHitCap * 2n });
      const gradReceipt = await buyTx.wait();
      const gradLog2 = gradReceipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      expect(gradLog2).to.not.be.undefined;

      const saleAfter = await duoLaunch.getSale(tAddr);
      expect(saleAfter.graduated).to.equal(true);
      expect(saleAfter.tokensSold).to.equal(maxTokens);
    });
  });

  describe("Path coverage", function () {
    beforeEach(async function () {
      await deployInfra();
      await createSale();
    });

    it("reverts when sending ETH directly to DuoLaunch contract", async function () {
      await expect(
        owner.sendTransaction({ to: await duoLaunch.getAddress(), value: ethers.parseEther("1") })
      ).to.be.reverted;
    });

    it("sell cannot trigger graduation even after selling all tokens", async function () {
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);
      await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);

      const sale = await duoLaunch.getSale(tokenAddr);
      expect(sale.graduated).to.equal(false);
    });

    it("createSale reverts with targetRaise = 0", async function () {
      await expect(
        duoLaunch.createSale("Zero", "ZRO", 8000, 0n, "", "", "", "")
      ).to.be.reverted;
    });
  });

  describe("createAndBuy Integration", function () {
    let cbTokenAddr: string;
    const CB_BUY = ethers.parseEther("50");

    beforeEach(async function () {
      await deployInfra();
      const tx = await duoLaunch.createAndBuy("CBToken", "CBT", 8000n, ethers.parseEther("1000"), 0n, "", "", "", "", {
        value: CB_BUY,
      });
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      cbTokenAddr = log!.args.token as string;
    });

    it("creates sale with correct initial state and tokens issued atomically", async function () {
      const sale = await duoLaunch.getSale(cbTokenAddr);
      expect(sale.creator).to.equal(owner.address);
      expect(sale.GASRaised).to.equal(CB_BUY);
      expect(sale.tokensSold).to.be.gt(0n);

      const token = TokenTemplate__factory.connect(cbTokenAddr, owner);
      const balance = await token.balanceOf(owner.address);
      expect(balance).to.be.gt(0n);
    });

    it("allows further buys and sells after createAndBuy", async function () {
      await duoLaunch.connect(user1).buy(cbTokenAddr, 0n, { value: ethers.parseEther("30") });
      const token = TokenTemplate__factory.connect(cbTokenAddr, user1);
      const user1Bal = await token.balanceOf(user1.address);
      expect(user1Bal).to.be.gt(0n);

      const sellAmt = user1Bal / 3n;
      await token.connect(user1).approve(await duoLaunch.getAddress(), sellAmt);
      await duoLaunch.connect(user1).sell(cbTokenAddr, sellAmt, 0n);
      expect(await token.balanceOf(user1.address)).to.equal(user1Bal - sellAmt);
    });

    it("can graduate and create Uniswap V2 pair after createAndBuy", async function () {
      const sale = await duoLaunch.getSale(cbTokenAddr);
      const remaining = sale.targetRaise - sale.GASRaised;

      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000",
      ]);
      const gradTx = await duoLaunch.connect(owner).buy(cbTokenAddr, 0n, { value: remaining });
      const rc = await gradTx.wait();
      const gradLog = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");

      expect(gradLog).to.not.be.undefined;
      const pairAddr = gradLog!.args.pair as string;
      expect(pairAddr).to.not.equal(ethers.ZeroAddress);

      const pair = UniswapV2Pair__factory.connect(pairAddr, owner);
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.be.gt(0n);
      expect(r1).to.be.gt(0n);
    });

    it("preserves price continuity through createAndBuy, further trades, and graduation", async function () {
      // User1 buys more after the atomic createAndBuy
      await duoLaunch.connect(user1).buy(cbTokenAddr, 0n, { value: ethers.parseEther("20") });

      // Graduate
      const sale = await duoLaunch.getSale(cbTokenAddr);
      const remaining = sale.targetRaise - sale.GASRaised;
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000",
      ]);
      const gradTx = await duoLaunch.connect(owner).buy(cbTokenAddr, 0n, { value: remaining + ethers.parseEther("1") });
      const rc = await gradTx.wait();
      const gradLog = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      const pairAddr = gradLog!.args.pair as string;
      const pair = UniswapV2Pair__factory.connect(pairAddr, owner);

      const sGrad = await duoLaunch.getSale(cbTokenAddr);
      const bcGAS = sGrad.virtualGAS + sGrad.GASRaised;
      const bcToken = sGrad.virtualToken - sGrad.tokensSold;

      const [r0, r1] = await pair.getReserves();
      const wethAddr = await weth.getAddress();
      const t0 = await pair.token0();
      const uniGas = t0.toLowerCase() === wethAddr.toLowerCase() ? r0 : r1;
      const uniToken = t0.toLowerCase() === wethAddr.toLowerCase() ? r1 : r0;

      const lhs = bcGAS * uniToken;
      const rhs = uniGas * bcToken;
      const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
      expect(diff * 1000000n).to.be.lt(lhs + rhs);
    });

    it("createAndBuy with value exceeding targetRaise refunds overpayment", async function () {
      await deployInfra();
      const targetRaise = ethers.parseEther("10");
      const overpay = targetRaise + ethers.parseEther("5");
      const balBefore = await ethers.provider.getBalance(owner.address);

      const tx = await duoLaunch.createAndBuy("Over", "OVR", 8000n, targetRaise, 0n, "", "", "", "", { value: overpay });
      const rc = await tx.wait();
      const gasCost = rc!.gasUsed * rc!.gasPrice;
      const balAfter = await ethers.provider.getBalance(owner.address);
      const netSpent = balBefore - balAfter - gasCost;

      expect(netSpent).to.be.closeTo(targetRaise, ethers.parseEther("0.01"));
    });
  });
});
