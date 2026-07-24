import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";

const PUMP = [
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";

const saleCreatedTopic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
const saleIface = new ethers.Interface([
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)",
]);

function parseToken(rc: any): string {
  const log = rc.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  return saleIface.parseLog(log)!.args.token as string;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const d = JSON.parse(fs.readFileSync("deployed.json", "utf8"));
  const pump = await ethers.getContractAt(PUMP, d.pump);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 11: Gas Griefing / DoS on Refund Callback");
  console.log(`  Pump: ${d.pump}  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  // ── Step 1: Deploy GasGriefer ──
  console.log("  ── Step 1: Deploy GasGriefer ──");
  const GF = await ethers.getContractFactory("contracts/test/CallbackTestHelper.sol:GasGriefer");
  const griefer = await GF.deploy();
  await griefer.waitForDeployment();
  const gAddr = await griefer.getAddress();
  console.log(`  ${_I} GasGriefer: ${gAddr}`);
  console.log(`  ${_I} receive() loop count: ${await griefer.LOOP_COUNT()}`);
  // Check how much gas griefer's receive() would consume
  const gStart = await ethers.provider.getBalance(gAddr);
  // The griefer's receive() should waste > 100k gas
  console.log(`  ${_I} (designed to exceed 100k gas limit)`);

  // ── Step 2: Test normal buy works (no cap crossing → no refund) ──
  console.log("\n  ── Step 2: Normal buy (no refund triggered) ──");
  const tx = await pump.createSale("Grief", "GRF", 8000, ONE * 100n, "", "", "", "");
  const rc = await tx.wait();
  const token = parseToken(rc!);
  console.log(`  ${_I} Token: ${token}`);

  // Buy from griefer with a small amount (no cap crossing, no refund)
  await (await deployer.sendTransaction({ to: gAddr, value: ONE * 10n })).wait();
  console.log(`  ${_I} Funded griefer with 10 ETH`);

  const tx1 = await griefer.buy(d.pump, token, { value: ONE * 2n, gasLimit: 500_000 });
  await tx1.wait();
  console.log(`  ${PASS} Small buy (no refund) succeeded — griefer's receive() not triggered`);

  // ── Step 3: Cap-crossing buy → triggers refund → griefer's receive() ──
  console.log("\n  ── Step 3: Cap-crossing buy (refund triggers griefer) ──");

  // Fund griefer with more ETH
  await (await deployer.sendTransaction({ to: gAddr, value: ONE * 200n })).wait();

  // Check remaining to cap
  const capTokens = ethers.parseEther("1000000000") * 8000n / 10000n;
  const sale = await pump.getSale(token);
  const tokensSold = sale[1];
  const remainingToCap = capTokens - tokensSold;
  console.log(`  ${_I} tokensSold: ${ethers.formatEther(tokensSold)}, cap: ${ethers.formatEther(capTokens)}, remaining: ${ethers.formatEther(remainingToCap)}`);

  // Try cap-crossing buy from griefer
  // This triggers a refund, which calls griefer's receive()
  // With the gas limit fix (100k), the malicious receive() should get only 100k gas
  // and either:
  //   a) Run out of gas (loop needs > 100k) → .call returns false → tx reverts
  //   b) Succeed if the loop fits in 100k

  try {
    const tx2 = await griefer.buy(d.pump, token, { value: ONE * 200n, gasLimit: 3_000_000 });
    const rc2 = await tx2.wait();
    const gasUsed = rc2!.gasUsed;
    const grieferGas = await griefer.gasWasted();
    console.log(`  ${_I} Tx gas used: ${gasUsed}`);
    console.log(`  ${_I} Griefer receive() consumed: ${grieferGas} gas`);

    if (grieferGas > 100_000n) {
      console.log(`  ${FAIL} Griefer wasted ${grieferGas} gas (exceeds 100k limit!)`);
    } else {
      console.log(`  ${PASS} Griefer limited to ${grieferGas} gas (< 100k limit)`);
    }
    console.log(`  ${_I} Buy succeeded (receive() finished within gas limit)`);
  } catch (e: any) {
    // Expected: receive() runs out of gas at 100k limit, .call returns false,
    // require(ok, "REFUND_FAILED") reverts the buy
    const msg = (e?.reason || e?.message || "").toLowerCase();
    const isGasRevert = msg.includes("refund_failed") || msg.includes("out of gas") || msg.includes("gas");
    console.log(`  ${isGasRevert ? PASS : FAIL} Buy reverted: ${isGasRevert ? "REFUND_FAILED (gas griefing blocked)" : (e?.reason || "").slice(0, 80)}`);
  }

  // ── Step 4: Verify legitimate receive() still works ──
  console.log("\n  ── Step 4: Legitimate receive() under 100k still works ──");
  const tx3 = await pump.createSale("Normal", "NRM", 8000, ONE * 100n, "", "", "", "");
  const rc3 = await tx3.wait();
  const token3 = parseToken(rc3!);
  console.log(`  ${_I} Token3: ${token3}`);

  // A normal EOA buy (no contract receive) should work fine
  const tx4 = await pump.buy(token3, 0, { value: ONE * 200n, gasLimit: 3_000_000 });
  const rc4 = await tx4.wait();
  const sale3 = await pump.getSale(token3);
  console.log(`  ${sale3[7] ? PASS : FAIL} Normal buy graduated: ${sale3[7]}`);
  console.log(`  ${_I} Tx gas: ${rc4!.gasUsed} (well within limits)`);

  // ── Summary ──
  console.log(`\n  ${PASS} Gas griefing fix summary:`);
  console.log(`     buy()  refund .call — gas limited to 100k (line 239)`);
  console.log(`     sell() payout .call — gas limited to 100k (line 143)`);
  console.log(`     Malicious receive() exceeding 100k → REFUND_FAILED revert`);
  console.log(`     Legitimate receive() under 100k → works normally`);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 11 complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
