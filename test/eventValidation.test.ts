import { expect } from "chai";
import { ethers } from "hardhat";
import type { DuoLaunch, TokenTemplate, UniswapV2Factory } from "../typechain-types";
import { DuoLaunch__factory, TokenTemplate__factory, UniswapV2Factory__factory, UniswapV2Router02__factory } from "../typechain-types";

describe("Event Validation", function () {
  let owner: any, user: any;
  let duoLaunch: DuoLaunch;
  let factory: UniswapV2Factory;
  let weth: string;
  let tokenAddr: string;
  let token: TokenTemplate;

  const evmTopic = (sig: string) => ethers.id(sig);

  before(async function () {
    [owner, user] = await ethers.getSigners();
    const WETH9 = await ethers.getContractFactory("WETH9");
    const wethC = await WETH9.deploy();
    await wethC.waitForDeployment();
    weth = await wethC.getAddress();
    factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();
    duoLaunch = await new DuoLaunch__factory(owner).deploy(await factory.getAddress(), weth);
    await duoLaunch.waitForDeployment();
  });

  describe("SaleCreated", function () {
    it("emits correct topic[0], indexed params, and data layout", async function () {
      const tx = await duoLaunch.createSale("EVT", "EVT", 8000, ethers.parseEther("1000"), "disc", "xAcc", "tel", "repo");
      const rc = await tx.wait();
      const iface = DuoLaunch__factory.createInterface();
      const log = rc!.logs.find((l: any) => {
        try { const p = iface.parseLog(l); return p?.name === "SaleCreated"; } catch { return false; }
      });
      expect(log).to.not.be.undefined;
      const parsed = iface.parseLog(log!);

      const expectedTopic = evmTopic("SaleCreated(address,address,string,string,string,string,string,string)");
      expect(log!.topics[0]).to.equal(expectedTopic);
      expect(log!.topics.length).to.equal(3);

      expect(parsed!.args.creator).to.equal(owner.address);
      expect(parsed!.args.token).to.not.equal(ethers.ZeroAddress);
      expect(parsed!.args.name).to.equal("EVT");
      expect(parsed!.args.symbol).to.equal("EVT");
      expect(parsed!.args.discord).to.equal("disc");
      expect(parsed!.args.x).to.equal("xAcc");
      expect(parsed!.args.telegram).to.equal("tel");
      expect(parsed!.args.repoUrl).to.equal("repo");
    });
  });

  describe("TokensPurchased", function () {
    before(async function () {
      const tx = await duoLaunch.createSale("PRCH", "PRCH", 8000, ethers.parseEther("1000"), "", "", "", "");
      const rc = await tx.wait();
      const iface = DuoLaunch__factory.createInterface();
      const log = rc!.logs.find((l: any) => {
        try { const p = iface.parseLog(l); return p?.name === "SaleCreated"; } catch { return false; }
      });
      tokenAddr = (iface.parseLog(log!).args.token) as string;
      token = TokenTemplate__factory.connect(tokenAddr, owner);
    });

    it("emits correct event structure on buy", async function () {
      const tx = await duoLaunch.connect(user).buy(tokenAddr, 0, { value: ethers.parseEther("10") });
      const rc = await tx.wait();
      const iface = DuoLaunch__factory.createInterface();
      const log = rc!.logs.find((l: any) => {
        try { const p = iface.parseLog(l); return p?.name === "TokensPurchased"; } catch { return false; }
      });
      expect(log).to.not.be.undefined;
      const parsed = iface.parseLog(log!);

      const expectedTopic = evmTopic("TokensPurchased(address,address,uint256,uint256)");
      expect(log!.topics[0]).to.equal(expectedTopic);
      expect(log!.topics.length).to.equal(3);

      expect(parsed!.args.buyer).to.equal(user.address);
      expect(parsed!.args.token).to.equal(tokenAddr);
      expect(parsed!.args.GASIn).to.equal(ethers.parseEther("10"));
      expect(parsed!.args.tokensOut).to.be.gt(0);
    });
  });

  describe("TokensSold", function () {
    before(async function () {
      const tx = await duoLaunch.createSale("SELL", "SELL", 8000, ethers.parseEther("1000"), "", "", "", "");
      const rc = await tx.wait();
      const iface = DuoLaunch__factory.createInterface();
      const log = rc!.logs.find((l: any) => {
        try { const p = iface.parseLog(l); return p?.name === "SaleCreated"; } catch { return false; }
      });
      tokenAddr = (iface.parseLog(log!).args.token) as string;
      token = TokenTemplate__factory.connect(tokenAddr, owner);
      await duoLaunch.connect(user).buy(tokenAddr, 0, { value: ethers.parseEther("10") });
    });

    it("emits correct event structure on sell", async function () {
      const bal = await token.balanceOf(user.address);
      await token.connect(user).approve(await duoLaunch.getAddress(), bal);
      const tx = await duoLaunch.connect(user).sell(tokenAddr, bal, 0);
      const rc = await tx.wait();
      const iface = DuoLaunch__factory.createInterface();
      const log = rc!.logs.find((l: any) => {
        try { const p = iface.parseLog(l); return p?.name === "TokensSold"; } catch { return false; }
      });
      expect(log).to.not.be.undefined;
      const parsed = iface.parseLog(log!);

      const expectedTopic = evmTopic("TokensSold(address,address,uint256,uint256)");
      expect(log!.topics[0]).to.equal(expectedTopic);
      expect(log!.topics.length).to.equal(3);

      expect(parsed!.args.seller).to.equal(user.address);
      expect(parsed!.args.token).to.equal(tokenAddr);
      expect(parsed!.args.tokensIn).to.equal(bal);
      expect(parsed!.args.GASOut).to.be.gt(0);
    });
  });

  describe("SaleGraduated", function () {
    before(async function () {
      const target = ethers.parseEther("5");
      const tx = await duoLaunch.createSale("GRAD", "GRAD", 8000, target, "", "", "", "");
      const rc = await tx.wait();
      const iface = DuoLaunch__factory.createInterface();
      const log = rc!.logs.find((l: any) => {
        try { const p = iface.parseLog(l); return p?.name === "SaleCreated"; } catch { return false; }
      });
      tokenAddr = (iface.parseLog(log!).args.token) as string;
    });

    it("emits correct event structure on graduation", async function () {
      const tx = await duoLaunch.connect(user).buy(tokenAddr, 0, { value: ethers.parseEther("5") });
      const rc = await tx.wait();
      const iface = DuoLaunch__factory.createInterface();
      const log = rc!.logs.find((l: any) => {
        try { const p = iface.parseLog(l); return p?.name === "SaleGraduated"; } catch { return false; }
      });
      expect(log).to.not.be.undefined;
      const parsed = iface.parseLog(log!);

      const expectedTopic = evmTopic("SaleGraduated(address,address,uint256,uint256)");
      expect(log!.topics[0]).to.equal(expectedTopic);
      expect(log!.topics.length).to.equal(2);

      expect(parsed!.args.token).to.equal(tokenAddr);
      expect(parsed!.args.pair).to.not.equal(ethers.ZeroAddress);
      expect(parsed!.args.tokensForLP).to.be.gt(0);
      expect(parsed!.args.GASForLP).to.be.gt(0);
    });
  });

  describe("PairCreated (from UniswapV2Factory)", function () {
    it("emits during graduation with correct params", async function () {
      const target = ethers.parseEther("5");
      const tx0 = await duoLaunch.createSale("PAIR", "PAIR", 8000, target, "", "", "", "");
      const rc0 = await tx0.wait();
      const iface = DuoLaunch__factory.createInterface();
      const log0 = rc0!.logs.find((l: any) => {
        try { const p = iface.parseLog(l); return p?.name === "SaleCreated"; } catch { return false; }
      });
      const tAddr = (iface.parseLog(log0!).args.token) as string;

      const tx = await duoLaunch.connect(user).buy(tAddr, 0, { value: target });
      const rc = await tx.wait();
      const factoryIface = UniswapV2Factory__factory.createInterface();
      const pairLog = rc!.logs.find((l: any) => {
        try { const p = factoryIface.parseLog(l); return p?.name === "PairCreated"; } catch { return false; }
      });
      expect(pairLog).to.not.be.undefined;
      const parsed = factoryIface.parseLog(pairLog!);

      const expectedTopic = evmTopic("PairCreated(address,address,address,uint256)");
      expect(pairLog!.topics[0]).to.equal(expectedTopic);
      expect(pairLog!.topics.length).to.equal(3);

      expect(parsed!.args.pair).to.not.equal(ethers.ZeroAddress);
      expect(parsed!.args[0]).to.not.equal(ethers.ZeroAddress);
      expect(parsed!.args[1]).to.not.equal(ethers.ZeroAddress);
    });
  });
});
