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
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";

const ROUTER = [
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function WETH() view returns (address)",
];
const PAIR = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const purchasedTopic = ethers.id("TokensPurchased(address,address,uint256,uint256)");
const buyIface = new ethers.Interface([
  "event TokensPurchased(address indexed buyer, address indexed token, uint256 GASIn, uint256 tokensOut)",
]);

function parseTokensOut(rc: any): bigint {
  const log = rc.logs.find((l: any) => l.topics[0] === purchasedTopic);
  return buyIface.parseLog(log)!.args.tokensOut as bigint;
}

async function deadline(minutes = 30): Promise<number> {
  const blk = await ethers.provider.getBlock("latest");
  return blk!.timestamp + minutes * 60;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const d = JSON.parse(fs.readFileSync("deployed.json", "utf8"));
  const pump = await ethers.getContractAt(PUMP, d.pump);
  const router = await ethers.getContractAt(ROUTER, d.router);
  const pumpAddr = d.pump;
  const routerAddr = d.router;

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 5: Multi-block MEV Sandwich After Graduation");
  console.log(`  Pump: ${pumpAddr}  Router: ${routerAddr}  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  // ── Step 1: Create a sale ──
  console.log("  ── Step 1: Create sale ──");
  const target = ONE * 100n;
  const gradBps = 8000;
  const tx = await pump.createSale("MEVTest", "MEV", gradBps, target, "", "", "", "");
  const rc = await tx.wait();

  const saleCreatedTopic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
  const log = rc!.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  const saleIface = new ethers.Interface(["event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)"]);
  const token = saleIface.parseLog(log!)!.args.token as string;
  console.log(`  ${_I} Token: ${token}`);

  // ── Step 2: Buy to cross the cap and graduate ──
  console.log("  ── Step 2: Graduate the sale ──");
  // Calculate how much ETH needed to cross the cap
  const capTokens = ethers.parseEther("1000000000") * BigInt(gradBps) / 10000n; // ~800M
  const buyVal = ONE * 200n; // 200 ETH should overshoot the cap
  const tx2 = await pump.buy(token, 0, { value: buyVal, gasLimit: 3_000_000 });
  const rc2 = await tx2.wait();
  const tokensOut = parseTokensOut(rc2!);

  const sale2 = await pump.getSale(token);
  const graduated = sale2[7];
  console.log(`  ${graduated ? PASS : FAIL} Graduated: ${graduated}`);
  console.log(`  ${_I} GASRaised: ${ethers.formatEther(sale2[2])}`);
  console.log(`  ${_I} tokensSold: ${ethers.formatEther(sale2[1])}`);
  console.log(`  ${_I} tokensOut (buy): ${ethers.formatEther(tokensOut)}`);

  // ── Step 3: Get the Uniswap pair ──
  console.log("  ── Step 3: Get the graduated Uniswap pair ──");
  const wgas = d.wgas;
  const factory = await ethers.getContractAt(
    ["function getPair(address,address) view returns (address)"],
    d.factory
  );
  const pairAddr = await factory.getPair(token, wgas);
  console.log(`  ${_I} Pair: ${pairAddr}`);
  const pair = await ethers.getContractAt(PAIR, pairAddr);
  const t0 = await pair.token0();
  const t1 = await pair.token1();
  const [r0, r1] = await pair.getReserves();
  console.log(`  ${_I} token0: ${t0}  token1: ${t1}`);
  console.log(`  ${_I} Reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);

  const lpTotal = await pair.totalSupply();
  const lpBurned = await pair.balanceOf(ethers.ZeroAddress);
  console.log(`  ${lpBurned > 0n ? PASS : FAIL} LP burned (locked): ${ethers.formatEther(lpBurned)} / ${ethers.formatEther(lpTotal)}`);

  console.log(`  ${_I} token0: ${t0}  token1: ${t1}`);

  // ── Step 4: MEV Sandwich ──
  console.log("  ── Step 4: MEV Sandwich ──");

  // Path for buying tokens: spend WETH → receive Token
  const pathBuy = [wgas, token];
  // Path for selling tokens: spend Token → receive WETH
  const pathSell = [token, wgas];

  // WETH wrapper
  const wethContract = await ethers.getContractAt(
    ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    wgas
  );

  // 4a. Front-run: bot buys tokens on pair
  console.log("  4a. Front-run: bot buys tokens on pair");
  const dt = await deadline();
  const tc = new ethers.Contract(token, ERC20, deployer);
  const balBefore = await tc.balanceOf(deployer.address); // includes graduation tokens

  const botBuyWETH = r1 / 80n;
  await (await wethContract.deposit({ value: botBuyWETH })).wait();
  await (await wethContract.approve(routerAddr, botBuyWETH)).wait();
  const botBuyExpected = await router.getAmountsOut(botBuyWETH, pathBuy);
  const botBuyMin = botBuyExpected[1] * 90n / 100n;
  await (await router.swapExactTokensForTokens(botBuyWETH, botBuyMin, pathBuy, deployer.address, dt)).wait();
  const balAfterFront = await tc.balanceOf(deployer.address);
  const botTokens = balAfterFront - balBefore;
  console.log(`  ${_I} Bot bought: ${ethers.formatEther(botTokens)} tokens (spent ${ethers.formatEther(botBuyWETH)} WETH)`);

  // 4b. Victim buys tokens (gets fewer due to front-run price impact)
  console.log("  4b. Victim buys tokens (worse price)");
  const victimBuyWETH = botBuyWETH;
  await (await wethContract.deposit({ value: victimBuyWETH })).wait();
  await (await wethContract.approve(routerAddr, victimBuyWETH)).wait();
  const victimExpected = await router.getAmountsOut(victimBuyWETH, pathBuy);
  const victimMin = victimExpected[1] * 90n / 100n;
  await (await router.swapExactTokensForTokens(victimBuyWETH, victimMin, pathBuy, deployer.address, dt)).wait();
  const balAfterVictim = await tc.balanceOf(deployer.address);
  const victimTokens = balAfterVictim - balAfterFront;
  console.log(`  ${_I} Victim bought: ${ethers.formatEther(victimTokens)} tokens (spent ${ethers.formatEther(victimBuyWETH)} WETH)`);
  console.log(`  ${victimTokens < botTokens ? PASS : FAIL} Victim got fewer tokens: ${ethers.formatEther(victimTokens)} < ${ethers.formatEther(botTokens)}`);

  // 4c. Back-run: bot sells tokens at inflated price
  console.log("  4c. Back-run: bot sells tokens for profit");
  await (await tc.approve(routerAddr, botTokens)).wait();
  const botSellExpected = await router.getAmountsOut(botTokens, pathSell);
  const botWETHOut = botSellExpected[1];
  console.log(`  ${_I} Bot expected WETH back: ${ethers.formatEther(botWETHOut)} (invested: ${ethers.formatEther(botBuyWETH)})`);

  if (botWETHOut > botBuyWETH) {
    await (await router.swapExactTokensForTokens(botTokens, botBuyWETH * 90n / 100n, pathSell, deployer.address, dt)).wait();
    console.log(`  ${PASS} Bot profited: got ${ethers.formatEther(botWETHOut)} WETH for ${ethers.formatEther(botBuyWETH)} WETH investment`);
  } else {
    console.log(`  ${_I} Bot would not profit (output ≤ investment) — market efficient for this size`);
  }

  // ── Step 5: Verify reserves shifted ──
  console.log("  ── Step 5: Reserves after sandwich ──");
  const [r0f, r1f] = await pair.getReserves();
  console.log(`  ${_I} Final reserves: ${ethers.formatEther(r0f)} / ${ethers.formatEther(r1f)}`);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 5 complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
