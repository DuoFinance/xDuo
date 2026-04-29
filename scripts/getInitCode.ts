import { ethers } from "hardhat";

async function main() {
  const factory = await ethers.getContractFactory("UniswapV2Pair");
  const initCodeHash = ethers.keccak256(factory.bytecode);
  
  console.log("UniswapV2Pair Bytecode Hash (initCodeHash):");
  console.log(initCodeHash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});