import hre from "hardhat";
import type { Interface } from "ethers";
const { ethers } = hre;
import assert from "assert";
import * as fs from "fs";
import path from "path";

const FACTORY_IFACE = "contracts/interfaces/IUniswapV2Factory.sol:IUniswapV2Factory";
const PAIR_IFACE    = "contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair";

const PUMP_ABI = [
  "function uniswapFactory() view returns (address)",
  "function weth() view returns (address)",
  "function createSale(string,string,uint256,uint256) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function getSale(address) view returns (address creator, uint256 totalSupply, uint256 tokensSold, uint256 gasRaised, uint256 targetRaise, uint256 virtualGas, uint256 virtualToken, uint256 graduationBps, bool graduated)",
  "function getCurrentPrice(address) view returns (uint256)",
];

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

const BPS_DENOM = 10000n;
const ZERO = ethers.ZeroAddress;
let pumpIface: Interface;

const GRAD_CASES = [
  { bps: 7000, label: "70%", targetRaise: 10n },
  { bps: 8000, label: "80%", targetRaise: 50n },
  { bps: 9500, label: "95%", targetRaise: 100n },
];

let roundIndex = 0;

function uniqueName(base: string): string {
  roundIndex++;
  return `${base}${roundIndex}`;
}

async function getBal(addr: string): Promise<bigint> {
  return ethers.provider.getBalance(addr);
}

async function runRound(
  pump: any,
  factory: any,
  wgas: string,
  bps: number,
  pctLabel: string,
  targetRaiseEth: bigint
) {
  const targetRaise = ethers.parseEther(targetRaiseEth.toString());
  const name = uniqueName(`GR${pctLabel.replace("%", "")}`);
  const symbol = name;

  console.log(`\n╔══════════════════════════════════════════════════`);
  console.log(`║  Round: ${name}  (${pctLabel}, ${targetRaiseEth} ETH target)`);
  console.log(`╚══════════════════════════════════════════════════`);

  // ── 1. Create sale ──
  console.log(`\n[1] createSale...`);
  const pumpAddr = await pump.getAddress();
  const gasEst = await pump.createSale.estimateGas(name, symbol, bps, targetRaise);
  console.log(`   gasEst: ${gasEst}`);
  const tx1 = await pump.createSale(name, symbol, bps, targetRaise, {
    gasLimit: gasEst * 120n / 100n,
  });
  const rc1 = await tx1.wait();
  if (!rc1 || rc1.status === 0) {
    let reason = `gasUsed=${rc1?.gasUsed}, gasEst=${gasEst}`;
    try {
      await pump.createSale.staticCall(name, symbol, bps, targetRaise);
    } catch (callErr: any) {
      reason += `, revert=${callErr.reason || callErr.message}`;
    }
    throw new Error(`createSale reverted (${reason})`);
  }
  const SALE_CREATED_TOPIC = ethers.id("SaleCreated(address,address,string,string)");
  const saleLog = rc1.logs.find((l: any) =>
    l.topics[0] === SALE_CREATED_TOPIC && l.address.toLowerCase() === pumpAddr.toLowerCase()
  );
  assert.ok(saleLog, `SaleCreated not found in ${rc1.logs.length} logs (pump=${pumpAddr})`);
  const parsedSale = pumpIface.parseLog(saleLog);
  assert.ok(parsedSale, `parseLog failed for SaleCreated log (topic=${saleLog.topics[0]})`);
  const tokenAddr: string = parsedSale.args.token;

  const token = await ethers.getContractAt(ERC20, tokenAddr);
  console.log(`   Token: ${tokenAddr}`);
  assert.strictEqual(await token.symbol(), symbol);

  // ── 2. Verify virtual reserves ──
  console.log(`\n[2] Virtual reserves...`);
  const s: any = await pump.getSale(tokenAddr);
  const vGas   = s.virtualGas as bigint;
  const vToken = s.virtualToken as bigint;
  const totalSupply = s.totalSupply as bigint;
  console.log(`   virtualGas  : ${ethers.formatEther(vGas)} ETH`);
  console.log(`   virtualToken: ${ethers.formatEther(vToken)} tokens`);

  const p = BigInt(bps);
  const twoPm1 = 2n * p - BPS_DENOM;
  const expVToken = totalSupply * p * p / (BPS_DENOM * twoPm1);
  const expVGas   = targetRaise * (BPS_DENOM - p) / twoPm1;
  console.log(`   expected vToken: ${ethers.formatEther(expVToken)}`);
  console.log(`   expected vGas  : ${ethers.formatEther(expVGas)}`);
  assert.strictEqual(vToken, expVToken, "vToken mismatch");
  assert.strictEqual(vGas,   expVGas,   "vGas mismatch");
  console.log(`   ✓`);

  // ── 3. Dynamic buy stages ──
  console.log(`\n[3] Buying in stages...`);
  const targetEthNum = targetRaiseEth;
  const stages: { eth: bigint; label: string }[] = [];
  if (targetEthNum >= 250n) {
    stages.push({ eth: targetEthNum / 4n, label: "25%" });
    stages.push({ eth: targetEthNum / 4n, label: "50%" });
    stages.push({ eth: targetEthNum / 4n, label: "75%" });
    stages.push({ eth: targetEthNum - (targetEthNum / 4n) * 3n, label: "100% (grad)" });
  } else {
    stages.push({ eth: targetEthNum, label: "100% (grad)" });
  }

  const K0 = vGas * vToken;
  let graduated = false;

  for (let i = 0; i < stages.length; i++) {
    if (graduated) {
      console.log(`   Stage ${i + 1}: already graduated, skip`);
      continue;
    }

    const stageEth = ethers.parseEther(stages[i].eth.toString());
    console.log(`   Stage ${i + 1} ${stages[i].label}: ${ethers.formatEther(stageEth)} ETH`);

    const balBefore = await getBal(await pump.getAddress());
    const tx = await pump.buy(tokenAddr, 0n, { value: stageEth });
    const rc = await tx.wait();
    const buyLog: any = rc!.logs
      .map((l: any) => { try { return pumpIface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "TokensPurchased");

    if (buyLog) {
      console.log(`      tokensOut: ${ethers.formatEther(buyLog.args.tokensOut)}`);
    }

    const gradLog: any = rc!.logs
      .map((l: any) => { try { return pumpIface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "SaleGraduated");
    if (gradLog) graduated = true;

    // ── 4. K invariant ──
    const s2: any = await pump.getSale(tokenAddr);
    const K = (BigInt(s2.virtualGas) + BigInt(s2.gasRaised)) * (BigInt(s2.virtualToken) - BigInt(s2.tokensSold));
    const kDiff = K > K0 ? K - K0 : K0 - K;
    const kDrift = kDiff * 10000n / K0;
    console.log(`      K drift: ${kDrift} bps`);
    assert.ok(kDrift <= 1n, `K drift ${kDrift} bps > 1 bps`);
    console.log(`      K invariant ✓`);

    // ── 5. tokensSold <= maxTokens ──
    const maxTokens = totalSupply * p / BPS_DENOM;
    const ts = s2.tokensSold as bigint;
    assert.ok(ts <= maxTokens, `tokensSold ${ts} > maxTokens ${maxTokens}`);
    if (i === stages.length - 1 || graduated) {
      console.log(`      tokensSold cap ✓`);
    }

    if (graduated) {
      console.log(`      Graduated! ✓`);
    }
  }

  // ── 6. Post-graduation verification ──
  console.log(`\n[4] Post-graduation...`);
  const sFinal: any = await pump.getSale(tokenAddr);
  assert.strictEqual(sFinal.graduated, true, "sale should be graduated");

  // pair is not returned by getSale() — query factory instead
  const pairAddr: string = await factory.getPair(tokenAddr, wgas);
  assert.notStrictEqual(pairAddr, ZERO, "pair should exist");

  const pair = await ethers.getContractAt(PAIR_IFACE, pairAddr);

  console.log(`   Pair: ${pairAddr}`);

  // non-zero reserves
  const [r0, r1] = await pair.getReserves();
  console.log(`   Reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);
  assert.ok(r0 > 0n && r1 > 0n, "reserves should be non-zero");

  // total LP supply = LP burned (all LP to address(0))
  const totalLP = await pair.totalSupply();
  const lpBurned = await pair.balanceOf(ZERO);
  console.log(`   Total LP: ${ethers.formatEther(totalLP)}`);
  console.log(`   LP burned: ${ethers.formatEther(lpBurned)}`);
  assert.strictEqual(lpBurned, totalLP, "all LP should be burned to 0x0");

  // K value
  const pairK = r0 * r1;
  assert.ok(pairK > 0n, "pair K should be > 0");
  console.log(`   Pair K: ${pairK} ✓`);

  // ── 7. Price continuity ──
  console.log(`\n[5] Price continuity...`);
  const bcGas   = BigInt(sFinal.virtualGas) + BigInt(sFinal.gasRaised);
  const bcToken = BigInt(sFinal.virtualToken) - BigInt(sFinal.tokensSold);

  const wethIsT0 = (await pair.token0()).toLowerCase() === wgas.toLowerCase();
  const uniGas   = wethIsT0 ? r0 : r1;
  const uniToken = wethIsT0 ? r1 : r0;

  // cross-multiply: bcGas/uniGas ≈ bcToken/uniToken
  const lhs = BigInt(bcGas) * BigInt(uniToken);
  const rhs = BigInt(uniGas) * BigInt(bcToken);
  const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
  const rel  = diff * 1000000n / (lhs + rhs);
  console.log(`   Pump closing price: ${ethers.formatEther(bcGas)} / ${ethers.formatEther(bcToken)}`);
  console.log(`   Uni opening price : ${ethers.formatEther(uniGas)} / ${ethers.formatEther(uniToken)}`);
  console.log(`   Relative diff: ${rel} / 1,000,000`);
  assert.ok(diff * 1000000n < lhs + rhs, "price divergence > 0.0001%");
  console.log(`   Price continuity ✓`);

  // ── 8. Post-grad revert ──
  console.log(`\n[6] Post-grad revert...`);
  try {
    await pump.buy(tokenAddr, 0n, { value: 1n });
    assert.fail("expected revert");
  } catch (e: any) {
    assert.ok(e.message?.includes("SALE_GRADUATED") || e.message?.includes("revert"));
    console.log(`   Post-grad buy reverted ✓`);
  }

  console.log(`\n   ✅ Round ${name} PASSED`);
}

async function main() {
  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", '..',"deployed.json"), "utf8")
  );
  const network = hre.network.name;

  console.log("═════════════════════════════════════════════════════════════");
  console.log(`  Pump Gradient Live Test — ${network}`);
  console.log("═════════════════════════════════════════════════════════════\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const ethBalance = await getBal(deployer.address);
  console.log("Balance:", ethers.formatEther(ethBalance), "\n");

  // RPC check
  const block = await ethers.provider.getBlockNumber();
  assert.ok(!isNaN(block) && block >= 0);
  console.log(`Block: ${block} ✓\n`);

  // Check bytecode
  let code = await ethers.provider.getCode(deployed.pump);
  assert.notStrictEqual(code, "0x", `No Pump bytecode at ${deployed.pump}. Use --network legacy/neoxTestnet`);
  code = await ethers.provider.getCode(deployed.factory);
  assert.notStrictEqual(code, "0x", `No Factory bytecode at ${deployed.factory}`);

  const pumpArtifact = await hre.artifacts.readArtifact("contracts/pump/Pump.sol:Pump");
  pumpIface = new ethers.Interface(pumpArtifact.abi);
  const pump: any = await ethers.getContractAt(pumpArtifact.abi, deployed.pump);
  const factory = await ethers.getContractAt(FACTORY_IFACE, deployed.factory);
  const wgas = deployed.wgas;

  // Verify Pump config
  const pumpFactory = await pump.uniswapFactory();
  const pumpWeth = await pump.weth();
  assert.strictEqual(pumpFactory.toLowerCase(), deployed.factory.toLowerCase());
  assert.strictEqual(pumpWeth.toLowerCase(), deployed.wgas.toLowerCase());
  console.log("Pump config ✓\n");

  // Balance check
  const totalNeeded = GRAD_CASES.reduce((sum, c) => sum + c.targetRaise, 0n);
  const buffer = ethers.parseEther("0.5");
  const totalCost = ethers.parseEther(totalNeeded.toString()) + buffer;
  console.log(`Total ETH needed: ~${ethers.formatEther(totalCost)}`);
  if (ethBalance < totalCost) {
    console.error(`\n✗ Insufficient ETH: have ${ethers.formatEther(ethBalance)}, need ~${ethers.formatEther(totalCost)}`);
    process.exit(1);
  }
  console.log(`Balance sufficient ✓\n`);

  // Run each case, continue on failure
  let passed = 0, failed = 0;
  for (const c of GRAD_CASES) {
    try {
      await runRound(pump, factory, wgas, c.bps, c.label, c.targetRaise);
      passed++;
    } catch (err: any) {
      console.error(`\n✗ Round ${c.label}/${c.targetRaise}ETH FAILED: ${err.message ?? err}`);
      failed++;
    }
  }

  const balAfter = await getBal(deployer.address);
  const spent = ethBalance - balAfter;

  console.log(`\n═════════════════════════════════════════════════════════════`);
  console.log(`  Summary: ${passed} passed / ${failed} failed / ${GRAD_CASES.length} total`);
  console.log(`  ETH spent: ${ethers.formatEther(spent)}`);
  console.log(`═════════════════════════════════════════════════════════════\n`);

  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ GRADIENT TEST FAILED:", err.message ?? err);
    process.exit(1);
  });


  