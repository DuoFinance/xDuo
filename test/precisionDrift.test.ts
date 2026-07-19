import { expect } from "chai";
import { ethers } from "hardhat";
import type { DuoLaunch } from "../typechain-types";
import { DuoLaunch__factory, UniswapV2Factory__factory, UniswapV2Router02__factory } from "../typechain-types";

describe("Precision Drift — accumulated K divergence", function () {
  let owner: any, user: any;
  let duoLaunch: DuoLaunch;
  let tokenAddr: string;

  before(async function () {
    [owner, user] = await ethers.getSigners();
    const WETH9 = await ethers.getContractFactory("WETH9");
    const wethC = await WETH9.deploy();
    await wethC.waitForDeployment();
    const weth = await wethC.getAddress();
    const factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();
    duoLaunch = await new DuoLaunch__factory(owner).deploy(await factory.getAddress(), weth);
    await duoLaunch.waitForDeployment();

    const tx = await duoLaunch.createSale("DRIFT", "DRIFT", 8000, ethers.parseEther("1000"), "", "", "", "");
    const rc = await tx.wait();
    const iface = DuoLaunch__factory.createInterface();
    const log = rc!.logs.find((l: any) => {
      try { const p = iface.parseLog(l); return p?.name === "SaleCreated"; } catch { return false; }
    });
    tokenAddr = (iface.parseLog(log!).args.token) as string;
  });

  it("K drift stays within 1 bps after 20 small buys", async function () {
    const s0 = await duoLaunch.getSale(tokenAddr);
    const K0 = (s0.virtualGAS + s0.GASRaised) * (s0.virtualToken - s0.tokensSold);

    for (let i = 0; i < 20; i++) {
      const amount = ethers.parseEther("0.1");
      await duoLaunch.connect(user).buy(tokenAddr, 0, { value: amount });
    }

    const s1 = await duoLaunch.getSale(tokenAddr);
    const K1 = (s1.virtualGAS + s1.GASRaised) * (s1.virtualToken - s1.tokensSold);
    const diff = K1 > K0 ? K1 - K0 : K0 - K1;
    const driftBps = diff * 10000n / K0;
    expect(driftBps).to.be.lte(1);
  });

  it("K drift stays within 1 bps after 20 buys + 20 sells", async function () {
    const tx = await duoLaunch.createSale("DRIFT2", "DRF2", 8000, ethers.parseEther("1000"), "", "", "", "");
    const rc = await tx.wait();
    const iface = DuoLaunch__factory.createInterface();
    const log = rc!.logs.find((l: any) => {
      try { const p = iface.parseLog(l); return p?.name === "SaleCreated"; } catch { return false; }
    });
    const tAddr = (iface.parseLog(log!).args.token) as string;
    const token2 = await ethers.getContractAt([
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], tAddr);

    const s0 = await duoLaunch.getSale(tAddr);
    const K0 = (s0.virtualGAS + s0.GASRaised) * (s0.virtualToken - s0.tokensSold);

    for (let i = 0; i < 10; i++) {
      await duoLaunch.connect(user).buy(tAddr, 0, { value: ethers.parseEther("1") });
    }
    const bal = await token2.balanceOf(user.address);
    const sellAmt = bal / 20n;
    await token2.connect(user).approve(await duoLaunch.getAddress(), bal);
    for (let i = 0; i < 10; i++) {
      await duoLaunch.connect(user).sell(tAddr, sellAmt, 0);
    }

    const s1 = await duoLaunch.getSale(tAddr);
    const K1 = (s1.virtualGAS + s1.GASRaised) * (s1.virtualToken - s1.tokensSold);
    const diff = K1 > K0 ? K1 - K0 : K0 - K1;
    const driftBps = diff * 10000n / K0;
    expect(driftBps).to.be.lte(1);
  });
});
