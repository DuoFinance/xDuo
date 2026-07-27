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
      "contracts/Weth9.sol": {
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
      "contracts/DuoToken.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/DuoSwapStaking.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/DuoSwapStakingFactory.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/DuoTokenDeployer.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/DuoBondingCurve.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/DuoBondingCurveFactory.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 } }
      },
      "contracts/duoLaunch/DuoLaunch.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true }
      },
      "contracts/duoLaunch/IDuo.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true }
      },
      "contracts/duoLaunch/TokenTemplate.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true }
      },
      "contracts/duoLaunch/CurveMath.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true }
      },
      "contracts/duoLaunch/Constants.sol": {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true }
      }
    }
  },
  networks: {
    hardhat: {},
    anvil: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
      accounts: [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      ],
    },
    legacy: networkConfig(CHAIN_CONFIGS.legacy),
    neoxTestnet: networkConfig(CHAIN_CONFIGS.neoxTestnet),
    neoxMainnet: networkConfig(CHAIN_CONFIGS.neoxMainnet)
  }
};

export default config;
