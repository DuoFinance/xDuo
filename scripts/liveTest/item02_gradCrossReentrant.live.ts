import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";

const PUMP = [
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function uniswapFactory() view returns (address)",
  "function weth() view returns (address)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";

async function getPump() {
  const d = JSON.parse(fs.readFileSync("deployed.json", "utf8"));
  const pump = await ethers.getContractAt(PUMP, d.pump);
  return { pump, pumpAddr: d.pump, factoryAddr: d.factory, wgasAddr: d.wgas };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const { pump, pumpAddr, factoryAddr, wgasAddr } = await getPump();
  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 2: Graduation Cross-Contract Reentrancy");
  console.log(`  Pump: ${pumpAddr}  Factory: ${factoryAddr}  WGAS: ${wgasAddr}`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  // Create a sale
  const tx = await pump.createSale("GradX2", "GX2", 8000, ONE * 100n, "", "", "", "");
  const rc = await tx.wait();
  const topic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
  const log = rc!.logs.find((l: any) => l.topics[0] === topic);
  const token = new ethers.Interface(["event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)"]).parseLog(log!)!.args.token as string;
  console.log(`  ${_I} Token: ${token}`);

  // Deploy GraduationCrossReentrant helper
  const HF = await ethers.getContractFactory("contracts/CallbackTestHelper.sol:GraduationCrossReentrant");
  const hlpr = await HF.connect(deployer).deploy(pumpAddr, factoryAddr, wgasAddr, token);
  await hlpr.waitForDeployment();
  const hAddr = await hlpr.getAddress();
  console.log(`  ${_I} Helper: ${hAddr}`);

  // Fund helper with tokens and ETH
  // First buy some tokens (cap-crossing, but from a separate EOA not from helper)
  // Actually, we need the helper to hold tokens for seeding the pair
  // Buy tokens normally from deployer, transfer some to helper
  const buyTx = await pump.buy(token, 0, { value: ONE * 50n, gasLimit: 3_000_000 });
  await (buyTx).wait();
  const tc = new ethers.Contract(token, ERC20, deployer);
  const tBal = await tc.balanceOf(deployer.address);
  // Transfer ~half to the helper for seeding
  const seedTokens = tBal / 3n;
  const tx1 = await tc.transfer(hAddr, seedTokens);
  await tx1.wait();
  // Fund ETH to helper for seeding
  const tx2 = await deployer.sendTransaction({ to: hAddr, value: ONE * 30n });
  await tx2.wait();
  console.log(`  ${_I} Helper token bal: ${ethers.formatEther(await tc.balanceOf(hAddr))}`);
  console.log(`  ${_I} Helper ETH bal: ${ethers.formatEther(await ethers.provider.getBalance(hAddr))}`);

  // Arm the helper (ready=true, so receive() will execute on next callback)
  await hlpr.setReady(true);

  // Now buy from helper with cap-crossing amount → triggers graduation
  // The helper's receive() will fire during the refund callback
  // It should pre-create the pair, seed liquidity, and try pump reentry
  try {
    await (await hlpr.trigger(token, { value: ONE * 80n, gasLimit: 8_000_000 })).wait();
    console.log(`  ${PASS} Graduation buy completed`);
  } catch (e: any) {
    console.log(`  ${FAIL} Graduation buy failed: ${(e?.reason || e?.message || "").slice(0, 100)}`);
    process.exit(1);
  }

  // Verify callback was triggered
  const cb = await hlpr.callbackTriggered();
  console.log(`  ${cb ? PASS : FAIL} Callback triggered: ${cb}`);

  // Verify pair was pre-created in callback
  const pc = await hlpr.pairPreCreated();
  console.log(`  ${pc ? PASS : FAIL} Pair pre-created: ${pc}`);

  // Verify pair was seeded with imbalanced liquidity
  const ps = await hlpr.pairSeeded();
  console.log(`  ${ps ? PASS : FAIL} Pair seeded: ${ps}`);

  // Verify pump reentries were blocked
  const buyB = await hlpr.pumpBuyBlocked();
  const sellB = await hlpr.pumpSellBlocked();
  console.log(`  ${buyB ? PASS : FAIL} pump.buy() blocked: ${buyB}`);
  console.log(`  ${sellB ? PASS : FAIL} pump.sell() blocked: ${sellB}`);

  // Attacker's LP from pre-seeding
  const aLP = await hlpr.attackerLP();
  console.log(`  ${_I} Attacker pre-seed LP: ${ethers.formatEther(aLP)}`);

  // Verify graduation state
  const s = await pump.getSale(token);
  console.log(`  ${s[7] ? PASS : FAIL} Sale graduated: ${s[7]}`);

  // Verify pair state after graduation
  const factory = await ethers.getContractAt(
    ["function getPair(address,address) view returns (address)"],
    factoryAddr
  );
  const pairAddr = await factory.getPair(token, wgasAddr);
  if (pairAddr !== ethers.ZeroAddress) {
    const pair = await ethers.getContractAt(
      ["function getReserves() view returns (uint112,uint112,uint32)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"],
      pairAddr
    );
    const [r0, r1] = await pair.getReserves();
    console.log(`  ${_I} Pair reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);
    const lpTotal = await pair.totalSupply();
    const lpBurned = await pair.balanceOf(ethers.ZeroAddress);
    console.log(`  ${lpBurned > 0n ? PASS : FAIL} LP burned: ${ethers.formatEther(lpBurned)} / ${ethers.formatEther(lpTotal)}`);
    // Attacker's LP should still exist
    const aLPFinal = await pair.balanceOf(hAddr);
    console.log(`  ${aLPFinal > 0n ? _I : FAIL} Attacker LP preserved: ${ethers.formatEther(aLPFinal)}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 2 complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
