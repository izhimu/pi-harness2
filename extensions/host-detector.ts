import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HostType } from "./types.js";

export interface HostInfo {
  host: HostType;
  projectConfigDir: string;
  userConfigDir: string;
}

export function detectHost(cwd: string): HostInfo {
  const envOverride = process.env.PI_HARNESS_HOST_OVERRIDE;
  if (envOverride === "omp" || envOverride === "pi") {
    const isOmp = envOverride === "omp";
    const dirName = isOmp ? ".omp" : ".pi";
    return {
      host: envOverride,
      projectConfigDir: path.join(cwd, dirName),
      userConfigDir: path.join(os.homedir(), dirName, "agent"),
    };
  }

  // Check project-level directory
  const hasOmpProject = fs.existsSync(path.join(cwd, ".omp"));
  const hasPiProject = fs.existsSync(path.join(cwd, ".pi"));

  if (hasOmpProject) {
    return {
      host: "omp",
      projectConfigDir: path.join(cwd, ".omp"),
      userConfigDir: path.join(os.homedir(), ".omp", "agent"),
    };
  }

  if (hasPiProject) {
    return {
      host: "pi",
      projectConfigDir: path.join(cwd, ".pi"),
      userConfigDir: path.join(os.homedir(), ".pi", "agent"),
    };
  }

  // Check user-level directory
  const hasOmpUser = fs.existsSync(path.join(os.homedir(), ".omp"));
  if (hasOmpUser) {
    return {
      host: "omp",
      projectConfigDir: path.join(cwd, ".omp"),
      userConfigDir: path.join(os.homedir(), ".omp", "agent"),
    };
  }

  // Default to pi
  return {
    host: "pi",
    projectConfigDir: path.join(cwd, ".pi"),
    userConfigDir: path.join(os.homedir(), ".pi", "agent"),
  };
}
