import type { ToolExecutionRecord, FrictionPoint } from "./types.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export class SessionTracer {
  private records: ToolExecutionRecord[] = [];
  private maxRecords = 100;

  public record(record: ToolExecutionRecord): void {
    if (this.records.length >= this.maxRecords) {
      this.records.shift();
    }
    const cleanRecord = {
      ...record,
      outputPreview: record.outputPreview ? stripAnsi(record.outputPreview) : undefined,
    };
    this.records.push(cleanRecord);
  }

  public getRecords(): readonly ToolExecutionRecord[] {
    return this.records;
  }

  public getErrors(): ToolExecutionRecord[] {
    return this.records.filter((r) => r.isError);
  }

  public getFrictionPoints(): FrictionPoint[] {
    const frictions: FrictionPoint[] = [];
    const errorMap = new Map<string, string[]>();

    for (const r of this.records) {
      if (r.isError) {
        const list = errorMap.get(r.toolName) ?? [];
        if (r.outputPreview) {
          list.push(r.outputPreview.slice(0, 200));
        } else {
          list.push("Execution failed");
        }
        errorMap.set(r.toolName, list);
      }
    }

    for (const [tool, errors] of errorMap.entries()) {
      // Harness² Rule: Minimum threshold of >= 2 errors to avoid false positives on transient exploration
      if (errors.length >= 2) {
        frictions.push({
          type: "tool_error_loop",
          toolName: tool,
          description: `Tool "${tool}" failed ${errors.length} times in current session`,
          frequency: errors.length,
          sampleErrors: errors.slice(0, 3),
        });
      }
    }

    return frictions;
  }

  public getTopFailingTools(): Array<{ tool: string; count: number }> {
    const countMap = new Map<string, number>();
    for (const r of this.records) {
      if (r.isError) {
        countMap.set(r.toolName, (countMap.get(r.toolName) ?? 0) + 1);
      }
    }

    return Array.from(countMap.entries())
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count);
  }

  public clear(): void {
    this.records = [];
  }
}
