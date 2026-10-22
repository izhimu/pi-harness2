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
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("host-detector should detect omp when .omp exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
    const hostInfo = detectHost(tmpDir);
    expect(hostInfo.host).toBe("omp");
    expect(hostInfo.projectConfigDir).toBe(path.join(tmpDir, ".omp"));
  });

  test("host-detector should detect pi when .pi exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    const hostInfo = detectHost(tmpDir);
    expect(hostInfo.host).toBe("pi");
    expect(hostInfo.projectConfigDir).toBe(path.join(tmpDir, ".pi"));
  });

  test("tracer should aggregate errors and detect friction points", () => {
    const tracer = new SessionTracer();
    tracer.record({ toolName: "bash", input: { command: "ls" }, isError: false, durationMs: 10, timestamp: 1 });
    tracer.record({ toolName: "bash", input: { command: "bad-cmd" }, outputPreview: "not found", isError: true, durationMs: 15, timestamp: 2 });
    tracer.record({ toolName: "bash", input: { command: "bad-cmd-2" }, outputPreview: "not found", isError: true, durationMs: 12, timestamp: 3 });

    expect(tracer.getRecords().length).toBe(3);
    expect(tracer.getErrors().length).toBe(2);

    const frictions = tracer.getFrictionPoints();
    expect(frictions.length).toBe(1);
    expect(frictions[0].toolName).toBe("bash");
    expect(frictions[0].frequency).toBe(2);
  });

  test("surface manager should enforce trigger line rule for skills", () => {
    const hostInfo = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const surface = new SurfaceManager(hostInfo);

    const invalidProposal: HarnessProposal = {
      id: "test-1",
      component: "c6_skill",
      targetPath: path.join(surface.getSkillDir(), "my-skill", "SKILL.md"),
      summary: "Invalid skill missing trigger line",
      contentDelta: "body",
      confidence: 1.0,
      status: "pending",
    };

    const val = surface.validateProposal(invalidProposal);
    expect(val.valid).toBe(false);
    expect(val.reason).toContain("trigger line");

    const validProposal: HarnessProposal = {
      ...invalidProposal,
      triggerLine: "- When doing XYZ, load the `my-skill` skill.",
    };

    const validResult = surface.validateProposal(validProposal);
    expect(validResult.valid).toBe(true);

    const applyResult = surface.applyProposal(validProposal);
    expect(applyResult.success).toBe(true);
    expect(fs.existsSync(validProposal.targetPath)).toBe(true);

    // Verify trigger line appended to RULES.md
    const rulesContent = fs.readFileSync(surface.getRulesFile(), "utf-8");
    expect(rulesContent).toContain("my-skill");
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

  test("ledger should record commit and perform rollback", () => {
    const hostInfo = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const surface = new SurfaceManager(hostInfo);
    const ledger = new ImprovementLedger(hostInfo);
    const testFile = path.join(tmpDir, "sample.txt");

    fs.writeFileSync(testFile, "original", "utf-8");

    const proposal: HarnessProposal = {
      id: "prop-commit",
      component: "c7_script",
      targetPath: testFile,
      summary: "Update sample script",
      contentDelta: "updated content",
      confidence: 0.9,
      status: "pending",
    };

    const applyRes = surface.applyProposal(proposal);
    expect(applyRes.success).toBe(true);
    expect(applyRes.previousContent).toBe("original");

    const entry = ledger.recordCommit(proposal, "sess-1", applyRes.previousContent);
    expect(entry.action).toBe("UPDATE");
    expect(entry.previousContent).toBe("original");
    expect(fs.readFileSync(testFile, "utf-8")).toBe("updated content");

    // Perform rollback
    const rollbackRes = ledger.rollback(entry.id);
    expect(rollbackRes.success).toBe(true);
    expect(fs.readFileSync(testFile, "utf-8")).toBe("original");

    const entries = ledger.getEntries();
    expect(entries[0].status).toBe("REVERTED");
  });

  test("reflector should diagnose friction and propose a skill", () => {
    const hostInfo = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const reflector = new ExperienceReflector(hostInfo);

    const proposals = reflector.diagnoseAndPropose([
      {
        type: "tool_error_loop",
        toolName: "bash",
        description: "Tool bash failed 3 times",
        frequency: 3,
        sampleErrors: ["command not found: rg", "syntax error"],
      },
    ]);

    expect(proposals.length).toBe(1);
    expect(proposals[0].component).toBe("c6_skill");
    expect(proposals[0].triggerLine).toContain("skill");
    expect(proposals[0].contentDelta).toContain("Best Practices");
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
