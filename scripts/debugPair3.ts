import { ethers } from "hardhat";

async function main() {
  const [d] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("contracts/pump/PumpToken.sol:PumpToken");

  // Deploy Uniswap
  const weth = await (await ethers.getContractFactory("contracts/Weth9.sol:WETH9")).deploy();
  const factory = await (await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory")).deploy(d.address);
  await weth.waitForDeployment();
  await factory.waitForDeployment();
  const fAddr = await factory.getAddress();
  const wAddr = await weth.getAddress();

  // Deploy two tokens
  const tokA = await Token.deploy("A", "A", 18, ethers.parseEther("1000000"), d.address);
  const tokB = await Token.deploy("B", "B", 18, ethers.parseEther("1000000"), d.address);
  await tokA.waitForDeployment();
  await tokB.waitForDeployment();
  const aAddr = await tokA.getAddress();
  const bAddr = await tokB.getAddress();
  console.log("A:", aAddr, "B:", bAddr);

  // Sort tokens
  const [t0, t1] = aAddr.toLowerCase() < bAddr.toLowerCase() ? [aAddr, bAddr] : [bAddr, aAddr];
  console.log("sorted:", t0, t1);

  // Hash and compute create2 address in JS
  const salt = ethers.solidityPackedKeccak256(["address", "address"], [t0, t1]);
  const initCodeHash = "0xbbbb25d7dbd3ac53985ee4587c020269570d6f99ec2613ae13fe973a2ffbf2f5";
  
  const computed = ethers.getAddress(
    "0x" + ethers.solidityPackedKeccak256(
      ["bytes1", "address", "bytes32", "bytes32"],
      ["0xff", fAddr, salt, initCodeHash]
    ).slice(26)
  );
  console.log("Computed pairFor:", computed);

  // Create pair via factory
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
  console.log("Actual pair:", actualPair);
  console.log("Match:", actualPair.toLowerCase() === computed.toLowerCase());

  // Check code at both addresses
  const codeA = await ethers.provider.getCode(actualPair);
  const codeC = await ethers.provider.getCode(computed);
  console.log("Actual code:", codeA.length, "chars");
  console.log("Computed code:", codeC.length, "chars");

  // Also compute from actual bytecode
  const pairArtifact = require("../artifacts/contracts/UniswapV2Pair.sol/UniswapV2Pair.json");
  const actualHash = ethers.keccak256(pairArtifact.bytecode);
  console.log("\nArtifact bytecode hash:", actualHash);
  console.log("Library hash:        ", initCodeHash);
  console.log("Hash match:", actualHash === initCodeHash);

  // Now with WETH
  console.log("\n--- With WETH ---");
  const tokC = await Token.deploy("C", "C", 18, ethers.parseEther("1000000"), d.address);
  await tokC.waitForDeployment();
  const cAddr = await tokC.getAddress();
  
  // Sort
  const [w0, w1] = cAddr.toLowerCase() < wAddr.toLowerCase() ? [cAddr, wAddr] : [wAddr, cAddr];
  const wSalt = ethers.solidityPackedKeccak256(["address", "address"], [w0, w1]);
  const wComputed = ethers.getAddress(
    "0x" + ethers.solidityPackedKeccak256(
      ["bytes1", "address", "bytes32", "bytes32"],
      ["0xff", fAddr, wSalt, initCodeHash]
    ).slice(26)
  );
  console.log("Computed pairFor:", wComputed);

  const tx2 = await factory.createPair(cAddr, wAddr);
  const r2 = await tx2.wait();
  let actualPair2 = "";
  for (const l of r2!.logs) {
    try {
      const p = eventIface.parseLog(l);
      if (p?.name === "PairCreated") actualPair2 = p.args.pair;
    } catch {}
  }
  console.log("Actual pair:", actualPair2);
  console.log("Match:", actualPair2.toLowerCase() === wComputed.toLowerCase());
}

main().catch(e => { console.error(e?.message?.slice(0,200)); process.exit(1); });
