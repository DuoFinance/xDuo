import "dotenv/config";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import { CHAIN_CONFIGS, ChainConfig, getRpcUrl } from "./config/chains";



function networkConfig(chain: ChainConfig) {
  return {
    url: getRpcUrl(chain) || "http://127.0.0.1:8545",
    chainId: chain.chainId || undefined,
    accounts: chain.deployerPrivateKey ? [chain.deployerPrivateKey] : []
  };
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.5.16",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      {
        version: "0.6.6",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      }
    ],
    overrides: {
      "contracts/UniswapV2ERC20.sol": {
        version: "0.5.16",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/UniswapV2Factory.sol": {
        version: "0.5.16",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/UniswapV2Pair.sol": {
        version: "0.5.16",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/UniswapV2Router01.sol": {
        version: "0.6.6",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/UniswapV2Router02.sol": {
        version: "0.6.6",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/OnlySwapToken.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/OnlySwapStaking.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/EvmTokenDeployer.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      }
    }
  },
  networks: {
    hardhat: {},
    legacy: networkConfig(CHAIN_CONFIGS.legacy),
    neoxTestnet: networkConfig(CHAIN_CONFIGS.neoxTestnet),
    neoxMainnet: networkConfig(CHAIN_CONFIGS.neoxMainnet)
  }
};

export default config;
