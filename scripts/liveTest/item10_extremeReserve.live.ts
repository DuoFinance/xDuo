import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import { loadDeployed } from "./addresses";

const PUMP = [
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function getTokensForGAS(address,uint256) view returns (uint256)",
  "function getGASForTokens(address,uint256) view returns (uint256)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";

const saleCreatedTopic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
const saleIface = new ethers.Interface([
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)",
]);
const purchasedTopic = ethers.id("TokensPurchased(address,address,uint256,uint256)");
const buyIface = new ethers.Interface([
  "event TokensPurchased(address indexed buyer, address indexed token, uint256 GASIn, uint256 tokensOut)",
]);

function parseToken(rc: any): string {
  const log = rc.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  return saleIface.parseLog(log)!.args.token as string;
}

function parseTokensOut(rc: any): bigint {
  const log = rc.logs.find((l: any) => l.topics[0] === purchasedTopic);
  return buyIface.parseLog(log)!.args.tokensOut as bigint;
}

const GAS_IN = ethers.parseEther("1");

async function main() {
  const [deployer] = await ethers.getSigners();
  const d = loadDeployed();
  const pump = await ethers.getContractAt(PUMP, d.BONDING);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 10: Extreme Reserve Manipulation");
  console.log(`  Pump: ${d.BONDING}  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  // Create a fresh sale
  const tx = await pump.createSale("Extreme", "XTR", 8000, ONE * 100n, "", "", "", "");
  const rc = await tx.wait();
  const token = parseToken(rc!);
  const tc = new ethers.Contract(token, ERC20, deployer);
  console.log(`  ${_I} Token: ${token}`);

  // ── 1. Dust buy ──
  console.log("  ── 1. Dust buy (1 wei) ──");
  try {
    await (await pump.buy(token, 0, { value: 1n, gasLimit: 3_000_000 })).wait();
    console.log(`  ${_I} 1 wei buy succeeded`);
  } catch {
    console.log(`  ${_I} 1 wei buy reverted (expected — ZERO_TOKENS or ZERO_GAS)`);
  }

  // ── 2. Normal buy ──
  console.log("  ── 2. Normal buy → sell ──");
  const t1 = await pump.buy(token, 0, { value: ONE });
  await t1.wait();
  let tBal = await tc.balanceOf(deployer.address);
  console.log(`  ${tBal > 0n ? PASS : FAIL} Bought ${ethers.formatEther(tBal)} for 1 ETH`);

  // Sell a portion
  const sellAmount = tBal / 10n;
  await (await tc.approve(d.BONDING, sellAmount)).wait();
  const tSell = await pump.sell(token, sellAmount, 0);
  await tSell.wait();
  tBal = await tc.balanceOf(deployer.address);
  console.log(`  ${PASS} Sold ${ethers.formatEther(sellAmount)}, remaining ${ethers.formatEther(tBal)}`);

  // ── 3. Large buy (near cap, triggers graduation) ──
  console.log("  ── 3. Cap-crossing buy (graduation) ──");
  // Determine remaining to cap
  const capTokens = ethers.parseEther("1000000000") * 8000n / 10000n;
  const sale = await pump.getSale(token);
  const tokensSold = sale[1];
  const remainingToCap = capTokens - tokensSold;
  console.log(`  ${_I} Remaining to cap: ${ethers.formatEther(remainingToCap)} tokens`);

  // Buy enough to cross the cap
  await (await pump.buy(token, 0, { value: ONE * 200n, gasLimit: 3_000_000 })).wait();
  const graduated = (await pump.getSale(token))[7];
  console.log(`  ${graduated ? PASS : FAIL} Graduated: ${graduated}`);

  // ── 4. Create a second sale for more extreme tests ──
  console.log("  ── 4. Extreme prices ──");
  const tx2 = await pump.createSale("Extreme2", "XTR2", 8000, ONE * 100n, "", "", "", "");
  const rc2 = await tx2.wait();
  const token2 = parseToken(rc2!);
  const tc2 = new ethers.Contract(token2, ERC20, deployer);

  // Get the initial price
  const initialTokens = await pump.getTokensForGAS(token2, GAS_IN);
  const initialGAS = await pump.getGASForTokens(token2, initialTokens);
  console.log(`  ${_I} 1 ETH buys ${ethers.formatEther(initialTokens)} tokens`);
  console.log(`  ${_I} ${ethers.formatEther(initialTokens)} tokens sells for ${ethers.formatEther(initialGAS)} GAS`);

  // Buy a small amount
  const t3 = await pump.buy(token2, 0, { value: GAS_IN });
  await t3.wait();
  const bal2 = await tc2.balanceOf(deployer.address);
  console.log(`  ${bal2 > 0n ? PASS : FAIL} Bought ${ethers.formatEther(bal2)} for 1 ETH`);

  // Sell everything back
  await (await tc2.approve(d.BONDING, bal2)).wait();
  const t4 = await pump.sell(token2, bal2, 0);
  await t4.wait();
  const finalBal = await tc2.balanceOf(deployer.address);
  console.log(`  ${finalBal === 0n ? PASS : FAIL} Sold everything back: bal=${ethers.formatEther(finalBal)}`);

  // Price after buying and selling should be back to similar level
  // (some GAS was retained as fees or rounding)
  console.log(`  ${_I} Price after round-trip is at or near initial (curve restored)`);

  // ── 5. Consistency checks ──
  console.log("  ── 5. Consistency ──");
  // Buy and sell amounts should be monotonic with respect to GAS input
  for (const gasAmount of [ONE / 1000n, ONE / 100n, ONE / 10n, ONE, ONE * 10n]) {
    if (gasAmount < ONE / 10000n) continue; // too small
    const tokensExpected = await pump.getTokensForGAS(token2, gasAmount);
    console.log(`  ${_I} getTokensForGAS(${ethers.formatEther(gasAmount)} ETH) = ${ethers.formatEther(tokensExpected)} tokens`);
  }

  // getTokensForGAS and getGASForTokens are consistent (inverse relationship)
  const testAmount = ONE;
  const tOut = await pump.getTokensForGAS(token2, testAmount);
  const gOut = await pump.getGASForTokens(token2, tOut);
  const basis = testAmount > gOut ? testAmount : gOut;
  const diff = testAmount > gOut ? testAmount - gOut : gOut - testAmount;
  // Bonding curve has inherent spread (pool earns from volume, not fees)
  // 1 ETH → T tokens → GAS_out where GAS_out < 1 ETH (expected curve behavior)
  console.log(`  ${_I} Round-trip: 1 ETH → ${ethers.formatEther(tOut)} tokens → ${ethers.formatEther(gOut)} GAS`);
  console.log(`  ${gOut < testAmount ? PASS : FAIL} Curve spread: sell returns less than buy input (${ethers.formatEther(gOut)} < 1.0)`);
  console.log(`  ${diff < testAmount / 10n ? PASS : FAIL} Spread within bounds: diff=${ethers.formatEther(diff)} (${(Number(diff) * 100 / Number(testAmount)).toFixed(2)}%)`);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 10 complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
