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

  const TokenFactory = await ethers.getContractFactory("contracts/duoLaunch/TokenTemplate.sol:TokenTemplate");
  const token = await TokenFactory.deploy("Test", "TST", ethers.parseEther("1000000"), deployer.address);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  await (await token.approve(deployed.router, ethers.parseEther("1000"))).wait();

  const latest = await ethers.provider.getBlock("latest");
  const dt2 = latest!.timestamp + 3600;

  const tx1 = await router.addLiquidityETH(
    tokenAddr, ethers.parseEther("100"), 0n, 0n, deployer.address, dt2,
    { value: ethers.parseEther("0.1") }
  );
  const rc1 = await tx1.wait();
  console.log("addLiquidityETH status=", rc1!.status);

  // Manual swap step by step
  const swapAmt = ethers.parseEther("0.01");
  const amounts = await router.getAmountsOut(swapAmt, [wgas, tokenAddr]);
  const minOut = amounts[1] * 99n / 100n;

  // Test 1: staticCall
  try {
    await router.swapExactETHForTokens.staticCall(minOut, [wgas, tokenAddr], deployer.address, dt2, { value: swapAmt });
    console.log("staticCall: OK");
  } catch (e: any) { console.log("staticCall:", e.message.slice(0,200)); }

  // Test 2: encode and provider.call to get raw revert reason
  const routerIface = new ethers.Interface([
    "function swapExactETHForTokens(uint,address[],address,uint) payable returns (uint[])"
  ]);
  const encData = routerIface.encodeFunctionData("swapExactETHForTokens", [minOut, [wgas, tokenAddr], deployer.address, dt2]);
  try {
    await ethers.provider.call({ from: deployer.address, to: deployed.router, data: encData, value: swapAmt, blockTag: "pending" });
    console.log("provider.call: OK");
  } catch (e: any) {
    const msg = e.message || "";
    // Extract revert reason from error
    const idx = msg.indexOf("reverted with reason string ");
    if (idx >= 0) {
      console.log("provider.call revert reason:", msg.slice(idx + 28, idx + 100));
    } else {
      try { const d = JSON.parse(msg.slice(msg.indexOf("{"))); console.log("data:", d?.data?.slice(0,100)); } catch {}
      console.log("provider.call failed:", msg.slice(0,300));
    }
  }

  // Test 3: try sending with very high gas limit
  try {
    const tx2 = await router.swapExactETHForTokens(minOut, [wgas, tokenAddr], deployer.address, dt2, {
      value: swapAmt, gasLimit: 500000
    });
    const rc2 = await tx2.wait();
    console.log("send: status=", rc2!.status);
  } catch (e: any) {
    console.log("send failed, status:", e.receipt?.status);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
