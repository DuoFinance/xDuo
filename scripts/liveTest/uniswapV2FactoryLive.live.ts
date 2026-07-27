import hre from "hardhat";
const { ethers } = hre;
import assert from "assert";
import * as fs from "fs";
import path from "path";

const FACTORY_IFACE = "contracts/interfaces/IUniswapV2Factory.sol:IUniswapV2Factory";
const PAIR_IFACE    = "contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair";

async function main() {
  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..","deployed.json"), "utf8")
  );
  const network = hre.network.name;

  console.log("═══════════════════════════════════════════════════");
  console.log(`  Uniswap V2 Factory Live Test — ${network}`);
  console.log("═══════════════════════════════════════════════════\n");

  const [deployer] = await ethers.getSigners();
  console.log("Signer:", deployer.address);
  console.log("Balance:", ethers.formatEther(
    await ethers.provider.getBalance(deployer.address)
  ), "\n");

  // 0 ── RPC connectivity
  console.log("0. RPC connectivity...");
  const networkName = hre.network.name;
  const block = await ethers.provider.getBlockNumber();
  assert.ok(!isNaN(block) && block >= 0, `Invalid block number: ${block} on ${networkName}`);
  console.log(`   Network: ${networkName}, Block: ${block} ✓\n`);

  // 1 ── Connect to Factory
  console.log("1. Connecting to Factory...");
  const code = await ethers.provider.getCode(deployed.factory);
  assert.notStrictEqual(code, "0x", `No bytecode at ${deployed.factory}. Run with --network <network> where the contracts are deployed (e.g. anvil, neoxTestnet, legacy)`);
  const factory = await ethers.getContractAt(FACTORY_IFACE, deployed.factory);
  const fAddr = await factory.getAddress();
  assert.strictEqual(fAddr.toLowerCase(), deployed.factory.toLowerCase());
  console.log(`   Factory: ${fAddr} ✓\n`);

  // 2 ── Configuration
  console.log("2. Configuration...");
  const feeTo       = await factory.feeTo();
  const feeToSetter = await factory.feeToSetter();
  console.log(`   feeTo      : ${feeTo || "0x0 (disabled)"}`);
  console.log(`   feeToSetter: ${feeToSetter}`);
  assert.strictEqual(
    feeToSetter.toLowerCase(),
    deployer.address.toLowerCase(),
    "feeToSetter must match deployer"
  );
  console.log("   ✓\n");

  // 3 ── Enumerate all pairs
  console.log("3. Enumerating pairs...");
  const len = Number(await factory.allPairsLength());
  console.log(`   Total pairs: ${len}`);

  for (let i = 0; i < len; i++) {
    const pAddr = await factory.allPairs(i);
    const pair  = await ethers.getContractAt(PAIR_IFACE, pAddr);

    const t0 = await pair.token0();
    const t1 = await pair.token1();
    const [r0, r1] = await pair.getReserves();
    const lp  = await pair.totalSupply();
    const kLast = await pair.kLast();

    console.log(`\n   Pair #${i}:`);
    console.log(`     Address  : ${pAddr}`);
    console.log(`     token0   : ${t0}`);
    console.log(`     token1   : ${t1}`);
    console.log(`     reserves : ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);
    console.log(`     LP supply: ${ethers.formatEther(lp)}`);
    console.log(`     kLast    : ${kLast}`);

    // verify getPair round-trip
    const got = await factory.getPair(t0, t1);
    assert.strictEqual(got.toLowerCase(), pAddr.toLowerCase());
    console.log(`     getPair ✓`);
  }
  console.log("\n   Enumeration ✓\n");

  // 4 ── Non-existent pair → zero address
  console.log("4. getPair(non-existent) → 0x0...");
  const zero = await factory.getPair(
    deployed.wgas,
    "0x0000000000000000000000000000000000000001"
  );
  assert.strictEqual(zero, ethers.ZeroAddress);
  console.log("   ✓\n");

  // 5 ── feeTo setter capability (restore original afterwards)
  console.log("5. feeTo setter authorization...");
  const origFeeTo = feeTo;
  if (!origFeeTo || origFeeTo === ethers.ZeroAddress) {
    // set a dummy address then restore zero
    const dummy = "0x000000000000000000000000000000000000dEaD";
    const tx = await factory.setFeeTo(dummy);
    await tx.wait();
    const updated = await factory.feeTo();
    assert.strictEqual(updated.toLowerCase(), dummy.toLowerCase());
    console.log("   setFeeTo(dummy) ✓");

    const tx2 = await factory.setFeeTo(ethers.ZeroAddress);
    await tx2.wait();
    const restored = await factory.feeTo();
    assert.strictEqual(restored, ethers.ZeroAddress);
    console.log("   restored feeTo ✓");
  } else {
    console.log("   feeTo is non-zero, skipping set test.");
  }
  console.log("   ✓\n");

  console.log("═══════════════════════════════════════════════════");
  console.log("  Factory live test passed! ✓");
  console.log("═══════════════════════════════════════════════════\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ FACTORY LIVE TEST FAILED:", err.message ?? err);
    process.exit(1);
  });
