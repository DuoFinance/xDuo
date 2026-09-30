import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import path from "path";

export type XDeployMode = "selfnet" | "testnet" | "mainnet";

const MODE_FILES: Record<XDeployMode, string> = {
  selfnet: "x_contracts.selfnet.json",
  testnet: "x_contracts.testnet.json",
  mainnet: "x_contracts.mainnet.json",
};

/** Single-file fallback, kept in sync with the mode file (N3 legacy pattern). */
const LEGACY_FILE = "x_contracts.json";

const isEvmAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * Hardhat network name -> ui-v2 deploy mode.
 * - anvil / localhost / legacy: local node (1337) -> selfnet file.
 * - neoxTestnet / neoxMainnet: -> testnet / mainnet file.
 * - hardhat (in-process, ephemeral) and anything unknown -> null (skip sync;
 *   those addresses vanish on exit, writing them would pollute the frontend).
 */
export function xModeForNetwork(hreNetworkName: string): XDeployMode | null {
  switch (hreNetworkName) {
    case "anvil":
    case "localhost":
    case "legacy":
      return "selfnet";
    case "neoxTestnet":
      return "testnet";
    case "neoxMainnet":
      return "mainnet";
    default:
      return null;
  }
}

/** Locate ui-v2/packages/config/src/deployedContracts by ascending from here. */
export function findUiDeployedContractsDir(): string {
  let dir = path.resolve(__dirname, "..", "..");
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(
      dir,
      "ui-v2",
      "packages",
      "config",
      "src",
      "deployedContracts",
    );
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[xContracts] ui-v2/packages/config/src/deployedContracts not found (started at ${__dirname})`,
  );
}

function loadJsonObject(file: string): Record<string, unknown> {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function atomicWriteJson(file: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, payload, "utf-8");
  renameSync(tmp, file);
  // Read-back assert: a torn or partial write must fail loudly here,
  // never surface as a silently key-dropping JSON downstream.
  const back = loadJsonObject(file);
  for (const [key, value] of Object.entries(data)) {
    if (back[key] !== value) {
      throw new Error(
        `[xContracts] read-back mismatch for "${key}" in ${file}`,
      );
    }
  }
}

/**
 * Merge partial addresses into the ui-v2 NeoX contract files for this
 * network's mode (plus the legacy single file, kept in sync as fallback).
 *
 * - Existing keys are preserved (a base-only run never wipes USDT/DUO/...).
 * - Every provided value must be a valid 0x address — invalid/empty values
 *   throw BEFORE anything is written (JSON.stringify would silently drop
 *   `undefined`, producing a valid-looking file with missing keys).
 * - Writes are atomic (tmp + rename) with a read-back assert.
 */
export function saveXContracts(
  partial: Record<string, string | undefined>,
  hreNetworkName: string,
): Record<string, string> {
  const mode = xModeForNetwork(hreNetworkName);
  if (!mode) {
    console.log(
      `[xContracts] skip ui-v2 sync (ephemeral network "${hreNetworkName}")`,
    );
    return {};
  }
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    // STAKING may be a comma-separated list of pool addresses.
    const segments = String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0 || !segments.every(isEvmAddress)) {
      throw new Error(
        `[xContracts] refusing to write invalid address for "${key}": ${JSON.stringify(value)}`,
      );
    }
    clean[key] = segments.join(",");
  }
  const dir = findUiDeployedContractsDir();
  for (const file of [MODE_FILES[mode], LEGACY_FILE]) {
    const target = path.join(dir, file);
    const merged = { ...loadJsonObject(target), ...clean };
    atomicWriteJson(target, merged);
    console.log(`[xContracts] synced ui-v2 -> ${target}`);
  }
  return clean;
}
