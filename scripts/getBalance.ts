import { ethers } from "ethers";

async function getTokenBalance() {
  const provider = new ethers.JsonRpcProvider("http://192.168.147.132:8545");
  const tokenAddress = "0x74E1Eb01940a0D9D0B4aA112aC108c4d79F4F1E8"; 
  const walletAddress = "0xf1a6Bc518a5eF2D84bFfE27B86A36f7F27C88a84";
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