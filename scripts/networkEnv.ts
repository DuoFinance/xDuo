const NETWORK_ENV_PREFIXES: Record<string, string[]> = {
  legacy: ["DUO_LEGACY_", "OS_LEGACY_"],
  neoxTestnet: ["DUO_TESTNET_", "OS_TESTNET_", "OS_NEOX_TESTNET_"],
  neoxMainnet: ["DUO_MAINNET_", "OS_MAINNET_", "OS_NEOX_MAINNET_"]
};

const GLOBAL_ENV_PREFIXES = ["DUO_", "OS_"];

function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getEnvByNetwork(networkName: string, key: string): string | undefined {
  for (const prefix of NETWORK_ENV_PREFIXES[networkName] ?? []) {
    const scoped = normalize(process.env[`${prefix}${key}`]);
    if (scoped !== undefined) {
      return scoped;
    }
  }

  for (const prefix of GLOBAL_ENV_PREFIXES) {
    const global = normalize(process.env[`${prefix}${key}`]);
    if (global !== undefined) {
      return global;
    }
  }

  return undefined;
}

export function requireEnvByNetwork(networkName: string, key: string): string {
  const value = getEnvByNetwork(networkName, key);
  if (!value) {
    const scopedPrefixes = NETWORK_ENV_PREFIXES[networkName] ?? [];
    throw new Error(
      `Missing ${key} for network "${networkName}". Set ${[...scopedPrefixes, ...GLOBAL_ENV_PREFIXES]
        .map((prefix) => `${prefix}${key}`)
        .join(" or ")} in .env.`
    );
  }
  return value;
}
