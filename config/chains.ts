export type TxType = "auto" | "legacy" | "eip1559";
export type ChainKey = "anvil" | "neoxTestnet" | "neoxMainnet";

export type ChainConfig = {
  name: string;
  chainId: number;
  rpcUrl: string;
  antiMevRpcUrl: string;
  explorerBaseUrl: string;
  deployerPrivateKey: string;
  wgasAddress: string;
  txType: TxType;
  gasPriceGwei?: string;
  maxFeePerGasGwei?: string;
  maxPriorityFeePerGasGwei?: string;
};

function normalize(value: string | undefined): string {
  return value?.trim() ?? "";
}

function parseTxType(value: string | undefined): TxType {
  const normalized = normalize(value).toLowerCase();
  if (normalized === "legacy" || normalized === "eip1559") {
    return normalized;
  }
  return "auto";
}

function buildChainConfig(
  name: string,
  prefix: string,
  fallbackPrefix?: string
): ChainConfig {
  const read = (key: string): string => {
    const primary = normalize(process.env[`${prefix}${key}`]);
    if (primary) return primary;
    if (!fallbackPrefix) return "";
    return normalize(process.env[`${fallbackPrefix}${key}`]);
  };

  return {
    name,
    chainId: Number(read("CHAIN_ID") || 0),
    rpcUrl: read("RPC_URL"),
    antiMevRpcUrl: read("ANTI_MEV_RPC_URL"),
    explorerBaseUrl: read("EXPLORER_BASE_URL"),
    deployerPrivateKey: read("DEPLOYER_PRIVATE_KEY"),
    wgasAddress: read("WGAS_ADDRESS"),
    txType: parseTxType(read("TX_TYPE")),
    gasPriceGwei: read("GAS_PRICE_GWEI") || undefined,
    maxFeePerGasGwei: read("MAX_FEE_PER_GAS_GWEI") || undefined,
    maxPriorityFeePerGasGwei: read("MAX_PRIORITY_FEE_PER_GAS_GWEI") || undefined
  };
}

export const CHAIN_CONFIGS: Record<ChainKey, ChainConfig> = {
  anvil: {
    name: "Anvil (NeoX mainnet fork)",
    chainId: Number(normalize(process.env.ANVIL_CHAIN_ID) || 1337),
    rpcUrl: normalize(process.env.ANVIL_RPC_URL) || "http://127.0.0.1:8545",
    antiMevRpcUrl: "",
    explorerBaseUrl: normalize(process.env.ANVIL_EXPLORER_BASE_URL),
    deployerPrivateKey: normalize(process.env.ANVIL_DEPLOYER_PRIVATE_KEY),
    wgasAddress:
      normalize(process.env.ANVIL_WGAS_ADDRESS) ||
      normalize(process.env.NEOX_MAINNET_WGAS_ADDRESS),
    txType: parseTxType(process.env.ANVIL_TX_TYPE),
    gasPriceGwei: normalize(process.env.ANVIL_GAS_PRICE_GWEI) || undefined,
    maxFeePerGasGwei:
      normalize(process.env.ANVIL_MAX_FEE_PER_GAS_GWEI) || undefined,
    maxPriorityFeePerGasGwei:
      normalize(process.env.ANVIL_MAX_PRIORITY_FEE_PER_GAS_GWEI) || undefined,
  },
  neoxTestnet: buildChainConfig("NeoX Testnet", "NEOX_TESTNET_", "NEOX_"),
  neoxMainnet: buildChainConfig("NeoX Mainnet", "NEOX_MAINNET_", "NEOX_")
};

const NETWORK_TO_CHAIN_KEY: Record<string, ChainKey> = {
  anvil: "anvil",
  neoxTestnet: "neoxTestnet",
  neoxMainnet: "neoxMainnet"
};

export function resolveChainByNetwork(networkName: string): ChainConfig {
  if (networkName === "hardhat") {
    return CHAIN_CONFIGS.anvil;
  }
  const chainKey = NETWORK_TO_CHAIN_KEY[networkName];
  if (!chainKey) {
    throw new Error(`Unsupported network "${networkName}".`);
  }
  return CHAIN_CONFIGS[chainKey];
}

export function getRpcUrl(chain: ChainConfig): string {
  return chain.antiMevRpcUrl || chain.rpcUrl;
}
