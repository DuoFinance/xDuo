import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import {
  X_LEGACY_FILE,
  X_MODE_FILES,
  saveDeployedAddresses,
  saveXContracts,
  xModeForNetwork,
} from "../scripts/xContracts";

/**
 * Deployment-sync regression tests.
 *
 * Call the real saveXContracts(), but point X_UI_DEPLOYED_CONTRACTS_DIR at a
 * temp dir so the repository's real ui-v2 config is never touched.
 *
 * Locks down the failure modes seen on the N3 side (2026-11 redeploy):
 *   - public deployment overwriting the selfnet fallback file;
 *   - a partial trio (only one/two addresses written);
 *   - invalid addresses silently written as valid-looking JSON.
 */

const addr = (seed: number) =>
  `0x${seed.toString(16).padStart(2, "0").repeat(20)}`;

const ANVIL = {
  FACTORY: addr(0x51),
  ROUTER: addr(0x52),
  BONDING: addr(0x53),
};
const TESTNET = {
  FACTORY: addr(0x61),
  ROUTER: addr(0x62),
  BONDING: addr(0x63),
};
const MAINNET = {
  FACTORY: addr(0x71),
  ROUTER: addr(0x72),
  BONDING: addr(0x73),
};

let tmpDir = "";
let previous: string | undefined;
let prevDeployedDir: string | undefined;
let deployedDir = "";

function read(name: string): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDir, name), "utf8"),
  ) as Record<string, string>;
}

function exists(name: string): boolean {
  return fs.existsSync(path.join(tmpDir, name));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-sync-"));
  deployedDir = path.join(tmpDir, "deployed");
  fs.mkdirSync(deployedDir, { recursive: true });
  previous = process.env.X_UI_DEPLOYED_CONTRACTS_DIR;
  prevDeployedDir = process.env.X_DEPLOYED_DIR;
  process.env.X_UI_DEPLOYED_CONTRACTS_DIR = tmpDir;
  process.env.X_DEPLOYED_DIR = deployedDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.X_UI_DEPLOYED_CONTRACTS_DIR;
  else process.env.X_UI_DEPLOYED_CONTRACTS_DIR = previous;
  if (prevDeployedDir === undefined) delete process.env.X_DEPLOYED_DIR;
  else process.env.X_DEPLOYED_DIR = prevDeployedDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("xContracts ui-v2 sync", () => {
  it("anvil (selfnet) writes the mode file and the legacy fallback", () => {
    saveXContracts(ANVIL, "anvil");

    expect(read(X_MODE_FILES.selfnet)).to.deep.equal(ANVIL);
    expect(read(X_LEGACY_FILE)).to.deep.equal(ANVIL);
    expect(exists(X_MODE_FILES.testnet)).to.equal(false);
    expect(exists(X_MODE_FILES.mainnet)).to.equal(false);
  });

  it("testnet writes only the testnet file, never the selfnet fallback", () => {
    saveXContracts(ANVIL, "anvil");
    saveXContracts(TESTNET, "neoxTestnet");

    expect(read(X_MODE_FILES.testnet)).to.deep.equal(TESTNET);
    expect(read(X_MODE_FILES.selfnet)).to.deep.equal(ANVIL);
    expect(read(X_LEGACY_FILE)).to.deep.equal(ANVIL);
  });

  it("mainnet writes only the mainnet file, never the selfnet fallback", () => {
    saveXContracts(ANVIL, "anvil");
    saveXContracts(MAINNET, "neoxMainnet");

    expect(read(X_MODE_FILES.mainnet)).to.deep.equal(MAINNET);
    expect(read(X_MODE_FILES.selfnet)).to.deep.equal(ANVIL);
    expect(read(X_LEGACY_FILE)).to.deep.equal(ANVIL);
  });

  it("keeps keys written by other deploy scripts (e.g. USDT)", () => {
    saveXContracts({ ...ANVIL, USDT: addr(0x54) }, "anvil");
    saveXContracts({ BONDING: addr(0x59) }, "anvil");

    const file = read(X_MODE_FILES.selfnet);
    expect(file.FACTORY).to.equal(ANVIL.FACTORY);
    expect(file.ROUTER).to.equal(ANVIL.ROUTER);
    expect(file.BONDING).to.equal(addr(0x59));
    expect(file.USDT).to.equal(addr(0x54));
  });

  it("rejects invalid addresses before writing anything", () => {
    expect(() =>
      saveXContracts({ FACTORY: "0x1234", ROUTER: ANVIL.ROUTER }, "anvil"),
    ).to.throw(/refusing to write invalid address/);
    expect(exists(X_MODE_FILES.selfnet)).to.equal(false);
    expect(exists(X_LEGACY_FILE)).to.equal(false);
  });

  it("skips ephemeral networks (hardhat) entirely", () => {
    expect(xModeForNetwork("hardhat")).to.equal(null);
    expect(saveXContracts(ANVIL, "hardhat")).to.deep.equal({});
    expect(
      fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json")),
    ).to.deep.equal([]);
  });

  it("first public deploy tolerates a 0-byte deployed record file", () => {
    const record = path.join(deployedDir, "deployed.testnet.json");
    fs.writeFileSync(record, "");

    saveDeployedAddresses(TESTNET, "neoxTestnet");

    const saved = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(saved.FACTORY).to.equal(TESTNET.FACTORY);
    expect(saved.ROUTER).to.equal(TESTNET.ROUTER);
    expect(saved.BONDING).to.equal(TESTNET.BONDING);
    expect(read(X_MODE_FILES.testnet)).to.deep.equal(TESTNET);
    expect(exists(X_LEGACY_FILE)).to.equal(false);
  });
});
