import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import { loadDeployed } from "./addresses";

const PUMP = [
  "function createAndBuy(string,string,uint256,uint256,uint256,string,string,string,string) payable",
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function getTokensForGAS(address,uint256) view returns (uint256)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";

const saleCreatedTopic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
const purchasedTopic  = ethers.id("TokensPurchased(address,address,uint256,uint256)");
const saleIface = new ethers.Interface([
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)",
]);
const buyIface = new ethers.Interface([
  "event TokensPurchased(address indexed buyer, address indexed token, uint256 GASIn, uint256 tokensOut)",
]);

function parseTokenFromReceipt(rc: any): string {
  const log = rc.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  return saleIface.parseLog(log)!.args.token as string;
}

function parseTokensOutFromReceipt(rc: any): bigint {
  const log = rc.logs.find((l: any) => l.topics[0] === purchasedTopic);
  return buyIface.parseLog(log)!.args.tokensOut as bigint;
}

function parseGASInFromReceipt(rc: any): bigint {
  const log = rc.logs.find((l: any) => l.topics[0] === purchasedTopic);
  return buyIface.parseLog(log)!.args.GASIn as bigint;
}

async function getPump() {
  const d = loadDeployed();
  const pump = await ethers.getContractAt(PUMP, d.BONDING);
  return pump;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const pump = await getPump();
  const pumpAddr = await pump.getAddress();
  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 3: createAndBuy Atomicity");
  console.log(`  Pump: ${pumpAddr}  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  // ── Part 1: createAndBuy atomic consistency ──
  console.log("  ── Part 1: createAndBuy atomic consistency ──");
  const val = ONE * 5n;
  const tx = await pump.createAndBuy("Atomic", "ATM", 8000, ONE * 100n, 0, "", "", "", "", { value: val });
  const rc = await tx.wait();
  const token = parseTokenFromReceipt(rc!);
  const tokensOut = parseTokensOutFromReceipt(rc!);
  console.log(`  ${_I} Token: ${token}  tokensOut: ${ethers.formatEther(tokensOut)}`);

  const tc = new ethers.Contract(token, ERC20, deployer);
  const sym = await tc.symbol();
  const name = await tc.name();
  console.log(`  ${sym === "ATM" ? PASS : FAIL} Symbol: ${sym}`);
  console.log(`  ${name === "Atomic" ? PASS : FAIL} Name: ${name}`);

  const sale = await pump.getSale(token);
  const creator = sale[0];
  const tokensSold = sale[1];
  const GASRaised = sale[2];
  console.log(`  ${creator === deployer.address ? PASS : FAIL} Creator: ${creator}`);
  console.log(`  ${tokensSold === tokensOut ? PASS : FAIL} tokensSold == tokensOut: ${ethers.formatEther(tokensSold)} == ${ethers.formatEther(tokensOut)}`);
  console.log(`  ${GASRaised > 0n ? PASS : FAIL} GASRaised: ${ethers.formatEther(GASRaised)} (val: ${ethers.formatEther(val)})`);

  const balAfter = await tc.balanceOf(deployer.address);
  console.log(`  ${balAfter === tokensOut ? PASS : FAIL} Deployer token bal == tokensOut: ${ethers.formatEther(balAfter)}`);

  // Verify GASRaised and GASIn from event are consistent
  const GASIn = parseGASInFromReceipt(rc!);
  console.log(`  ${GASRaised === GASIn ? PASS : FAIL} GASRaised == GASIn: ${ethers.formatEther(GASRaised)} == ${ethers.formatEther(GASIn)}`);
  console.log(`  ${_I} GASIn ${ethers.formatEther(GASIn)} from ${ethers.formatEther(val)} sent (refund: ${ethers.formatEther(val - GASIn)})`);

  // Verify the buy did NOT cross the cap (5 ETH << 100 ETH target with 80% curve)
  const graduated = await (await pump.getSale(token))[7];
  console.log(`  ${!graduated ? PASS : FAIL} Not graduated: ${graduated}`);

  // Internal state consistency: price formula matches
  // Compute expected output using the sale's initial state
  const vGAS = sale[4];
  const vToken = sale[5];
  const GASReserve = vGAS + 0n;  // 0 GASRaised at the moment of buy
  const tokenReserve = vToken - 0n;  // 0 tokensSold at the moment of buy
  // We can't easily replicate CurveMath.getAmountOut here, but we can verify
  // that getTokensForGAS computed with pre-buy state matches tokensOut
  // Since we can't query pre-buy state (token didn't exist), just confirm GASIn is correct
  console.log(`  ${GASIn > 0n && GASIn <= val ? PASS : FAIL} GASIn valid range: ${ethers.formatEther(GASIn)}`);
  console.log();

  // ── Part 2: Demonstrate the race condition ──
  console.log("  ── Part 2: Race condition demonstration ──");
  // Create a sale, then simulate a front-runner buying before the creator
  const t2 = await pump.createSale("Raced", "RCD", 8000, ONE * 100n, "", "", "", "");
  const r2 = await t2.wait();
  const token2 = parseTokenFromReceipt(r2!);
  console.log(`  ${_I} Token2: ${token2}`);

  const expectedInit = await pump.getTokensForGAS(token2, ONE);
  console.log(`  ${_I} Expected tokens for 1 ETH (initial): ${ethers.formatEther(expectedInit)}`);

  // "Front-runner" buys 1 ETH (same account, simulating mempool ordering)
  const tFront = await pump.buy(token2, 0, { value: ONE });
  const rcFront = await tFront.wait();
  const frontTokens = parseTokensOutFromReceipt(rcFront!);
  console.log(`  ${_I} Front-runner bought: ${ethers.formatEther(frontTokens)} for 1 ETH`);

  // Now the creator buys 1 ETH (worse price — curve moved after front-run buy)
  const expectedAfterFront = await pump.getTokensForGAS(token2, ONE);
  console.log(`  ${_I} Expected tokens for 1 ETH (after front-run): ${ethers.formatEther(expectedAfterFront)}`);
  const tCreator = await pump.buy(token2, 0, { value: ONE });
  const rcCreator = await tCreator.wait();
  const creatorTokens = parseTokensOutFromReceipt(rcCreator!);
  console.log(`  ${_I} Creator (late) bought: ${ethers.formatEther(creatorTokens)} for 1 ETH`);

  const frontGotMore = frontTokens > creatorTokens;
  console.log(`  ${frontGotMore ? PASS : FAIL} Front-runner got more than late creator: ${ethers.formatEther(frontTokens)} > ${ethers.formatEther(creatorTokens)}`);

  // Compare with createAndBuy which atomically locks the initial price
  // Same curve params (8000 bps, 100 ETH target) → same initial price as token2
  const t3 = await pump.createAndBuy("Safe", "SFE", 8000, ONE * 100n, 0, "", "", "", "", { value: ONE });
  const r3 = await t3.wait();
  const tokensOut3 = parseTokensOutFromReceipt(r3!);
  console.log(`  ${_I} createAndBuy got: ${ethers.formatEther(tokensOut3)} for 1 ETH`);
  const initialPriceSame = tokensOut3 === frontTokens;
  console.log(`  ${initialPriceSame ? PASS : FAIL} createAndBuy output == initial front-run output: ${ethers.formatEther(tokensOut3)} == ${ethers.formatEther(frontTokens)}`);

  // Part 2 conclusion:
  // - createAndBuy atomically locks the initial curve price (same output as first buy)
  // - createSale + separate buy exposes a race: front-runner jumps ahead, late buyer gets worse price
  const raceExists = frontGotMore && initialPriceSame;
  console.log(`  ${raceExists ? PASS : FAIL} Atomicity confirmed: createAndBuy locks initial price; separate txs expose race`);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 3 complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
