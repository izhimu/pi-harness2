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
  totalCalls: number;
  totalErrors: number;
  errorRate: number;
  topFailingTools: Array<{ tool: string; count: number }>;
  frictions: FrictionPoint[];
  activeComponents: {
    skillsCount: number;
    rulesCount: number;
    scriptsCount: number;
  };
  recentLedgerEntries: LedgerEntry[];
}
