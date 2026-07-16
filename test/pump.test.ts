import { expect } from "chai";
import { ethers } from "hardhat";
import type { DuoLaunch, TokenTemplate } from "../typechain-types";
import { DuoLaunch__factory, TokenTemplate__factory } from "../typechain-types";

describe("DuoLaunch — static functions", function () {
  let owner: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let user: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let duoLaunch: DuoLaunch;
  let factoryAddr: string;
  let wethAddr: string;

  const TOTAL_SUPPLY = ethers.parseEther("1000000000");
  const BPS_DENOMINATOR = 10000n;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("WETH9");
    const weth = await WETH.deploy();
    await weth.waitForDeployment();
    wethAddr = await weth.getAddress();

    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    const factory = await Factory.deploy(owner.address);
    await factory.waitForDeployment();
    factoryAddr = await factory.getAddress();

    duoLaunch = await new DuoLaunch__factory(owner).deploy(factoryAddr, wethAddr);
    await duoLaunch.waitForDeployment();
  });

  describe("uniswapFactory", function () {
    it("returns the Uniswap factory address from constructor", async function () {
      expect(await duoLaunch.uniswapFactory()).to.equal(factoryAddr);
    });
  });

  describe("weth", function () {
    it("returns the WETH address from constructor", async function () {
      expect(await duoLaunch.weth()).to.equal(wethAddr);
    });
  });

  describe("getSale", function () {
    let tokenAddr: string;
    const graduationBps = 8000n;
    const targetRaise = ethers.parseEther("1000");

    beforeEach(async function () {
      const tx = await duoLaunch.createSale("Test", "TST", graduationBps, targetRaise);
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      tokenAddr = log!.args.token as string;
    });

    it("returns correct initial sale info", async function () {
      const sale = await duoLaunch.getSale(tokenAddr);
      expect(sale.creator).to.equal(owner.address);
      expect(sale.totalSupply).to.equal(TOTAL_SUPPLY);
      expect(sale.tokensSold).to.equal(0n);
      expect(sale.GASRaised).to.equal(0n);
      expect(sale.targetRaise).to.equal(targetRaise);
      expect(sale.graduationBps).to.equal(graduationBps);
      expect(sale.graduated).to.equal(false);
    });

    it("computes virtual reserves correctly for P=8000", async function () {
      const p = graduationBps;
      const twoPminusOne = 2n * p - BPS_DENOMINATOR;
      const pSquared = p * p;
      const expectedVToken = TOTAL_SUPPLY * pSquared / (BPS_DENOMINATOR * twoPminusOne);
      const expectedVGas = targetRaise * (BPS_DENOMINATOR - p) / twoPminusOne;

      const sale = await duoLaunch.getSale(tokenAddr);
      expect(sale.virtualToken).to.equal(expectedVToken);
      expect(sale.virtualGAS).to.equal(expectedVGas);
    });

    it("updates tokensSold and gasRaised after buy", async function () {
      await duoLaunch.connect(user).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const sale = await duoLaunch.getSale(tokenAddr);
      expect(sale.tokensSold).to.be.gt(0n);
      expect(sale.GASRaised).to.equal(ethers.parseEther("10"));
    });

    it("reverts for non-existent token", async function () {
      await expect(
        duoLaunch.getSale(ethers.Wallet.createRandom().getAddress())
      ).to.be.revertedWith("SALE_NOT_EXIST");
    });
  });

  describe("getCurrentPrice", function () {
    let tokenAddr: string;

    beforeEach(async function () {
      const tx = await duoLaunch.createSale("Test", "TST", 8000n, ethers.parseEther("1000"));
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      tokenAddr = log!.args.token as string;
    });

    it("returns zero price before any trades", async function () {
      const sale = await duoLaunch.getSale(tokenAddr);
      const initialPrice = sale.virtualGAS * ethers.parseEther("1") / sale.virtualToken;
      const price = await duoLaunch.getCurrentPrice(tokenAddr);
      expect(price).to.equal(initialPrice);
    });

    it("returns increasing price after buy", async function () {
      const priceBefore = await duoLaunch.getCurrentPrice(tokenAddr);
      await duoLaunch.connect(user).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const priceAfter = await duoLaunch.getCurrentPrice(tokenAddr);
      expect(priceAfter).to.be.gt(priceBefore);
    });

    it("returns decreasing price after sell", async function () {
      await duoLaunch.connect(user).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });
      const priceBefore = await duoLaunch.getCurrentPrice(tokenAddr);

      const token: TokenTemplate = TokenTemplate__factory.connect(tokenAddr, user);
      const balance = await token.balanceOf(user.address);
      await token.connect(user).approve(await duoLaunch.getAddress(), balance);
      await duoLaunch.connect(user).sell(tokenAddr, balance / 2n, 0n);

      const priceAfter = await duoLaunch.getCurrentPrice(tokenAddr);
      expect(priceAfter).to.be.lt(priceBefore);
    });

    it("reverts for non-existent token", async function () {
      await expect(
        duoLaunch.getCurrentPrice(ethers.Wallet.createRandom().getAddress())
      ).to.be.revertedWith("SALE_NOT_EXIST");
    });

    it("reverts after graduation", async function () {
      const targetRaise = ethers.parseEther("10");
      const tx = await duoLaunch.createSale("Test", "TST", 8000n, targetRaise);
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      const tAddr = log!.args.token as string;

      await duoLaunch.connect(user).buy(tAddr, 0n, { value: targetRaise });
      await expect(duoLaunch.getCurrentPrice(tAddr)).to.be.revertedWith("SALE_GRADUATED");
    });
  });

  describe("getTokensForGas", function () {
    let tokenAddr: string;

    beforeEach(async function () {
      const tx = await duoLaunch.createSale("Test", "TST", 8000n, ethers.parseEther("1000"));
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      tokenAddr = log!.args.token as string;
    });

    it("returns expected token amount for given gas", async function () {
      const sale = await duoLaunch.getSale(tokenAddr);
      const GASReserve = sale.virtualGAS + sale.GASRaised;
      const tokenReserve = sale.virtualToken - sale.tokensSold;
      const GASAmount = ethers.parseEther("1");

      const expected = GASAmount * tokenReserve / (GASReserve + GASAmount);
      const result = await duoLaunch.getTokensForGAS(tokenAddr, GASAmount);
      expect(result).to.be.closeTo(expected, expected / 1000n);
    });

    it("matches actual buy output", async function () {
      const GASAmount = ethers.parseEther("10");
      const quote = await duoLaunch.getTokensForGAS(tokenAddr, GASAmount);

      const buyTx = await duoLaunch.connect(user).buy(tokenAddr, 0n, { value: GASAmount });
      const receipt = await buyTx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensPurchased");

      const actualOut = log!.args.tokensOut as bigint;
      const diff = quote > actualOut ? quote - actualOut : actualOut - quote;
      expect(diff * 1000000n).to.be.lt(quote + actualOut);
    });

    it("reverts for non-existent token", async function () {
      await expect(
        duoLaunch.getTokensForGAS(ethers.Wallet.createRandom().getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWith("SALE_NOT_EXIST");
    });

    it("reverts after graduation", async function () {
      const targetRaise = ethers.parseEther("10");
      const tx = await duoLaunch.createSale("Test", "TST", 8000n, targetRaise);
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      const tAddr = log!.args.token as string;

      await duoLaunch.connect(user).buy(tAddr, 0n, { value: targetRaise });
      await expect(
        duoLaunch.getTokensForGAS(tAddr, ethers.parseEther("1"))
      ).to.be.revertedWith("SALE_GRADUATED");
    });
  });

  describe("getGasForTokens", function () {
    let tokenAddr: string;

    beforeEach(async function () {
      const tx = await duoLaunch.createSale("Test", "TST", 8000n, ethers.parseEther("1000"));
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      tokenAddr = log!.args.token as string;
    });

    it("returns expected gas amount for given tokens", async function () {
      await duoLaunch.connect(user).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });

      const sale = await duoLaunch.getSale(tokenAddr);
      const GASReserve = sale.virtualGAS + sale.GASRaised;
      const tokenReserve = sale.virtualToken - sale.tokensSold;
      const tokenAmount = ethers.parseEther("100");

      const expected = tokenAmount * GASReserve / (tokenReserve + tokenAmount);
      const result = await duoLaunch.getGASForTokens(tokenAddr, tokenAmount);
      expect(result).to.be.closeTo(expected, expected / 1000n);
    });

    it("matches actual sell output", async function () {
      await duoLaunch.connect(user).buy(tokenAddr, 0n, { value: ethers.parseEther("10") });

      const token: TokenTemplate = TokenTemplate__factory.connect(tokenAddr, user);
      const balance = await token.balanceOf(user.address);
      const sellAmount = balance / 4n;
      const quote = await duoLaunch.getGASForTokens(tokenAddr, sellAmount);

      await token.connect(user).approve(await duoLaunch.getAddress(), sellAmount);
      const sellTx = await duoLaunch.connect(user).sell(tokenAddr, sellAmount, 0n);
      const receipt = await sellTx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "TokensSold");

      const actualOut = log!.args.GASOut as bigint;
      const diff = quote > actualOut ? quote - actualOut : actualOut - quote;
      expect(diff * 1000000n).to.be.lt(quote + actualOut);
    });

    it("reverts for non-existent token", async function () {
      await expect(
        duoLaunch.getGASForTokens(ethers.Wallet.createRandom().getAddress(), ethers.parseEther("100"))
      ).to.be.revertedWith("SALE_NOT_EXIST");
    });

    it("reverts after graduation", async function () {
      const targetRaise = ethers.parseEther("10");
      const tx = await duoLaunch.createSale("Test", "TST", 8000n, targetRaise);
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      const tAddr = log!.args.token as string;

      await duoLaunch.connect(user).buy(tAddr, 0n, { value: targetRaise });
      await expect(
        duoLaunch.getGASForTokens(tAddr, ethers.parseEther("100"))
      ).to.be.revertedWith("SALE_GRADUATED");
    });
  });

  describe("createAndBuy", function () {
    let tokenAddr: string;
    let buyValue: bigint;

    beforeEach(async function () {
      buyValue = ethers.parseEther("1");
      const tx = await duoLaunch.createAndBuy("CB", "CB", 8000n, ethers.parseEther("1000"), 0n, {
        value: buyValue,
      });
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      tokenAddr = log!.args.token as string;
    });

    it("creates sale and buys atomically", async function () {
      const token = TokenTemplate__factory.connect(tokenAddr, user);
      expect(await token.name()).to.equal("CB");
      expect(await token.symbol()).to.equal("CB");

      const sale = await duoLaunch.getSale(tokenAddr);
      expect(sale.GASRaised).to.be.gt(0n);
      expect(sale.tokensSold).to.be.gt(0n);
      expect(sale.creator).to.equal(owner.address);

      const balance = await token.balanceOf(owner.address);
      expect(balance).to.be.gt(0n);
    });

    it("reverts with zero value", async function () {
      await expect(
        duoLaunch.createAndBuy("Zero", "ZRO", 8000n, ethers.parseEther("1000"), 0n, { value: 0n })
      ).to.be.revertedWith("ZERO_GAS");
    });

    it("reverts with excessive slippage", async function () {
      const maxOut = ethers.parseEther("999999999");
      await expect(
        duoLaunch.createAndBuy("Slippage", "SLP", 8000n, ethers.parseEther("1000"), maxOut, {
          value: ethers.parseEther("0.001"),
        })
      ).to.be.revertedWith("SLIPPAGE");
    });

    it("supports buy and sell after createAndBuy", async function () {
      const token = TokenTemplate__factory.connect(tokenAddr, owner);
      const bal = await token.balanceOf(owner.address);

      await duoLaunch.connect(user).buy(tokenAddr, 0n, { value: ethers.parseEther("5") });
      expect(await token.balanceOf(user.address)).to.be.gt(0n);

      await token.connect(owner).approve(await duoLaunch.getAddress(), bal);
      await duoLaunch.connect(owner).sell(tokenAddr, bal / 2n, 0n);
      expect(await token.balanceOf(owner.address)).to.equal(bal - bal / 2n);
    });

    it("triggers graduation when buying past targetRaise", async function () {
      const targetRaise = ethers.parseEther("5");
      const tx = await duoLaunch.createAndBuy("Grad", "GRD", 8000n, targetRaise, 0n, {
        value: targetRaise,
      });
      const receipt = await tx.wait();
      const log = receipt!.logs
        .map((l: any) => { try { return duoLaunch.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleCreated");
      const addr = log!.args.token as string;

      const sale = await duoLaunch.getSale(addr);
      expect(sale.graduated).to.equal(true);
      // Integer division rounding can leave gasRaised 1 wei below targetRaise
      expect(sale.GASRaised + 1n).to.be.gte(targetRaise);
    });

    it("refunds overpayment when buy exceeds graduation point", async function () {
      const targetRaise = ethers.parseEther("5");
      const overpay = targetRaise + ethers.parseEther("2");
      const balBefore = await ethers.provider.getBalance(owner.address);

      const tx = await duoLaunch.createAndBuy("Overpay", "OVR", 8000n, targetRaise, 0n, {
        value: overpay,
      });
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(owner.address);
      const netSpent = balBefore - balAfter - gasCost;

      expect(netSpent).to.be.lt(overpay);
      expect(netSpent).to.be.closeTo(targetRaise, ethers.parseEther("0.01"));
    });

    it("reverts createAndBuy with invalid graduation BPS", async function () {
      await expect(
        duoLaunch.createAndBuy("Bad", "BAD", 5000n, ethers.parseEther("1000"), 0n, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("INVALID_GRADUATION_MIN");
    });
  });
});
