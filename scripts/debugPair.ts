import { ethers } from "hardhat";

async function main() {
  const [d] = await ethers.getSigners();

  // Deploy
  const weth = await (await ethers.getContractFactory("contracts/Weth9.sol:WETH9")).deploy();
  const factory = await (await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory")).deploy(d.address);
  const router = await (await ethers.getContractFactory("contracts/UniswapV2Router02.sol:UniswapV2Router02")).deploy(await factory.getAddress(), await weth.getAddress());
  await Promise.all([weth, factory, router].map(c => c.waitForDeployment()));

  const fAddr = await factory.getAddress();
  const rAddr = await router.getAddress();

  console.log("factory:", fAddr);
  console.log("router:", rAddr);

  // Deploy two ERC20 tokens for testing
  const Token = await ethers.getContractFactory("contracts/test/TestERC20.sol:TestERC20");
  const tokA = await Token.deploy("A", "A", 18);
  const tokB = await Token.deploy("B", "B", 18);
  await Promise.all([tokA, tokB].map(c => c.waitForDeployment()));
  const aAddr = await tokA.getAddress();
  const bAddr = await tokB.getAddress();
  console.log("tokenA:", aAddr, "tokenB:", bAddr);

  // Create pair
  const tx = await factory.createPair(aAddr, bAddr);
  const r = await tx.wait();
  console.log("Pair created");

  // Get the actual pair address from the event
  const eventIface = new ethers.Interface(["event PairCreated(address indexed token0, address indexed token1, address pair, uint)"]);
  let actualPairAddr = "";
  for (const l of r!.logs) {
    try {
      const p = eventIface.parseLog(l);
      if (p?.name === "PairCreated") actualPairAddr = p.args.pair;
    } catch {}
  }
  console.log("Actual pair address (from event):", actualPairAddr);

  // Compute pairFor address
  const Library = await ethers.getContractFactory("contracts/libraries/UniswapV2Library.sol:UniswapV2Library");
  const lib = await Library.deploy();
  await lib.waitForDeployment();

  // Use a static call to compute pairFor
  // We need to deploy a small helper or use low-level call
  const pairForCode = new ethers.Interface([
    "function pairFor(address factory, address tokenA, address tokenB) pure returns (address)"
  ]);
  
  // Hardhat Network: we can use the actual deployed library
  const computedAddr = await lib.pairFor(fAddr, aAddr, bAddr);
  console.log("Computed pairFor address:", computedAddr);
  console.log("Match:", actualPairAddr.toLowerCase() === computedAddr.toLowerCase());
  
  // Check the pair has code
  const code = await ethers.provider.getCode(actualPairAddr);
  console.log("Actual pair code length:", code.length);
  const code2 = await ethers.provider.getCode(computedAddr);
  console.log("Computed pair code length:", code2.length);

  // Now test with WETH
  console.log("\n--- Test with WETH and a token ---");
  const tokC = await Token.deploy("C", "C", 18);
  await tokC.waitForDeployment();
  const cAddr = await tokC.getAddress();
  
  const tx2 = await factory.createPair(cAddr, await weth.getAddress());
  const r2 = await tx2.wait();
  let actualPair2 = "";
  for (const l of r2!.logs) {
    try {
      const p = eventIface.parseLog(l);
      if (p?.name === "PairCreated") actualPair2 = p.args.pair;
    } catch {}
  }
  console.log("Actual pair2:", actualPair2);
  
  const computed2 = await lib.pairFor(fAddr, cAddr, await weth.getAddress());
  console.log("Computed pair2:", computed2);
  console.log("Match:", actualPair2.toLowerCase() === computed2.toLowerCase());
}

main().catch(e => { console.error(e); process.exit(1); });
