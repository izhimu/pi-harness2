import * as path from "node:path";
import type {
  FrictionPoint,
  HarnessProposal,
  TimelineEvent,
  DiagnosticResult,
  LLMCompletionFn,
  HarnessComponentType,
} from "./types.js";
import type { HostInfo } from "./host-detector.js";
import { SurfaceManager } from "./surface.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function parseDiagnosticJson(raw: string): DiagnosticResult | null {
  const candidates: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(raw)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(trimmed);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as DiagnosticResult;
      if (parsed && Array.isArray(parsed.proposals)) {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function extractGroundingTokens(evidence: string): string[] {
  const cjkRuns = evidence.match(/[一-龥]+/g) || [];
  const tokens: string[] = [];
  // CJK bigrams within contiguous runs only (punctuation/Latin boundaries must not pair chars)
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }
  // English / alphanumeric words, ignoring common stop-words
  const stopWords: Record<string, true> = {
    the: true, and: true, or: true, for: true, with: true, this: true, that: true, from: true, into: true,
    use: true, using: true, must: true, should: true, not: true, can: true, will: true, please: true,
    rule: true, skill: true, file: true, make: true, when: true, load: true, error: true, fail: true,
  };
  const words = evidence
    .toLowerCase()
    .replace(/[\u4e00-\u9fa5]/g, " ")
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !stopWords[w]);
  tokens.push(...words);
  return tokens;
}

export function isGroundedInText(evidence: string, text: string): boolean {
  if (!evidence || !text) return false;
  const trimmed = evidence.trim();
  if (!trimmed) return false;
  const lowerText = text.toLowerCase();
  const tokens = extractGroundingTokens(trimmed);
  if (tokens.length === 0) {
    return trimmed.length >= 4 && lowerText.includes(trimmed.toLowerCase());
  }
  const matchCount = tokens.filter((t) => lowerText.includes(t)).length;
  return matchCount >= Math.min(2, tokens.length) || (matchCount / tokens.length >= 0.5);
}

/**
 * User messages must read as corrections of the agent's behavior, not merely
 * contain modal verbs. Bare "should/must/not" matches produced rules out of
 * ordinary design discussion, so the patterns require explicit corrective framing.
 */
const CORRECTION_RE =
  /(不对|不是这|搞错|写错|弄错|用错|错了|重新(?:写|做|改|来)|不要(?:这?样|用)|别(?:用|这)|不能(?:这?样|用)|不允许|禁止)|(?:\b(?:wrong|incorrect|mistake|misused?)\b)|(?:\b(?:don'?t|do not|stop)\s+(?:use|using|do|doing|generate|write)\b)|(?:\binstead\s+of\b)|(?:\byou\s+(?:must|should)\s+not\b)/i;

export function isUserCorrection(content: string): boolean {
  return CORRECTION_RE.test(content);
}

/**
 * Tool output can contain attacker-controlled text (fetched pages, untrusted repo
 * files). Snippets are persisted into SKILL.md that the agent later loads, so only
 * the first line survives, markdown/link syntax is stripped, and length is capped.
 */
export function sanitizeErrorSnippet(error: string): string {
  const firstLine =
    error
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return firstLine
    .replace(/`+/g, "'")
    .replace(/^[#>\-*+=~\t ]+/, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/<[^>]{0,120}>/g, "")
    .slice(0, 120);
}

/** Stable short identifier fallback for names that sanitize to empty (e.g. CJK-only). */
function stableSuffix(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export class ExperienceReflector {
  private surface: SurfaceManager;

  constructor(private hostInfo: HostInfo, private llmCaller?: LLMCompletionFn) {
    this.surface = new SurfaceManager(hostInfo);
  }

  public async diagnoseTimelineAsync(timeline: TimelineEvent[]): Promise<HarnessProposal[]> {
    if (this.llmCaller && timeline.length > 0) {
      try {
        const prompt = this.buildDiagnosticPrompt(timeline);
        const rawResponse = await this.llmCaller(prompt);
        const parsed = parseDiagnosticJson(rawResponse);
        if (parsed && parsed.proposals.length > 0) {
          const mapped = this.mapDiagnosticProposals(parsed, timeline);
          if (mapped.length > 0) {
            return mapped;
          }
        }
      } catch {
        // Fall back to deterministic timeline diagnosis if LLM fails
      }
    }

    return this.diagnoseTimeline(timeline);
  }

  public diagnoseTimeline(timeline: TimelineEvent[]): HarnessProposal[] {
    const proposals: HarnessProposal[] = [];
    const toolErrors = new Map<string, string[]>();
    const userCorrections: string[] = [];

    // Passive analysis of conversation turns
    for (const ev of timeline) {
      if (ev.type === "user_message" && ev.content.trim().length > 0) {
        const content = ev.content.trim();
        if (isUserCorrection(content)) {
          userCorrections.push(content);
        }
      } else if (ev.type === "tool_result" && ev.isError && ev.toolName) {
        const errors = toolErrors.get(ev.toolName) ?? [];
        errors.push(ev.content || "Execution failed");
        toolErrors.set(ev.toolName, errors);
      }
    }

    // 1. Business & Domain Invariants from User Feedback (c2_rules).
    // Heuristic evidence only — these are never auto-applied without review.
    for (let i = 0; i < userCorrections.length; i++) {
      const correction = userCorrections[i]!;
      const cleanCorrection = correction.replace(/\n+/g, " ").slice(0, 120);
      const targetPath = this.surface.getRulesFile();
      const contentDelta = `- Rule: ${cleanCorrection}\n`;

      proposals.push({
        id: `prop-${Date.now()}-rule-${i}`,
        component: "c2_rules",
        targetPath,
        summary: `Domain rule from user feedback: ${cleanCorrection.slice(0, 50)}...`,
        contentDelta,
        confidence: 0.7,
        autoApplicable: false,
      });
    }

    // 2. High-Frequency Tool Friction (c6_skill) — grounded in >= 2 recorded failures
    for (const [tool, errors] of toolErrors.entries()) {
      if (errors.length >= 2) {
        proposals.push(this.buildToolSkillProposal(tool, errors, undefined));
      }
    }

    return proposals;
  }

  private buildToolSkillProposal(
    tool: string,
    errors: string[],
    frequency: number | undefined,
  ): HarnessProposal {
    const cleanTool = tool.replace(/[\r\n`]+/g, " ").trim();
    const baseTool = cleanTool.replace(/[^a-zA-Z0-9_-]/g, "") || "tool";
    const skillName = `${baseTool}-best-practices`;
    const targetPath = path.join(this.surface.getSkillDir(), skillName, "SKILL.md");
    const triggerLine = `- When encountering complex or repeated operations with \`${cleanTool}\`, load the \`${skillName}\` skill.`;

    const cleanErrors = errors.slice(0, 3).map((e) => `> ${sanitizeErrorSnippet(e)}`);
    const frequencyNote = frequency !== undefined ? `Diagnosed from ${frequency} failure(s) in session:` : "";
    const contentDelta = [
      `---`,
      `name: ${skillName}`,
      `description: ${JSON.stringify(`Reusable procedure and error prevention for ${cleanTool}`)}`,
      `---`,
      ``,
      `# ${cleanTool} Best Practices and Error Recovery`,
      ...(frequencyNote ? [frequencyNote] : []),
      ...cleanErrors,
      ``,
      `## Recommended Procedure`,
      `1. Verify command syntax, paths, and tool constraints prior to execution.`,
      `2. Avoid speculative flags or unverified assumptions.`,
      `3. Inspect intermediate outputs before chained operations.`,
    ].join("\n");

    return {
      id: `prop-${Date.now()}-${baseTool}`,
      component: "c6_skill",
      targetPath,
      summary: `Auto-generated skill to mitigate ${cleanTool} errors`,
      triggerLine,
      contentDelta,
      confidence: 0.85,
    };
  }

  private buildDiagnosticPrompt(timeline: TimelineEvent[]): string {
    // Prompt budget: LLM diagnosis prices per token, and sessions can be huge.
    // Keep the most recent events within both an event-count and a character cap.
    const MAX_EVENTS = 300;
    const MAX_CHARS = 48_000;
    const rendered: string[] = [];
    let total = 0;
    let truncated = false;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const ev = timeline[i]!;
      let line: string | null = null;
      if (ev.type === "user_message") {
        line = `User: ${ev.content.slice(0, 500)}`;
      } else if (ev.type === "tool_call") {
        line = `ToolCall [${ev.toolName}]: ${ev.content}`;
      } else if (ev.type === "tool_result") {
        line = `ToolResult [${ev.toolName}]${ev.isError ? " ERROR" : ""}: ${ev.content.slice(0, 200)}`;
      }
      if (line === null) continue;
      const cost = line.length + 1;
      if (rendered.length >= MAX_EVENTS || (total + cost > MAX_CHARS && rendered.length > 0)) {
        truncated = true;
        break;
      }
      rendered.push(line);
      total += cost;
    }
    rendered.reverse();
    const timelineNote = truncated
      ? "Timeline (most recent events; older events omitted to stay within the prompt budget):"
      : "Timeline:";

    return [
      `You are the Harness² Experience Reflector for an autonomous AI coding agent.`,
      `Analyze the following dialogue and tool execution timeline to diagnose friction and propose harness self-evolutions.`,
      ``,
      `Harness Components:`,
      `- c2_rules: Domain constraints and rules (strictly <= 15 lines).`,
      `- c3_memory: Domain facts, schemas, terminology.`,
      `- c6_skill: Reusable workflows and procedures (must include triggerLine: "- When ..., load the \`<name>\` skill.").`,
      `- c7_script: Deterministic automation or validation scripts.`,
      ``,
      timelineNote,
      rendered.join("\n"),
      ``,
      `Output strictly valid JSON with this shape:`,
      `{`,
      `  "frictions": [`,
      `    {`,
      `      "category": "business_logic",`,
      `      "userEvidence": "exact user quote",`,
      `      "rootCause": "explanation"`,
      `    }`,
      `  ],`,
      `  "proposals": [`,
      `    {`,
      `      "component": "c2_rules",`,
      `      "summary": "short summary",`,
      `      "userEvidence": "exact user quote grounding this proposal",`,
      `      "triggerLine": "- When ..., load the \\\`...\\\` skill.",`,
      `      "contentDelta": "- Rule: ...",`,
      `      "confidence": 0.9`,
      `    }`,
      `  ]`,
      `}`,
    ].join("\n");
  }

  private mapDiagnosticProposals(result: DiagnosticResult, timeline?: TimelineEvent[]): HarnessProposal[] {
    const proposals: HarnessProposal[] = [];
    const validComponents: HarnessComponentType[] = ["c2_rules", "c3_memory", "c6_skill", "c7_script"];
    const userMessagesText = timeline
      ? timeline
          .filter((e) => e.type === "user_message")
          .map((e) => e.content.toLowerCase())
          .join(" ")
      : "";
    for (let i = 0; i < result.proposals.length; i++) {
      const p = result.proposals[i]!;
      if (!validComponents.includes(p.component as HarnessComponentType)) {
        continue;
      }
      // Untrusted LLM JSON: contentDelta must be a real string, downstream split() would TypeError
      if (typeof p.contentDelta !== "string" || p.contentDelta.length === 0) {
        continue;
      }
      if (p.targetFile !== undefined && typeof p.targetFile !== "string") {
        continue;
      }
      if (p.summary !== undefined && typeof p.summary !== "string") {
        continue;
      }
      // Evidence grounding probe for business rules / domain memory.
      // Only the proposal's OWN evidence counts — a shared friction quote must not
      // ground unrelated proposals (hallucination bypass).
      if ((p.component === "c2_rules" || p.component === "c3_memory") && userMessagesText.length > 0) {
        const evidenceToCheck = p.userEvidence;
        if (typeof evidenceToCheck !== "string" || !isGroundedInText(evidenceToCheck, userMessagesText)) {
          // Reject ungrounded hallucination
          continue;
        }
      }

      // P0 Security: targetPath is strictly constructed by component with sanitized basename
      let targetPath: string;
      if (p.component === "c2_rules") {
        targetPath = this.surface.getRulesFile();
      } else if (p.component === "c3_memory") {
        const safeName = p.targetFile ? path.basename(p.targetFile) : "domain-knowledge.md";
        if (safeName === "." || safeName === "..") continue;
        targetPath = path.join(this.surface.getMemoryDir(), safeName.endsWith(".md") ? safeName : `${safeName}.md`);
      } else if (p.component === "c6_skill") {
        let candidateName = "";
        if (p.targetFile) {
          const dir = path.dirname(p.targetFile);
          if (dir && dir !== "." && dir !== "/") {
            candidateName = path.basename(dir);
          } else {
            candidateName = path.basename(p.targetFile, path.extname(p.targetFile));
          }
        }
        if (!candidateName || candidateName.toLowerCase() === "skill") {
          candidateName = p.summary || "workflow";
        }
        const safeName = candidateName
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "");
        // CJK-only names sanitize to "": fall back to a stable per-summary slug so
        // distinct skills don't all collapse onto the same "workflow" directory
        const finalName = safeName || `workflow-${stableSuffix(p.summary ?? candidateName)}`;
        targetPath = path.join(this.surface.getSkillDir(), finalName, "SKILL.md");
      } else if (p.component === "c7_script") {
        const safeScript = p.targetFile ? path.basename(p.targetFile) : "check.sh";
        if (safeScript === "." || safeScript === "..") continue;
        targetPath = path.join(this.surface.getScriptsDir(), safeScript);
      } else {
        targetPath = this.surface.getRulesFile();
      }
      let triggerLine = p.triggerLine;
      if (p.component === "c6_skill") {
        const skillName = path.basename(path.dirname(targetPath));
        if (!triggerLine || !triggerLine.includes(`\`${skillName}\``)) {
          const cleanSummary = (p.summary || skillName).replace(/[\r\n`]+/g, " ").trim();
          triggerLine = `- When encountering ${cleanSummary}, load the \`${skillName}\` skill.`;
        }
      }
      // Anti-bloat: triggerLine is injected verbatim into the rules file — must stay a single line
      if (triggerLine) {
        triggerLine = triggerLine
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? "";
      }
      proposals.push({
        id: `prop-llm-${Date.now()}-${i}`,
        component: p.component as HarnessComponentType,
        targetPath,
        summary: p.summary || "LLM-generated harness improvement",
        triggerLine,
        contentDelta: p.contentDelta,
        confidence: typeof p.confidence === "number" ? p.confidence : 0.85,
      });
    }

    return proposals;
  }
}
