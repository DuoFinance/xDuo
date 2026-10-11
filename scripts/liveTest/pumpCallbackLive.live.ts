import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import path from "path";
import { loadDeployed } from "./addresses";

const PUMP_ABI = [
  "function uniswapFactory() view returns (address)",
  "function weth() view returns (address)",
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";
const _log = (p: string, m: string) => console.log(`  ${p} ${m}`);

async function getPump() {
  const d = loadDeployed();
  return {
    pump: await ethers.getContractAt(PUMP_ABI, d.BONDING),
    pumpAddr: d.BONDING,
    factoryAddr: d.FACTORY,
    wgasAddr: d.WGAS,
  };
}

async function createSale(pump: any, label: string, target: bigint = ONE) {
  const pumpAddr = await pump.getAddress();
  const pumpLc = pumpAddr.toLowerCase();
  const tx = await pump.createSale(label, label.slice(0,4), 8000, target, "", "", "", "");
  const rc = await tx.wait();
  const topic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
  const log = rc!.logs.find((l: any) => l.topics[0] === topic && l.address.toLowerCase() === pumpLc);
  const iface = new ethers.Interface(["event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)"]);
  return iface.parseLog(log!)!.args.token as string;
}

async function buyEOA(pump: any, token: string, value: bigint): Promise<bigint> {
  try {
    const tx = await pump.buy(token, 0, { value, gasLimit: 3_000_000 });
    const rc = await tx.wait();
    if (rc?.status === 0) return 0n;
    for (const l of rc!.logs) {
      try {
        const p = new ethers.Interface(["event TokensPurchased(address indexed buyer, address indexed token, uint256 GASIn, uint256 tokensOut)"]).parseLog(l);
        if (p?.name === "TokensPurchased") return p.args.tokensOut;
      } catch {}
    }
    return 0n;
  } catch { return 0n; }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const { pump, pumpAddr, factoryAddr, wgasAddr } = await getPump();
  console.log(`\n${"=".repeat(60)}`);
  console.log("  DuoLaunch Callback Edge Case Test");
  console.log(`  Pump: ${pumpAddr}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`${"=".repeat(60)}\n`);

  // ── 1. Buy refund callback triggers re-entrant buy/sell ──
  // Flow: helper.trigger{value:300 ETH} → pump.buy() crosses cap → refund sent to helper
  //   → helper.receive() gets refund → tries pump.buy{value:refund} + pump.sell(tokens)
  //   → both blocked by nonReentrant (outer buy is still executing)
  console.log("── 1. Refund callback reentrancy ──");
  const t1 = await createSale(pump, "RR1", ONE * 200n);
  _log(_I, `Token: ${t1}`);

  const RF = await ethers.getContractFactory("contracts/test/CallbackTestHelper.sol:RefundReentrant");
  const rr = await RF.connect(deployer).deploy(pumpAddr, t1);
  await rr.waitForDeployment();

  // trigger sends ETH directly — no separate funding needed
  try {
    await (await rr.trigger(t1, { value: ONE * 300n, gasLimit: 5_000_000 })).wait();
    const rrCb = await rr.callbackTriggered();
    const rrBuyB = await rr.reenterBuyBlocked();
    const rrSellB = await rr.reenterSellBlocked();
    _log(rrCb ? PASS : FAIL, `  Callback triggered: ${rrCb}`);
    _log(rrBuyB ? PASS : FAIL, `  reenter buy() blocked: ${rrBuyB}`);
    _log(rrSellB ? PASS : FAIL, `  reenter sell() blocked: ${rrSellB}`);
  } catch (e: any) {
    _log(FAIL, `  trigger failed: ${(e?.reason || e?.message || "").slice(0, 100)}`);
  }
  const s1 = await pump.getSale(t1);
  _log(s1[7] ? PASS : FAIL, `  Sale graduated: ${s1[7]}`);

  // ── 2. Sell callback triggers re-entrant buy/sell ──
  // Flow: helper has tokens, trigger{value:0} → pump.sell() sends GASOut → helper.receive()
  //   → tries pump.buy{value:GASOut} + pump.sell(tokens) → both blocked by nonReentrant
  console.log("\n── 2. Sell callback reentrancy ──");
  const t2 = await createSale(pump, "SR1", ONE * 100n);
  _log(_I, `Token: ${t2}`);

  const SF = await ethers.getContractFactory("contracts/test/CallbackTestHelper.sol:SellReentrant");
  const sr = await SF.connect(deployer).deploy(pumpAddr, t2);
  await sr.waitForDeployment();

  // Buy tokens and transfer to helper
  const tokensOut = await buyEOA(pump, t2, ONE * 50n);
  if (tokensOut > 0n) {
    _log(PASS, `  Bought ${ethers.formatEther(tokensOut)} tokens`);
    const t2c = new ethers.Contract(t2, ERC20, deployer);
    const bal = await t2c.balanceOf(deployer.address);
    const tx1 = await t2c.transfer(await sr.getAddress(), bal);
    await tx1.wait();

    // Fund helper with ETH (ready=false → receive() ignores funding)
    const tx2 = await deployer.sendTransaction({ to: await sr.getAddress(), value: ONE * 60n });
    await tx2.wait();
    _log(PASS, "  Funded helper (ready=false, ignored by receive)");

    // Arm the helper
    await sr.setReady(true);

    // Trigger sell → GASOut → receive() → reentrant buy/sell
    // Sell only half so helper retains tokens for inner sell attempt
    const srBal = await t2c.balanceOf(await sr.getAddress());
    try {
      await (await sr.trigger(srBal / 2n, 0, { gasLimit: 5_000_000 })).wait();
      const srCb = await sr.callbackTriggered();
      const srBuyB = await sr.reenterBuyBlocked();
      const srSellB = await sr.reenterSellBlocked();
      _log(srCb ? PASS : FAIL, `  Callback triggered: ${srCb}`);
      _log(srBuyB ? PASS : FAIL, `  reenter buy() blocked: ${srBuyB}`);
      _log(srSellB ? PASS : FAIL, `  reenter sell() blocked: ${srSellB}`);
    } catch (e: any) {
      _log(FAIL, `  trigger failed: ${(e?.reason || e?.message || "").slice(0, 100)}`);
    }
  }

  // ── 3. Graduation with pre-existing pair ──
  console.log("\n── 3. Graduation with pre-existing pair ──");
  const t3 = await createSale(pump, "PrePair", ONE * 50n);
  _log(_I, `Token: ${t3}`);

  const factory = await ethers.getContractAt(
    ["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)"],
    factoryAddr
  );
  if ((await factory.getPair(t3, wgasAddr)) === ethers.ZeroAddress) {
    await (await factory.createPair(t3, wgasAddr)).wait();
    _log(PASS, "Pre-created pair");
  }
  const pairAddr = await factory.getPair(t3, wgasAddr);

  const t3PreBuy = await buyEOA(pump, t3, ONE * 5n);
  _log(t3PreBuy > 0n ? PASS : FAIL, `  Pre-bought ${ethers.formatEther(t3PreBuy)} tokens`);

  const t3c = new ethers.Contract(t3, ERC20, deployer);
  const t3bal = await t3c.balanceOf(deployer.address);
  if (t3bal > 0n) {
    const wgas = await ethers.getContractAt(
      ["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
      wgasAddr
    );
    await (await wgas.deposit({ value: ONE / 100n })).wait();
    await (await wgas.transfer(pairAddr, ONE / 100n)).wait();
    await t3c.transfer(pairAddr, t3bal / 2n);
    _log(PASS, "Seeded pre-created pair with LP");
  }

  const b3 = await buyEOA(pump, t3, ONE * 60n);
  _log(b3 > 0n ? PASS : FAIL, `  Grad buy: ${ethers.formatEther(b3)} tokens`);
  const s3 = await pump.getSale(t3);
  _log(s3[7] ? PASS : FAIL, `  Graduated: ${s3[7]}`);

  const pair = await ethers.getContractAt(
    ["function getReserves() view returns (uint112,uint112,uint32)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"],
    pairAddr
  );
  const [r0, r1] = await pair.getReserves();
  _log(r0 > 0n && r1 > 0n ? PASS : FAIL, `  Reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);
  const lpTotal = await pair.totalSupply();
  const lpBurned = await pair.balanceOf(ethers.ZeroAddress);
  _log(lpBurned === lpTotal ? PASS : FAIL, `  LP burned: ${ethers.formatEther(lpBurned)} / ${ethers.formatEther(lpTotal)}`);

  // ── 4. Refund griefing ──
  console.log("\n── 4. Refund griefing ──");
  const t4 = await createSale(pump, "Grief", ONE * 200n);
  _log(_I, `Token: ${t4}`);

  const GG = await ethers.getContractFactory("contracts/test/MaliciousHelper.sol:RefundGriefer");
  const griefer = await GG.connect(deployer).deploy();
  await griefer.waitForDeployment();
  await griefer.setReject(false);
  const ftx = await deployer.sendTransaction({ to: await griefer.getAddress(), value: ONE * 300n });
  await ftx.wait();
  await griefer.setReject(true);

  try {
    await (await griefer.attackRefundGrief(pumpAddr, t4, { value: ONE * 300n, gasLimit: 3_000_000 })).wait();
    _log(FAIL, "Should have reverted");
  } catch {
    _log(PASS, "Grief reverted as expected");
  }
  const b4 = await buyEOA(pump, t4, ONE * 10n);
  _log(b4 > 0n ? PASS : FAIL, `  Other users buy: ${ethers.formatEther(b4)} tokens`);

  // ── 5. Graduation cap crossing ──
  console.log("\n── 5. Graduation cap crossing ──");
  const t5 = await createSale(pump, "CapX", ONE * 30n);
  _log(_I, `Token: ${t5}`);

  const b5 = await buyEOA(pump, t5, ONE * 50n);
  if (b5 > 0n) {
    _log(PASS, `  Cap-cross buy: ${ethers.formatEther(b5)} tokens`);
    const s5 = await pump.getSale(t5);
    _log(s5[7] ? PASS : FAIL, `  Graduated: ${s5[7]}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Callback edge case test complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
