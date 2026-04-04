export type TxType = "auto" | "legacy" | "eip1559";
export type ChainKey = "legacy" | "neoxTestnet" | "neoxMainnet";

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
  legacy: buildChainConfig("Legacy", "LEGACY_"),
  neoxTestnet: buildChainConfig("NeoX Testnet", "NEOX_TESTNET_", "NEOX_"),
  neoxMainnet: buildChainConfig("NeoX Mainnet", "NEOX_MAINNET_", "NEOX_")
};

const NETWORK_TO_CHAIN_KEY: Record<string, ChainKey> = {
  legacy: "legacy",
  neoxTestnet: "neoxTestnet",
  neoxMainnet: "neoxMainnet"
};

export function resolveChainByNetwork(networkName: string): ChainConfig {
  return CHAIN_CONFIGS[NETWORK_TO_CHAIN_KEY[networkName] ?? "legacy"];
}

export function getRpcUrl(chain: ChainConfig): string {
  return chain.antiMevRpcUrl || chain.rpcUrl;
}
