import { ethers } from "ethers";

async function getTokenBalance() {
  const provider = new ethers.JsonRpcProvider("http://192.168.147.132:8545");
  const tokenAddress = "0xC8A2025Ea9Bb632d6d207B9C8c637cB131c4D334"; 
  const walletAddress = "0x91fF7b766c44Fd28cB1219Bc7Ab9DfeF84D7DcC7";
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

    console.log(`Balance: ${ethers.formatUnits(balance, decimals)} ${symbol}`);
    console.log(`Total Supply: ${ethers.formatUnits(totalSupply, decimals)} ${symbol}`);
    console.log(`Decimasl: ${decimals}`)
  } catch (error) {
    console.error("Query failed, please check the contract address:", error);
  }
}

getTokenBalance();