import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { detectHost, getHarnessPaths } from "../extensions/host-detector.js";
import { findSessionFile, readSession, deriveFrictionPoints } from "../extensions/session-reader.js";
import { SurfaceManager } from "../extensions/surface.js";
import { ImprovementLedger } from "../extensions/ledger.js";
import { ExperienceReflector, isGroundedInText } from "../extensions/reflector.js";
import { HarnessReporter } from "../extensions/reporter.js";
import type { HarnessProposal, HarnessReportData, TimelineEvent } from "../extensions/types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piHarness2Extension from "../extensions/index.js";
describe("pi-harness2 test suite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness2-test-"));
    delete process.env.PI_HARNESS_HOST_OVERRIDE;
    delete process.env.PI_CODING_AGENT;
    delete process.env.AI_AGENT;
    delete process.env.OMP_PROFILE;
    delete process.env.PI_HARNESS_SESSIONS_ROOT;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PI_HARNESS_HOST_OVERRIDE;
    delete process.env.PI_CODING_AGENT;
    delete process.env.AI_AGENT;
    delete process.env.OMP_PROFILE;
    delete process.env.PI_HARNESS_SESSIONS_ROOT;
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

  // Write a host-format session recording for tmpDir (omp host layout)
  const writeSessionFixture = (messages: object[], id = "fixture-session", cwd = tmpDir): string => {
    const root = path.join(tmpDir, ".omp", "agent", "sessions");
    process.env.PI_HARNESS_SESSIONS_ROOT = root;
    const dir = path.join(root, "proj");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
      ...messages.map((m) => JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: m })),
    ];
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
    return file;
  };

  const toolError = (cmd: string, err: string) => ({
    role: "toolResult",
    toolCallId: `tc-${cmd}`,
    toolName: "bash",
    isError: true,
    durationMs: 10,
    content: [{ type: "text", text: err }],
  });

  test("deriveFrictionPoints should require >= 2 errors and readSession should strip ANSI escape codes", () => {
    writeSessionFixture([toolError("bad-1", "\x1b[31mError: command not found\x1b[0m")]);
    let { records } = readSession(detectHost(tmpDir), tmpDir);
    expect(deriveFrictionPoints(records).length).toBe(0);

    writeSessionFixture([
      toolError("bad-1", "\x1b[31mError: command not found\x1b[0m"),
      toolError("bad-2", "\x1b[31mError: syntax error\x1b[0m"),
    ]);
    ({ records } = readSession(detectHost(tmpDir), tmpDir));
    const frictions = deriveFrictionPoints(records);
    expect(frictions.length).toBe(1);
    expect(frictions[0]!.toolName).toBe("bash");
    expect(frictions[0]!.frequency).toBe(2);
    expect(frictions[0]!.sampleErrors[0]).toBe("Error: command not found");
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

  test("harness-apply command should invoke ctx.reload() when proposals are applied", async () => {
    fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
    type EventHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;
    type CommandEntry = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void };
    const events = new Map<string, EventHandler>();
    const commands = new Map<string, CommandEntry>();
    const mockPi: ExtensionAPI = {
      on: (event: string, handler: unknown) => {
        events.set(event, handler as EventHandler);
      },
      registerCommand: (name: string, def: unknown) => {
        commands.set(name, def as CommandEntry);
      },
    };

    piHarness2Extension(mockPi);

    // Friction from the host session recording (>= 2 tool errors)
    writeSessionFixture([
      toolError("f1", "fail 1"),
      toolError("f2", "fail 2"),
    ]);

    // Trigger session_stop to populate pendingProposals in review mode
    const sessionStopHandler = events.get("session_stop");
    await sessionStopHandler!({}, { cwd: tmpDir, ui: { notify: () => {} } });

    let reloadInvoked = false;
    const mockCtx = {
      cwd: tmpDir,
      ui: { notify: () => {} },
      reload: async () => {
        reloadInvoked = true;
      },
    };

    const applyCommand = commands.get("harness-apply");
    expect(applyCommand).toBeDefined();
    await applyCommand.handler("all", mockCtx);

    expect(reloadInvoked).toBe(true);
  });

  test("auto mode should apply proposals at session_stop without reload", async () => {
    fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
    type EventHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;
    type CommandEntry = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void };
    const events = new Map<string, EventHandler>();
    const commands = new Map<string, CommandEntry>();
    const mockPi: ExtensionAPI = {
      on: (event: string, handler: unknown) => {
        events.set(event, handler as EventHandler);
      },
      registerCommand: (name: string, def: unknown) => {
        commands.set(name, def as CommandEntry);
      },
    };

    piHarness2Extension(mockPi);

    let reloadCount = 0;
    const mockCtx = {
      cwd: tmpDir,
      ui: { notify: () => {} },
      reload: async () => {
        reloadCount++;
      },
    };

    // Switch to auto mode
    const modeCommand = commands.get("harness-mode");
    expect(modeCommand).toBeDefined();
    await modeCommand!.handler("auto", mockCtx);

    writeSessionFixture([
      toolError("f1", "fail 1"),
      toolError("f2", "fail 2"),
    ]);

    // Session ends: auto mode applies proposals without reload
    await events.get("session_stop")!({}, mockCtx);

    const ledger = new ImprovementLedger(detectHost(tmpDir));
    expect(ledger.getEntries().length).toBe(1);
    expect(reloadCount).toBe(0);

    // stopHandled dedup: a second stop (or shutdown) without session_start is a no-op
    await events.get("session_shutdown")!({}, mockCtx);
    await events.get("session_stop")!({}, mockCtx);
    expect(new ImprovementLedger(detectHost(tmpDir)).getEntries().length).toBe(1);
  });

  test("idempotent re-apply should not duplicate ledger commits", async () => {
    fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
    type EventHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;
    type CommandEntry = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void };
    const events = new Map<string, EventHandler>();
    const commands = new Map<string, CommandEntry>();
    const mockPi: ExtensionAPI = {
      on: (event: string, handler: unknown) => {
        events.set(event, handler as EventHandler);
      },
      registerCommand: (name: string, def: unknown) => {
        commands.set(name, def as CommandEntry);
      },
    };

    piHarness2Extension(mockPi);

    let reloadCount = 0;
    const mockCtx = {
      cwd: tmpDir,
      ui: { notify: () => {} },
      reload: async () => {
        reloadCount++;
      },
    };

    await commands.get("harness-mode")!.handler("auto", mockCtx);

    writeSessionFixture([
      toolError("f1", "fail 1"),
      toolError("f2", "fail 2"),
    ]);

    const stop = () => events.get("session_stop")!({}, mockCtx);
    await stop();

    const ledger = new ImprovementLedger(detectHost(tmpDir));
    expect(ledger.getEntries().length).toBe(1);
    expect(reloadCount).toBe(0);

    // Simulate next session: same friction recurs, apply is idempotent
    await events.get("session_start")!({}, mockCtx);
    await stop();

    expect(ledger.getEntries().length).toBe(1);
    expect(reloadCount).toBe(0);
  });

  test("getHarnessPaths should return structured paths within <projectDir>/.<host>/harness", () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };
    const paths = getHarnessPaths(piHost);
    expect(paths.harnessDir).toBe(path.join(tmpDir, ".pi", "harness"));
    expect(paths.reportsDir).toBe(path.join(tmpDir, ".pi", "harness", "reports"));
    expect(paths.ledgerFile).toBe(path.join(tmpDir, ".pi", "harness", "ledger.json"));
  });

  test("readSession should parse host recording into timeline and records", () => {
    writeSessionFixture([
      { role: "user", content: [{ type: "text", text: "Please fix the transaction boundary" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "ApprovalService.kt" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "read",
        isError: false,
        durationMs: 20,
        content: [{ type: "text", text: "class ApprovalService { ... }" }],
      },
    ]);

    const { timeline, records } = readSession(detectHost(tmpDir), tmpDir);
    expect(timeline.map((e) => e.type)).toEqual(["user_message", "assistant_thought", "tool_call", "tool_result"]);
    expect(timeline[0]?.content).toBe("Please fix the transaction boundary");
    expect(timeline[2]?.toolName).toBe("read");
    expect(records.length).toBe(1);
    expect(records[0]?.toolName).toBe("read");
    expect(records[0]?.isError).toBe(false);
  });

  test("findSessionFile should match by recorded cwd, not directory name", () => {
    // Distractor: newer file in another dir with a different cwd
    const otherDir = path.join(tmpDir, ".omp", "agent", "sessions", "other");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, "2026-06-01T00-00-00-000Z_distractor.jsonl"),
      JSON.stringify({ type: "session", version: 3, id: "d", timestamp: "2026-06-01T00:00:00.000Z", cwd: "/somewhere/else" }) + "\n",
      "utf-8",
    );

    const file = writeSessionFixture([{ role: "user", content: "hi" }]);
    expect(findSessionFile(detectHost(tmpDir), tmpDir)).toBe(file);
    expect(findSessionFile(detectHost(tmpDir), "/somewhere/else")).toContain("distractor");
    expect(findSessionFile(detectHost(tmpDir), "/no/such/cwd")).toBeUndefined();
  });

  test("SurfaceManager should support c3_memory and c7_script with safe append and counting", () => {
    const ompHost = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const surface = new SurfaceManager(ompHost);
    expect(surface.getMemoryDir()).toBe(path.join(tmpDir, ".omp", "memory"));

    // 1. Apply c3_memory
    const memFile = path.join(surface.getMemoryDir(), "domain.md");
    const memProposal: HarnessProposal = {
      id: "prop-mem-1",
      component: "c3_memory",
      targetPath: memFile,
      summary: "Domain fact about order status",
      contentDelta: "Order status 5 means ARCHIVED.\n",
      confidence: 0.9,
      status: "pending",
    };

    const res1 = surface.applyProposal(memProposal);
    expect(res1.success).toBe(true);
    expect(fs.readFileSync(memFile, "utf-8")).toContain("Order status 5 means ARCHIVED.");

    // Re-apply same content should be unchanged (idempotent)
    const res2 = surface.applyProposal(memProposal);
    expect(res2.success).toBe(true);
    expect(res2.unchanged).toBe(true);

    // 2. Apply c7_script
    const scriptFile = path.join(surface.getScriptsDir(), "check.sh");
    const scriptProposal: HarnessProposal = {
      id: "prop-scr-1",
      component: "c7_script",
      targetPath: scriptFile,
      summary: "Validation shell script",
      contentDelta: "#!/usr/bin/env bash\necho ok\n",
      confidence: 0.85,
      status: "pending",
    };

    const res3 = surface.applyProposal(scriptProposal);
    expect(res3.success).toBe(true);
    expect(fs.readFileSync(scriptFile, "utf-8")).toContain("echo ok");

    // Check active component counts
    const counts = surface.countActiveComponents();
    expect(counts.memoryCount).toBe(1);
    expect(counts.scriptsCount).toBe(1);
  });

  test("ExperienceReflector should diagnose user corrections and tool failures into proposals", async () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };

    const reflector = new ExperienceReflector(piHost);
    const timeline: TimelineEvent[] = [
      {
        timestamp: 1,
        type: "user_message",
        content: "不对，不能使用全局大事务，必须用 requiresNewTemplate 小事务",
      },
      {
        timestamp: 2,
        type: "tool_result",
        toolName: "bash",
        isError: true,
        content: "error 1",
      },
      {
        timestamp: 3,
        type: "tool_result",
        toolName: "bash",
        isError: true,
        content: "error 2",
      },
    ];

    const proposals = reflector.diagnoseTimeline(timeline);
    expect(proposals.length).toBe(2);

    const ruleProp = proposals.find((p) => p.component === "c2_rules");
    expect(ruleProp).toBeDefined();
    expect(ruleProp?.contentDelta).toContain("requiresNewTemplate");

    const skillProp = proposals.find((p) => p.component === "c6_skill");
    expect(skillProp).toBeDefined();
    expect(skillProp?.summary).toContain("bash");
  });

  test("ExperienceReflector diagnoseTimelineAsync should use LLM when provided and parse diagnostic JSON", async () => {
    const ompHost = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };

    const fakeLLM = async (prompt: string): Promise<string> => {
      expect(prompt.length).toBeGreaterThan(0);
      return `\`\`\`json
{
  "frictions": [
    {
      "category": "business_logic",
      "userEvidence": "use requiresNewTemplate",
      "rootCause": "Transaction boundary desync"
    }
  ],
  "proposals": [
    {
      "component": "c2_rules",
      "summary": "Enforce small transaction isolation for batch approval",
      "contentDelta": "- Rule: Use requiresNewTemplate for individual batch item approval.\\n",
      "userEvidence": "use requiresNewTemplate",
      "confidence": 0.95
    },
    {
      "component": "c3_memory",
      "summary": "Batch approval workflow invariants",
      "contentDelta": "# Batch Approval Workflow\\nMust isolate each remote RPC in a separate transaction.\\n",
      "userEvidence": "batch approval",
      "confidence": 0.9
    }
  ]
}
\`\`\``;
    };

    const reflector = new ExperienceReflector(ompHost, fakeLLM);
    const timeline: TimelineEvent[] = [
      { timestamp: 1, type: "user_message", content: "Fix the batch approval, please use requiresNewTemplate" },
    ];

    const proposals = await reflector.diagnoseTimelineAsync(timeline);
    expect(proposals.length).toBe(2);
    expect(proposals[0]?.component).toBe("c2_rules");
    expect(proposals[0]?.contentDelta).toContain("requiresNewTemplate");
    expect(proposals[1]?.component).toBe("c3_memory");
    expect(proposals[1]?.contentDelta).toContain("Batch Approval Workflow");
  });

  test("ExperienceReflector diagnoseTimelineAsync should skip malformed LLM proposals without crashing", async () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };

    // LLM returns a proposal missing contentDelta (untrusted JSON) — must not TypeError
    const fakeLLM = async (): Promise<string> => {
      return JSON.stringify({
        frictions: [],
        proposals: [
          { component: "c2_rules", summary: "Missing delta" },
          { component: "c2_rules", summary: "ok", contentDelta: "- Rule: 必须使用小事务隔离\n", userEvidence: "必须使用小事务隔离" },
        ],
      });
    };

    const reflector = new ExperienceReflector(piHost, fakeLLM);
    const timeline: TimelineEvent[] = [
      { timestamp: 1, type: "user_message", content: "必须使用小事务隔离" },
    ];

    const proposals = await reflector.diagnoseTimelineAsync(timeline);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.contentDelta).toContain("必须使用小事务隔离");
  });

  test("ExperienceReflector diagnoseTimelineAsync should fallback to deterministic diagnosis if LLM fails", async () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };

    const failingLLM = async (): Promise<string> => {
      throw new Error("LLM rate limit or network error");
    };

    const reflector = new ExperienceReflector(piHost, failingLLM);
    const timeline: TimelineEvent[] = [
      { timestamp: 1, type: "user_message", content: "必须使用小事务隔离" },
    ];

    const proposals = await reflector.diagnoseTimelineAsync(timeline);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.component).toBe("c2_rules");
    expect(proposals[0]?.contentDelta).toContain("必须使用小事务隔离");
  });

  test("ExperienceReflector should reject ungrounded hallucinations when userEvidence is absent from timeline", async () => {
    const ompHost = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };

    const hallucinatingLLM = async (): Promise<string> => {
      return JSON.stringify({
        frictions: [
          {
            category: "business_logic",
            userEvidence: "quantum teleportation protocol xyz",
            rootCause: "Unchecked quantum flux",
          },
        ],
        proposals: [
          {
            component: "c2_rules",
            summary: "Enforce quantum protocol",
            contentDelta: "- Rule: Always calibrate quantum flux.\n",
            confidence: 0.99,
          },
        ],
      });
    };

    const reflector = new ExperienceReflector(ompHost, hallucinatingLLM);
    const timeline: TimelineEvent[] = [
      { timestamp: 1, type: "user_message", content: "Please fix the simple database query" },
    ];

    // The ungrounded proposal must be rejected by the grounding probe
    const proposals = await reflector.diagnoseTimelineAsync(timeline);
    expect(proposals.length).toBe(0);
  });

  test("SurfaceManager should enforce cumulative 200 lines limit on rules file", () => {
    const ompHost = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const surface = new SurfaceManager(ompHost);
    const rulesFile = surface.getRulesFile();
    fs.mkdirSync(path.dirname(rulesFile), { recursive: true });

    // Pre-populate with 200 lines
    const lines200 = Array.from({ length: 200 }, (_, i) => `- Rule ${i}: invariant`).join("\n") + "\n";
    fs.writeFileSync(rulesFile, lines200, "utf-8");

    const newProposal: HarnessProposal = {
      id: "prop-overflow",
      component: "c2_rules",
      targetPath: rulesFile,
      summary: "One more rule",
      contentDelta: "- Rule: Extra rule\n",
      confidence: 0.9,
      status: "pending",
    };

    const validation = surface.validateProposal(newProposal);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain("exceed limit");
  });

  test("Full end-to-end self-evolution with memory, rules, ledger, and rollback", () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };
    const surface = new SurfaceManager(piHost);
    const ledger = new ImprovementLedger(piHost);

    // 1. Commit a c3_memory proposal
    const memFile = path.join(surface.getMemoryDir(), "auth.md");
    const memProp: HarnessProposal = {
      id: "prop-e2e-mem",
      component: "c3_memory",
      targetPath: memFile,
      summary: "Gateway token header name",
      contentDelta: "Dynamic gateway token header is store.get('token.name').\n",
      confidence: 0.95,
      status: "pending",
    };

    const applyRes = surface.applyProposal(memProp);
    expect(applyRes.success).toBe(true);
    const commit = ledger.recordCommit(memProp, "e2e-session", applyRes.previousContent);
    expect(fs.existsSync(memFile)).toBe(true);
    expect(ledger.getEntries().length).toBe(1);

    // 2. Rollback the commit
    const rollbackRes = ledger.rollback(commit.id);
    expect(rollbackRes.success).toBe(true);
    // Since action was CREATE, rollback should delete the created file
    expect(fs.existsSync(memFile)).toBe(false);
    expect(ledger.getEntries()[0]?.status).toBe("REVERTED");
  });

  test("c3_memory UPDATE rollback should restore exact previousContent", () => {
    const ompHost = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const surface = new SurfaceManager(ompHost);
    const ledger = new ImprovementLedger(ompHost);

    const memFile = path.join(surface.getMemoryDir(), "database.md");
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    const initialContent = "# Database Conventions\nDB is PostgreSQL 16.\n";
    fs.writeFileSync(memFile, initialContent, "utf-8");

    const appendProp: HarnessProposal = {
      id: "prop-mem-update",
      component: "c3_memory",
      targetPath: memFile,
      summary: "Add Redis info",
      contentDelta: "Redis is used for distributed locks.\n",
      confidence: 0.9,
      status: "pending",
    };

    const applyRes = surface.applyProposal(appendProp);
    expect(applyRes.success).toBe(true);
    expect(applyRes.unchanged).toBe(false);
    expect(applyRes.previousContent).toBe(initialContent);

    const commit = ledger.recordCommit(appendProp, "session-update", applyRes.previousContent);
    expect(commit.action).toBe("UPDATE");
    expect(fs.readFileSync(memFile, "utf-8")).toContain("Redis is used for distributed locks.");

    const rollbackRes = ledger.rollback(commit.id);
    expect(rollbackRes.success).toBe(true);
    expect(fs.readFileSync(memFile, "utf-8")).toBe(initialContent);
  });

  test("SurfaceManager should reject path traversal proposals outside configuration directories", () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };
    const surface = new SurfaceManager(piHost);

    const maliciousProposal: HarnessProposal = {
      id: "prop-malicious-traversal",
      component: "c7_script",
      targetPath: "/etc/cron.daily/malicious.sh",
      summary: "Malicious cron script",
      contentDelta: "echo hacked\n",
      confidence: 0.99,
      status: "pending",
    };

    const res = surface.validateProposal(maliciousProposal);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Security violation");

    const dotDotProposal: HarnessProposal = {
      id: "prop-dotdot",
      component: "c2_rules",
      targetPath: path.join(tmpDir, "..", "..", "outside.txt"),
      summary: "Escape sandbox",
      contentDelta: "bad rule\n",
      confidence: 0.9,
      status: "pending",
    };
    const resDotDot = surface.validateProposal(dotDotProposal);
    expect(resDotDot.valid).toBe(false);
    expect(resDotDot.reason).toContain("Security violation");
  });

  test("CJK grounding tokens and 2-gram matching should accurately ground Chinese user feedback", () => {
    const ompHost = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };

    const reflector = new ExperienceReflector(ompHost);
    const timeline: TimelineEvent[] = [
      { timestamp: 1, type: "user_message", content: "请修改批量审批接口，必须使用小事务隔离RPC调用" },
    ];

    const proposals = reflector.diagnoseTimeline(timeline);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const ruleProp = proposals.find((p) => p.component === "c2_rules");
    expect(ruleProp).toBeDefined();
    expect(ruleProp?.contentDelta).toContain("小事务隔离");
  });

  test("recordCommit in same millisecond should generate unique collision-free IDs", () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };
    const ledger = new ImprovementLedger(piHost);
    const prop1: HarnessProposal = {
      id: "p1",
      component: "c2_rules",
      targetPath: path.join(tmpDir, ".pi", "RULES.md"),
      summary: "Rule 1",
      contentDelta: "Rule 1\n",
      confidence: 0.9,
      status: "pending",
    };
    const prop2: HarnessProposal = {
      id: "p2",
      component: "c2_rules",
      targetPath: path.join(tmpDir, ".pi", "RULES.md"),
      summary: "Rule 2",
      contentDelta: "Rule 2\n",
      confidence: 0.9,
      status: "pending",
    };
    const c1 = ledger.recordCommit(prop1, "s1");
    const c2 = ledger.recordCommit(prop2, "s1");
    expect(c1.id).not.toBe(c2.id);
  });

  test("c6_skill candidateName with bare SKILL.md should use summary instead of collapsing to workflow", async () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };
    const reflector = new ExperienceReflector(piHost, async () => {
      return JSON.stringify({
        proposals: [
          {
            component: "c6_skill",
            targetFile: "SKILL.md",
            summary: "Database migration guide",
            triggerLine: "- When migrating DB, load the `db-migration` skill.",
            contentDelta: "# Migration\nStep 1",
            confidence: 0.9,
          },
        ],
      });
    });

    const proposals = await reflector.diagnoseTimelineAsync([
      { timestamp: 1, type: "user_message", content: "Database migration failed" },
    ]);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.targetPath).toContain("database-migration-guide");
  });

  test("validateProposal should allow re-applying existing rules at 195 lines, but trigger injection stops at 200", () => {
    const piHost = {
      host: "pi" as const,
      projectConfigDir: path.join(tmpDir, ".pi"),
      userConfigDir: path.join(tmpDir, ".pi", "agent"),
    };
    const surface = new SurfaceManager(piHost);
    const rulesFile = surface.getRulesFile();
    fs.mkdirSync(path.dirname(rulesFile), { recursive: true });

    // Pre-populate 195 lines
    const lines = Array.from({ length: 195 }, (_, i) => `- Rule ${i}: invariant`).join("\n") + "\n";
    fs.writeFileSync(rulesFile, lines, "utf-8");

    // 1. Re-apply an existing rule — delta is 5 lines that already exist
    const prop: HarnessProposal = {
      id: "p1",
      component: "c2_rules",
      targetPath: rulesFile,
      summary: "Existing rules",
      contentDelta: "- Rule 0: invariant\n- Rule 1: invariant\n",
      confidence: 0.9,
      status: "pending",
    };
    const val = surface.validateProposal(prop);
    expect(val.valid).toBe(true);

    // 2. Fill to exactly 200 lines
    const fullLines = Array.from({ length: 200 }, (_, i) => `- Rule ${i}: invariant`).join("\n") + "\n";
    fs.writeFileSync(rulesFile, fullLines, "utf-8");

    // 3. At the cap, c6 skill apply must FAIL loudly — a skill without its triggerLine is unreachable
    const skillProp: HarnessProposal = {
      id: "p2",
      component: "c6_skill",
      targetPath: path.join(surface.getSkillDir(), "test-skill", "SKILL.md"),
      summary: "Test skill",
      triggerLine: "- When testing, load the `test-skill` skill.",
      contentDelta: "# Test Skill",
      confidence: 0.9,
      status: "pending",
    };
    const res = surface.applyProposal(skillProp);
    expect(res.success).toBe(false);
    expect(res.error).toContain("200-line cap");
    expect(fs.existsSync(skillProp.targetPath)).toBe(false);
    const afterLines = fs.readFileSync(rulesFile, "utf-8").split("\n").filter((l) => l.trim().length > 0).length;
    expect(afterLines).toBe(200);
  });

  test("session_start should isolate proposals across different working directories", async () => {
    type EventHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;
    type CommandEntry = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void };
    const events = new Map<string, EventHandler>();
    const commands = new Map<string, CommandEntry>();
    const mockPi: ExtensionAPI = {
      on: (event: string, handler: unknown) => {
        events.set(event, handler as EventHandler);
      },
      registerCommand: (name: string, def: unknown) => {
        commands.set(name, def as CommandEntry);
      },
    };

    piHarness2Extension(mockPi);

    const dirA = path.join(tmpDir, "project-a");
    const dirB = path.join(tmpDir, "project-b");
    fs.mkdirSync(path.join(dirA, ".omp"), { recursive: true });
    fs.mkdirSync(path.join(dirB, ".omp"), { recursive: true });

    const notificationsA: string[] = [];
    const mockCtxA = {
      cwd: dirA,
      ui: { notify: (msg: string) => notificationsA.push(msg) },
    };

    const notificationsB: string[] = [];
    const mockCtxB = {
      cwd: dirB,
      ui: { notify: (msg: string) => notificationsB.push(msg) },
    };

    // 1. Session start in dirA, populate friction
    await events.get("session_start")!({}, mockCtxA);
    writeSessionFixture([toolError("fail-tool", "error 1"), toolError("fail-tool", "error 2")], "s-a", dirA);
    await events.get("session_stop")!({}, mockCtxA);

    // Reflect in dirA shows pending proposal
    const reflectCmd = commands.get("harness-reflect");
    expect(reflectCmd).toBeDefined();
    await reflectCmd!.handler("", mockCtxA as any);
    expect(notificationsA.some((n) => n.includes("bash-best-practices"))).toBe(true);

    // 2. Switch to dirB: session_start clears stale proposals from dirA
    await events.get("session_start")!({}, mockCtxB);
    await reflectCmd!.handler("", mockCtxB as any);
    expect(notificationsB.some((n) => n.includes("No friction diagnosed"))).toBe(true);
  });

  test("isGroundedInText should reject empty, whitespace, and sub-token strings", () => {
    expect(isGroundedInText("   ", "any text at all")).toBe(false);
    expect(isGroundedInText("", "any text at all")).toBe(false);
    expect(isGroundedInText("no", "no exception thrown")).toBe(false);
    expect(isGroundedInText("transaction boundary", "Fix the transaction boundary issue")).toBe(true);
  });

  test("turn_start should allow re-diagnosis at each settle while deduplicating proposals", async () => {
    type EventHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;
    type CommandEntry = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void };
    const events = new Map<string, EventHandler>();
    const commands = new Map<string, CommandEntry>();
    const mockPi: ExtensionAPI = {
      on: (event: string, handler: unknown) => {
        events.set(event, handler as EventHandler);
      },
      registerCommand: (name: string, def: unknown) => {
        commands.set(name, def as CommandEntry);
      },
    };

    piHarness2Extension(mockPi);
    fs.mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });

    let notifyCount = 0;
    const mockCtx = {
      cwd: tmpDir,
      ui: { notify: () => { notifyCount++; } },
    };

    await events.get("session_start")!({}, mockCtx);
    writeSessionFixture([toolError("bash", "fail 1"), toolError("bash", "fail 2")]);

    // Turn 1 settles: diagnoses 1 proposal (session_start was notify 1, session_stop is notify 2)
    await events.get("session_stop")!({}, mockCtx);
    expect(notifyCount).toBe(2);

    // Turn 2 starts: resets stopHandled
    await events.get("turn_start")!({}, mockCtx);

    // Turn 2 settles: re-diagnoses, but proposal deduplication prevents duplicate pending entries
    await events.get("session_stop")!({}, mockCtx);
    // Notification not re-sent because 0 new proposals added
    expect(notifyCount).toBe(2);
  });

  test("readSession should read tail of oversized session (>4MB) without crashing", () => {
    const hostInfo = {
      host: "omp" as const,
      projectConfigDir: path.join(tmpDir, ".omp"),
      userConfigDir: path.join(tmpDir, ".omp", "agent"),
    };
    const root = path.join(tmpDir, ".omp", "agent", "sessions");
    process.env.PI_HARNESS_SESSIONS_ROOT = root;
    const dir = path.join(root, "proj");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `2026-01-01T00-00-00-000Z_large-session.jsonl`);

    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "large-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: tmpDir,
    });
    // Write header (first 8KB)
    const fd = fs.openSync(file, "w");
    fs.writeSync(fd, header + "\n");

    // Write ~4.2MB padding lines in chunks
    const paddingLine = JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: "x".repeat(1000) },
    }) + "\n";
    const chunk = paddingLine.repeat(50); // ~50KB
    for (let i = 0; i < 85; i++) {
      fs.writeSync(fd, chunk);
    }

    // Write tail message (tool call + tool result with error)
    const tailMsg1 = JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T01:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "tc-large", toolName: "bash", input: { command: "test" } }],
      },
    }) + "\n";
    const tailMsg2 = JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T01:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc-large",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "command failed in tail" }],
      },
    }) + "\n";
    fs.writeSync(fd, tailMsg1);
    fs.writeSync(fd, tailMsg2);
    fs.closeSync(fd);

    expect(fs.statSync(file).size).toBeGreaterThan(4 * 1024 * 1024);

    const { timeline, records } = readSession(hostInfo, tmpDir);
    expect(records.length).toBe(1);
    expect(records[0]?.toolName).toBe("bash");
    expect(records[0]?.isError).toBe(true);
    expect(timeline.length).toBeGreaterThanOrEqual(1);
  });
});
