import { ethers } from "ethers";

async function getTokenBalance() {
  const provider = new ethers.JsonRpcProvider("http://192.168.147.132:8545");
  const tokenAddress = "0x37EB98a83440B041624DF2c89a2FC4f993d7f5fb"; 
  const walletAddress = "0x13497D5735Ae6F8eB8B5A4C469CEBeB76e2364b5";
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