// @ts-expect-error hardhat module doesn't export ethers at type level but does at runtime
import { ethers } from "hardhat";

const PK1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PK2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ONE = ethers.parseEther("1");
const TG = ethers.parseEther("1000");
const PASS = "✅", FAIL = "❌", WARN = "⚠️", INFO = "ℹ️";
const _log = (p: string, m: string) => console.log(`  ${p} ${m}`);

let pumpAddr: string, routerAddr: string, wgasAddr: string;

const ABI = [
  "function createSale(string,string,uint256) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function getSale(address) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const eventsIface = new ethers.Interface([
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol)",
]);

async function sale(contract: ethers.Contract, n: string, s: string, b = 8000): Promise<string> {
  const tx = await contract.createSale(n, s, b);
  const rc = await tx.wait();
  for (const l of rc!.logs) {
    if (l.address.toLowerCase() !== pumpAddr.toLowerCase()) continue;
    const p = eventsIface.parseLog(l);
    if (p?.name === "SaleCreated") return p.args.token as string;
  }
  throw new Error("SaleCreated not found");
}

function tok(addr: string, s?: ethers.Signer) {
  return new ethers.Contract(addr, [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], s ?? ethers.provider) as any;
}
function mkPump(s: ethers.Signer) { return new ethers.Contract(pumpAddr, ABI, s); }

async function buy(s: ethers.Signer, l: string, t: string, v: bigint, mo = 0n, f = false) {
  try {
    const tx = await mkPump(s).buy(t, mo, { value: v, gasLimit: 3_000_000 });
    const r = await tx.wait();
    if (r?.status === 0) throw new Error("REVERTED");
    if(f) _log(FAIL, l); else _log(PASS, l); return true;
  } catch(e: any) {
    if(f) _log(PASS, l + " [reverted]"); else _log(FAIL, l);
    const msg = e?.message?.slice(0,80) || e?.toString?.()?.slice(0,80);
    if (msg) _log(WARN, `  cause: ${msg}`);
    return false;
  }
}
async function sell(s: ethers.Signer, l: string, t: string, a: bigint, f = false) {
  try { const tx = await mkPump(s).sell(t, a, 0n, { gasLimit: 300000 }); await tx.wait(); if(f) _log(FAIL, l); else _log(PASS, l); return true; }
  catch { if(f) _log(PASS, l + " [reverted]"); else _log(FAIL, l); return false; }
}

async function main() {
  const attacker = new ethers.Wallet(PK1, ethers.provider);
  const victim = new ethers.Wallet(PK2, ethers.provider);
  const deployer = victim; // victim has most ETH left

  _log(INFO, "Deploying Factory + WETH + Router + Pump...");
  const Factory = await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory");
  const factory = await Factory.connect(deployer).deploy(deployer.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  const WETH9 = await ethers.getContractFactory("contracts/Weth9.sol:WETH9");
  const weth = await WETH9.connect(deployer).deploy();
  await weth.waitForDeployment();
  wgasAddr = await weth.getAddress();

  const Router = await ethers.getContractFactory("contracts/UniswapV2Router02.sol:UniswapV2Router02");
  const router = await Router.connect(deployer).deploy(factoryAddr, wgasAddr);
  await router.waitForDeployment();
  routerAddr = await router.getAddress();

  const Pump = await ethers.getContractFactory("contracts/pump/Pump.sol:Pump");
  const pump = await Pump.connect(deployer).deploy(routerAddr);
  await pump.waitForDeployment();
  pumpAddr = await pump.getAddress();

  _log(INFO, `Factory=${factoryAddr} Router=${routerAddr} Pump=${pumpAddr}`);
  const bal = async (w: string, s: ethers.Signer) => _log(INFO, `${w}: ${ethers.formatEther(await ethers.provider.getBalance(s.address))}`);
  await bal("Deployer", deployer); await bal("Attacker", attacker); await bal("Victim", victim);

  const P = mkPump(deployer), PA = mkPump(attacker), PV = mkPump(victim);
  const factoryC = new ethers.Contract(factoryAddr, ["function getPair(address,address) view returns (address)"], ethers.provider);

  // ──── 1. REENTRANCY ────
  console.log(`\n${"=".repeat(60)}\n  1. REENTRANCY\n${"=".repeat(60)}`);
  const t1 = await sale(P, "Reentrant", "REN");
  const RA = await ethers.getContractFactory("contracts/test/MaliciousHelper.sol:ReentrancyAttacker");
  const reenter = await RA.connect(attacker).deploy(pumpAddr, t1);
  await reenter.waitForDeployment();
  await attacker.sendTransaction({ to: await reenter.getAddress(), value: ONE * 100n });
  try {
    await reenter.attack(pumpAddr, t1, { gasLimit: 600000 });
    (await reenter.reentrancySucceeded()) ? _log(FAIL, "Reentrancy succeeded!") : _log(PASS, "Reentrancy blocked");
  } catch { _log(PASS, "Reentrancy blocked"); }

  // ──── 2. REFUND GRIEF ────
  console.log(`\n${"=".repeat(60)}\n  2. REFUND GRIEF\n${"=".repeat(60)}`);
  const t2 = await sale(P, "Grief", "GRF");
  // DEBUG: Buy 3000 ETH directly from EOA to verify cap threshold
  const BUY_IFACE = new ethers.Interface(["function buy(address,uint256) payable returns (uint256)"]);
  const bd = BUY_IFACE.encodeFunctionData("buy", [t2, 0n]);
  try {
    const dbtx = await attacker.sendTransaction({ to: pumpAddr, data: bd, value: TG * 3n, gasLimit: 2_000_000 });
    const dr = await dbtx.wait();
    if (dr?.status === 0) throw new Error("REVERTED");
    const [,,,grDb,,,,] = await P.getSale(t2);
    _log(INFO, `Direct 3000 buy OK, gasRaised=${ethers.formatEther(grDb)}`);
  } catch { /* direct buy reverted (may have triggered graduation with insufficient gas) */ }
  // Test RefundGriefer helper
  const RG = await ethers.getContractFactory("contracts/test/MaliciousHelper.sol:RefundGriefer");
  const griefer = await RG.connect(attacker).deploy();
  await griefer.waitForDeployment();
  try { await attacker.sendTransaction({ to: await griefer.getAddress(), value: ONE, gasLimit: 50000 }); _log(FAIL, "Griefer should reject ETH"); }
  catch { _log(PASS, "Griefer rejects direct ETH transfers"); }
  try { await griefer.attackRefundGrief(pumpAddr, t2, { value: TG * 3n, gasLimit: 2_000_000 }); _log(FAIL, "Griefer buy should revert (refund blocked)"); }
  catch { _log(PASS, "Griefer buy reverted (refund blocked by reverting receive)"); }
  // Other users
  const ok = await buy(victim, "Victim buys after griefer", t2, ONE * 50n);
  const tb = await tok(t2).balanceOf(victim.address);
  ok && tb > 0n ? _log(PASS, "Other users unaffected") : _log(FAIL, "Other users blocked");

  // ──── 3. BOUNDARIES ────
  console.log(`\n${"=".repeat(60)}\n  3. BOUNDARIES\n${"=".repeat(60)}`);
  const t3 = await sale(P, "Boundary", "BND");
  const T3 = tok(t3, victim);
  const b3 = await buy(victim, "Buy 50 GAS", t3, ONE * 50n);
  const bal3 = b3 ? await T3.balanceOf(victim.address) : 0n;
  if (bal3 > 0n) {
    _log(INFO, `Tokens: ${ethers.formatEther(bal3)}`);
    await T3.connect(victim).approve(pumpAddr, bal3);
    await sell(victim, "Full sell", t3, bal3);
  }
  await sell(attacker, "Zero-token sell", t3, 0n, true);
  await sell(attacker, "Sell 1 (no balance)", t3, 1n, true);
  await buy(victim, "Excessive slippage", t3, ONE, ethers.MaxUint256, true);
  await buy(attacker, "Zero-value buy", t3, 0n, 0n, true);

  // ──── 4. GRADUATION MANIPULATION ────
  console.log(`\n${"=".repeat(60)}\n  4. GRAD MANIPULATION\n${"=".repeat(60)}`);
  const t4 = await sale(P, "GradManip", "GRD");
  await buy(attacker, "Attacker buys 200", t4, ONE * 200n);
  await buy(victim, "Victim buys 300", t4, ONE * 300n);
  const T4 = tok(t4, attacker);
  const ab = await T4.balanceOf(attacker.address);
  if (ab > 0n) {
    await T4.connect(attacker).approve(pumpAddr, ab);
    await sell(attacker, "Attacker dumps all", t4, ab);
    const [,,, g4, tr4,,,,] = await P.getSale(t4);
    _log(INFO, `gasRaised: ${ethers.formatEther(g4)} / ${ethers.formatEther(tr4)}`);
    if (tr4 > g4) await buy(victim, "Graduation buy", t4, tr4 - g4 + ONE * 10n);
    else _log(WARN, "Already at/over target");
    const [,,,,,,,, grad4] = await P.getSale(t4);
    grad4 ? _log(PASS, "Graduated") : _log(FAIL, "Not graduated");
  }

  // ──── 5. POST-GRAD ────
  console.log(`\n${"=".repeat(60)}\n  5. POST-GRAD ACCESS\n${"=".repeat(60)}`);
  const t5 = await sale(P, "PostGrad", "PST");
  // Split graduation into multiple buys so we don't hit the cap + grad in one tx
  // Buy 500 ETH first, then 500 more
  await buy(victim, "Buy 500", t5, ONE * 500n);
  await buy(victim, "Buy 500 more + overpay", t5, ONE * 510n);
  const [,,,,,,,, g5] = await P.getSale(t5);
  g5 ? _log(PASS, "Sale graduated") : _log(FAIL, "Not graduated - Router/pair init code mismatch likely");
  await buy(attacker, "Buy after grad", t5, ONE, 0n, g5);
  await sell(attacker, "Sell after grad", t5, 1n, g5);
  if (g5) {
    const p5 = await factoryC.getPair(t5, wgasAddr);
    if (p5 !== ethers.ZeroAddress) _log(PASS, `Uniswap pair: ${p5}`);
    else _log(FAIL, "No pair");
  }

  // ──── 6. FORCED ETH ────
  console.log(`\n${"=".repeat(60)}\n  6. FORCED ETH\n${"=".repeat(60)}`);
  const t6 = await sale(P, "ForceETH", "FRC");
  await attacker.sendTransaction({ to: pumpAddr, value: ONE });
  const [,,,g6,,,,] = await P.getSale(t6);
  g6 === 0n ? _log(PASS, "Forced ETH doesn't affect gasRaised") : _log(FAIL, "gasRaised tainted");

  // ──── 7. FULL LIFECYCLE ────
  console.log(`\n${"=".repeat(60)}\n  7. FULL LIFECYCLE\n${"=".repeat(60)}`);
  const t7 = await sale(P, "FullLife", "FUL");
  const T7 = tok(t7, victim);
  await buy(victim, "Victim buys 300", t7, ONE * 300n);
  await buy(attacker, "Attacker buys 200", t7, ONE * 200n);
  const vb = await T7.balanceOf(victim.address);
  if (vb > 0n) {
    await T7.connect(victim).approve(pumpAddr, vb / 2n);
    await sell(victim, "Partial sell", t7, vb / 2n);
    const [,,, g7, tr7,,,,] = await P.getSale(t7);
    _log(INFO, `gasRaised: ${ethers.formatEther(g7)}/${ethers.formatEther(tr7)}`);
    if (tr7 > g7) await buy(victim, "Final buy to graduate", t7, tr7 - g7 + ONE * 10n);
    const [,,,,,,,, g7b] = await P.getSale(t7);
    g7b ? _log(PASS, "Lifecycle complete") : _log(FAIL, "Not graduated");
    const p7 = await factoryC.getPair(t7, wgasAddr);
    p7 !== ethers.ZeroAddress ? _log(PASS, "Uniswap pair exists") : _log(FAIL, "No pair");
  }

  // ──── SUMMARY ────
  console.log(`\n${"=".repeat(60)}\n  SUMMARY\n${"=".repeat(60)}`);
  await bal("Deployer", deployer); await bal("Attacker", attacker); await bal("Victim", victim);
  _log(INFO, `Graduation works: ${g5 ? "YES" : "NO (init code hash mismatch in pairFor)"}`);
}

main().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
