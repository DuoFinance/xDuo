import { ethers } from "ethers";

const FACTORY_ADDRESS = "0x32206320dE47aa694Af784211cfEff2f57761F3e";

const ABIS = [
  "function allPairsLength() external view returns (uint)",
  "function allPairs(uint) external view returns (address)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

async function main() {
 
  const provider = new ethers.JsonRpcProvider("http://192.168.147.132:8545");

  const factory = new ethers.Contract(FACTORY_ADDRESS, ABIS, provider);


  const totalPairs = Number(await factory.allPairsLength());
  console.log(`🚀 : ${totalPairs}`);


  const limit = 10;
  const start = totalPairs > limit ? totalPairs - limit : 0;

  console.log(`---  Index ${start}  ${totalPairs - 1} ---`);

  const results = [];

  for (let i = start; i < totalPairs; i++) {
   
    const pairAddress = await factory.allPairs(i);
    const pairContract = new ethers.Contract(pairAddress, ABIS, provider);
    const [token0, token1] = await Promise.all([
      pairContract.token0(),
      pairContract.token1()
    ]);

    results.push({
      index: i,
      pair: pairAddress,
      token0: token0,
      token1: token1
    });

    console.log(`✅ [${i}] Pair: ${pairAddress} | T0: ${token0} | T1: ${token1}`);
  }

  console.table(results);
}

main().catch(console.error);