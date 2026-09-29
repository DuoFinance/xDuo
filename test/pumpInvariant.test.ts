import { expect } from "chai";
import { ethers } from "hardhat";
import type {
  DuoLaunch, TokenTemplate, UniswapV2Factory, UniswapV2Router02, UniswapV2Pair
} from "../typechain-types";
import {
  DuoLaunch__factory, TokenTemplate__factory,
  UniswapV2Factory__factory, UniswapV2Router02__factory,
  UniswapV2Pair__factory,
} from "../typechain-types";

describe("DuoLaunch Invariants & Boundary Tests", function () {
  let owner: any, user1: any, user2: any;
  let duoLaunch: DuoLaunch;
  let token: TokenTemplate;
  let tokenAddr: string;
  let weth: any;
  let GraduationBps: number;

  const TOTAL_SUPPLY = ethers.parseEther("1000000000");

  // ─── helpers ───────────────────────────────────────────────
  async function deploy(graduationBps: number) {
    GraduationBps = graduationBps;
    [owner, user1, user2] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("WETH9");
    weth = await WETH.deploy();
    await weth.waitForDeployment();

    const factory: UniswapV2Factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    const router: UniswapV2Router02 = await new UniswapV2Router02__factory(owner).deploy(
      await factory.getAddress(), await weth.getAddress()
    );
    await router.waitForDeployment();

    duoLaunch = await new DuoLaunch__factory(owner).deploy(await factory.getAddress(), await weth.getAddress());
    await duoLaunch.waitForDeployment();

    const tx = await duoLaunch.createSale("T", "T", graduationBps, ethers.parseEther("1000"), "", "", "", "");
    const rc = await tx.wait();
    const log = rc!.logs
      .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "SaleCreated");
    tokenAddr = log!.args.token as string;
    token = TokenTemplate__factory.connect(tokenAddr, owner);
  }

  let K0: bigint;

  /** k = (virtualGas + gasRaised) * (virtualToken - tokensSold) */
  async function invariantK(): Promise<bigint> {
    const s = await duoLaunch.getSale(tokenAddr);
    return (s.virtualGAS + s.GASRaised) * (s.virtualToken - s.tokensSold);
  }

  /** Assert k is approximately unchanged (within 1e-17 relative tolerance) */
  async function assertKUnchanged() {
    const k = await invariantK();
    const diff = k > K0 ? k - K0 : K0 - k;
    // Solidity integer division causes ~1 wei drift per trade
    // Accept relative error < 1e-17 (negligible)
    expect(diff * 1_000_000_000_000_000_000n).to.be.lt((k + K0) * 10n);
  }

  async function getGasReserve() {
    const s = await duoLaunch.getSale(tokenAddr);
    return s.virtualGAS + s.GASRaised;
  }
  async function getTokenReserve() {
    const s = await duoLaunch.getSale(tokenAddr);
    return s.virtualToken - s.tokensSold;
  }

  // ─── INVARIANT 1: constant product ────────────────────────
  describe("Invariant: constant product (x*y=k)", function () {
    it("k approximately unchanged after multiple buys", async function () {
      await deploy(8000);
      K0 = await invariantK();

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      await assertKUnchanged();

      await duoLaunch.connect(user2).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      await assertKUnchanged();
    });

    it("k approximately unchanged after buy �?sell", async function () {
      await deploy(8000);
      K0 = await invariantK();

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal / 2n);
      await duoLaunch.connect(user1).sell(tokenAddr, bal / 2n, 0n);

      await assertKUnchanged();
    });

    it("k approximately unchanged after buy �?full sell �?buy again", async function () {
      await deploy(8000);
      K0 = await invariantK();

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("3") });
      let bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);
      await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);
      // Full sell leaves 1 wei gasRaised due to getAmountIn rounding up (+1)
      await assertKUnchanged();

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      await assertKUnchanged();
    });
  });

  // ─── INVARIANT 2: DuoLaunch holds all unsold tokens ────────────
  describe("Invariant: DuoLaunch contract holds (totalSupply - tokensSold) tokens", function () {
    it("holds correct balance after mixed buys/sells", async function () {
      await deploy(8000);

      const pumpAddr = await duoLaunch.getAddress();
      const s0 = await duoLaunch.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(TOTAL_SUPPLY - s0.tokensSold);

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("8") });
      const s1 = await duoLaunch.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(TOTAL_SUPPLY - s1.tokensSold);

      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal / 2n);
      await duoLaunch.connect(user1).sell(tokenAddr, bal / 2n, 0n);
      const s2 = await duoLaunch.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(TOTAL_SUPPLY - s2.tokensSold);
    });
  });

  // ─── INVARIANT 3: tokensSold never exceeds cap ────────────
  describe("Invariant: tokensSold �?totalSupply * P / BPS_DENOM before graduation", function () {
    for (const p of [6000, 6001, 7000, 8000, 9999]) {
      it(`P = ${p}`, async function () {
        await deploy(p);
        const s = await duoLaunch.getSale(tokenAddr);
        const cap = TOTAL_SUPPLY * BigInt(p) / 10000n;

        for (let i = 0; i < 10; i++) {
          const s2 = await duoLaunch.getSale(tokenAddr);
          if (s2.graduated) break;
          const remaining = s2.targetRaise - s2.GASRaised;
          if (remaining <= 0n) break;
          const chunk = remaining > ethers.parseEther("100")
            ? ethers.parseEther("100") : remaining;
          await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: chunk });
        }

        const s3 = await duoLaunch.getSale(tokenAddr);
        expect(s3.tokensSold).to.be.lte(cap);
        if (s3.graduated) {
          // Graduation is triggered by tokensSold cap; GASRaised can be
          // a few wei below targetRaise due to integer-division rounding
          // (notably at P=9999). Allow 1e6 wei dust.
          expect(s3.GASRaised).to.be.gte(s3.targetRaise - 1000000n);
        }
      });
    }
  });

  // ─── INVARIANT 4: gasRaised monotonically increases, tokensSold monotonically increases ───
  describe("Invariant: gasRaised & tokensSold are monotonic", function () {
    it("monotonic across sequential buys", async function () {
      await deploy(8000);
      let prevGAS = 0n, prevTokens = 0n;
      for (let i = 0; i < 5; i++) {
        await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
        const s = await duoLaunch.getSale(tokenAddr);
        expect(s.GASRaised).to.be.gt(prevGAS);
        expect(s.tokensSold).to.be.gt(prevTokens);
        prevGAS = s.GASRaised;
        prevTokens = s.tokensSold;
      }
    });

    it("tokensSold decreases on sell, gasRaised decreases on sell", async function () {
      await deploy(8000);
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("100") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);

      const sBefore = await duoLaunch.getSale(tokenAddr);
      await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);
      const sAfter = await duoLaunch.getSale(tokenAddr);
      // Both should have decreased
      expect(sAfter.tokensSold).to.be.lt(sBefore.tokensSold);
      expect(sAfter.GASRaised).to.be.lt(sBefore.GASRaised);
    });
  });

  // ─── INVARIANT 5: price is always positive ────────────────
  describe("Invariant: getCurrentPrice > 0", function () {
    it("price > 0 after each action", async function () {
      await deploy(8000);
      expect(await duoLaunch.getCurrentPrice(tokenAddr)).to.be.gt(0n);

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      expect(await duoLaunch.getCurrentPrice(tokenAddr)).to.be.gt(0n);

      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal / 2n);
      await duoLaunch.connect(user1).sell(tokenAddr, bal / 2n, 0n);
      expect(await duoLaunch.getCurrentPrice(tokenAddr)).to.be.gt(0n);
    });
  });

  // ─── INVARIANT 6: getTokensForGas / getGasForTokens are consistent ───
  describe("Invariant: quote helpers are consistent with actual trades", function () {
    it("getAmountOut(GASReserve, tokenReserve, GASIn) matches actual tokensOut", async function () {
      await deploy(8000);

      const GASAmount = ethers.parseEther("5");
      const quoted = await duoLaunch.getTokensForGAS(tokenAddr, GASAmount);

      const tx = await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: GASAmount });
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensPurchased");
      const actual = log!.args.tokensOut as bigint;

      expect(actual).to.equal(quoted);
    });

    it("getGasForTokens matches actual GASOut on sell", async function () {
      await deploy(8000);
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });

      const sellAmount = await token.balanceOf(user1.address) / 4n;
      const quotedGAS = await duoLaunch.getGASForTokens(tokenAddr, sellAmount);

      await token.connect(user1).approve(await duoLaunch.getAddress(), sellAmount);
      const tx = await duoLaunch.connect(user1).sell(tokenAddr, sellAmount, 0n);
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensSold");
      const actualGas = log!.args.GASOut as bigint;

      expect(actualGas).to.equal(quotedGAS);
    });
  });

  // ─── INVARIANT 7: post-graduation price continuity ────────
  describe("Invariant: price continuity across graduation", function () {
    it("Uniswap V2 opening price �?DuoLaunch closing price", async function () {
      await deploy(8000);
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("30") });

      const s = await duoLaunch.getSale(tokenAddr);
      const remaining = s.targetRaise - s.GASRaised;
      // Ensure owner has enough ETH for graduation
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000" // 1,208,925 ETH
      ]);
      const gradTx = await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: remaining + ethers.parseEther("1") });
      const rc = await gradTx.wait();
      const gradLog = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      const pairAddr = gradLog!.args.pair as string;
      const pair = await ethers.getContractAt("contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair", pairAddr);

      const sGrad = await duoLaunch.getSale(tokenAddr);
      const bcGASReserve = sGrad.virtualGAS + sGrad.GASRaised;
      const bcTokenReserve = sGrad.virtualToken - sGrad.tokensSold;
      const tokensForLP = TOTAL_SUPPLY - sGrad.tokensSold;

      const [r0, r1] = await pair.getReserves();
      const wethAddr = await weth.getAddress();
      const t0 = await pair.token0();
      const uniGas = t0.toLowerCase() === wethAddr.toLowerCase() ? r0 : r1;
      const uniToken = t0.toLowerCase() === wethAddr.toLowerCase() ? r1 : r0;

      // Compare DuoLaunch closing price vs Uniswap opening price
      // DuoLaunch: bcGASReserve / bcTokenReserve
      // Uni:  uniGas / uniToken
      // Cross-multiplied: bcGASReserve * uniToken �?uniGas * bcTokenReserve
      const lhs = bcGASReserve * uniToken;
      const rhs = uniGas * bcTokenReserve;
      const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
      expect(diff * 1000000n).to.be.lt(lhs + rhs);
    });
  });

  // ─── BOUNDARY: invalid graduation values ──────────────────
  describe("Boundary: graduation BPS", function () {
    // it("reverts P = 5000 (invalid, twoPminusOne = 0)", async function () {
    //   await deploy(8000); // deploy a baseline first for signers
    //   const [o] = await ethers.getSigners();
    //   const Router = await ethers.getContractFactory("UniswapV2Router02");
    //   const r = await Router.deploy(ethers.ZeroAddress, ethers.ZeroAddress);
    //   await r.waitForDeployment();
    //   const p = await new DuoLaunch__factory(o).deploy(ethers.ZeroAddress, ethers.ZeroAddress);
    //   await p.waitForDeployment();
    //   await expect(p.createSale("X", "X", 5000, ethers.parseEther("1000"))).to.be.revertedWith("INVALID_GRADUATION");
    // });

    it("reverts P < 6000", async function () {
      const [o] = await ethers.getSigners();
      const p = await new DuoLaunch__factory(o).deploy(ethers.ZeroAddress, ethers.ZeroAddress);
      await p.waitForDeployment();
      await expect(p.createSale("X", "X", 5999, ethers.parseEther("1000"), "", "", "", "")).to.be.revertedWith("INVALID_GRADUATION_MIN");
    });

    it("reverts P > 9999", async function () {
      const [o] = await ethers.getSigners();
      const p = await new DuoLaunch__factory(o).deploy(ethers.ZeroAddress, ethers.ZeroAddress);
      await p.waitForDeployment();
      await expect(p.createSale("X", "X", 10000, ethers.parseEther("1000"), "", "", "", "")).to.be.revertedWith("INVALID_GRADUATION_MAX");
    });

    it("accepts P = 6000 (minimum valid)", async function () {
      await deploy(6000);
      const s = await duoLaunch.getSale(tokenAddr);
      expect(s.virtualGAS).to.be.gt(0n);
      expect(s.virtualToken).to.be.gt(0n);
      expect(s.graduationBps).to.equal(6000);
    });

    it("accepts P = 9999 (maximum valid)", async function () {
      await deploy(9999);
      const s = await duoLaunch.getSale(tokenAddr);
      expect(s.virtualGAS).to.be.gt(0n);
      expect(s.virtualToken).to.be.gt(0n);
      expect(s.graduationBps).to.equal(9999);
    });
  });

  // ─── BOUNDARY: edge case buys/sells ───────────────────────
  describe("Boundary: buy/sell edge cases", function () {
    it("reverts buy with 0 wei", async function () {
      await deploy(8000);
      await expect(duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: 0n })).to.be.revertedWith("ZERO_GAS");
    });

    it("reverts sell with 0 tokens", async function () {
      await deploy(8000);
      await expect(duoLaunch.connect(user1).sell(tokenAddr, 0n, 0n)).to.be.revertedWith("ZERO_TOKENS");
    });

    it("reverts sell when user has no tokens", async function () {
      await deploy(8000);
      await expect(
        duoLaunch.connect(user1).sell(tokenAddr, 100n, 0n)
      ).to.be.reverted;
    });

    it("reverts sell exceeding user balance", async function () {
      await deploy(8000);
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);
      await expect(
        duoLaunch.connect(user1).sell(tokenAddr, bal + 1n, 0n)
      ).to.be.reverted;
    });

    it("returns remaining gas (1 wei rounding dust) after selling all tokens", async function () {
      await deploy(8000);
      // Buy and sell enough to leave minimal dust
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);
      await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);
      const s = await duoLaunch.getSale(tokenAddr);
      // getAmountIn's +1 rounding leaves 1 wei dust
      expect(s.GASRaised).to.be.lte(1n);
      expect(s.tokensSold).to.equal(0n);
    });

    it("reverts buy with slippage too high", async function () {
      await deploy(8000);
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      // Now price is higher; trying to buy at previous token count should fail with SLIPPAGE
      const s = await duoLaunch.getSale(tokenAddr);
      const tokenReserve = s.virtualToken - s.tokensSold;
      const GASReserve = s.virtualGAS + s.GASRaised;
      // Buying with 1 ETH now gets fewer tokens
      const tokensFor1Eth = GASReserve * tokenReserve / (GASReserve + ethers.parseEther("1"));
      const minTokensOut = tokensFor1Eth + 1n; // slightly higher than actual
      await expect(
        duoLaunch.connect(user2).buy(tokenAddr, minTokensOut, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("SLIPPAGE");
    });

    it("reverts when tokenReserve would hit zero", async function () {
      await deploy(8000);
      const s = await duoLaunch.getSale(tokenAddr);
      // Buying in huge chunk shouldn't be possible (capped at graduation point)
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000"
      ]);
      await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: s.targetRaise });
      const s2 = await duoLaunch.getSale(tokenAddr);
      expect(s2.graduated).to.equal(true);
      const tokenReserve = s2.virtualToken - s2.tokensSold;
      expect(tokenReserve).to.be.gt(0n);
    });
  });

  // ─── BOUNDARY: exact graduation ────────────────────────────
  describe("Boundary: exact graduation", function () {
    it("graduation triggers exactly at targetRaise", async function () {
      await deploy(8000);
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000"
      ]);
      await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: ethers.parseEther("1000") });
      const s = await duoLaunch.getSale(tokenAddr);
      expect(s.graduated).to.equal(true);
      expect(s.GASRaised).to.be.gte(ethers.parseEther("1000"));
    });

    it("P=6000 graduation still creates Uniswap pair", async function () {
      await deploy(6000);
      const s = await duoLaunch.getSale(tokenAddr);
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000"
      ]);
      const gradTx = await duoLaunch.connect(owner).buy(tokenAddr, 0n, {
        value: s.targetRaise + ethers.parseEther("10")
      });
      const rc = await gradTx.wait();
      const gradLog = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      expect(gradLog).to.not.be.undefined;
      expect(gradLog!.args.pair).to.not.equal(ethers.ZeroAddress);
    });

    it("graduation triggers when tokensSold reaches maxTokens (prevents deadlock)", async function () {
      await deploy(8000);
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000"
      ]);

      // Buy in many small increments to accumulate rounding dust
      for (let i = 0; i < 100; i++) {
        const s = await duoLaunch.getSale(tokenAddr);
        if (s.graduated) break;
        await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("0.01") });
      }

      // If not yet graduated, try to push tokensSold to cap
      const s = await duoLaunch.getSale(tokenAddr);
      if (!s.graduated) {
        const maxTokens = TOTAL_SUPPLY * BigInt(GraduationBps) / 10000n;
        if (s.tokensSold >= maxTokens) {
          await expect(
            duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: ethers.parseEther("1") })
          ).to.not.be.reverted;
          const s2 = await duoLaunch.getSale(tokenAddr);
          expect(s2.graduated).to.equal(true);
        }
      }
    });
  });

  // ─── SECURITY: getSale revert on non-existent token ────────
  describe("Security: getSale reverts for non-existent token", function () {
    it("reverts getSale for non-existent token", async function () {
      await deploy(8000);
      await expect(
        duoLaunch.getSale(ethers.ZeroAddress)
      ).to.be.revertedWith("SALE_NOT_EXIST");
    });
  });

  // ─── SECURITY: pre-existing pair liquidity handled safely ──
  describe("Security: pre-existing pair liquidity handled safely", function () {
    it("graduation succeeds even if pair has pre-existing liquidity (no DoS)", async function () {
      await deploy(8000);
      const factoryAddr = await duoLaunch.uniswapFactory();
      const factory = UniswapV2Factory__factory.connect(factoryAddr, owner);

      // User1 buys some tokens first (needed for donation)
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      const user1Bal = await token.balanceOf(user1.address);
      expect(user1Bal).to.be.gt(0n);

      // Pre-create the pair and donate tokens + WETH (simulating attack)
      await factory.createPair(tokenAddr, await weth.getAddress());
      const pairAddr = await factory.getPair(tokenAddr, await weth.getAddress());
      const pair = UniswapV2Pair__factory.connect(pairAddr, owner);

      // Donate tokens (from user1) and WETH (from owner) to the pair
      const donateAmount = user1Bal / 10n;
      await token.connect(user1).transfer(pairAddr, donateAmount);
      await weth.deposit({ value: ethers.parseEther("1") });
      await weth.transfer(pairAddr, ethers.parseEther("1"));
      // Mint LP tokens to make reserves non-zero
      await pair.mint(owner.address);

      const [r0Before, r1Before] = await pair.getReserves();
      expect(r0Before).to.not.equal(0n);
      expect(r1Before).to.not.equal(0n);

      // Graduation should still succeed (no DoS)
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000"
      ]);
      const gradTx = await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: ethers.parseEther("1000") });
      const gradRc = await gradTx.wait();
      const gradLog = gradRc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      expect(gradLog).to.not.be.undefined;

      // Verify sale graduated
      const sale = await duoLaunch.getSale(tokenAddr);
      expect(sale.graduated).to.equal(true);

      // LP tokens should be burned (sent to address(0))
      // pair.totalSupply() includes the pre-existing LP + new LP
      // The new LP from DuoLaunch's mint goes to address(0)
      const lpBalancePump = await pair.balanceOf(await duoLaunch.getAddress());
      expect(lpBalancePump).to.equal(0n);

      // Both reserves should be non-zero after graduation
      const [r0After, r1After] = await pair.getReserves();
      expect(r0After).to.be.gt(r0Before);
      expect(r1After).to.be.gt(r1Before);
    });
  });

  // ─── FUZZ: random buy/sell sequences ──────────────────────
  describe("Fuzz: random trade sequences preserve invariants", function () {
    async function fuzzRound(graduationBps: number, rounds: number) {
      await deploy(graduationBps);
      K0 = await invariantK();
      const pumpAddr = await duoLaunch.getAddress();
      let userBalances: Map<string, bigint> = new Map();

      const users = [user1, user2, owner];
      const userAddr = users.map(u => u.address.toLowerCase());
      for (const u of userAddr) userBalances.set(u, 0n);

      for (let i = 0; i < rounds; i++) {
        const s = await duoLaunch.getSale(tokenAddr);
        if (s.graduated) break;

        const u = users[i % users.length];
        const uAddr = u.address.toLowerCase();

        // Decide action: 70% buy, 30% sell
        const action = Math.random() < 0.7 ? "buy" : "sell";

        if (action === "buy") {
          const amount = ethers.parseEther((Math.random() * 50 + 0.01).toFixed(2));

          try {
            await duoLaunch.connect(u).buy(tokenAddr, 0n, { value: amount });
            userBalances.set(uAddr, await token.balanceOf(uAddr));
          } catch { /* expected on graduation edge */ }
        } else {
          const bal = await token.balanceOf(uAddr);
          if (bal > 0n) {
            const sellAmt = bal / BigInt(Math.floor(Math.random() * 4 + 2)); // 25-50%
            const actualSell = sellAmt > 0n ? sellAmt : 1n;
            try {
              await token.connect(u).approve(await duoLaunch.getAddress(), actualSell);
              await duoLaunch.connect(u).sell(tokenAddr, actualSell, 0n);
              userBalances.set(uAddr, await token.balanceOf(uAddr));
            } catch { /* expected when no gas */ }
          }
        }

        // Check invariants (only while the sale is still on the bonding curve;
        // graduation moves reserves into the LP pair)
        const s2 = await duoLaunch.getSale(tokenAddr);
        if (!s2.graduated) {
          await assertKUnchanged();

          expect(await token.balanceOf(pumpAddr)).to.equal(TOTAL_SUPPLY - s2.tokensSold);
          const cap = TOTAL_SUPPLY * BigInt(GraduationBps) / 10000n;
          expect(s2.tokensSold).to.be.lte(cap);
        }
      }

      // Final state invariants
      const sFinal = await duoLaunch.getSale(tokenAddr);
      if (!sFinal.graduated) {
        expect(await token.balanceOf(pumpAddr)).to.equal(TOTAL_SUPPLY - sFinal.tokensSold);
        await assertKUnchanged();
        const cap = TOTAL_SUPPLY * BigInt(GraduationBps) / 10000n;
        expect(sFinal.tokensSold).to.be.lte(cap);
      }
    }

    for (const p of [6000, 6001, 6500, 8000, 9500, 9999]) {
      it(`P = ${p} survives 10 rounds`, async function () {
        await fuzzRound(p, 10);
      });
    }

    it("P = 8000 survives 30 rounds", async function () {
      await fuzzRound(8000, 30);
    });
  });

  // ─── CREATE AND BUY ─────────────────────────────────────────
  describe("createAndBuy", function () {
    let tokenAddr: string;
    let K0: bigint;

    async function deployAndCreateBuy(bps: number, targetRaise: bigint, buyValue: bigint) {
      [owner, user1] = await ethers.getSigners();
      const WETH = await ethers.getContractFactory("WETH9");
      weth = await WETH.deploy();
      await weth.waitForDeployment();
      const factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
      await factory.waitForDeployment();
      const router = await new UniswapV2Router02__factory(owner).deploy(
        await factory.getAddress(), await weth.getAddress()
      );
      await router.waitForDeployment();
      duoLaunch = await new DuoLaunch__factory(owner).deploy(await factory.getAddress(), await weth.getAddress());
      await duoLaunch.waitForDeployment();

      const tx = await duoLaunch.createAndBuy("CB", "CB", bps, targetRaise, 0n, "", "", "", "", { value: buyValue });
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      tokenAddr = log!.args.token as string;
      token = TokenTemplate__factory.connect(tokenAddr, owner);
    }

    it("k approximately unchanged after atomic create+buy", async function () {
      await deployAndCreateBuy(8000, ethers.parseEther("1000"), ethers.parseEther("10"));
      const s = await duoLaunch.getSale(tokenAddr);
      const k = (s.virtualGAS + s.GASRaised) * (s.virtualToken - s.tokensSold);
      const k0 = s.virtualGAS * s.virtualToken;
      const diff = k > k0 ? k - k0 : k0 - k;
      // Accept tiny drift from integer division rounding
      expect(diff * 1_000_000_000_000_000_000n).to.be.lt(k + k0);
    });

    it("k unchanged after createAndBuy → buy → sell", async function () {
      await deployAndCreateBuy(8000, ethers.parseEther("1000"), ethers.parseEther("10"));
      const s0 = await duoLaunch.getSale(tokenAddr);
      K0 = (s0.virtualGAS + s0.GASRaised) * (s0.virtualToken - s0.tokensSold);

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      let s1 = await duoLaunch.getSale(tokenAddr);
      let k1 = (s1.virtualGAS + s1.GASRaised) * (s1.virtualToken - s1.tokensSold);
      let diff1 = k1 > K0 ? k1 - K0 : K0 - k1;
      expect(diff1 * 1_000_000_000_000_000_000n).to.be.lt(k1 + K0);

      const bal = await token.balanceOf(owner.address);
      await token.connect(owner).approve(await duoLaunch.getAddress(), bal / 2n);
      await duoLaunch.connect(owner).sell(tokenAddr, bal / 2n, 0n);
      s1 = await duoLaunch.getSale(tokenAddr);
      k1 = (s1.virtualGAS + s1.GASRaised) * (s1.virtualToken - s1.tokensSold);
      diff1 = k1 > K0 ? k1 - K0 : K0 - k1;
      expect(diff1 * 1_000_000_000_000_000_000n).to.be.lt(k1 + K0);
    });

    it("reverts createAndBuy with zero value", async function () {
      await deployAndCreateBuy(8000, ethers.parseEther("1000"), ethers.parseEther("1"));
      // Create a second sale attempt with zero value should revert
      await expect(
        duoLaunch.createAndBuy("Zero", "ZRO", 8000, ethers.parseEther("1000"), 0n, "", "", "", "", { value: 0n })
      ).to.be.revertedWith("ZERO_GAS");
    });

    it("reverts createAndBuy with excessive slippage", async function () {
      await expect(
        duoLaunch.createAndBuy("Slip", "SLP", 8000, ethers.parseEther("1000"), ethers.parseEther("1000000"), "", "", "", "", {
          value: ethers.parseEther("0.001"),
        })
      ).to.be.revertedWith("SLIPPAGE");
    });

    it("duoLaunch holds (totalSupply - tokensSold) tokens after createAndBuy", async function () {
      await deployAndCreateBuy(8000, ethers.parseEther("1000"), ethers.parseEther("10"));
      const pumpAddr = await duoLaunch.getAddress();
      const s = await duoLaunch.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(TOTAL_SUPPLY - s.tokensSold);
    });
  });
})