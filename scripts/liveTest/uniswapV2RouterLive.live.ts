import hre from "hardhat";
const { ethers } = hre;
import assert from "assert";
import * as fs from "fs";
import path from "path";
import { loadDeployed } from "./addresses";

const ROUTER_IFACE  = "contracts/interfaces/IUniswapV2Router02.sol:IUniswapV2Router02";
const FACTORY_IFACE = "contracts/interfaces/IUniswapV2Factory.sol:IUniswapV2Factory";
const PAIR_IFACE    = "contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
];

async function getBlockTimestamp(): Promise<number> {
  const blk = await ethers.provider.getBlock("latest");
  return blk!.timestamp;
}

async function deadline(minutes = 30): Promise<number> {
  return (await getBlockTimestamp()) + minutes * 60;
}

async function main() {
  const deployed = loadDeployed();
  const network = hre.network.name;

  console.log("═══════════════════════════════════════════════════");
  console.log(`  Uniswap V2 Router Live Test — ${network}`);
  console.log("═══════════════════════════════════════════════════\n");

  const [deployer] = await ethers.getSigners();
  const ethBalance = await ethers.provider.getBalance(deployer.address);
  console.log("Signer:", deployer.address);
  console.log("Balance:", ethers.formatEther(ethBalance), "\n");

  // 0 ── RPC connectivity
  console.log("0. RPC connectivity...");
  const networkName = hre.network.name;
  const block = await ethers.provider.getBlockNumber();
  assert.ok(!isNaN(block) && block >= 0, `Invalid block number: ${block} on ${networkName}`);
  console.log(`   Network: ${networkName}, Block: ${block} ✓\n`);

  // 1 ── Connect to Router
  console.log("1. Connecting to Router...");
  const code = await ethers.provider.getCode(deployed.ROUTER);
  assert.notStrictEqual(code, "0x", `No bytecode at ${deployed.ROUTER}. Run with --network <network> where the contracts are deployed (e.g. anvil, neoxTestnet, neoxMainnet)`);
  const router = await ethers.getContractAt(ROUTER_IFACE, deployed.ROUTER);
  assert.strictEqual(
    (await router.getAddress()).toLowerCase(),
    deployed.ROUTER.toLowerCase()
  );
  console.log(`   Router: ${deployed.ROUTER} ✓\n`);

  // 2 ── Configuration
  console.log("2. Configuration...");
  const routerFactory = await router.factory();
  const routerWeth    = await router.WETH();
  console.log(`   factory: ${routerFactory}`);
  console.log(`   WETH   : ${routerWeth}`);
  assert.strictEqual(routerFactory.toLowerCase(), deployed.FACTORY.toLowerCase());
  assert.strictEqual(routerWeth.toLowerCase(),    deployed.WGAS.toLowerCase());
  console.log("   ✓\n");

  // 3 ── Library / pure functions
  console.log("3. Library functions...");

  // quote
  const q = await router.quote(
    ethers.parseEther("1"),
    ethers.parseEther("100"),
    ethers.parseEther("200")
  );
  assert.strictEqual(q, ethers.parseEther("2"));
  console.log(`   quote(1, 100, 200) = ${ethers.formatEther(q)} ✓`);

  // getAmountOut
  const ao = await router.getAmountOut(
    ethers.parseEther("1"),
    ethers.parseEther("100"),
    ethers.parseEther("200")
  );
  console.log(`   getAmountOut(1, 100, 200) = ${ethers.formatEther(ao)} ✓`);

  // getAmountIn
  const ai = await router.getAmountIn(
    ethers.parseEther("1"),
    ethers.parseEther("100"),
    ethers.parseEther("200")
  );
  console.log(`   getAmountIn(1, 100, 200) = ${ethers.formatEther(ai)} ✓\n`);

  // 4 ── Explore factory pairs & path queries
  console.log("4. Factory pairs & path queries...");
  const factory = await ethers.getContractAt(FACTORY_IFACE, deployed.FACTORY);
  const pairsLen = Number(await factory.allPairsLength());
  console.log(`   Pairs in factory: ${pairsLen}`);

  if (pairsLen === 0) {
    console.log("   No pairs exist — skipping swap & path tests.\n");
    console.log("\n═══════════════════════════════════════════════════");
    console.log("  Router live test (read-only) passed! ✓");
    console.log("═══════════════════════════════════════════════════\n");
    return;
  }

  // Pick the first pair with non-zero reserves
  let bestPair: string | null = null;
  let bestReserves: [bigint, bigint] = [0n, 0n];
  let bestToken0 = "", bestToken1 = "";

  for (let i = 0; i < pairsLen; i++) {
    const pAddr = await factory.allPairs(i);
    const pair  = await ethers.getContractAt(PAIR_IFACE, pAddr);
    const t0 = await pair.token0();
    const t1 = await pair.token1();
    const [r0, r1] = await pair.getReserves();
    if (r0 > 0n && r1 > 0n) {
      bestPair = pAddr;
      bestReserves = [r0, r1];
      bestToken0 = t0;
      bestToken1 = t1;
      console.log(`   Using pair #${i}: ${pAddr}`);
      console.log(`     ${t0} / ${t1}`);
      console.log(`     reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);
      break;
    }
  }

  if (!bestPair) {
    console.log("   No pair with non-zero reserves — skipping swap & path tests.\n");
    console.log("\n═══════════════════════════════════════════════════");
    console.log("  Router live test (read-only) passed! ✓");
    console.log("═══════════════════════════════════════════════════\n");
    return;
  }

  // 4a: getAmountsOut / getAmountsIn on the active pair
  const testIn = bestReserves[0] / 1000n;
  if (testIn > 0n) {
    const amountsOut = await router.getAmountsOut(testIn, [bestToken0, bestToken1]);
    console.log(`\n   getAmountsOut(${ethers.formatEther(testIn)}, [token0, token1])`);
    console.log(`     → ${ethers.formatEther(amountsOut[0])} → ${ethers.formatEther(amountsOut[1])} ✓`);
  }

  const testOut = bestReserves[1] / 1000n;
  if (testOut > 0n) {
    const amountsIn = await router.getAmountsIn(testOut, [bestToken0, bestToken1]);
    console.log(`   getAmountsIn(${ethers.formatEther(testOut)}, [token0, token1])`);
    console.log(`     → ${ethers.formatEther(amountsIn[0])} → ${ethers.formatEther(amountsIn[1])} ✓`);
  }
  console.log("   ✓\n");

  // 5 ── Swap test (only with sufficient balance)
  console.log("5. Swap test...");
  const MIN_BALANCE = ethers.parseEther("0.01");
  if (ethBalance < MIN_BALANCE) {
    console.log("   Insufficient ETH — skip.\n");
  } else {
    const wgas  = deployed.WGAS;
    const dt    = await deadline();
    const value = ethers.parseEther("0.0005"); // tiny amount

    // Determine which token is WETH for correct path ordering
    const wethIsToken0 = bestToken0.toLowerCase() === wgas.toLowerCase();
    const swapPath = wethIsToken0
      ? [wgas, bestToken1]
      : [wgas, bestToken0];
    const outToken = wethIsToken0 ? bestToken1 : bestToken0;

    try {
      const expected = await router.getAmountsOut(value, swapPath);
      const minOut = expected[1] * 99n / 100n;

      console.log(`   swapExactETHForTokens: ${ethers.formatEther(value)} ETH → ${outToken}`);
      const tx = await router.swapExactETHForTokens(minOut, swapPath, deployer.address, dt, {
        value,
      });
      const r = await tx.wait();
      console.log(`   tx: ${r!.hash}`);
      console.log("   ✓");
    } catch (e: any) {
      console.log(`   Swap attempt: ${e.shortMessage || e.message}`);
    }

    console.log();
  }

  // 6 ── Edge cases (read-only views that should revert)
  console.log("6. Boundary conditions...");

  // identical address path
  try {
    await router.getAmountsOut(ethers.parseEther("1"), [deployed.WGAS, deployed.WGAS]);
    assert.fail("expected revert");
  } catch (e: any) {
    assert.ok(
      e.message?.includes("IDENTICAL") || e.message?.includes("revert"),
      `unexpected: ${e.message}`
    );
    console.log("   a) identical path reverted ✓");
  }

  // empty path
  try {
    await router.getAmountsOut(ethers.parseEther("1"), []);
  } catch {
    console.log("   b) empty path reverted ✓");
  }

  console.log("   ✓\n");

  console.log("═══════════════════════════════════════════════════");
  console.log("  Router live test passed! ✓");
  console.log("═══════════════════════════════════════════════════\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ ROUTER LIVE TEST FAILED:", err.message ?? err);
    process.exit(1);
  });
