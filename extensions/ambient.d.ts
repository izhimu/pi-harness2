declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionUIContext {
    notify?(message: string, level?: "info" | "warning" | "error"): void;
    setStatus?(key: string, value: string): void;
  }

  export interface ExtensionCommandContext {
    cwd: string;
    ui?: ExtensionUIContext;
    hasUI?: boolean;
    waitForIdle?(): Promise<void>;
    reload?(): Promise<void>;
  }

  export interface ExtensionContext {
    cwd: string;
    ui?: ExtensionUIContext;
    hasUI?: boolean;
    isIdle?(): boolean;
    reload?(): Promise<void>;
  }

  export interface AutocompleteItem {
    value: string;
    label?: string;
    description?: string;
  }

  export interface ToolCallEvent {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }

  export interface ToolResultEvent {
    toolCallId?: string;
    toolName: string;
    input: unknown;
    isError?: boolean;
    content?: unknown;
    details?: unknown;
  }

  export interface ExtensionAPI {
    on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "session_stop", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "turn_start", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "turn_end", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "input", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "tool_result", handler: (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: string, handler: (event?: any, ctx?: any, ...args: any[]) => any): void;

    registerCommand(
      name: string,
      def: {
        description: string;
        getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
      },
    ): void;

    registerTool?(tool: unknown): void;
    sendMessage?(message: unknown, options?: unknown): void;
  }
}

declare module "@oh-my-pi/pi-coding-agent" {
  export * from "@earendil-works/pi-coding-agent";
}
