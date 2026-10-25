import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerEntry, HarnessProposal, MutationOutcome, ToolEvidence } from "./types.js";
import { getHarnessPaths, type HostInfo } from "./host-detector.js";
import { SurfaceManager } from "./surface.js";

const MAX_LEDGER_ENTRIES = 500;

function isValidEntry(e: unknown): e is LedgerEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.timestamp === "number" &&
    typeof o.component === "string" &&
    typeof o.filePath === "string" &&
    (o.status === "APPLIED" || o.status === "REVERTED") &&
    (o.action === "CREATE" || o.action === "UPDATE" || o.action === "DELETE")
  );
}

/**
 * Cross-process read-modify-write guard: two hosts in the same project would
 * otherwise clobber each other's ledger commits (last writer wins, entries lost).
 */
function withLedgerLock<T>(lockPath: string, fn: () => T): T {
  const STALE_MS = 10_000;
  const deadline = Date.now() + 2000;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd: number | undefined;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        continue;
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // lock vanished between open and stat — retry immediately
      }
      if (Date.now() > deadline) return fn(); // degrade to unlocked write rather than fail
      const waitUntil = Date.now() + 50;
      while (Date.now() < waitUntil) {
        /* synchronous backoff */
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(lockPath, { force: true });
    } catch {
      // best-effort release
    }
  }
}

export class ImprovementLedger {
  private ledgerPath: string;
  private surface: SurfaceManager;
  private commitSeq = 0;
  constructor(private hostInfo: HostInfo) {
    this.ledgerPath = getHarnessPaths(hostInfo).ledgerFile;
    this.surface = new SurfaceManager(hostInfo);
  }

  public getLedgerPath(): string {
    return this.ledgerPath;
  }

  public getEntries(): LedgerEntry[] {
    if (!fs.existsSync(this.ledgerPath)) {
      return [];
    }
    try {
      const data = fs.readFileSync(this.ledgerPath, "utf-8");
      const parsed = JSON.parse(data) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidEntry);
    } catch {
      return [];
    }
  }

  public recordCommit(
    proposal: HarnessProposal,
    sessionId: string,
    previousContent?: string,
    triggerAdded?: boolean,
    evidence?: ToolEvidence,
  ): LedgerEntry {
    const entry: LedgerEntry = {
      id: `harn-${Date.now()}-${++this.commitSeq}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`,
      timestamp: Date.now(),
      sessionId,
      action: previousContent !== undefined ? "UPDATE" : "CREATE",
      component: proposal.component,
      filePath: proposal.targetPath,
      summary: proposal.summary,
      previousContent,
      appliedContent: proposal.contentDelta,
      status: "APPLIED",
      triggerAdded,
      evidence: evidence ?? proposal.evidence,
    };

    withLedgerLock(`${this.ledgerPath}.lock`, () => {
      const entries = this.getEntries();
      entries.unshift(entry);
      this.saveEntries(entries);
    });
    return entry;
  }

  /**
   * Record a definitive post-application measurement. Only improved/neutral/regressed
   * count as samples; consecutive regressions drive the rollback candidate policy.
   * A session is measured at most once: repeat shutdowns for the same session
   * (reload storms, duplicate events) are ignored via measuredSessionStart.
   */
  public recordOutcome(
    id: string,
    status: MutationOutcome["status"],
    detail?: string,
    sessionStart?: number,
  ): LedgerEntry | undefined {
    return withLedgerLock(`${this.ledgerPath}.lock`, () => {
      const entries = this.getEntries();
      const entry = entries.find((e) => e.id === id);
      if (!entry || entry.status !== "APPLIED") return undefined;
      const prev = entry.outcome;
      if (sessionStart !== undefined && prev?.measuredSessionStart === sessionStart) {
        return undefined; // this session already produced its verdict
      }
      entry.outcome = {
        status,
        measuredAt: Date.now(),
        measuredSessionStart: sessionStart,
        samples: (prev?.samples ?? 0) + 1,
        consecutiveRegressed: status === "regressed" ? (prev?.consecutiveRegressed ?? 0) + 1 : 0,
        detail: detail ?? prev?.detail,
      };
      this.saveEntries(entries);
      return entry;
    });
  }

  public rollback(id: string): { success: boolean; error?: string } {
    return withLedgerLock(`${this.ledgerPath}.lock`, () => {
      const entries = this.getEntries();
      const entry = entries.find((e) => e.id === id);

      if (!entry) {
        return { success: false, error: `Ledger entry ${id} not found.` };
      }

      if (entry.status === "REVERTED") {
        return { success: false, error: `Ledger entry ${id} is already reverted.` };
      }

      try {
        if (entry.action === "CREATE") {
          if (fs.existsSync(entry.filePath)) {
            fs.unlinkSync(entry.filePath);
          }

          // Clean up empty skill directory if applicable
          if (entry.component === "c6_skill") {
            const skillDir = path.dirname(entry.filePath);
            if (fs.existsSync(skillDir) && fs.readdirSync(skillDir).length === 0) {
              fs.rmdirSync(skillDir);
            }
          }
        } else if (entry.action === "UPDATE" && entry.previousContent !== undefined) {
          fs.writeFileSync(entry.filePath, entry.previousContent, "utf-8");
        }

        // Remove the trigger registration only when THIS mutation added it — the
        // CREATE entry that registered an earlier skill's trigger stays untouched
        // when rolling back a later content UPDATE.
        if (entry.component === "c6_skill" && (entry.action === "CREATE" || entry.triggerAdded)) {
          const skillName = path.basename(path.dirname(entry.filePath));
          this.surface.removeTriggerLineFromRules(skillName);
        }

        entry.status = "REVERTED";
        this.saveEntries(entries);
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    });
  }

  private saveEntries(entries: LedgerEntry[]): void {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const capped = entries.slice(0, MAX_LEDGER_ENTRIES);
    const tmp = `${this.ledgerPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(capped, null, 2), "utf-8");
    fs.renameSync(tmp, this.ledgerPath);
  }
}
