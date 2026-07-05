import { ethers } from "hardhat";

async function main() {
  const [s] = await ethers.getSigners();
  console.log("signer:", s.address);

  const RG = await ethers.getContractFactory("contracts/test/MaliciousHelper.sol:RefundGriefer");
  const g = await RG.connect(s).deploy();
  await g.waitForDeployment();
  const ga = await g.getAddress();
  console.log("griefer:", ga);
  console.log("rejectEther:", (await g.rejectEther()).toString());
  console.log("code len:", (await ethers.provider.getCode(ga)).length);

  // Test 1: send ETH with call (should revert)
  console.log("\n--- Test 1: sendTransaction with value ---");
  try {
    const tx = await s.sendTransaction({ to: ga, value: 1n, gasLimit: 50000 });
    const r = await tx.wait();
    console.log("TX status:", r?.status, "(expected: 0 = revert)");
    console.log("griefer balance:", (await ethers.provider.getBalance(ga)).toString());
  } catch(e: any) {
    console.log("TX reverted:", e?.reason || e?.message?.slice(0, 100));
  }

  // Test 2: call with wallet (no revert in receive)
  await g.setReject(false);
  console.log("\n--- Test 2: set reject=false, send 1 ETH ---");
  try {
    const tx2 = await s.sendTransaction({ to: ga, value: 1n, gasLimit: 50000 });
    const r2 = await tx2.wait();
    console.log("TX status:", r2?.status, "(expected: 1 = success)");
  } catch(e: any) {
    console.log("TX reverted:", e?.reason || e?.message?.slice(0, 100));
  }

  // Test 3: check balance
  console.log("\n--- Final state ---");
  console.log("griefer balance:", (await ethers.provider.getBalance(ga)).toString());
  console.log("rejectEther:", (await g.rejectEther()).toString());
}

main().catch(console.error);
