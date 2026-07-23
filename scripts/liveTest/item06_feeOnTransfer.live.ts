import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";

const PUMP = [
  "function createSale(string,string,uint256,uint256,string,string,string,string) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function uniswapFactory() view returns (address)",
  "function weth() view returns (address)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];
const ONE = ethers.parseEther("1");
const PASS = "\u2713", FAIL = "\u2717", _I = "\u2192";

const purchasedTopic = ethers.id("TokensPurchased(address,address,uint256,uint256)");
const buyIface = new ethers.Interface([
  "event TokensPurchased(address indexed buyer, address indexed token, uint256 GASIn, uint256 tokensOut)",
]);
const saleCreatedTopic = ethers.id("SaleCreated(address,address,string,string,string,string,string,string)");
const saleIface = new ethers.Interface([
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol, string discord, string x, string telegram, string repoUrl)",
]);

function parseTokensOut(rc: any): bigint {
  const log = rc.logs.find((l: any) => l.topics[0] === purchasedTopic);
  return buyIface.parseLog(log)!.args.tokensOut as bigint;
}

function parseToken(rc: any): string {
  const log = rc.logs.find((l: any) => l.topics[0] === saleCreatedTopic);
  return saleIface.parseLog(log)!.args.token as string;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const d = JSON.parse(fs.readFileSync("deployed.json", "utf8"));
  const pump = await ethers.getContractAt(PUMP, d.pump);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 6: Token with Fee-on-Transfer (Reflection)");
  console.log(`  Pump: ${d.pump}  Deployer: ${deployer.address}`);
  console.log(`${"=".repeat(60)}\n`);

  // ── Part 1: Verify TokenTemplate has NO fee ──
  console.log("  ── Part 1: TokenTemplate (no fee) ──");
  const tx = await pump.createSale("NoFee", "NOF", 8000, ONE * 100n, "", "", "", "");
  const rc = await tx.wait();
  const token = parseToken(rc!);
  console.log(`  ${_I} TokenTemplate: ${token}`);

  const buyVal = ONE * 5n;
  const tx2 = await pump.buy(token, 0, { value: buyVal });
  const rc2 = await tx2.wait();
  const tokensOut = parseTokensOut(rc2!);
  const balAfter = await new ethers.Contract(token, ERC20, deployer).balanceOf(deployer.address);
  const noFeeDiscrepancy = tokensOut - balAfter;
  console.log(`  ${_I} tokensOut: ${ethers.formatEther(tokensOut)}`);
  console.log(`  ${_I} tokensReceived: ${ethers.formatEther(balAfter)}`);
  console.log(`  ${noFeeDiscrepancy === 0n ? PASS : FAIL} No fee: balanceDelta == tokensOut (diff: ${ethers.formatEther(noFeeDiscrepancy)})`);

  // Graduate and verify LP receives full amount
  const capTokens = ethers.parseEther("1000000000") * 8000n / 10000n;
  await (await pump.buy(token, 0, { value: ONE * 200n, gasLimit: 3_000_000 })).wait();

  const sale = await pump.getSale(token);
  const tokensSold = sale[1];
  const GASRaised = sale[2];
  const graduated = sale[7];

  if (graduated) {
    const factory = await ethers.getContractAt(["function getPair(address,address) view returns (address)"], d.factory);
    const pairAddr = await factory.getPair(token, d.wgas);
    const pair = await ethers.getContractAt(
      ["function getReserves() view returns (uint112,uint112,uint32)", "function balanceOf(address) view returns (uint256)"],
      pairAddr
    );
    const [r0, r1] = await pair.getReserves();
    console.log(`  ${_I} Graduated pair reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);

    const tokensForLP = ethers.parseEther("1000000000") - tokensSold;
    console.log(`  ${_I} tokensForLP: ${ethers.formatEther(tokensForLP)}  GASForLP: ${ethers.formatEther(GASRaised)}`);
    const tc = new ethers.Contract(token, ERC20, deployer);
    const poolTokenBal = await tc.balanceOf(pairAddr);
    console.log(`  ${poolTokenBal === tokensForLP ? PASS : FAIL} Pool token bal == tokensForLP: ${ethers.formatEther(poolTokenBal)} == ${ethers.formatEther(tokensForLP)}`);
  } else {
    console.log(`  ${_I} Sale did not graduate (needs more GAS)`);
  }
  console.log();

  // ── Part 2: FeeOnTransfer token demonstration ──
  console.log("  ── Part 2: FeeOnTransfer token (5% fee) ──");
  const HF = await ethers.getContractFactory("contracts/CallbackTestHelper.sol:FeeOnTransferToken");
  const feeTok = await HF.deploy("FeeToken", "FEE", ethers.parseEther("1000000000"), deployer.address);
  await feeTok.waitForDeployment();
  const feeAddr = await feeTok.getAddress();
  console.log(`  ${_I} FeeOnTransferToken: ${feeAddr}`);
  console.log(`  ${_I} Fee: ${await feeTok.feeBps()} bps (5%)`);

  const transferAmount = ethers.parseEther("1000");
  const destAddr = "0x000000000000000000000000000000000000dEaD";
  const balBefore = await feeTok.balanceOf(deployer.address);
  const txFee = await feeTok.transfer(destAddr, transferAmount);
  const rcFee = await txFee.wait();
  const balAfterFee = await feeTok.balanceOf(deployer.address);
  const balDestAfter = await feeTok.balanceOf(destAddr);
  const deducted = balBefore - balAfterFee;
  const netToDest = balDestAfter;
  const expectedFee = transferAmount * 500n / 10000n;
  const expectedNet = transferAmount - expectedFee;
  console.log(`  ${_I} Sent: ${ethers.formatEther(transferAmount)}`);
  console.log(`  ${_I} Expected fee: ${ethers.formatEther(expectedFee)}, net to dest: ${ethers.formatEther(expectedNet)}`);
  console.log(`  ${_I} Balance before: ${ethers.formatEther(balBefore)}  after: ${ethers.formatEther(balAfterFee)}`);
  console.log(`  ${_I} Deducted from sender: ${ethers.formatEther(deducted)}  received by dest: ${ethers.formatEther(netToDest)}`);
  console.log(`  ${netToDest === expectedNet ? PASS : FAIL} Fee charged: net=${ethers.formatEther(netToDest)} (expected ${ethers.formatEther(expectedNet)})`);

  // ── Part 3: What would happen if fee token was used in pump ──
  console.log();
  console.log("  ── Part 3: Impact on pump accounting ──");
  // Simulate: if the pump used FeeOnTransferToken, buyer would get less than tokensOut
  // The pump records tokensOut as sold, but buyer only receives tokensOut - fee
  // Graduation would transfer tokensForLP to pair, but pair gets tokensForLP - fee
  const simulatedSold = ethers.parseEther("100000000");
  const simulatedFee = simulatedSold * 500n / 10000n;
  const simulatedReceived = simulatedSold - simulatedFee;
  console.log(`  ${_I} Pump records tokensSold += ${ethers.formatEther(simulatedSold)}`);
  console.log(`  ${_I} Buyer actually gets ${ethers.formatEther(simulatedReceived)} (${ethers.formatEther(simulatedFee)} fee lost)`);
  console.log(`  ${_I} Over time, tokensSold would diverge from actual circulating supply`);

  // Verify that TokenTemplate doesn't have this issue
  const ttContract = new ethers.Contract(token, [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ], deployer);
  const ttBalBefore = await ttContract.balanceOf(deployer.address);
  const testTransfer = ethers.parseEther("1");
  const burnAddr = "0x000000000000000000000000000000000000dEaD";
  await (await ttContract.transfer(burnAddr, testTransfer)).wait();
  const ttDeducted = ttBalBefore - await ttContract.balanceOf(deployer.address);
  console.log(`  ${ttDeducted === testTransfer ? PASS : FAIL} TokenTemplate no fee: sent ${ethers.formatEther(testTransfer)}, deducted ${ethers.formatEther(ttDeducted)}`);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Item 6 complete");
  console.log(`${"=".repeat(60)}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
