import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as PiAI from "@oh-my-pi/pi-ai";
import { registerHarness, type HarnessContext } from "./core.js";
import type { LLMCompletionFn } from "./types.js";

/**
 * Best-effort reflection LLM: reuses the session's active model through the host's
 * own pi-ai runtime (API keys included). Any failure returns undefined and the
 * reflector degrades to deterministic diagnosis.
 */
async function createOmpLLMCaller(ctx: HarnessContext): Promise<LLMCompletionFn | undefined> {
  // The ctx object IS the host's ExtensionContext, passed through from the event.
  const model = (ctx as ExtensionContext).model;
  if (!model) return undefined;
  try {
    // Dynamic on purpose: pi-ai belongs to the host runtime and may be absent or
    // shaped differently; a static import would crash extension load instead of
    // degrading to deterministic diagnosis.
    const piAI = (await import("@oh-my-pi/pi-ai")) as typeof PiAI;
    if (typeof piAI.completeSimple !== "function") return undefined;
    return async (prompt: string): Promise<string> => {
      const assistant = await piAI.completeSimple(model, {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      });
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        throw new Error(assistant.errorMessage ?? `completion stopped: ${assistant.stopReason}`);
      }
      const text = (assistant.content ?? [])
        .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (!text.trim()) throw new Error("empty completion");
      return text;
    };
  } catch {
    return undefined;
  }
}

export default function piHarness2OmpExtension(pi: ExtensionAPI) {
  // OMP has no `agent_settled`; `agent_end` is the loop-end signal.
  registerHarness(pi, { loopEndEvent: "agent_end", createLLMCaller: createOmpLLMCaller });
}
