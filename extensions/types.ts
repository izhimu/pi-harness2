export type HostType = "pi" | "omp";

export type HarnessComponentType =
  | "c1_prompt"
  | "c2_rules"
  | "c3_memory"
  | "c4_tool_guidance"
  | "c5_subagent"
  | "c6_skill"
  | "c7_script"
  | "c8_plugin";

export interface ToolExecutionRecord {
  toolName: string;
  input: unknown;
  outputPreview?: string;
  isError: boolean;
  durationMs: number;
  timestamp: number;
}

export interface FrictionPoint {
  type: "tool_error_loop" | "repetitive_retries" | "context_spill" | "user_correction";
  toolName?: string;
  description: string;
  frequency: number;
  sampleErrors: string[];
}

export interface HarnessProposal {
  id: string;
  component: HarnessComponentType;
  targetPath: string;
  summary: string;
  triggerLine?: string; // required for c6 skills
  contentDelta: string;
  confidence: number;
  /**
   * False for proposals whose only evidence is a heuristic interpretation of user
   * messages. Auto mode holds these for interactive review instead of applying them.
   */
  autoApplicable?: boolean;
  /** Deterministic evidence used for post-application outcome measurement. */
  evidence?: ToolEvidence;
}

/** What triggered a deterministic proposal — the baseline for outcome tracking. */
export interface ToolEvidence {
  tool: string;
  baselineErrorCount: number;
}

export interface LedgerEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  component: HarnessComponentType;
  filePath: string;
  summary: string;
  previousContent?: string;
  appliedContent: string;
  status: "APPLIED" | "REVERTED";
  /** c6 only: true when this mutation added the skill's trigger line to the rules file. */
  triggerAdded?: boolean;
  /** Baseline evidence captured at apply time, used to measure later outcomes. */
  evidence?: ToolEvidence;
  /** Post-application effectiveness measurement from later sessions. */
  outcome?: MutationOutcome;
}

export interface MutationOutcome {
  status: "improved" | "neutral" | "regressed";
  measuredAt: number;
  /** Session start this measurement belongs to — the same session never counts twice. */
  measuredSessionStart?: number;
  /** Definitive measurements so far (unknown verdicts are not recorded). */
  samples: number;
  /** Consecutive "regressed" verdicts — 2+ marks a rollback candidate. */
  consecutiveRegressed: number;
  detail?: string;
}

export interface HarnessReportData {
  host: HostType;
  baseDir: string;
  totalCalls: number;
  totalErrors: number;
  errorRate: number;
  topFailingTools: Array<{ tool: string; count: number }>;
  frictions: FrictionPoint[];
  activeComponents: {
    skillsCount: number;
    rulesCount: number;
    scriptsCount: number;
    memoryCount?: number;
  };
  recentLedgerEntries: LedgerEntry[];
  /** Entries carrying a measured post-application outcome. */
  outcomeEntries?: LedgerEntry[];
  /** Soft-cap and hygiene warnings (oversized SYSTEM.md, memory growth, ...). */
  warnings?: string[];
  /** Result of the missing-trigger audit run before rendering, when it ran. */
  triggerAudit?: { repaired: number; skipped: number };
}

export interface TimelineEvent {
  timestamp: number;
  type: "user_message" | "tool_call" | "tool_result" | "assistant_thought";
  content: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface HarnessPaths {
  harnessDir: string;
  reportsDir: string;
  ledgerFile: string;
  settingsFile: string;
}

export interface DiagnosticFriction {
  category: "business_logic" | "domain_fact" | "tool_misuse" | "repetitive_flow";
  userEvidence: string;
  rootCause: string;
}

export interface DiagnosticProposal {
  component: "c2_rules" | "c3_memory" | "c6_skill" | "c7_script";
  summary: string;
  targetFile?: string;
  triggerLine?: string;
  contentDelta: string;
  confidence: number;
  userEvidence?: string;
}

export interface DiagnosticResult {
  frictions: DiagnosticFriction[];
  proposals: DiagnosticProposal[];
  /** Optional transferable lessons distilled by the LLM (all four fields required). */
  lessons?: DiagnosticLesson[];
}

export interface DiagnosticLesson {
  /** Situation keyword: when this lesson applies. */
  cue: string;
  /** The transferable lesson itself. */
  lesson: string;
  /** Exact quote from the timeline that supports the lesson. */
  evidence: string;
  confidence: number;
}

export interface ReflectionResult {
  proposals: HarnessProposal[];
  lessons: DiagnosticLesson[];
}

export type LLMCompletionFn = (prompt: string) => Promise<string>;
