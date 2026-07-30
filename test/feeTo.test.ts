import { expect } from "chai";
import { ethers } from "hardhat";
import type { DuoLaunch, TokenTemplate, UniswapV2Factory } from "../typechain-types";
import {
  DuoLaunch__factory, TokenTemplate__factory,
  UniswapV2Factory__factory, UniswapV2Router02__factory,
} from "../typechain-types";

describe("feeTo: protocol fee on buy/sell", function () {
  let owner: any, user1: any, user2: any, feeRecipient: any;
  let duoLaunch: DuoLaunch;
  let factory: UniswapV2Factory;
  let token: TokenTemplate;
  let tokenAddr: string;
  let weth: any;

  const FEE_FACTOR = 3n;
  const FEE_DENOMINATOR = 10000n;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000");

  async function deploy(graduationBps: number, targetRaise = ethers.parseEther("1000")) {
    [owner, user1, user2, feeRecipient] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("WETH9");
    weth = await WETH.deploy();
    await weth.waitForDeployment();

    factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    const router = await new UniswapV2Router02__factory(owner).deploy(
      await factory.getAddress(), await weth.getAddress()
    );
    await router.waitForDeployment();

    duoLaunch = await new DuoLaunch__factory(owner).deploy(await factory.getAddress(), await weth.getAddress());
    await duoLaunch.waitForDeployment();

    const tx = await duoLaunch.createSale("FT", "FT", graduationBps, targetRaise, "", "", "", "");
    const rc = await tx.wait();
    const log = rc!.logs
      .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "SaleCreated");
    tokenAddr = log!.args.token as string;
    token = TokenTemplate__factory.connect(tokenAddr, owner);
  }

  describe("buy fee", function () {
    beforeEach(async function () {
      await deploy(8000);
      // Enable feeTo
      await factory.connect(owner).setFeeTo(feeRecipient.address);
    });

    afterEach(async function () {
      // Disable feeTo so other tests aren't affected
      await factory.connect(owner).setFeeTo(ethers.ZeroAddress);
    });

    it("deducts 0.03% fee from buy and sends to feeTo", async function () {
      const GASIn = ethers.parseEther("100");
      const expectedFee = GASIn * FEE_FACTOR / FEE_DENOMINATOR; // 0.003 ETH

      const balanceBefore = await ethers.provider.getBalance(feeRecipient.address);

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: GASIn });

      const balanceAfter = await ethers.provider.getBalance(feeRecipient.address);
      expect(balanceAfter - balanceBefore).to.equal(expectedFee);
    });

    it("only adds post-fee GAS to the pool", async function () {
      const GASIn = ethers.parseEther("100");
      const expectedFee = GASIn * FEE_FACTOR / FEE_DENOMINATOR;
      const expectedPoolIn = GASIn - expectedFee;

      const sBefore = await duoLaunch.getSale(tokenAddr);
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: GASIn });
      const sAfter = await duoLaunch.getSale(tokenAddr);

      expect(sAfter.GASRaised - sBefore.GASRaised).to.equal(expectedPoolIn);
    });

    it("tokens out matches post-fee curve calculation", async function () {
      const GASIn = ethers.parseEther("50");
      const expectedFee = GASIn * FEE_FACTOR / FEE_DENOMINATOR;
      const effectiveIn = GASIn - expectedFee;

      // Quote using getTokensForGAS (which already accounts for fee)
      const quoted = await duoLaunch.getTokensForGAS(tokenAddr, GASIn);

      const tx = await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: GASIn });
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensPurchased");
      const actualTokensOut = log!.args.tokensOut as bigint;

      expect(actualTokensOut).to.equal(quoted);
    });

    it("event emits total GAS (fee + pool contribution)", async function () {
      const GASIn = ethers.parseEther("30");
      const expectedFee = GASIn * FEE_FACTOR / FEE_DENOMINATOR;

      const tx = await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: GASIn });
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensPurchased");
      const eventGASIn = log!.args.GASIn as bigint;

      expect(eventGASIn).to.equal(GASIn);
    });

    it("no fee when feeTo is zero address", async function () {
      // Turn off feeTo
      await factory.connect(owner).setFeeTo(ethers.ZeroAddress);

      const balanceBefore = await ethers.provider.getBalance(feeRecipient.address);
      const GASIn = ethers.parseEther("50");

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: GASIn });

      const balanceAfter = await ethers.provider.getBalance(feeRecipient.address);
      expect(balanceAfter - balanceBefore).to.equal(0n);
    });
  });

  describe("sell fee", function () {
    beforeEach(async function () {
      await deploy(8000);
      await factory.connect(owner).setFeeTo(feeRecipient.address);
      // Buy tokens first
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("100") });
    });

    afterEach(async function () {
      await factory.connect(owner).setFeeTo(ethers.ZeroAddress);
    });

    it("deducts 0.03% fee from sell and sends to feeTo", async function () {
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);

      const balanceBefore = await ethers.provider.getBalance(feeRecipient.address);

      // Capture the event to get GASOut before fee
      const tx = await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensSold");
      const GASOutBeforeFee = log!.args.GASOut as bigint;
      const expectedFee = GASOutBeforeFee * FEE_FACTOR / FEE_DENOMINATOR;

      const balanceAfter = await ethers.provider.getBalance(feeRecipient.address);
      const actualFee = balanceAfter - balanceBefore;
      // Allow 1 wei rounding difference
      const diff = actualFee > expectedFee ? actualFee - expectedFee : expectedFee - actualFee;
      expect(diff).to.be.lte(1n);
    });

    it("user receives GAS minus fee", async function () {
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);

      // Quote from getGASForTokens (which already deducts fee)
      const quoted = await duoLaunch.getGASForTokens(tokenAddr, bal);

      const balanceBefore = await ethers.provider.getBalance(user1.address);
      const tx = await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);
      const rc = await tx.wait();
      const gasCost = rc!.gasUsed * rc!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(user1.address);

      const received = balanceAfter - balanceBefore + gasCost;
      expect(received).to.equal(quoted);
    });

    it("sell event emits GASOut before fee deduction", async function () {
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);

      // Compute expected GASOut from curve math directly
      const s = await duoLaunch.getSale(tokenAddr);
      const GASReserve = s.virtualGAS + s.GASRaised;
      const tokenReserve = s.virtualToken - s.tokensSold;
      const expectedGASOut = bal * GASReserve / (tokenReserve + bal);

      const tx = await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);
      const rc = await tx.wait();
      const log = rc!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensSold");
      const eventGASOut = log!.args.GASOut as bigint;

      expect(eventGASOut).to.equal(expectedGASOut);
    });

    it("no fee on sell when feeTo is zero address", async function () {
      await factory.connect(owner).setFeeTo(ethers.ZeroAddress);

      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);

      const balanceBefore = await ethers.provider.getBalance(feeRecipient.address);
      await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);
      const balanceAfter = await ethers.provider.getBalance(feeRecipient.address);

      expect(balanceAfter - balanceBefore).to.equal(0n);
    });
  });

  describe("quote helpers with feeTo enabled", function () {
    beforeEach(async function () {
      await deploy(8000);
      await factory.connect(owner).setFeeTo(feeRecipient.address);
    });

    afterEach(async function () {
      await factory.connect(owner).setFeeTo(ethers.ZeroAddress);
    });

    it("getTokensForGAS accounts for fee", async function () {
      const GASAmount = ethers.parseEther("50");
      const expectedFee = GASAmount * FEE_FACTOR / FEE_DENOMINATOR;
      const effectiveIn = GASAmount - expectedFee;

      // Manual calculation of expected tokensOut
      const s = await duoLaunch.getSale(tokenAddr);
      const GASReserve = s.virtualGAS + s.GASRaised;
      const tokenReserve = s.virtualToken - s.tokensSold;
      const expectedTokens = effectiveIn * tokenReserve / (GASReserve + effectiveIn);

      const quoted = await duoLaunch.getTokensForGAS(tokenAddr, GASAmount);
      expect(quoted).to.equal(expectedTokens);
    });

    it("getGASForTokens accounts for fee", async function () {
      // Buy some tokens first
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("20") });
      const tokenBal = await token.balanceOf(user1.address);
      const sellAmount = tokenBal / 2n;

      // Manual calculation
      const s = await duoLaunch.getSale(tokenAddr);
      const GASReserve = s.virtualGAS + s.GASRaised;
      const tokenReserve = s.virtualToken - s.tokensSold;
      const GASOutBeforeFee = sellAmount * GASReserve / (tokenReserve + sellAmount);
      const expectedGASOut = GASOutBeforeFee - (GASOutBeforeFee * FEE_FACTOR / FEE_DENOMINATOR);

      const quoted = await duoLaunch.getGASForTokens(tokenAddr, sellAmount);
      expect(quoted).to.equal(expectedGASOut);
    });
  });

  describe("fee accounting invariants", function () {
    beforeEach(async function () {
      await deploy(8000);
      await factory.connect(owner).setFeeTo(feeRecipient.address);
    });

    afterEach(async function () {
      await factory.connect(owner).setFeeTo(ethers.ZeroAddress);
    });

    it("buy: pool increase + feeTo received = GASIn", async function () {
      const GASIn = ethers.parseEther("50");
      const balanceBeforeFee = await ethers.provider.getBalance(feeRecipient.address);
      const sBefore = await duoLaunch.getSale(tokenAddr);

      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: GASIn });

      const balanceAfterFee = await ethers.provider.getBalance(feeRecipient.address);
      const sAfter = await duoLaunch.getSale(tokenAddr);

      const poolIncrease = sAfter.GASRaised - sBefore.GASRaised;
      const feeReceived = balanceAfterFee - balanceBeforeFee;

      expect(poolIncrease + feeReceived).to.equal(GASIn);
    });

    it("sell: pool decrease = user received + feeTo received", async function () {
      // Buy first
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("100") });
      const bal = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await duoLaunch.getAddress(), bal);

      const balanceBeforeUser = await ethers.provider.getBalance(user1.address);
      const balanceBeforeFee = await ethers.provider.getBalance(feeRecipient.address);
      const sBefore = await duoLaunch.getSale(tokenAddr);

      const tx = await duoLaunch.connect(user1).sell(tokenAddr, bal, 0n);
      const rc = await tx.wait();
      const gasCost = rc!.gasUsed * rc!.gasPrice;

      const balanceAfterUser = await ethers.provider.getBalance(user1.address);
      const balanceAfterFee = await ethers.provider.getBalance(feeRecipient.address);
      const sAfter = await duoLaunch.getSale(tokenAddr);

      const userReceived = balanceAfterUser - balanceBeforeUser + gasCost;
      const poolDecrease = sBefore.GASRaised - sAfter.GASRaised;
      const feeReceived = balanceAfterFee - balanceBeforeFee;

      expect(userReceived + feeReceived).to.equal(poolDecrease);
    });
  });

  describe("fee with graduation cap", function () {
    beforeEach(async function () {
      await deploy(8000, ethers.parseEther("100")); // Small target for easy graduation
      await factory.connect(owner).setFeeTo(feeRecipient.address);
    });

    afterEach(async function () {
      await factory.connect(owner).setFeeTo(ethers.ZeroAddress);
    });

    it("fee is collected correctly when buy triggers graduation cap", async function () {
      // Buy until nearly graduated
      await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("80") });

      const s = await duoLaunch.getSale(tokenAddr);
      expect(s.graduated).to.be.false;

      // This buy should cap and trigger graduation
      const balanceBefore = await ethers.provider.getBalance(feeRecipient.address);
      await ethers.provider.send("hardhat_setBalance", [
        owner.address, "0x1000000000000000000000"
      ]);
      await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: ethers.parseEther("50") });
      const balanceAfter = await ethers.provider.getBalance(feeRecipient.address);

      // feeTo should have received some fee
      expect(balanceAfter - balanceBefore).to.be.gt(0n);

      // Graduation should have occurred
      const s2 = await duoLaunch.getSale(tokenAddr);
      expect(s2.graduated).to.be.true;
    });
  });
});
