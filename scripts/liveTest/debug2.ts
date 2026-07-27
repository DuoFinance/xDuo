import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import path from "path";

async function main() {
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "deployed.json"), "utf8"));
  const [deployer] = await ethers.getSigners();

  const router = await ethers.getContractAt("contracts/interfaces/IUniswapV2Router02.sol:IUniswapV2Router02", deployed.router);
  const factory = await ethers.getContractAt("contracts/interfaces/IUniswapV2Factory.sol:IUniswapV2Factory", deployed.factory);
  const wgas = deployed.wgas;

  // Need to create a token + pair first
  const TokenFactory = await ethers.getContractFactory("contracts/duoLaunch/TokenTemplate.sol:TokenTemplate");
  const token = await TokenFactory.deploy("Test", "TST", ethers.parseEther("1000000"), deployer.address);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("Token:", tokenAddr);

  await (await token.approve(deployed.router, ethers.parseEther("1000"))).wait();

  const dt = Math.floor(Date.now() / 1000) + 3600;
  const tx1 = await router.addLiquidityETH(
    tokenAddr, ethers.parseEther("100"), 0n, 0n, deployer.address, dt,
    { value: ethers.parseEther("0.1") }
  );
  const rc1 = await tx1.wait();
  console.log("addLiquidityETH: gasUsed=", rc1!.gasUsed, "status=", rc1!.status);

  const pairAddr = await factory.getPair(tokenAddr, wgas);
  console.log("Pair:", pairAddr);

  // Try swapExactETHForTokens step by step
  const swapAmt = ethers.parseEther("0.01");

  // Step 1: deposit to WGAS
  const wgasContract = await ethers.getContractAt([
    "function deposit() payable",
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ], wgas);

  console.log("WGAS symbol:", await wgasContract.symbol());
  console.log("WGAS decimals:", await wgasContract.decimals());

  const routerAddr = deployed.router;

  // Manually deposit to WGAS from router's perspective
  // First check router WGAS balance before
  const balBeforeWGAS = await wgasContract.balanceOf(routerAddr);
  console.log("Router WGAS balance before:", balBeforeWGAS.toString());

  // Try to call deposit via router
  const amounts = await router.getAmountsOut(swapAmt, [wgas, tokenAddr]);
  console.log("Amounts out:", amounts.map((a:any) => ethers.formatEther(a)));

  // Simulate the deposit call
  try {
    const iface = new ethers.Interface(["function deposit() payable"]);
    const data = iface.encodeFunctionData("deposit");
    const sim = await ethers.provider.call({
      to: wgas,
      data: data,
      value: amounts[0],
      from: routerAddr,
    });
    console.log("Deposit simulation result:", sim);
  } catch (e: any) {
    console.log("Deposit simulation failed:", e.message.slice(0, 300));
  }

  // Check WGAS balance of router after (note: call doesn't change state)
  const balAfterWGAS = await wgasContract.balanceOf(routerAddr);
  console.log("Router WGAS balance after:", balAfterWGAS.toString());

  // Try full swap with staticCall
  try {
    await router.swapExactETHForTokens.staticCall(
      amounts[1] * 99n / 100n, [wgas, tokenAddr], deployer.address, dt,
      { value: swapAmt }
    );
    console.log("swapExactETHForTokens staticCall: OK");
  } catch (e: any) {
    console.log("swapExactETHForTokens staticCall FAILED:", e.message.slice(0,500));
  }

  // Try FULL send
  try {
    const tx = await router.swapExactETHForTokens(
      amounts[1] * 99n / 100n, [wgas, tokenAddr], deployer.address, dt,
      { value: swapAmt }
    );
    const rc = await tx.wait();
    console.log("swapExactETHForTokens send: OK status=", rc!.status, "gas=", rc!.gasUsed);
  } catch (e: any) {
    console.log("swapExactETHForTokens send FAILED:", e.message.slice(0,500));
    if (e.receipt) console.log("receipt status:", e.receipt.status);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
