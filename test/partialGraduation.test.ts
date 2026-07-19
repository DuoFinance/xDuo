import { expect } from "chai";
import { ethers } from "hardhat";
import type { DuoLaunch } from "../typechain-types";
import { DuoLaunch__factory, UniswapV2Factory__factory } from "../typechain-types";

describe("Partial Graduation — staged buys before target", function () {
  let owner: any, user: any;
  let duoLaunch: DuoLaunch;
  let tokenAddr: string;
  let target: bigint;

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

    target = ethers.parseEther("100");
    const tx = await duoLaunch.createSale("STAGE", "STG", 8000, target, "", "", "", "");
    const rc = await tx.wait();
    const iface = DuoLaunch__factory.createInterface();
    const log = rc!.logs.find((l: any) => {
      try { const p = iface.parseLog(l); return p?.name === "SaleCreated"; } catch { return false; }
    });
    tokenAddr = (iface.parseLog(log!).args.token) as string;
  });

  it("not graduated at 25% of target", async function () {
    await duoLaunch.connect(user).buy(tokenAddr, 0, { value: target / 4n });
    const s = await duoLaunch.getSale(tokenAddr);
    expect(s.graduated).to.be.false;
    expect(s.GASRaised).to.equal(target / 4n);
  });

  it("not graduated at 50% of target", async function () {
    await duoLaunch.connect(user).buy(tokenAddr, 0, { value: target / 4n });
    const s = await duoLaunch.getSale(tokenAddr);
    expect(s.graduated).to.be.false;
    expect(s.GASRaised).to.equal(target / 2n);
  });

  it("not graduated at 75% of target", async function () {
    await duoLaunch.connect(user).buy(tokenAddr, 0, { value: target / 4n });
    const s = await duoLaunch.getSale(tokenAddr);
    expect(s.graduated).to.be.false;
    expect(s.GASRaised).to.equal(target * 3n / 4n);
  });

  it("graduates at 100% of target", async function () {
    await duoLaunch.connect(user).buy(tokenAddr, 0, { value: target / 4n + 1n });
    const s = await duoLaunch.getSale(tokenAddr);
    expect(s.graduated).to.be.true;
  });
});
