import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { detectHost } from "../extensions/host-detector.js";
import { SessionTracer } from "../extensions/tracer.js";
import { SurfaceManager } from "../extensions/surface.js";
import { ImprovementLedger } from "../extensions/ledger.js";
import { ExperienceReflector } from "../extensions/reflector.js";
import { HarnessReporter } from "../extensions/reporter.js";
import type { HarnessProposal, HarnessReportData } from "../extensions/types.js";

describe("pi-harness2 test suite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness2-test-"));
    delete process.env.PI_HARNESS_HOST_OVERRIDE;
    delete process.env.PI_CODING_AGENT;
    delete process.env.AI_AGENT;
    delete process.env.OMP_PROFILE;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PI_HARNESS_HOST_OVERRIDE;
    delete process.env.PI_CODING_AGENT;
    delete process.env.AI_AGENT;
    delete process.env.OMP_PROFILE;
  });

  test("host-detector should detect omp when runtime env or .omp exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
    const hostInfo = detectHost(tmpDir);
    expect(hostInfo.host).toBe("omp");
    expect(hostInfo.projectConfigDir).toBe(path.join(tmpDir, ".omp"));
  });

  test("host-detector should prioritize PI_CODING_AGENT runtime signal", () => {
    process.env.PI_CODING_AGENT = "true";
    const hostInfo = detectHost(tmpDir);
    expect(hostInfo.host).toBe("pi");
    expect(hostInfo.projectConfigDir).toBe(path.join(tmpDir, ".pi"));
  });

  test("surface manager should use AGENTS.md for pi and RULES.md for omp", () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };
    const ompHost = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };

    const piSurface = new SurfaceManager(piHost);
    const ompSurface = new SurfaceManager(ompHost);

    expect(piSurface.getRulesFile()).toBe(path.join(tmpDir, "AGENTS.md"));
    expect(ompSurface.getRulesFile()).toBe(path.join(tmpDir, ".omp", "RULES.md"));
  });

  test("tracer should require >= 2 errors for friction and strip ANSI escape codes", () => {
    const tracer = new SessionTracer();
    tracer.record({
      toolName: "bash",
      input: { command: "bad-1" },
      outputPreview: "\x1b[31mError: command not found\x1b[0m",
      isError: true,
      durationMs: 15,
      timestamp: 1,
    });

    // 1 error should NOT trigger a friction loop
    expect(tracer.getFrictionPoints().length).toBe(0);

    tracer.record({
      toolName: "bash",
      input: { command: "bad-2" },
      outputPreview: "\x1b[31mError: syntax error\x1b[0m",
      isError: true,
      durationMs: 12,
      timestamp: 2,
    });

    // >= 2 errors triggers friction loop
    const frictions = tracer.getFrictionPoints();
    expect(frictions.length).toBe(1);
    expect(frictions[0].toolName).toBe("bash");
    expect(frictions[0].frequency).toBe(2);
    expect(frictions[0].sampleErrors[0]).toBe("Error: command not found");
  });

  test("surface manager should safely append rules without clobbering existing content", () => {
    const hostInfo = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const surface = new SurfaceManager(hostInfo);
    const ledger = new ImprovementLedger(hostInfo);
    const rulesFile = surface.getRulesFile();

    fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
    fs.writeFileSync(rulesFile, "# Existing Project Rules\n- Maintain strict types\n", "utf-8");

    const ruleProposal: HarnessProposal = {
      id: "prop-rule-1",
      component: "c2_rules",
      targetPath: rulesFile,
      summary: "Add bash precaution",
      contentDelta: "- When using bash, avoid unquoted variables\n",
      confidence: 0.8,
      status: "pending",
    };

    const applyRes = surface.applyProposal(ruleProposal);
    expect(applyRes.success).toBe(true);

    const afterContent = fs.readFileSync(rulesFile, "utf-8");
    expect(afterContent).toContain("# Existing Project Rules");
    expect(afterContent).toContain("- Maintain strict types");
    expect(afterContent).toContain("- When using bash, avoid unquoted variables");

    // Commit and rollback
    const entry = ledger.recordCommit(ruleProposal, "sess-safe", applyRes.previousContent);
    const rollbackRes = ledger.rollback(entry.id);
    expect(rollbackRes.success).toBe(true);

    const revertedContent = fs.readFileSync(rulesFile, "utf-8");
    expect(revertedContent).toBe("# Existing Project Rules\n- Maintain strict types\n");
    expect(revertedContent).not.toContain("unquoted variables");
  });

  test("surface manager and ledger should cleanly apply and rollback a skill", () => {
    const hostInfo = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const surface = new SurfaceManager(hostInfo);
    const ledger = new ImprovementLedger(hostInfo);

    const skillProposal: HarnessProposal = {
      id: "prop-skill-1",
      component: "c6_skill",
      targetPath: path.join(surface.getSkillDir(), "docker-helper", "SKILL.md"),
      summary: "Docker guide",
      contentDelta: "# Docker guide content",
      triggerLine: "- When running docker commands, load the `docker-helper` skill.",
      confidence: 0.9,
      status: "pending",
    };

    const applyRes = surface.applyProposal(skillProposal);
    expect(applyRes.success).toBe(true);
    expect(fs.existsSync(skillProposal.targetPath)).toBe(true);

    const rulesPath = surface.getRulesFile();
    expect(fs.readFileSync(rulesPath, "utf-8")).toContain("docker-helper");

    const entry = ledger.recordCommit(skillProposal, "sess-1", applyRes.previousContent);
    expect(entry.status).toBe("APPLIED");

    // Perform rollback
    const rollbackRes = ledger.rollback(entry.id);
    expect(rollbackRes.success).toBe(true);

    // Verify SKILL.md is removed
    expect(fs.existsSync(skillProposal.targetPath)).toBe(false);

    // Verify empty parent directory is removed
    expect(fs.existsSync(path.dirname(skillProposal.targetPath))).toBe(false);

    // Verify trigger line is removed from rules file
    expect(fs.readFileSync(rulesPath, "utf-8")).not.toContain("docker-helper");
  });

  test("surface manager should enforce anti-bloat limit for rules", () => {
    const hostInfo = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };
    const surface = new SurfaceManager(hostInfo);

    const bloatedProposal: HarnessProposal = {
      id: "test-bloat",
      component: "c2_rules",
      targetPath: surface.getRulesFile(),
      summary: "Too long rule",
      contentDelta: new Array(20).fill("- bloated rule line").join("\n"),
      confidence: 0.5,
      status: "pending",
    };

    const val = surface.validateProposal(bloatedProposal);
    expect(val.valid).toBe(false);
    expect(val.reason).toContain("Anti-Bloat");
  });

  test("reporter should render terminal summary without errors", () => {
    const data: HarnessReportData = {
      host: "omp",
      baseDir: "/path/.omp",
      totalCalls: 10,
      totalErrors: 2,
      errorRate: 20.0,
      topFailingTools: [{ tool: "bash", count: 2 }],
      frictions: [],
      activeComponents: { skillsCount: 3, rulesCount: 12, scriptsCount: 1 },
      recentLedgerEntries: [],
    };

    const text = HarnessReporter.renderTerminalReport(data);
    expect(text).toContain("[pi-harness2]");
    expect(text).toContain("OMP");
    expect(text).toContain("bash");
  });
});
