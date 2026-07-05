import { ethers } from "hardhat";

async function main() {
  const [d] = await ethers.getSigners();
  // Use PumpToken as a test ERC20
  const Token = await ethers.getContractFactory("contracts/pump/PumpToken.sol:PumpToken");

  // Deploy Uniswap
  const weth = await (await ethers.getContractFactory("contracts/Weth9.sol:WETH9")).deploy();
  const factory = await (await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory")).deploy(d.address);
  const router = await (await ethers.getContractFactory("contracts/UniswapV2Router02.sol:UniswapV2Router02")).deploy(await factory.getAddress(), await weth.getAddress());
  await Promise.all([weth, factory, router].map(c => c.waitForDeployment()));
  const fAddr = await factory.getAddress();

  // Deploy two tokens
  const tokA = await Token.deploy("A", "A", 18, ethers.parseEther("1000000"), d.address);
  const tokB = await Token.deploy("B", "B", 18, ethers.parseEther("1000000"), d.address);
  await Promise.all([tokA, tokB].map(c => c.waitForDeployment()));
  const aAddr = await tokA.getAddress();
  const bAddr = await tokB.getAddress();
  console.log("tokenA:", aAddr);
  console.log("tokenB:", bAddr);

  // Create pair via factory
  console.log("\nCreating pair via factory...");
  const tx = await factory.createPair(aAddr, bAddr);
  const r = await tx.wait();
  const eventIface = new ethers.Interface(["event PairCreated(address indexed token0, address indexed token1, address pair, uint)"]);
  let actualPair = "";
  for (const l of r!.logs) {
    try {
      const p = eventIface.parseLog(l);
      if (p?.name === "PairCreated") actualPair = p.args.pair;
    } catch {}
  }
  console.log("Actual pair address:", actualPair);

  // Compute pairFor using a simple solidity helper
  // Deploy a tiny library wrapper
  const factoryCode = `contract Helper {
    function pairFor(address f, address a, address b) public pure returns (address) {
      address t0 = a < b ? a : b;
      address t1 = a < b ? b : a;
      return address(uint160(uint(keccak256(abi.encodePacked(hex"ff", f, keccak256(abi.encodePacked(t0, t1)), hex"${"bbbb25d7dbd3ac53985ee4587c020269570d6f99ec2613ae13fe973a2ffbf2f5"}"))))));
    }
  }`;
  const Helper = await ethers.getContractFactory(factoryCode);
  const helper = await Helper.deploy();
  await helper.waitForDeployment();
  const computed = await helper.pairFor(fAddr, aAddr, bAddr);
  console.log("Computed pairFor:", computed);
  console.log("Match:", actualPair.toLowerCase() === computed.toLowerCase());

  // Check if pairAddress has code
  const code = await ethers.provider.getCode(actualPair);
  console.log("Actual pair code length:", code.length);
  const code2 = await ethers.provider.getCode(computed);
  console.log("Computed pair code length:", code2.length);

  // Now test with WETH
  console.log("\n--- With WETH (simulating Pump graduation) ---");
  const tokC = await Token.deploy("C", "C", 18, ethers.parseEther("1000000"), d.address);
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
  
  const computed2 = await helper.pairFor(fAddr, cAddr, await weth.getAddress());
  console.log("Computed pair2:", computed2);
  console.log("Match:", actualPair2.toLowerCase() === computed2.toLowerCase());
}

main().catch(e => { console.error(e?.message?.slice(0,200)); process.exit(1); });
