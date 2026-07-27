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
  const tokenAddr = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";

  const code = await ethers.provider.getCode(wgas);
  console.log("WETH code length:", code.length);

  const WETH = [ "function symbol() view returns (string)" ];
  const w = await ethers.getContractAt(WETH, wgas);
  try { console.log("WETH symbol:", await w.symbol()); } catch (e: any) { console.log("WETH error:", e.message.slice(0,200)); }

  const pairAddr = await factory.getPair(tokenAddr, wgas);
  console.log("Pair:", pairAddr);
  if (pairAddr !== ethers.ZeroAddress) {
    const pair = await ethers.getContractAt("contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair", pairAddr);
    const [r0, r1] = await pair.getReserves();
    console.log("Reserves:", ethers.formatEther(r0), ethers.formatEther(r1));
  }

  const swapEthAmt = ethers.parseEther("0.01");
  try {
    const amounts = await router.getAmountsOut(swapEthAmt, [wgas, tokenAddr]);
    console.log("getAmountsOut:", amounts.map((a: any) => ethers.formatEther(a)));
  } catch (e: any) {
    console.log("getAmountsOut failed:", e.message.slice(0,300));
  }

  const dt = Math.floor(Date.now() / 1000) + 3600;
  const amounts2 = await router.getAmountsOut(swapEthAmt, [wgas, tokenAddr]);
  const minOut = amounts2[1] * 99n / 100n;
  try {
    await router.swapExactETHForTokens.staticCall(minOut, [wgas, tokenAddr], deployer.address, dt, { value: swapEthAmt });
    console.log("staticCall succeeded");
  } catch (e: any) {
    console.log("staticCall revert:", e.message.slice(0,600));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
