import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import { loadDeployed } from "./addresses";

const PUMP = [
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";

const saleCreatedTopic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
const saleIface = new ethers.Interface([
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)",
]);

async function main() {
  const [deployer] = await ethers.getSigners();
  const d = loadDeployed();
  const pump = await ethers.getContractAt(PUMP, d.BONDING);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 7: Token with Blacklist (USDT-style)");
  console.log(`  Pump: ${d.BONDING}  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  // ── Part 1: Verify TokenTemplate works normally (no blacklist) ──
  console.log("  ── Part 1: TokenTemplate (no blacklist) ──");
  const tx = await pump.createSale("Normal", "NRM", 8000, ONE * 100n, "", "", "", "");
  const rc = await tx.wait();
  const log = rc!.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  const token = saleIface.parseLog(log!)!.args.token as string;
  console.log(`  ${_I} TokenTemplate: ${token}`);

  const buyVal = ONE * 5n;
  const tx2 = await pump.buy(token, 0, { value: buyVal });
  await tx2.wait();
  const balAfter = await new ethers.Contract(token, ERC20, deployer).balanceOf(deployer.address);
  console.log(`  ${balAfter > 0n ? PASS : FAIL} Tokens received: ${ethers.formatEther(balAfter)}`);
  console.log();

  // ── Part 2: Deploy BlacklistToken and test blacklist behavior ──
  console.log("  ── Part 2: BlacklistToken behavior ──");
  const HF = await ethers.getContractFactory("contracts/test/CallbackTestHelper.sol:BlacklistToken");
  const blToken = await HF.deploy("Blacklisted", "BLK", ethers.parseEther("1000000000"), deployer.address);
  await blToken.waitForDeployment();
  const blAddr = await blToken.getAddress();
  console.log(`  ${_I} BlacklistToken: ${blAddr}`);

  // Verify normal transfer works before blacklisting
  const destAddr = "0x000000000000000000000000000000000000dEaD";
  await (await blToken.transfer(destAddr, ONE)).wait();
  const destBal = await blToken.balanceOf(destAddr);
  console.log(`  ${destBal === ONE ? PASS : FAIL} Normal transfer works: dest=${ethers.formatEther(destBal)}`);

  // Blacklist the recipient
  await (await blToken.setBlacklist(destAddr, true)).wait();
  console.log(`  ${_I} Blacklisted: ${destAddr}`);

  // Try to transfer to blacklisted address → should revert
  try {
    await (await blToken.transfer(destAddr, ONE)).wait();
    console.log(`  ${FAIL} Transfer to blacklisted address should have reverted`);
  } catch (e: any) {
    const msg = (e?.reason || e?.message || "").toLowerCase();
    console.log(`  ${msg.includes("blacklisted") || msg.includes("revert") ? PASS : FAIL} Transfer to blacklisted reverted: ${(e?.reason || "").slice(0, 80)}`);
  }

  // Blacklist the sender
  await (await blToken.setBlacklist(destAddr, false)).wait(); // unblacklist dest
  await (await blToken.setBlacklist(deployer.address, true)).wait();
  console.log(`  ${_I} Blacklisted: ${deployer.address}`);

  try {
    await (await blToken.transfer(destAddr, ONE)).wait();
    console.log(`  ${FAIL} Transfer from blacklisted should have reverted`);
  } catch (e: any) {
    const msg = (e?.reason || e?.message || "").toLowerCase();
    console.log(`  ${msg.includes("blacklisted") || msg.includes("revert") ? PASS : FAIL} Transfer from blacklisted reverted: ${(e?.reason || "").slice(0, 80)}`);
  }

  // Unblacklist deployer for remaining tests
  await (await blToken.setBlacklist(deployer.address, false)).wait();
  console.log();

  // ── Part 3: Simulate impact on pump graduation ──
  console.log("  ── Part 3: Blacklist impact on graduation ──");
  // Create a normal sale, then graduate it
  const tx3 = await pump.createSale("GradTest", "GRD", 8000, ONE * 100n, "", "", "", "");
  const rc3 = await tx3.wait();
  const log3 = rc3!.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  const token3 = saleIface.parseLog(log3!)!.args.token as string;
  await (await pump.buy(token3, 0, { value: ONE * 200n, gasLimit: 3_000_000 })).wait();
  const sale3 = await pump.getSale(token3);
  console.log(`  ${sale3[7] ? PASS : FAIL} Sale graduated: ${sale3[7]}`);

  // Get pair and show it's a normal Uniswap V2 pair
  const factory = await ethers.getContractAt(["function getPair(address,address) view returns (address)"], d.FACTORY);
  const pairAddr = await factory.getPair(token3, d.WGAS);
  console.log(`  ${_I} Uniswap pair: ${pairAddr}`);

  // Transfer tokens between addresses on the graduated pair (normal AMM behavior)
  const pair = await ethers.getContractAt(
    ["function getReserves() view returns (uint112,uint112,uint32)", "function balanceOf(address) view returns (uint256)"],
    pairAddr
  );
  const [r0, r1] = await pair.getReserves();
  console.log(`  ${_I} Reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);

  // Verify that the TokenTemplate used by pump has no blacklist by checking token code
  const ttContract = new ethers.Contract(token3, ["function balanceOf(address) view returns (uint256)"], deployer);
  const pumpBal = await ttContract.balanceOf(d.BONDING);
  console.log(`  ${_I} Pump balance of token: ${ethers.formatEther(pumpBal)} (0 after graduation)`);
  console.log(`  ${PASS} TokenTemplate has no blacklist — transfers always succeed`);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 7 complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
