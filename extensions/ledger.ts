import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerEntry, HarnessProposal } from "./types.js";
import type { HostInfo } from "./host-detector.js";
import { SurfaceManager } from "./surface.js";

export class ImprovementLedger {
  private ledgerPath: string;
  private surface: SurfaceManager;

  constructor(private hostInfo: HostInfo) {
    this.ledgerPath = path.join(hostInfo.projectConfigDir, "harness", "ledger.json");
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
      if (Array.isArray(parsed)) {
        return parsed as LedgerEntry[];
      }
      return [];
    } catch {
      return [];
    }
  }

  public recordCommit(proposal: HarnessProposal, sessionId: string, previousContent?: string): LedgerEntry {
    const entries = this.getEntries();

    const entry: LedgerEntry = {
      id: `harn-${Date.now()}`,
      timestamp: Date.now(),
      sessionId,
      action: previousContent !== undefined ? "UPDATE" : "CREATE",
      component: proposal.component,
      filePath: proposal.targetPath,
      summary: proposal.summary,
      previousContent,
      appliedContent: proposal.contentDelta,
      status: "APPLIED",
    };

    entries.unshift(entry);
    this.saveEntries(entries);
    return entry;
  }

  public rollback(id: string): { success: boolean; error?: string } {
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

      // If c6_skill rollback, remove trigger line from rules file
      if (entry.component === "c6_skill") {
        this.cleanTriggerLineFromRules(entry.filePath);
      }

      entry.status = "REVERTED";
      this.saveEntries(entries);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private cleanTriggerLineFromRules(skillFilePath: string): void {
    const skillName = path.basename(path.dirname(skillFilePath));
    const rulesPath = this.surface.getRulesFile();

    if (!fs.existsSync(rulesPath)) return;

    try {
      const content = fs.readFileSync(rulesPath, "utf-8");
      const lines = content.split("\n");
      const targetPattern = `\`${skillName}\` skill`;
      const filtered = lines.filter((line) => !line.includes(targetPattern));

      fs.writeFileSync(rulesPath, filtered.join("\n").trimEnd() + "\n", "utf-8");
    } catch {
      // Best-effort cleanup
    }
  }

  private saveEntries(entries: LedgerEntry[]): void {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.ledgerPath, JSON.stringify(entries, null, 2), "utf-8");
  }
}
