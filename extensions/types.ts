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

export interface SessionFrictionPoint {
  type: "tool_error_loop" | "repetitive_retries" | "context_spill" | "user_correction";
  description: string;
  evidence: ToolExecutionRecord[];
}

export interface HarnessProposal {
  id: string;
  component: HarnessComponentType;
  targetPath: string;
  summary: string;
  triggerLine?: string; // required for c6 skills
  contentDelta: string;
  confidence: number;
  status: "pending" | "applied" | "rejected" | "reverted";
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
}

export interface HarnessReportData {
  host: HostType;
  baseDir: string;
  totalSessions: number;
  totalToolCalls: number;
  totalErrors: number;
  errorRate: number;
  topFailingTools: Array<{ tool: string; count: number }>;
  activeComponents: {
    skillsCount: number;
    rulesCount: number;
    scriptsCount: number;
  };
  recentProposals: HarnessProposal[];
  recentLedgerEntries: LedgerEntry[];
}
