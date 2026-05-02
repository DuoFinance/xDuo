import { ethers } from "ethers";

async function getTokenBalance() {
  const provider = new ethers.JsonRpcProvider("http://192.168.147.132:8545");
  const tokenAddress = "0xf592382308678DF0D08cF7827523EA6fD9cec88F"; 
  const walletAddress = "0x6407D8268aD97C808Ee33f72f57d3476cd5C3954";
  const abi = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)"
  ];

  const contract = new ethers.Contract(tokenAddress, abi, provider);

  try {
    const [balance, decimals, symbol, totalSupply] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals(),
      contract.symbol(),
      contract.totalSupply()
    ]);

    console.log(`: ${ethers.formatUnits(balance, decimals)} ${symbol}`);
    console.log(`: ${ethers.formatUnits(totalSupply, decimals)} ${symbol}`);
  } catch (error) {
    console.error("，:", error);
  }
}

getTokenBalance();