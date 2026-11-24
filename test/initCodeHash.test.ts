import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

describe("UniswapV2Library init code hash", function () {
  it("matches the compiled UniswapV2Pair creation bytecode", async function () {
    const pairFactory = await ethers.getContractFactory("UniswapV2Pair");
    const actual = ethers.keccak256(pairFactory.bytecode);

    const libraryPath = path.join(
      __dirname,
      "..",
      "contracts",
      "libraries",
      "UniswapV2Library.sol"
    );
    const source = fs.readFileSync(libraryPath, "utf8");
    const match = source.match(/function pairFor[\s\S]*?hex'([0-9a-fA-F]{64})'/);

    expect(match, "init code hash literal not found in UniswapV2Library.sol").to.not.be.null;
    expect(actual).to.equal(`0x${match![1].toLowerCase()}`);
  });
});
