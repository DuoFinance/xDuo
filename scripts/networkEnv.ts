const NETWORK_ENV_PREFIX: Record<string, string> = {
  legacy:"OS_LEGACY_",
  neoxTestnet: "OS_TESTNET_",
  neoxMainnet: "OS_MAINNET_"
};

function normalize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getEnvByNetwork(networkName: string, key: string): string | undefined {
  const prefix = NETWORK_ENV_PREFIX[networkName];
  if (prefix) {
    const scoped = normalize(process.env[`${prefix}${key}`]);
    if (scoped !== undefined) return scoped;
  }
  return normalize(process.env[`OS_${key}`]);
}

export function requireEnvByNetwork(networkName: string, key: string): string {
  const value = getEnvByNetwork(networkName, key);
  if (!value) {
    throw new Error(
      `Missing ${key} for network "${networkName}". Set ${NETWORK_ENV_PREFIX[networkName] ?? "OS_"}${key} or OS_${key} in .env.`
    );
  }
  return value;
}

