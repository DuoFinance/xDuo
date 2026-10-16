import hre from "hardhat";
import * as fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Frontend / deploy-script aligned address file (uppercase keys).
 * Live tests only ever read it — never write it.
 */
export const DEPLOYED_PATH = path.join(ROOT, "deployed.json");

/**
 * Local Anvil addresses produced by setupAnvil.ts. Same uppercase schema as
 * deployed.json, but git-ignored and never synced to the UI.
 */
export const ANVIL_DEPLOYED_PATH = path.join(ROOT, "deployed.anvil.json");

/** Uppercase key schema shared by deployed.json and deployed.anvil.json. */
export type DeployedAddresses = {
  FACTORY: string;
  ROUTER: string;
  BONDING: string;
  WGAS: string;
  STAKING: string;
  USDT?: string;
  DUO?: string;
  DUOGAS?: string;
  raw: Record<string, unknown>;
};

const isAddressLike = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** deployed.json carries no WGAS entry — it lives in .env per network. */
function envWgas(network: string): string | undefined {
  const candidates =
    network === "neoxTestnet"
      ? [process.env.NEOX_TESTNET_WGAS_ADDRESS, process.env.NEOX_WGAS_ADDRESS]
      : network === "neoxMainnet"
        ? [process.env.NEOX_MAINNET_WGAS_ADDRESS, process.env.NEOX_WGAS_ADDRESS]
        : network === "anvil"
          ? // Anvil forks NeoX mainnet.
            [process.env.NEOX_MAINNET_WGAS_ADDRESS, process.env.LEGACY_WGAS_ADDRESS]
          : [process.env.LEGACY_WGAS_ADDRESS];
  return candidates.find(isAddressLike);
}

/** Address file backing live tests on the given network. */
export function deployedPathFor(network: string): string {
  return network === "anvil" ? ANVIL_DEPLOYED_PATH : DEPLOYED_PATH;
}

/** Load deployed contract addresses (uppercase schema) for a network. */
export function loadDeployed(network: string = hre.network.name): DeployedAddresses {
  const file = deployedPathFor(network);
  if (!fs.existsSync(file)) {
    throw new Error(
      network === "anvil"
        ? `${file} not found — run "npm run anvil:setup" first (or "npm run test:live", which does it for you)`
        : `${file} not found — run the deploy script for network "${network}" first`,
    );
  }

  const raw = readJson(file);
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (isAddressLike(value)) return value.trim();
    }
    return undefined;
  };

  const FACTORY = pick("FACTORY");
  const ROUTER = pick("ROUTER");
  const BONDING = pick("BONDING");
  const WGAS = pick("WGAS", "WGAS_ADDRESS") ?? envWgas(network);

  const missing = (
    [
      ["FACTORY", FACTORY],
      ["ROUTER", ROUTER],
      ["BONDING", BONDING],
      ["WGAS", WGAS],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `${file} is missing address(es): ${missing.join(", ")}` +
        (missing.includes("WGAS") ? " (set *_WGAS_ADDRESS in .env)" : ""),
    );
  }

  return {
    FACTORY: FACTORY!,
    ROUTER: ROUTER!,
    BONDING: BONDING!,
    WGAS: WGAS!,
    STAKING: pick("STAKING") ?? "",
    USDT: pick("USDT"),
    DUO: pick("DUO"),
    DUOGAS: pick("DUOGAS"),
    raw,
  };
}
