import type { HarnessReportData } from "./types.js";

export class HarnessReporter {
  public static renderTerminalReport(data: HarnessReportData): string {
    const esc = "\x1b[";
    const rst = `${esc}0m`;
    const bold = `${esc}1m`;
    const cyan = `${esc}36m`;
    const yellow = `${esc}33m`;
    const green = `${esc}32m`;
    const red = `${esc}31m`;

    const statusColor = data.errorRate > 15 ? red : data.errorRate > 0 ? yellow : green;

    const lines: string[] = [
      `${bold}=== [pi-harness2] Continuous Optimization Report ===${rst}`,
      `Host Platform : ${cyan}${data.host.toUpperCase()}${rst} (${data.baseDir})`,
      `Invocations   : ${data.totalCalls} calls | ${statusColor}${data.totalErrors} errors (${data.errorRate.toFixed(1)}%)${rst}`,
      `Components    : ${green}${data.activeComponents.skillsCount} skills${rst}, ${yellow}${data.activeComponents.rulesCount} rule lines${rst}, ${cyan}${data.activeComponents.scriptsCount} scripts${rst}`,
    ];

    if (data.topFailingTools.length > 0) {
      lines.push(`${bold}Failing Tools :${rst}`);
      for (const item of data.topFailingTools.slice(0, 3)) {
        lines.push(`  - ${yellow}${item.tool}${rst}: ${item.count} failure(s)`);
      }
    }

    if (data.outcomeEntries && data.outcomeEntries.length > 0) {
      lines.push(`${bold}Mutation Outcomes :${rst}`);
      for (const e of data.outcomeEntries.slice(0, 5)) {
        const o = e.outcome!;
        const color = o.status === "improved" ? green : o.status === "regressed" ? red : yellow;
        const state = e.status === "REVERTED" ? `${cyan}[REVERTED]${rst} ` : "";
        const flag = e.status === "APPLIED" && o.consecutiveRegressed >= 2 ? ` ${red}[ROLLBACK CANDIDATE]${rst}` : "";
        lines.push(`  - ${state}${color}${o.status.toUpperCase()}${rst} (${o.samples}x) ${e.summary}${flag}`);
        if (o.detail) lines.push(`      ${o.detail}`);
      }
    }

    if (data.triggerAudit && (data.triggerAudit.repaired > 0 || data.triggerAudit.skipped > 0)) {
      lines.push(`${bold}Trigger Audit :${rst} ${green}${data.triggerAudit.repaired} repaired${rst}, ${data.triggerAudit.skipped} skipped (cap/invalid frontmatter)`);
    }

    if (data.warnings && data.warnings.length > 0) {
      lines.push(`${bold}Warnings :${rst}`);
      for (const w of data.warnings) {
        lines.push(`  - ${yellow}${w}${rst}`);
      }
    }

    if (data.frictions.length > 0) {
      lines.push(`${bold}Active Frictions :${rst}`);
      for (const f of data.frictions.slice(0, 2)) {
        lines.push(`  - [${f.type}] ${f.description}`);
      }
    }

    if (data.recentLedgerEntries.length > 0) {
      lines.push(`${bold}Recent Mutations :${rst}`);
      for (const e of data.recentLedgerEntries.slice(0, 2)) {
        lines.push(`  - ${e.id} [${e.status}] ${e.summary}`);
      }
    }

    return lines.join("\n");
  }

  public static renderMarkdownReport(data: HarnessReportData): string {
    const lines: string[] = [
      `# Harness² Optimization Report`,
      ``,
      `- **Generated**: ${new Date().toISOString()}`,
      `- **Host**: \`${data.host.toUpperCase()}\` (\`${data.baseDir}\`)`,
      `- **Total Invocations**: ${data.totalCalls}`,
      `- **Total Errors**: ${data.totalErrors} (${data.errorRate.toFixed(2)}%)`,
      ``,
      `## Active Harness Surface`,
      `- **Skills**: ${data.activeComponents.skillsCount}`,
      `- **Rules (lines)**: ${data.activeComponents.rulesCount}`,
      `- **Scripts**: ${data.activeComponents.scriptsCount}`,
      ``,
    ];

    if (data.topFailingTools.length > 0) {
      lines.push(`## Friction Hotspots`);
      lines.push(`| Tool | Failure Count |`);
      lines.push(`| :--- | :--- |`);
      for (const t of data.topFailingTools) {
        lines.push(`| \`${t.tool}\` | ${t.count} |`);
      }
      lines.push(``);
    }

    if (data.outcomeEntries && data.outcomeEntries.length > 0) {
      lines.push(`## Mutation Outcomes`);
      lines.push(`| Commit | Entry | Outcome | Samples | Detail |`);
      lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
      for (const e of data.outcomeEntries) {
        const o = e.outcome!;
        const flag = e.status === "APPLIED" && o.consecutiveRegressed >= 2 ? " **[ROLLBACK CANDIDATE]**" : "";
        lines.push(`| \`${e.id}\` | ${e.status} | ${o.status}${flag} | ${o.samples} | ${o.detail ?? ""} |`);
      }
      lines.push(``);
    }

    if (data.warnings && data.warnings.length > 0) {
      lines.push(`## Warnings`);
      for (const w of data.warnings) {
        lines.push(`- ${w}`);
      }
      lines.push(``);
    }

    if (data.recentLedgerEntries.length > 0) {
      lines.push(`## Recent Ledger Mutations`);
      lines.push(`| Commit ID | Component | Status | Summary |`);
      lines.push(`| :--- | :--- | :--- | :--- |`);
      for (const e of data.recentLedgerEntries) {
        lines.push(`| \`${e.id}\` | \`${e.component}\` | ${e.status} | ${e.summary} |`);
      }
      lines.push(``);
    }

    return lines.join("\n");
  }
}
