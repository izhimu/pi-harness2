import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HostType, HarnessPaths } from "./types.js";

export interface HostInfo {
  host: HostType;
  projectConfigDir: string;
  userConfigDir: string;
}

export interface DetectHostOptions {
  /** Overrides the user home directory (used by tests to fake dual-host setups). */
  userHome?: string;
}

function createHostInfo(host: HostType, cwd: string, userHome: string): HostInfo {
  const dirName = host === "omp" ? ".omp" : ".pi";
  return {
    host,
    projectConfigDir: path.join(cwd, dirName),
    userConfigDir: path.join(userHome, dirName, "agent"),
  };
}

/**
 * Cheap disambiguation for machines that have BOTH ~/.pi and ~/.omp: hosts encode
 * the session directory name from the cwd (path separators become dashes). A
 * normalized directory-name match nominates a candidate; the candidate is then
 * confirmed by reading a session header and comparing the recorded cwd, so
 * punctuation-sibling paths (ca_veman vs caveman) cannot cross-match.
 */
function readRecordedCwd(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    let bytes: number;
    const buf = Buffer.alloc(8192);
    try {
      bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const sessionLine = buf.subarray(0, bytes).toString("utf-8").split("\n").find((l) => l.includes('"type":"session"'));
    if (!sessionLine) return undefined;
    const cwd = (JSON.parse(sessionLine) as { cwd?: string }).cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

const disambiguationCache = new Map<string, boolean>();

function hasSessionDirForCwd(userHome: string, host: HostType, cwd: string): boolean {
  const cacheKey = `${userHome}|${host}|${cwd}`;
  const cached = disambiguationCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const sessionsRoot = path.join(userHome, host === "omp" ? ".omp" : ".pi", "agent", "sessions");
  let result = false;
  try {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const want = normalize(cwd);
    const candidates = fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && normalize(d.name) === want);
    let verifiable = false;
    for (const dir of candidates) {
      const dirPath = path.join(sessionsRoot, dir.name);
      let files: string[];
      try {
        files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")).sort().reverse();
      } catch {
        continue;
      }
      for (const name of files.slice(0, 5)) {
        const recorded = readRecordedCwd(path.join(dirPath, name));
        if (recorded === undefined) continue;
        verifiable = true;
        if (samePath(recorded, cwd)) {
          result = true;
          break;
        }
      }
      if (result) break;
    }
    // Empty/unreadable dirs keep the old normalized-match heuristic
    if (!result && !verifiable && candidates.length > 0) result = true;
  } catch {
    result = false;
  }
  if (disambiguationCache.size > 64) disambiguationCache.clear();
  disambiguationCache.set(cacheKey, result);
  return result;
}

export function detectHost(cwd: string, options?: DetectHostOptions): HostInfo {
  const userHome = options?.userHome ?? os.homedir();

  // 1. Explicit override
  const envOverride = process.env.PI_HARNESS_HOST_OVERRIDE;
  if (envOverride === "omp" || envOverride === "pi") {
    return createHostInfo(envOverride, cwd, userHome);
  }

  // 2. Active runtime process signals (exact executable names only — substring
  // matching would fire on paths like "compose" or "example")
  if (process.env.PI_CODING_AGENT === "true" || process.env.AI_AGENT === "pi") {
    return createHostInfo("pi", cwd, userHome);
  }
  if (process.env.OMP_PROFILE !== undefined) {
    return createHostInfo("omp", cwd, userHome);
  }
  const exeNames = process.argv.slice(0, 2).map((a) => path.basename(a).toLowerCase());
  if (exeNames.some((n) => n === "omp" || n === "omp.exe" || n === "omp.cmd" || n === "omp.ps1")) {
    return createHostInfo("omp", cwd, userHome);
  }

  // 3. Project-level directory probe
  if (fs.existsSync(path.join(cwd, ".omp"))) {
    return createHostInfo("omp", cwd, userHome);
  }
  if (fs.existsSync(path.join(cwd, ".pi"))) {
    return createHostInfo("pi", cwd, userHome);
  }

  // 4. User-level probe. When only one host is installed there, it wins. When
  // both exist, prefer whichever host actually has session recordings for this cwd.
  const ompUser = fs.existsSync(path.join(userHome, ".omp"));
  const piUser = fs.existsSync(path.join(userHome, ".pi"));
  if (ompUser && !piUser) {
    return createHostInfo("omp", cwd, userHome);
  }
  if (ompUser && piUser) {
    const ompMatch = hasSessionDirForCwd(userHome, "omp", cwd);
    const piMatch = hasSessionDirForCwd(userHome, "pi", cwd);
    if (ompMatch && !piMatch) return createHostInfo("omp", cwd, userHome);
    if (piMatch && !ompMatch) return createHostInfo("pi", cwd, userHome);
  }

  // 5. Default fallback
  return createHostInfo("pi", cwd, userHome);
}

export function getHarnessPaths(hostInfo: HostInfo): HarnessPaths {
  const harnessBase = path.join(hostInfo.projectConfigDir, "harness");
  return {
    harnessDir: harnessBase,
    reportsDir: path.join(harnessBase, "reports"),
    ledgerFile: path.join(harnessBase, "ledger.json"),
    settingsFile: path.join(harnessBase, "settings.json"),
  };
}
