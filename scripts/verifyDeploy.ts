import fs from "fs";
import path from "path";
import hre, { ethers } from "hardhat";
import {
  X_LEGACY_FILE,
  X_MODE_FILES,
  findUiDeployedContractsDir,
  loadDeployedAddresses,
  xModeForNetwork,
} from "./xContracts";

/**
 * 校验 NeoX 三件套部署同步:
 *   1. deployed.<network>.json 的 FACTORY/ROUTER/BONDING 合法;
 *   2. 链上真的有代码 (默认开启, `--offline` 关闭);
 *   3. Router.factory == FACTORY, DuoLaunch.uniswapFactory == FACTORY,
 *      DuoLaunch.weth == WGAS (记录里有 WGAS 时);
 *   4. ui-v2 x_contracts.<mode>.json 与记录全等;
 *   5. ui-v2 x_contracts.json 必须等于 selfnet 记录 (公网部署不能覆盖它).
 *
 * 用法: npx hardhat run scripts/verifyDeploy.ts --network <anvil|neoxTestnet|neoxMainnet>
 *       X_VERIFY_OFFLINE=1 ...  仅校验文件, 不访问 RPC
 */

const CORE_KEYS = ["FACTORY", "ROUTER", "BONDING"] as const;
const HASH = /^0x[0-9a-fA-F]{40}$/;
const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

function readJson(file: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : null;
  } catch {
    return null;
  }
}

function coreDiffs(
  a: Record<string, string>,
  b: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const key of CORE_KEYS) {
    if (lower(a[key]) !== lower(b[key])) {
      out.push(`${key}: ${a[key] || "(空)"} != ${b[key] || "(空)"}`);
    }
  }
  return out;
}

async function main() {
  const mode = xModeForNetwork(hre.network.name);
  if (!mode) {
    console.log(
      `[verifyDeploy] skip: ephemeral network "${hre.network.name}" has no ui-v2 mode file`,
    );
    return;
  }
  const offline = process.env.X_VERIFY_OFFLINE === "1";
  const failures: string[] = [];
  const log = (line: string) => console.log(line);

  console.log(`[verifyDeploy] 网络: ${hre.network.name} -> mode ${mode}`);
  const record = loadDeployedAddresses(hre.network.name);

  for (const key of CORE_KEYS) {
    const value = String(record[key] ?? "").trim();
    if (!HASH.test(value)) {
      failures.push(`deployed 记录 ${key} 缺失或非法: ${value || "(空)"}`);
    }
  }

  if (!offline) {
    for (const key of CORE_KEYS) {
      const value = String(record[key] ?? "").trim();
      if (!HASH.test(value)) continue;
      const code = await ethers.provider.getCode(value);
      if (!code || code === "0x") {
        failures.push(`链上无代码 ${key}=${value}`);
      } else {
        log(`[verifyDeploy] on-chain 存在 OK ${key}=${value}`);
      }
    }

    if (HASH.test(record.FACTORY ?? "") && HASH.test(record.ROUTER ?? "")) {
      const router = new ethers.Contract(record.ROUTER, [
        "function factory() view returns (address)",
      ], ethers.provider);
      try {
        const factory = await router.factory();
        if (lower(factory) !== lower(record.FACTORY)) {
          failures.push(
            `Router.factory() = ${factory}, 记录 FACTORY = ${record.FACTORY}`,
          );
        } else {
          log("[verifyDeploy] Router.factory() OK");
        }
      } catch (e) {
        failures.push(
          `Router.factory() 读取失败: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    if (HASH.test(record.BONDING ?? "")) {
      const launch = new ethers.Contract(record.BONDING, [
        "function uniswapFactory() view returns (address)",
        "function weth() view returns (address)",
      ], ethers.provider);
      try {
        const factory = await launch.uniswapFactory();
        if (lower(factory) !== lower(record.FACTORY)) {
          failures.push(
            `DuoLaunch.uniswapFactory() = ${factory}, 记录 FACTORY = ${record.FACTORY}`,
          );
        } else {
          log("[verifyDeploy] DuoLaunch.uniswapFactory() OK");
        }
      } catch (e) {
        failures.push(
          `DuoLaunch.uniswapFactory() 读取失败: ${e instanceof Error ? e.message : e}`,
        );
      }
      if (record.WGAS && HASH.test(record.WGAS)) {
        try {
          const weth = await launch.weth();
          if (lower(weth) !== lower(record.WGAS)) {
            failures.push(
              `DuoLaunch.weth() = ${weth}, 记录 WGAS = ${record.WGAS}`,
            );
          } else {
            log("[verifyDeploy] DuoLaunch.weth() OK");
          }
        } catch (e) {
          failures.push(
            `DuoLaunch.weth() 读取失败: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    }
  }

  // ui-v2 模式文件
  const uiDir = findUiDeployedContractsDir();
  const modeFile = X_MODE_FILES[mode];
  const modePath = path.join(uiDir, modeFile);
  const modeJson = readJson(modePath);
  if (!modeJson) {
    failures.push(`ui-v2 模式文件不可读: ${modePath}`);
  } else {
    const diffs = coreDiffs(record, modeJson);
    if (diffs.length > 0) {
      failures.push(
        `ui-v2 ${modeFile} 与 deployed 记录不一致:\n  - ${diffs.join("\n  - ")}`,
      );
    } else {
      log(`[verifyDeploy] ui-v2 ${modeFile} 全等 OK`);
    }
  }

  // ui-v2 selfnet 回退文件
  const selfnet = readJson(path.join(uiDir, X_MODE_FILES.selfnet));
  const legacy = readJson(path.join(uiDir, X_LEGACY_FILE));
  if (!legacy) {
    failures.push(`ui-v2 ${X_LEGACY_FILE} 不可读`);
  } else if (!selfnet) {
    failures.push(
      `ui-v2 ${X_MODE_FILES.selfnet} 不可读, 无法校验 ${X_LEGACY_FILE}`,
    );
  } else {
    const diffs = coreDiffs(selfnet, legacy);
    if (diffs.length > 0) {
      failures.push(
        `ui-v2 ${X_LEGACY_FILE} 必须等于 selfnet 记录:\n  - ${diffs.join("\n  - ")}`,
      );
    } else {
      log(`[verifyDeploy] ui-v2 ${X_LEGACY_FILE} = selfnet OK`);
    }
  }

  // 跨模式串档
  const modes = ["selfnet", "testnet", "mainnet"] as const;
  for (const other of modes) {
    if (other === mode) continue;
    const otherJson = readJson(path.join(uiDir, X_MODE_FILES[other]));
    if (!otherJson) continue;
    const hasCore = CORE_KEYS.every(
      (k) => HASH.test(String(otherJson[k] ?? "").trim()),
    );
    if (!hasCore) continue;
    if (coreDiffs(record, otherJson).length === 0 && CORE_KEYS.every((k) => HASH.test(String(record[k] ?? "").trim()))) {
      failures.push(`${mode} 与 ${other} 三件套完全相同, 疑似串档`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n[verifyDeploy] 失败 (${failures.length}):`);
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "\n[verifyDeploy] 全部通过: deployed 记录、ui-v2、legacy、链上状态一致.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
