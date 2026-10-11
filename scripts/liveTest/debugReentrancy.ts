import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import path from "path";
import { loadDeployed } from "./addresses";

const PUMP_ABI = [
  "function buy(address,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function uniswapFactory() view returns (address)",
  "function weth() view returns (address)",
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"];
const ONE = ethers.parseEther("1");

async function getPump() {
  const d = loadDeployed();
  return {
    pump: await ethers.getContractAt(PUMP_ABI, d.BONDING),
    pumpAddr: d.BONDING,
    factoryAddr: d.FACTORY,
    wgasAddr: d.WGAS,
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const { pump, pumpAddr } = await getPump();

  // Create a fresh sale
  const tx = await pump.createSale("Dbg", "DBG", 8000, ONE * 100n, "", "", "", "");
  const rc = await tx.wait();
  const topic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
  const log = rc!.logs.find((l: any) => l.topics[0] === topic);
  const iface = new ethers.Interface(["event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)"]);
  const token = iface.parseLog(log!)!.args.token as string;
  console.log("Token:", token);

  // Deploy the test helper
  const T = await ethers.getContractFactory("contracts/DebugSellReentrant.sol:DebugSellReentrant");
  const t = await T.connect(deployer).deploy(pumpAddr, token);
  await t.waitForDeployment();
  const tAddr = await t.getAddress();
  console.log("Helper:", tAddr);

  // Buy tokens first (pump → deployer)
  const buyTx1 = await pump.buy(token, 0, { value: ONE * 50n, gasLimit: 3_000_000 });
  await buyTx1.wait();
  const tokenC = new ethers.Contract(token, ERC20, deployer);
  const deployerBal = await tokenC.balanceOf(deployer.address);
  console.log("Deployer token balance:", ethers.formatEther(deployerBal));

  // Transfer tokens to helper
  await tokenC.transfer(tAddr, deployerBal);
  const helperTokenBal = await tokenC.balanceOf(tAddr);
  console.log("Helper token balance:", ethers.formatEther(helperTokenBal));

  // Fund helper with ETH (for the buy callback value)
  await deployer.sendTransaction({ to: tAddr, value: ONE * 60n });
  console.log("Helper ETH balance:", ethers.formatEther(await ethers.provider.getBalance(tAddr)));

  // Trigger sell: helper calls pump.sell(), pump sends ETH back → helper.receive() → helper calls pump.buy()
  // The buy is guarded by nonReentrant - should fail
  const triggerTx = await t.trigger(helperTokenBal, 0, { gasLimit: 5_000_000 });
  const triggerRc = await triggerTx.wait();

  const cb = await t.callbackTriggered();
  const okBuy = await t.okBuy();
  const okSell = await t.okSell();
  const buyRet = await t.buyRetData();
  const sellRet = await t.sellRetData();

  console.log("\nResults:");
  console.log("  callbackTriggered:", cb);
  console.log("  okBuy:", okBuy);
  console.log("  okSell:", okSell);
  console.log("  buyRetData:", buyRet);
  console.log("  sellRetData:", sellRet);

  // Parse revert reasons
  try {
    const buyErr = new ethers.Interface(["error ReentrancyGuardReentrantCall()"]);
    const decoded = buyErr.parseError(buyRet);
    console.log("  buy revert reason:", decoded?.name || "unknown");
  } catch { console.log("  buy retData is not a standard error"); }

  try {
    const sellErr = new ethers.Interface(["error ReentrancyGuardReentrantCall()", "error SaleGraduated()"]);
    const decoded = sellErr.parseError(sellRet);
    console.log("  sell revert reason:", decoded?.name || "unknown");
  } catch { console.log("  sell retData is not a standard error"); }

  // Check pump's nonReentrant status directly
  console.log("\nSale state after trigger:");
  const sale = await pump.getSale(token);
  console.log("  tokensSold:", ethers.formatEther(sale.tokensSold));
  console.log("  GASRaised:", ethers.formatEther(sale.GASRaised));
  console.log("  graduated:", sale.graduated);
  console.log("Helper ETH after:", ethers.formatEther(await ethers.provider.getBalance(tAddr)));
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
