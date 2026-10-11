import hre from "hardhat";
const { ethers } = hre;
import assert from "assert";
import * as fs from "fs";
import path from "path";
import { loadDeployed } from "./addresses";

const ROUTER_IFACE = "contracts/interfaces/IUniswapV2Router02.sol:IUniswapV2Router02";
const FACTORY_IFACE = "contracts/interfaces/IUniswapV2Factory.sol:IUniswapV2Factory";
const PAIR_IFACE = "contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
];

const WETH = [
  "function deposit() payable",
  "function withdraw(uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const PUMP_ABI = [
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function createAndBuy(string,string,uint256,uint256,uint256,string,string,string,string) payable returns (address token, uint256 tokensOut)",
  "function buy(address,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function getSale(address) view returns (address creator, uint256 tokensSold, uint256 GASRaised, uint256 targetRaise, uint256 virtualGAS, uint256 virtualToken, uint256 graduationBps, bool graduated)",
  "function getCurrentPrice(address) view returns (uint256)",
  "function getTokensForGAS(address,uint256) view returns (uint256)",
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)",
  "event TokensPurchased(address indexed buyer, address indexed token, uint256 GASIn, uint256 tokensOut)",
  "event TokensSold(address indexed seller, address indexed token, uint256 tokensIn, uint256 GASOut)",
  "event SaleGraduated(address indexed token, address pair, uint256 tokensForLP, uint256 GASForLP)",
];

async function printFee(label: string, txResponse: any) {
  const rc = await txResponse.wait();
  const block = await ethers.provider.getBlock(rc!.blockNumber);
  const gasUsed = rc!.gasUsed;
  const gasPrice = rc!.gasPrice;
  const baseFee = block!.baseFeePerGas ?? 0n;
  const priorityFee = gasPrice - baseFee;

  console.log(`  ${"=".repeat(56)}`);
  console.log(`  ${label}`);
  console.log(`  ${"=".repeat(56)}`);
  console.log(`  gasUsed          : ${gasUsed.toLocaleString()}`);
  console.log(`  gasPrice         : ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`  baseFeePerGas    : ${ethers.formatUnits(baseFee, "gwei")} gwei`);
  console.log(`  priorityFee      : ${ethers.formatUnits(priorityFee, "gwei")} gwei`);
  console.log(`  txFee            : ${ethers.formatEther(gasUsed * gasPrice)} ETH`);
  console.log(`  txHash           : ${rc!.hash}`);
  console.log();
}

async function main() {
  const deployed = loadDeployed();
  const network = hre.network.name;

  console.log("=".repeat(60));
  console.log(`  DuoSwap / DuoLaunch Fee Analysis — ${network}`);
  console.log("=".repeat(60));
  console.log();

  const [deployer] = await ethers.getSigners();
  const ethBalance = await ethers.provider.getBalance(deployer.address);
  console.log(`  Signer : ${deployer.address}`);
  console.log(`  Balance: ${ethers.formatEther(ethBalance)} ETH`);
  console.log();

  // ── RPC check ──
  const blockNum = await ethers.provider.getBlockNumber();
  console.log(`  Network: ${network}, Block: ${blockNum}`);
  console.log();

  // ── Connect contracts ──
  const router = await ethers.getContractAt(ROUTER_IFACE, deployed.ROUTER);
  const factory = await ethers.getContractAt(FACTORY_IFACE, deployed.FACTORY);
  const wgas = deployed.WGAS;
  const pump = await ethers.getContractAt(PUMP_ABI, deployed.BONDING);

  // ──────────────────────────────────────────
  // Setup: deploy test ERC20 & create WETH pair
  // ──────────────────────────────────────────
  console.log("─".repeat(56));
  console.log("  SETUP — Deploy test token & create WETH pair");
  console.log("─".repeat(56));
  console.log();

  console.log("  Deploying TokenTemplate ERC20...");
  const TokenFactory = await ethers.getContractFactory("contracts/duoLaunch/TokenTemplate.sol:TokenTemplate");
  const testToken = await TokenFactory.deploy("FeeTest", "FEE", ethers.parseEther("1000000"), deployer.address);
  await testToken.waitForDeployment();
  const tokenAddr = await testToken.getAddress();
  console.log(`  Token: ${tokenAddr}`);
  console.log(`  Symbol: ${await testToken.symbol()}`);
  console.log(`  Supply: ${ethers.formatEther(await testToken.totalSupply())}`);
  console.log();

  // Check if WETH-token pair exists
  const existingPair = await factory.getPair(tokenAddr, wgas);
  const pairExists = existingPair !== ethers.ZeroAddress;
  console.log(`  WETH-token pair exists: ${pairExists}`);
  console.log();

  // Approve router for token spending
  const approveAmt = ethers.parseEther("1000");
  await (await testToken.approve(deployed.ROUTER, approveAmt)).wait();
  console.log(`  Approved router for ${ethers.formatEther(approveAmt)} tokens`);
  console.log();

  // ── 1. addLiquidityETH ──
  console.log("─".repeat(56));
  console.log("  1. addLiquidityETH");
  console.log("─".repeat(56));
  console.log();

  const liqTokenAmt = ethers.parseEther("100");
  const liqEthAmt = ethers.parseEther("0.1");

  const tx1 = await router.addLiquidityETH(
    tokenAddr, liqTokenAmt, 0n, 0n, deployer.address,
    (await ethers.provider.getBlock("latest"))!.timestamp + 3600,
    { value: liqEthAmt }
  );
  await printFee("1. addLiquidityETH", tx1);

  // Verify pair was created
  const pairAddr = await factory.getPair(tokenAddr, wgas);
  assert.notStrictEqual(pairAddr, ethers.ZeroAddress, "Pair should exist after addLiquidityETH");
  const pair = await ethers.getContractAt(PAIR_IFACE, pairAddr);
  const [r0, r1] = await pair.getReserves();
  console.log(`  Pair reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);
  console.log();

  // ── 2. swapExactETHForTokens ──
  console.log("─".repeat(56));
  console.log("  2. swapExactETHForTokens");
  console.log("─".repeat(56));
  console.log();

  const swapEthAmt = ethers.parseEther("0.01");
  const expectedOut = await router.getAmountsOut(swapEthAmt, [wgas, tokenAddr]);
  const minOut = expectedOut[1] * 99n / 100n;

  const tx2 = await router.swapExactETHForTokens(
    minOut, [wgas, tokenAddr], deployer.address,
    (await ethers.provider.getBlock("latest"))!.timestamp + 3600,
    { value: swapEthAmt, gasLimit: 500000 }
  );
  await printFee("2. swapExactETHForTokens", tx2);

  const tokenBalAfterSwap = await testToken.balanceOf(deployer.address);
  console.log(`  Token balance: ${ethers.formatEther(tokenBalAfterSwap)}`);
  console.log(`  Expected out : ${ethers.formatEther(expectedOut[1])}`);
  console.log();

  // ── 3. swapExactTokensForTokens ──
  console.log("─".repeat(56));
  console.log("  3. swapExactTokensForTokens (token → WETH)");
  console.log("─".repeat(56));
  console.log();

  const swapTokenAmt = ethers.parseEther("1");
  const expectedOut2 = await router.getAmountsOut(swapTokenAmt, [tokenAddr, wgas]);
  const minOut2 = expectedOut2[1] * 99n / 100n;

  // Check token balance and approve if needed
  const tokBal = await testToken.balanceOf(deployer.address);
  console.log(`  Token balance: ${ethers.formatEther(tokBal)}`);
  if (tokBal < swapTokenAmt) {
    console.log("  (skipping — insufficient token balance after previous ops)");
    console.log();
  } else {
    const tx3 = await router.swapExactTokensForTokens(
      swapTokenAmt, minOut2, [tokenAddr, wgas], deployer.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 3600,
      { gasLimit: 500000 }
    );
    await printFee("3. swapExactTokensForTokens", tx3);

    console.log(`  Expected WETH out: ${ethers.formatEther(expectedOut2[1])}`);
    console.log();
  }

  // ── 4. addLiquidity (tokenA = token, tokenB = WETH) ──
  console.log("─".repeat(56));
  console.log("  4. addLiquidity (token / WETH)");
  console.log("─".repeat(56));
  console.log();

  const wethContract = await ethers.getContractAt(WETH, wgas);
  const liqTokenAmt2 = ethers.parseEther("10");
  const liqWethAmt2 = ethers.parseEther("0.01");
  const curTokBal2 = await testToken.balanceOf(deployer.address);
  let curWethBal = await wethContract.balanceOf(deployer.address);
  if (curTokBal2 < liqTokenAmt2) {
    console.log("  (skipping — insufficient token balance)");
    console.log();
  } else {
    if (curWethBal < liqWethAmt2) {
      const wrapAmt = liqWethAmt2 - curWethBal;
      await (await wethContract.deposit({ value: wrapAmt })).wait();
      console.log(`  Wrapped ${ethers.formatEther(wrapAmt)} ETH → WETH`);
    }
    curWethBal = await wethContract.balanceOf(deployer.address);
    await (await wethContract.approve(deployed.ROUTER, curWethBal)).wait();
    await (await testToken.approve(deployed.ROUTER, liqTokenAmt2)).wait();
    const tx4 = await router.addLiquidity(
      tokenAddr, wgas,
      liqTokenAmt2, curWethBal, 0n, 0n,
      deployer.address,
      (await ethers.provider.getBlock("latest"))!.timestamp + 3600
    );
    await printFee("4. addLiquidity", tx4);

    const [r0b, r1b] = await pair.getReserves();
    console.log(`  Pair reserves: ${ethers.formatEther(r0b)} / ${ethers.formatEther(r1b)}`);
    console.log();
  }

  // ──────────────────────────────────────────
  //  Bonding Curve Operations
  // ──────────────────────────────────────────
  console.log("=".repeat(60));
  console.log("  BONDING CURVE OPERATIONS");
  console.log("=".repeat(60));
  console.log();

  // ── 5. createAndBuy ──
  console.log("─".repeat(56));
  console.log("  5. createAndBuy");
  console.log("─".repeat(56));
  console.log();

  const cbName = "FeeBonding";
  const cbSymbol = "FEEB";
  const cbBps = 8000;
  const cbTarget = ethers.parseEther("0.002");
  const cbBuyAmt = ethers.parseEther("0.001");

  const tx5 = await pump.createAndBuy(
    cbName, cbSymbol, cbBps, cbTarget, 0n, "", "", "", "",
    { value: cbBuyAmt }
  );
  await printFee("5. createAndBuy", tx5);

  // Extract token address from SaleCreated event
  const saleCreatedTopic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
  const pumpAddr = deployed.BONDING;
  const rc5 = await tx5.wait();
  const cbLog = rc5!.logs.find((l: any) =>
    l.topics[0] === saleCreatedTopic && l.address.toLowerCase() === pumpAddr.toLowerCase()
  );
  assert.ok(cbLog, "SaleCreated event expected");
  const pumpIface = new ethers.Interface(PUMP_ABI);
  const cbParsed = pumpIface.parseLog(cbLog);
  assert.ok(cbParsed);
  const bondingToken: string = cbParsed!.args.token;

  const cbTokenContract = await ethers.getContractAt(ERC20, bondingToken);
  const cbBal = await cbTokenContract.balanceOf(deployer.address);
  console.log(`  Token: ${bondingToken} (${await cbTokenContract.symbol()})`);
  console.log(`  Tokens received: ${ethers.formatEther(cbBal)}`);
  console.log();

  // ── 6. buy ──
  console.log("─".repeat(56));
  console.log("  6. buy");
  console.log("─".repeat(56));
  console.log();

  const buyAmt = ethers.parseEther("0.0005");
  const tx6 = await pump.buy(bondingToken, 0n, { value: buyAmt });
  await printFee("6. buy", tx6);

  const tokenBalAfterBuy = await cbTokenContract.balanceOf(deployer.address);
  const buyDelta = tokenBalAfterBuy - cbBal;
  console.log(`  In : ${ethers.formatEther(buyAmt)} ETH`);
  console.log(`  Out: ${ethers.formatEther(buyDelta)} tokens`);
  console.log(`  Total token balance: ${ethers.formatEther(tokenBalAfterBuy)}`);
  console.log();

  // ── 7. sell ──
  console.log("─".repeat(56));
  console.log("  7. sell");
  console.log("─".repeat(56));
  console.log();

  const sellAmt = tokenBalAfterBuy / 2n;
  if (sellAmt <= 0n) {
    console.log("  (skipping — no tokens to sell)");
    console.log();
  } else {
    await (await cbTokenContract.approve(pumpAddr, sellAmt)).wait();
    const tx7 = await pump.sell(bondingToken, sellAmt, 0n);
    await printFee("7. sell", tx7);

    const tokenBalAfterSell = await cbTokenContract.balanceOf(deployer.address);
    console.log(`  In : ${ethers.formatEther(sellAmt)} tokens`);
    console.log(`  Remaining tokens: ${ethers.formatEther(tokenBalAfterSell)}`);
    console.log();
  }

  console.log("=".repeat(60));
  console.log("  Fee analysis complete");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ Fee test failed:", err.message ?? err);
    process.exit(1);
  });
