import { ethers } from "hardhat";

async function main() {
  const [d] = await ethers.getSigners();

  // Deploy
  const weth = await (await ethers.getContractFactory("contracts/Weth9.sol:WETH9")).deploy();
  const factory = await (await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory")).deploy(d.address);
  const router = await (await ethers.getContractFactory("contracts/UniswapV2Router02.sol:UniswapV2Router02")).deploy(await factory.getAddress(), await weth.getAddress());
  const pump = await (await ethers.getContractFactory("contracts/pump/Pump.sol:Pump")).deploy(await router.getAddress());
  await Promise.all([weth, factory, router, pump].map(c => c.waitForDeployment()));

  console.log("weth:", await weth.getAddress());
  console.log("factory:", await factory.getAddress());
  console.log("router:", await router.getAddress());
  console.log("pump:", await pump.getAddress());

  // Create sale
  const tx0 = await pump.createSale("T", "T", 8000);
  const r0 = await tx0.wait();
  let t = "";
  const iface = new ethers.Interface(["event SaleCreated(address indexed creator, address indexed token, string name, string symbol)"]);
  for (const l of r0!.logs) try { const p = iface.parseLog(l); if (p?.name === "SaleCreated") t = p.args.token as string; } catch {}
  console.log("token:", t);

  const token = new ethers.Contract(t, [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], d);

  // Buy 600
  const bi = new ethers.Interface(["function buy(address,uint256) payable"]);
  let b = bi.encodeFunctionData("buy", [t, 0n]);
  let tx = await d.sendTransaction({ to: await pump.getAddress(), data: b, value: ethers.parseEther("600"), gasLimit: 400000 });
  let r = await tx.wait();
  console.log("Buy 600:", r?.status);

  let gs = await pump.getSale(t);
  console.log("  gasRaised:", ethers.formatEther(gs[3]), "/", ethers.formatEther(gs[4]));

  // Buy 500 — will trigger graduation, catch error
  b = bi.encodeFunctionData("buy", [t, 0n]);
  console.log("\nTrying second buy (should graduate)...");
  
  // Static call to get revert reason
  try {
    await ethers.provider.call({
      from: d.address,
      to: await pump.getAddress(),
      data: b,
      value: ethers.parseEther("500"),
    });
    console.log("Static call SUCCEEDED (unexpected)");
  } catch (e2: any) {
    console.log("Static call reverted:");
    console.log("  reason:", e2?.reason);
    console.log("  message:", e2?.message?.slice(0, 200));
    const data = e2?.data || e2?.info?.error?.data || e2?.error?.data || e2?.info?.data;
    if (data) {
      console.log("  data:", typeof data === 'string' ? data.slice(0, 100) : JSON.stringify(data).slice(0,100));
    }
    // Try to decode revert string
    const rdata = e2?.data?.data || e2?.data;
    if (rdata && typeof rdata === 'string' && rdata.length > 10) {
      try { console.log("  decoded:", ethers.toUtf8String("0x" + rdata.slice(138))); } catch {}
    }
  }

  // Try to call graduate directly
  console.log("\nTrying graduate() directly...");
  try {
    await ethers.provider.call({
      from: d.address,
      to: await pump.getAddress(),
      data: new ethers.Interface(["function graduate(address)"]).encodeFunctionData("graduate", [t]),
    });
    console.log("graduate SUCCEEDED");
  } catch (e2: any) {
    console.log("graduate reverted:");
    console.log("  reason:", e2?.reason);
    console.log("  message:", e2?.message?.slice(0, 200));
    const data = e2?.data || e2?.info?.error?.data || e2?.error?.data || e2?.info?.data;
    if (data) {
      console.log("  data:", typeof data === 'string' ? data.slice(0, 100) : JSON.stringify(data).slice(0,100));
    }
  }

  // Try addLiquidityETH directly
  const pumpBal = await token.balanceOf(await pump.getAddress());
  const pumpEth = await ethers.provider.getBalance(await pump.getAddress());
  console.log("\npump tokens:", ethers.formatEther(pumpBal), "pump ETH:", ethers.formatEther(pumpEth));
  
  // Check if pair exists
  const pair = await factory.getPair(t, await weth.getAddress());
  console.log("existing pair:", pair);

  // Approve router
  await token.approve(await router.getAddress(), pumpBal);
  console.log("\nTrying addLiquidityETH directly...");
  try {
    await ethers.provider.call({
      from: d.address,
      to: await router.getAddress(),
      data: new ethers.Interface([
        "function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)"
      ]).encodeFunctionData("addLiquidityETH", [
        t, pumpBal, pumpBal, ethers.parseEther("0.01"), d.address, Math.floor(Date.now() / 1000) + 3600
      ]),
      value: pumpEth,
    });
    console.log("addLiquidityETH SUCCEEDED");
  } catch (e2: any) {
    console.log("addLiquidityETH reverted:");
    console.log("  reason:", e2?.reason);
    console.log("  message:", e2?.message?.slice(0, 300));
    const data = e2?.data || e2?.info?.error?.data || e2?.error?.data || e2?.info?.data;
    if (data) {
      console.log("  data:", typeof data === 'string' ? data.slice(0, 100) : "");
    }
    try { console.log("  decoded:", ethers.toUtf8String("0x" + (data?.slice(138) || ""))); } catch {}
  }
}

main().catch(e => { console.error("FATAL:", e?.message?.slice(0,200)); process.exit(1); });
