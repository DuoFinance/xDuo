import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const WETH = await ethers.getContractFactory("contracts/Weth9.sol:WETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const Factory = await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory");
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();

  const Router = await ethers.getContractFactory("contracts/UniswapV2Router02.sol:UniswapV2Router02");
  const router = await Router.deploy(await factory.getAddress(), await weth.getAddress());
  await router.waitForDeployment();

  const Pump = await ethers.getContractFactory("contracts/pump/Pump.sol:Pump");
  const pump = await Pump.deploy(await router.getAddress());
  await pump.waitForDeployment();

  console.log("Factory:", await factory.getAddress());
  console.log("WETH:", await weth.getAddress());
  console.log("Router:", await router.getAddress());
  console.log("Pump:", await pump.getAddress());

  // Create sale
  const tx0 = await pump.connect(deployer).createSale("Test", "TST", 8000);
  const r0 = await tx0.wait();
  let tokenAddr = "";
  for (const l of r0!.logs) {
    try {
      const p = new ethers.Interface(["event SaleCreated(address indexed creator, address indexed token, string name, string symbol)"]).parseLog(l);
      if (p?.name === "SaleCreated") tokenAddr = p.args.token as string;
    } catch {}
  }
  console.log("Token:", tokenAddr);

  // Buy enough to graduate
  const buyIface = new ethers.Interface(["function buy(address,uint256) payable returns (uint256)"]);
  // Buy 600 ETH first, then more
  const bd1 = buyIface.encodeFunctionData("buy", [tokenAddr, 0n]);
  const tx1 = await deployer.sendTransaction({ to: await pump.getAddress(), data: bd1, value: ethers.parseEther("600"), gasLimit: 300000 });
  const r1 = await tx1.wait();
  console.log("Buy 600 status:", r1?.status);

  const gs = await pump.getSale(tokenAddr);
  console.log("gasRaised:", ethers.formatEther(gs[3]), "target:", ethers.formatEther(gs[4]));

  // Buy 500 more
  const bd2 = buyIface.encodeFunctionData("buy", [tokenAddr, 0n]);
  const tx2 = await deployer.sendTransaction({ to: await pump.getAddress(), data: bd2, value: ethers.parseEther("500"), gasLimit: 300000 });
  const r2 = await tx2.wait();
  console.log("Buy 500 status:", r2?.status);

  const gs2 = await pump.getSale(tokenAddr);
  console.log("gasRaised:", ethers.formatEther(gs2[3]), "target:", ethers.formatEther(gs2[4]));

  // Try to graduate
  console.log("\n--- Trying graduate() ---");
  try {
    const gtx = await pump.graduate(tokenAddr, { gasLimit: 500000 });
    const gr = await gtx.wait();
    console.log("graduate status:", gr?.status);
    const gs3 = await pump.getSale(tokenAddr);
    console.log("graduated:", gs3[8]);
  } catch (e: any) {
    console.log("graduate threw (tx send)");
    // Try static call for revert reason
    try {
      await ethers.provider.call({
        to: await pump.getAddress(),
        data: new ethers.Interface(["function graduate(address)"]).encodeFunctionData("graduate", [tokenAddr]),
        from: deployer.address,
      }, 0n);
    } catch (e2: any) {
      console.log("Revert reason:", e2?.reason || e2?.message?.slice(0,200) || "unknown");
      // Try to decode the revert data
      const data = e2?.data || e2?.info?.error?.data || e2?.error?.data;
      if (data) {
        try {
          const reason = ethers.toUtf8String("0x" + data.slice(138));
          console.log("Decoded:", reason);
        } catch {}
      }
    }
  }

  // Also try addLiquidityETH directly
  console.log("\n--- Trying addLiquidityETH directly ---");
  const token = new ethers.Contract(tokenAddr, ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], deployer);
  const pumpBal = await token.balanceOf(await pump.getAddress());
  const pumpEth = await ethers.provider.getBalance(await pump.getAddress());
  console.log("Pump token balance:", ethers.formatEther(pumpBal));
  console.log("Pump ETH balance:", ethers.formatEther(pumpEth));

  // Transfer all tokens to deployer (simulate what Pump would do)
  // Actually, let's just try manually
  await token.approve(await router.getAddress(), pumpBal);
  try {
    const ltx = await router.addLiquidityETH(
      tokenAddr, pumpBal, pumpBal, ethers.parseEther("0.01"),
      deployer.address,
      Math.floor(Date.now() / 1000) + 3600,
      { value: pumpEth, gasLimit: 500000 }
    );
    const lr = await ltx.wait();
    console.log("addLiquidityETH status:", lr?.status);
    console.log("✅ Direct addLiquidityETH worked!");
  } catch (e: any) {
    try {
      await ethers.provider.call({
        to: await router.getAddress(),
        data: new ethers.Interface(["function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)"]).encodeFunctionData("addLiquidityETH", [tokenAddr, pumpBal, pumpBal, ethers.parseEther("0.01"), deployer.address, Math.floor(Date.now() / 1000) + 3600]),
        from: deployer.address,
        value: pumpEth
      });
    } catch (e2: any) {
      console.log("Revert reason:", e2?.reason || e2?.message?.slice(0,200) || "unknown");
      const data = e2?.data || e2?.info?.error?.data || e2?.error?.data;
      if (data && typeof data === 'string') {
        try {
          const reason = ethers.toUtf8String("0x" + data.slice(138));
          console.log("Decoded:", reason);
        } catch {}
      }
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
