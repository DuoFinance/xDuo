import { ethers } from "hardhat";

async function main() {
  const [s] = await ethers.getSigners();
  const PK1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const attacker = new ethers.Wallet(PK1, ethers.provider);

  console.log("deployer nonce:", await ethers.provider.getTransactionCount(s.address));
  console.log("attacker nonce:", await ethers.provider.getTransactionCount(attacker.address));

  // Simulate attackPump.ts deploys
  const F = await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory");
  const f = await F.connect(s).deploy(s.address); await f.waitForDeployment();
  const W = await ethers.getContractFactory("contracts/Weth9.sol:WETH9");
  const w = await W.connect(s).deploy(); await w.waitForDeployment();
  const R = await ethers.getContractFactory("contracts/UniswapV2Router02.sol:UniswapV2Router02");
  const r = await R.connect(s).deploy(await f.getAddress(), await w.getAddress()); await r.waitForDeployment();
  const P = await ethers.getContractFactory("Pump");
  const pump = await P.connect(s).deploy(await r.getAddress()); await pump.waitForDeployment();

  // Now deploy as attacker (same as attackPump.ts flow)
  const RA = await ethers.getContractFactory("contracts/test/MaliciousHelper.sol:ReentrancyAttacker");
  const reenter = await RA.connect(attacker).deploy(await pump.getAddress(), await f.getAddress());
  await reenter.waitForDeployment();

  const RG = await ethers.getContractFactory("contracts/test/MaliciousHelper.sol:RefundGriefer");
  const griefer = await RG.connect(attacker).deploy();
  await griefer.waitForDeployment();
  const ga = await griefer.getAddress();

  console.log("\ngriefer address:", ga);
  console.log("deployer nonces:", await ethers.provider.getTransactionCount(s.address), "attacker:", await ethers.provider.getTransactionCount(attacker.address));
  const code = await ethers.provider.getCode(ga);
  console.log("griefer code len:", code.length);
  console.log("griefer code prefix:", code.slice(0, 20));
  console.log("griefer rejectEther:", (await griefer.rejectEther()).toString());

  // Try sending ETH
  console.log("\n--- Send 1 wei to griefer ---");
  try {
    const tx = await attacker.sendTransaction({ to: ga, value: 1n, gasLimit: 50000 });
    const r2 = await tx.wait();
    console.log("TX status:", r2?.status, "(0=revert expected)");
    console.log("griefer balance:", (await ethers.provider.getBalance(ga)).toString());
  } catch(e: any) {
    console.log("TX reverted:", e?.reason || e?.message?.slice(0, 100));
  }
}

main().catch(console.error);
