import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HostType, HarnessPaths } from "./types.js";

export interface HostInfo {
  host: HostType;
  projectConfigDir: string;
  userConfigDir: string;
}

function createHostInfo(host: HostType, cwd: string): HostInfo {
  const dirName = host === "omp" ? ".omp" : ".pi";
  return {
    host,
    projectConfigDir: path.join(cwd, dirName),
    userConfigDir: path.join(os.homedir(), dirName, "agent"),
  };
}

export function detectHost(cwd: string): HostInfo {
  // 1. Explicit override
  const envOverride = process.env.PI_HARNESS_HOST_OVERRIDE;
  if (envOverride === "omp" || envOverride === "pi") {
    return createHostInfo(envOverride, cwd);
  }

  // 2. Active runtime process signals
  if (process.env.PI_CODING_AGENT === "true" || process.env.AI_AGENT === "pi") {
    return createHostInfo("pi", cwd);
  }
  if (process.env.OMP_PROFILE !== undefined || process.argv.some((a) => a.includes("omp"))) {
    return createHostInfo("omp", cwd);
  }

  // 3. Project-level directory probe
  if (fs.existsSync(path.join(cwd, ".omp"))) {
    return createHostInfo("omp", cwd);
  }
  if (fs.existsSync(path.join(cwd, ".pi"))) {
    return createHostInfo("pi", cwd);
  }

  // 4. User-level directory probe
  if (fs.existsSync(path.join(os.homedir(), ".omp"))) {
    return createHostInfo("omp", cwd);
  }

  // 5. Default fallback
  return createHostInfo("pi", cwd);
}

export function getHarnessPaths(hostInfo: HostInfo): HarnessPaths {
  const harnessBase = path.join(hostInfo.projectConfigDir, "harness");
  return {
    harnessDir: harnessBase,
    reportsDir: path.join(harnessBase, "reports"),
    ledgerFile: path.join(harnessBase, "ledger.json"),
  };
}
