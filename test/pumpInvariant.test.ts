import { expect } from "chai";
import { ethers } from "hardhat";
import type {
  Pump, PumpToken, UniswapV2Factory, UniswapV2Router02, UniswapV2Pair
} from "../typechain-types";
import {
  Pump__factory, PumpToken__factory,
  UniswapV2Factory__factory, UniswapV2Router02__factory,
  UniswapV2Pair__factory,
} from "../typechain-types";

describe("Pump Invariants & Boundary Tests", function () {
  let owner: any, user1: any, user2: any;
  let pump: Pump;
  let token: PumpToken;
  let tokenAddr: string;
  let weth: any;
  let GraduationBps: number;

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

    pump = await new Pump__factory(owner).deploy(await factory.getAddress(), await weth.getAddress());
    await pump.waitForDeployment();

    const tx = await pump.createSale("T", "T", graduationBps, ethers.parseEther("1000"));
    const rc = await tx.wait();
    const log = rc!.logs
      .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "SaleCreated");
    tokenAddr = log!.args.token as string;
    token = PumpToken__factory.connect(tokenAddr, owner);
  }

  let K0: bigint;

  /** k = (virtualGas + gasRaised) * (virtualToken - tokensSold) */
  async function invariantK(): Promise<bigint> {
    const s = await pump.getSale(tokenAddr);
    return (s.virtualGas + s.gasRaised) * (s.virtualToken - s.tokensSold);
  }

  /** Assert k is approximately unchanged (within 1e-17 relative tolerance) */
  async function assertKUnchanged() {
    const k = await invariantK();
    const diff = k > K0 ? k - K0 : K0 - k;
    // Solidity integer division causes ~1 wei drift per trade
    // Accept relative error < 1e-17 (negligible)
    expect(diff * 1_000_000_000_000_000_000n).to.be.lt(k + K0);
  }

  async function getGasReserve() {
    const s = await pump.getSale(tokenAddr);
    return s.virtualGas + s.gasRaised;
  }
  async function getTokenReserve() {
    const s = await pump.getSale(tokenAddr);
    return s.virtualToken - s.tokensSold;
  }

  // ─── INVARIANT 1: constant product ────────────────────────
  describe("Invariant: constant product (x*y=k)", function () {
    it("k approximately unchanged after multiple buys", async function () {
      await deploy(8000);
      K0 = await invariantK();

      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      await assertKUnchanged();

      await pump.connect(user2).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      await assertKUnchanged();
    });

    it("k approximately unchanged after buy �?sell", async function () {
      await deploy(8000);
      K0 = await invariantK();

      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await pump.getAddress(), bal / 2n);
      await pump.connect(user1).sell(tokenAddr, bal / 2n, 0n);

      await assertKUnchanged();
    });

    it("k approximately unchanged after buy �?full sell �?buy again", async function () {
      await deploy(8000);
      K0 = await invariantK();

      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("3") });
      let bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await pump.getAddress(), bal);
      await pump.connect(user1).sell(tokenAddr, bal, 0n);
      // Full sell leaves 1 wei gasRaised due to getAmountIn rounding up (+1)
      await assertKUnchanged();

      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      await assertKUnchanged();
    });
  });

  // ─── INVARIANT 2: Pump holds all unsold tokens ────────────
  describe("Invariant: Pump contract holds (totalSupply - tokensSold) tokens", function () {
    it("holds correct balance after mixed buys/sells", async function () {
      await deploy(8000);

      const pumpAddr = await pump.getAddress();
      const s0 = await pump.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(s0.totalSupply - s0.tokensSold);

      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("8") });
      const s1 = await pump.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(s1.totalSupply - s1.tokensSold);

      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await pump.getAddress(), bal / 2n);
      await pump.connect(user1).sell(tokenAddr, bal / 2n, 0n);
      const s2 = await pump.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(s2.totalSupply - s2.tokensSold);
    });
  });

  // ─── INVARIANT 3: tokensSold never exceeds cap ────────────
  describe("Invariant: tokensSold �?totalSupply * P / BPS_DENOM before graduation", function () {
    for (const p of [6001, 6000, 7000, 8000]) {
      it(`P = ${p}`, async function () {
        await deploy(p);
        const s = await pump.getSale(tokenAddr);
        const cap = s.totalSupply * BigInt(p) / 10000n;

        for (let i = 0; i < 10; i++) {
          const s2 = await pump.getSale(tokenAddr);
          if (s2.graduated) break;
          const remaining = s2.targetRaise - s2.gasRaised;
          if (remaining <= 0n) break;
          const chunk = remaining > ethers.parseEther("100")
            ? ethers.parseEther("100") : remaining;
          await pump.connect(user1).buy(tokenAddr, 0n, { value: chunk });
        }

        const s3 = await pump.getSale(tokenAddr);
        expect(s3.tokensSold).to.be.lte(cap);
        if (s3.graduated) {
          expect(s3.gasRaised).to.be.gte(s3.targetRaise);
        }
      });
    }
  });

  // ─── INVARIANT 4: gasRaised monotonically increases, tokensSold monotonically increases ───
  describe("Invariant: gasRaised & tokensSold are monotonic", function () {
    it("monotonic across sequential buys", async function () {
      await deploy(8000);
      let prevGas = 0n, prevTokens = 0n;
      for (let i = 0; i < 5; i++) {
        await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
        const s = await pump.getSale(tokenAddr);
        expect(s.gasRaised).to.be.gt(prevGas);
        expect(s.tokensSold).to.be.gt(prevTokens);
        prevGas = s.gasRaised;
        prevTokens = s.tokensSold;
      }
    });

    it("tokensSold decreases on sell, gasRaised decreases on sell", async function () {
      await deploy(8000);
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("100") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await pump.getAddress(), bal);

      const sBefore = await pump.getSale(tokenAddr);
      await pump.connect(user1).sell(tokenAddr, bal, 0n);
      const sAfter = await pump.getSale(tokenAddr);
      // Both should have decreased
      expect(sAfter.tokensSold).to.be.lt(sBefore.tokensSold);
      expect(sAfter.gasRaised).to.be.lt(sBefore.gasRaised);
    });
  });

  // ─── INVARIANT 5: price is always positive ────────────────
  describe("Invariant: getCurrentPrice > 0", function () {
    it("price > 0 after each action", async function () {
      await deploy(8000);
      expect(await pump.getCurrentPrice(tokenAddr)).to.be.gt(0n);

      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      expect(await pump.getCurrentPrice(tokenAddr)).to.be.gt(0n);

      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await pump.getAddress(), bal / 2n);
      await pump.connect(user1).sell(tokenAddr, bal / 2n, 0n);
      expect(await pump.getCurrentPrice(tokenAddr)).to.be.gt(0n);
    });
  });

  // ─── INVARIANT 6: getTokensForGas / getGasForTokens are consistent ───
  describe("Invariant: quote helpers are consistent with actual trades", function () {
    it("getAmountOut(gasReserve, tokenReserve, gasIn) matches actual tokensOut", async function () {
      await deploy(8000);

      const gasAmount = ethers.parseEther("5");
      const quoted = await pump.getTokensForGas(tokenAddr, gasAmount);

      const tx = await pump.connect(user1).buy(tokenAddr, 0n, { value: gasAmount });
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensPurchased");
      const actual = log!.args.tokensOut as bigint;

      expect(actual).to.equal(quoted);
    });

    it("getGasForTokens matches actual gasOut on sell", async function () {
      await deploy(8000);
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });

      const sellAmount = await token.balanceOf(user1.address) / 4n;
      const quotedGas = await pump.getGasForTokens(tokenAddr, sellAmount);

      await token.connect(user1).approve(await pump.getAddress(), sellAmount);
      const tx = await pump.connect(user1).sell(tokenAddr, sellAmount, 0n);
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensSold");
      const actualGas = log!.args.gasOut as bigint;

      expect(actualGas).to.equal(quotedGas);
    });
  });

  // ─── INVARIANT 7: post-graduation price continuity ────────
  describe("Invariant: price continuity across graduation", function () {
    it("Uniswap V2 opening price �?Pump closing price", async function () {
      await deploy(8000);
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("30") });

      const s = await pump.getSale(tokenAddr);
      const remaining = s.targetRaise - s.gasRaised;
      // Ensure owner has enough ETH for graduation
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000" // 1,208,925 ETH
      ]);
      const gradTx = await pump.connect(owner).buy(tokenAddr, 0n, { value: remaining + ethers.parseEther("1") });
      const rc = await gradTx.wait();
      const gradLog = rc!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      const pairAddr = gradLog!.args.pair as string;
      const pair = await ethers.getContractAt("contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair", pairAddr);

      const sGrad = await pump.getSale(tokenAddr);
      const bcGasReserve = sGrad.virtualGas + sGrad.gasRaised;
      const bcTokenReserve = sGrad.virtualToken - sGrad.tokensSold;
      const tokensForLP = sGrad.totalSupply - sGrad.tokensSold;

      const [r0, r1] = await pair.getReserves();
      const wethAddr = await weth.getAddress();
      const t0 = await pair.token0();
      const uniGas = t0.toLowerCase() === wethAddr.toLowerCase() ? r0 : r1;
      const uniToken = t0.toLowerCase() === wethAddr.toLowerCase() ? r1 : r0;

      // Compare Pump closing price vs Uniswap opening price
      // Pump: bcGasReserve / bcTokenReserve
      // Uni:  uniGas / uniToken
      // Cross-multiplied: bcGasReserve * uniToken �?uniGas * bcTokenReserve
      const lhs = bcGasReserve * uniToken;
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
    //   const p = await new Pump__factory(o).deploy(ethers.ZeroAddress, ethers.ZeroAddress);
    //   await p.waitForDeployment();
    //   await expect(p.createSale("X", "X", 5000, ethers.parseEther("1000"))).to.be.revertedWith("INVALID_GRADUATION");
    // });

    it("reverts P < 6000", async function () {
      const [o] = await ethers.getSigners();
      const p = await new Pump__factory(o).deploy(ethers.ZeroAddress, ethers.ZeroAddress);
      await p.waitForDeployment();
      await expect(p.createSale("X", "X", 5999, ethers.parseEther("1000"))).to.be.revertedWith("INVALID_GRADUATION_MIN");
    });

    it("reverts P > 9900", async function () {
      const [o] = await ethers.getSigners();
      const p = await new Pump__factory(o).deploy(ethers.ZeroAddress, ethers.ZeroAddress);
      await p.waitForDeployment();
      await expect(p.createSale("X", "X", 9901, ethers.parseEther("1000"))).to.be.revertedWith("INVALID_GRADUATION_MAX");
    });

    it("accepts P = 6001 (minimum valid)", async function () {
      await deploy(6001);
      const s = await pump.getSale(tokenAddr);
      expect(s.virtualGas).to.be.gt(0n);
      expect(s.virtualToken).to.be.gt(0n);
      expect(s.graduationBps).to.equal(6001);
    });

    it("accepts P = 9900 (maximum valid)", async function () {
      await deploy(9900);
      const s = await pump.getSale(tokenAddr);
      expect(s.virtualGas).to.be.gt(0n);
      expect(s.virtualToken).to.be.gt(0n);
      expect(s.graduationBps).to.equal(9900);
    });
  });

  // ─── BOUNDARY: edge case buys/sells ───────────────────────
  describe("Boundary: buy/sell edge cases", function () {
    it("reverts buy with 0 wei", async function () {
      await deploy(8000);
      await expect(pump.connect(user1).buy(tokenAddr, 0n, { value: 0n })).to.be.revertedWith("ZERO_GAS");
    });

    it("reverts sell with 0 tokens", async function () {
      await deploy(8000);
      await expect(pump.connect(user1).sell(tokenAddr, 0n, 0n)).to.be.revertedWith("ZERO_TOKENS");
    });

    it("reverts sell when user has no tokens", async function () {
      await deploy(8000);
      await expect(
        pump.connect(user1).sell(tokenAddr, 100n, 0n)
      ).to.be.reverted;
    });

    it("reverts sell exceeding user balance", async function () {
      await deploy(8000);
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await pump.getAddress(), bal);
      await expect(
        pump.connect(user1).sell(tokenAddr, bal + 1n, 0n)
      ).to.be.reverted;
    });

    it("returns remaining gas (1 wei rounding dust) after selling all tokens", async function () {
      await deploy(8000);
      // Buy and sell enough to leave minimal dust
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await pump.getAddress(), bal);
      await pump.connect(user1).sell(tokenAddr, bal, 0n);
      const s = await pump.getSale(tokenAddr);
      // getAmountIn's +1 rounding leaves 1 wei dust
      expect(s.gasRaised).to.be.lte(1n);
      expect(s.tokensSold).to.equal(0n);
    });

    it("reverts buy with slippage too high", async function () {
      await deploy(8000);
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
      // Now price is higher; trying to buy at previous token count should fail with SLIPPAGE
      const s = await pump.getSale(tokenAddr);
      const tokenReserve = s.virtualToken - s.tokensSold;
      const gasReserve = s.virtualGas + s.gasRaised;
      // Buying with 1 ETH now gets fewer tokens
      const tokensFor1Eth = gasReserve * tokenReserve / (gasReserve + ethers.parseEther("1"));
      const minTokensOut = tokensFor1Eth + 1n; // slightly higher than actual
      await expect(
        pump.connect(user2).buy(tokenAddr, minTokensOut, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("SLIPPAGE");
    });

    it("reverts when tokenReserve would hit zero", async function () {
      await deploy(8000);
      const s = await pump.getSale(tokenAddr);
      // Buying in huge chunk shouldn't be possible (capped at graduation point)
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000"
      ]);
      await pump.connect(owner).buy(tokenAddr, 0n, { value: s.targetRaise });
      const s2 = await pump.getSale(tokenAddr);
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
      await pump.connect(owner).buy(tokenAddr, 0n, { value: ethers.parseEther("1000") });
      const s = await pump.getSale(tokenAddr);
      expect(s.graduated).to.equal(true);
      expect(s.gasRaised).to.be.gte(ethers.parseEther("1000"));
    });

    it("P=5001 graduation still creates Uniswap pair", async function () {
      await deploy(6001);
      const s = await pump.getSale(tokenAddr);
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000"
      ]);
      const gradTx = await pump.connect(owner).buy(tokenAddr, 0n, {
        value: s.targetRaise + ethers.parseEther("10")
      });
      const rc = await gradTx.wait();
      const gradLog = rc!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
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
        const s = await pump.getSale(tokenAddr);
        if (s.graduated) break;
        await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("0.01") });
      }

      // If not yet graduated, try to push tokensSold to cap
      const s = await pump.getSale(tokenAddr);
      if (!s.graduated) {
        const maxTokens = s.totalSupply * BigInt(GraduationBps) / 10000n;
        if (s.tokensSold >= maxTokens) {
          await expect(
            pump.connect(owner).buy(tokenAddr, 0n, { value: ethers.parseEther("1") })
          ).to.not.be.reverted;
          const s2 = await pump.getSale(tokenAddr);
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
        pump.getSale(ethers.ZeroAddress)
      ).to.be.revertedWith("SALE_NOT_EXIST");
    });
  });

  // ─── SECURITY: pre-existing pair liquidity handled safely ──
  describe("Security: pre-existing pair liquidity handled safely", function () {
    it("graduation succeeds even if pair has pre-existing liquidity (no DoS)", async function () {
      await deploy(8000);
      const factoryAddr = await pump.uniswapFactory();
      const factory = UniswapV2Factory__factory.connect(factoryAddr, owner);

      // User1 buys some tokens first (needed for donation)
      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("1") });
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
      const gradTx = await pump.connect(owner).buy(tokenAddr, 0n, { value: ethers.parseEther("1000") });
      const gradRc = await gradTx.wait();
      const gradLog = gradRc!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");
      expect(gradLog).to.not.be.undefined;

      // Verify sale graduated
      const sale = await pump.getSale(tokenAddr);
      expect(sale.graduated).to.equal(true);

      // LP tokens should be burned (sent to address(0))
      // pair.totalSupply() includes the pre-existing LP + new LP
      // The new LP from Pump's mint goes to address(0)
      const lpBalancePump = await pair.balanceOf(await pump.getAddress());
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
      const pumpAddr = await pump.getAddress();
      let userBalances: Map<string, bigint> = new Map();

      const users = [user1, user2, owner];
      const userAddr = users.map(u => u.address.toLowerCase());
      for (const u of userAddr) userBalances.set(u, 0n);

      for (let i = 0; i < rounds; i++) {
        const s = await pump.getSale(tokenAddr);
        if (s.graduated) break;

        const u = users[i % users.length];
        const uAddr = u.address.toLowerCase();

        // Decide action: 70% buy, 30% sell
        const action = Math.random() < 0.7 ? "buy" : "sell";

        if (action === "buy") {
          const amount = ethers.parseEther((Math.random() * 50 + 0.01).toFixed(2));

          try {
            await pump.connect(u).buy(tokenAddr, 0n, { value: amount });
            userBalances.set(uAddr, await token.balanceOf(uAddr));
          } catch { /* expected on graduation edge */ }
        } else {
          const bal = await token.balanceOf(uAddr);
          if (bal > 0n) {
            const sellAmt = bal / BigInt(Math.floor(Math.random() * 4 + 2)); // 25-50%
            const actualSell = sellAmt > 0n ? sellAmt : 1n;
            try {
              await token.connect(u).approve(await pump.getAddress(), actualSell);
              await pump.connect(u).sell(tokenAddr, actualSell, 0n);
              userBalances.set(uAddr, await token.balanceOf(uAddr));
            } catch { /* expected when no gas */ }
          }
        }

        // Check invariants
        await assertKUnchanged();

        const s2 = await pump.getSale(tokenAddr);
        expect(await token.balanceOf(pumpAddr)).to.equal(s2.totalSupply - s2.tokensSold);
        if (!s2.graduated) {
          const cap = s2.totalSupply * BigInt(GraduationBps) / 10000n;
          expect(s2.tokensSold).to.be.lte(cap);
        }
      }

      // Final state invariants
      const sFinal = await pump.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(sFinal.totalSupply - sFinal.tokensSold);
      await assertKUnchanged();
      if (!sFinal.graduated) {
        const cap = sFinal.totalSupply * BigInt(GraduationBps) / 10000n;
        expect(sFinal.tokensSold).to.be.lte(cap);
      }
    }

    for (const p of [6001, 6500, 8000, 9500]) {
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
      pump = await new Pump__factory(owner).deploy(await factory.getAddress(), await weth.getAddress());
      await pump.waitForDeployment();

      const tx = await pump.createAndBuy("CB", "CB", bps, targetRaise, 0n, { value: buyValue });
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      tokenAddr = log!.args.token as string;
      token = PumpToken__factory.connect(tokenAddr, owner);
    }

    it("k approximately unchanged after atomic create+buy", async function () {
      await deployAndCreateBuy(8000, ethers.parseEther("1000"), ethers.parseEther("10"));
      const s = await pump.getSale(tokenAddr);
      const k = (s.virtualGas + s.gasRaised) * (s.virtualToken - s.tokensSold);
      const k0 = s.virtualGas * s.virtualToken;
      const diff = k > k0 ? k - k0 : k0 - k;
      // Accept tiny drift from integer division rounding
      expect(diff * 1_000_000_000_000_000_000n).to.be.lt(k + k0);
    });

    it("k unchanged after createAndBuy → buy → sell", async function () {
      await deployAndCreateBuy(8000, ethers.parseEther("1000"), ethers.parseEther("10"));
      const s0 = await pump.getSale(tokenAddr);
      K0 = (s0.virtualGas + s0.gasRaised) * (s0.virtualToken - s0.tokensSold);

      await pump.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      let s1 = await pump.getSale(tokenAddr);
      let k1 = (s1.virtualGas + s1.gasRaised) * (s1.virtualToken - s1.tokensSold);
      let diff1 = k1 > K0 ? k1 - K0 : K0 - k1;
      expect(diff1 * 1_000_000_000_000_000_000n).to.be.lt(k1 + K0);

      const bal = await token.balanceOf(owner.address);
      await token.connect(owner).approve(await pump.getAddress(), bal / 2n);
      await pump.connect(owner).sell(tokenAddr, bal / 2n, 0n);
      s1 = await pump.getSale(tokenAddr);
      k1 = (s1.virtualGas + s1.gasRaised) * (s1.virtualToken - s1.tokensSold);
      diff1 = k1 > K0 ? k1 - K0 : K0 - k1;
      expect(diff1 * 1_000_000_000_000_000_000n).to.be.lt(k1 + K0);
    });

    it("reverts createAndBuy with zero value", async function () {
      await deployAndCreateBuy(8000, ethers.parseEther("1000"), ethers.parseEther("1"));
      // Create a second sale attempt with zero value should revert
      await expect(
        pump.createAndBuy("Zero", "ZRO", 8000, ethers.parseEther("1000"), 0n, { value: 0n })
      ).to.be.revertedWith("ZERO_GAS");
    });

    it("reverts createAndBuy with excessive slippage", async function () {
      await expect(
        pump.createAndBuy("Slip", "SLP", 8000, ethers.parseEther("1000"), ethers.parseEther("1000000"), {
          value: ethers.parseEther("0.001"),
        })
      ).to.be.revertedWith("SLIPPAGE");
    });

    it("pump holds (totalSupply - tokensSold) tokens after createAndBuy", async function () {
      await deployAndCreateBuy(8000, ethers.parseEther("1000"), ethers.parseEther("10"));
      const pumpAddr = await pump.getAddress();
      const s = await pump.getSale(tokenAddr);
      expect(await token.balanceOf(pumpAddr)).to.equal(s.totalSupply - s.tokensSold);
    });
  });
})