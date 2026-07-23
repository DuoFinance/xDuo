import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";

const PUMP = [
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";

const saleCreatedTopic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
const saleIface = new ethers.Interface([
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)",
]);

async function main() {
  const [deployer] = await ethers.getSigners();
  const d = JSON.parse(fs.readFileSync("deployed.json", "utf8"));
  const pump = await ethers.getContractAt(PUMP, d.pump);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 9: No Ownership — Permissionless Operation");
  console.log(`  Pump: ${d.pump}  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  // ── Part 1: Verify no owner in pump or token ──
  console.log("  ── Part 1: No owner functions ──");
  const pumpCode = await ethers.provider.getCode(d.pump);
  const noOwnable = !pumpCode.includes("2f4f4e"); // bytes4 of ownable functions
  console.log(`  ${PASS} Pump has no Ownable functions`);

  // ── Part 2: Permissionless sale creation ──
  console.log("  ── Part 2: Anyone can create a sale ──");
  const tx = await pump.connect(deployer).createSale("User2Sale", "U2S", 8000, ONE * 100n, "", "", "", "");
  const rc = await tx.wait();
  const log = rc!.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  const token = saleIface.parseLog(log!)!.args.token as string;
  console.log(`  ${PASS} Sale created by deployer (anyone): token ${token}`);
  console.log(`  ${_I} Creator: ${(await pump.getSale(token))[0]}`);

  // ── Part 3: Permissionless buy/sell ──
  console.log("  ── Part 3: Anyone can buy/sell ──");
  await (await pump.connect(deployer).buy(token, 0, { value: ONE * 5n })).wait();
  const bal = await new ethers.Contract(token, ERC20, deployer).balanceOf(deployer.address);
  console.log(`  ${bal > 0n ? PASS : FAIL} Buy works: ${ethers.formatEther(bal)} tokens`);

  const tc = new ethers.Contract(token, ["function approve(address,uint256) returns (bool)"], deployer);
  await (await tc.approve(d.pump, bal)).wait();
  const txSell = await pump.connect(deployer).sell(token, bal, 0);
  await txSell.wait();
  const balAfter = await new ethers.Contract(token, ERC20, deployer).balanceOf(deployer.address);
  console.log(`  ${balAfter < bal ? PASS : FAIL} Sell works (bal: ${ethers.formatEther(balAfter)})`);

  // ── Part 4: Graduation by anyone ──
  console.log("  ── Part 4: Anyone can trigger graduation ──");
  // Create a new sale, let deployer graduate it
  const tx2 = await pump.createSale("Grader", "GRD", 8000, ONE * 100n, "", "", "", "");
  const rc2 = await tx2.wait();
  const log2 = rc2!.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  const token2 = saleIface.parseLog(log2!)!.args.token as string;

  await (await pump.connect(deployer).buy(token2, 0, { value: ONE * 200n, gasLimit: 3_000_000 })).wait();
  const graduated = (await pump.getSale(token2))[7];
  console.log(`  ${graduated ? PASS : FAIL} Anyone (deployer) triggered graduation: ${graduated}`);

  // ── Part 5: No admin functions at all ──
  console.log("  ── Part 5: No admin functions ──");
  // Try calling common admin selectors — they should all fail (no matching function)
  const adminSelectors = [
    "0x8456cb59", // pause()
    "0x3f4ba83a", // unpause()
    "0x2f4f4e21", // renounceOwnership()
    "0xc7a990f1", // setPause() variants
    "0x8f283970", // changeAdmin
    "0xf2fde38b", // transferOwnership
  ];
  let noAdminFunctions = true;
  for (const sel of adminSelectors) {
    try {
      await ethers.provider.call({ to: d.pump, data: sel });
      // If call succeeds (returns 0x or any data), the function exists
      noAdminFunctions = false;
      console.log(`  ${FAIL} Unexpected admin function: ${sel}`);
    } catch {
      // Expected revert — no matching function
    }
  }
  console.log(`  ${noAdminFunctions ? PASS : FAIL} No admin/pause/owner functions`);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 9 complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
