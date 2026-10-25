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
}

export type LLMCompletionFn = (prompt: string) => Promise<string>;
