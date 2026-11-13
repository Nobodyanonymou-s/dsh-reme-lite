import { a as SearchHit } from "./store-BwMh64xf.js";
interface Turn {
  role: "user" | "assistant";
  text: string;
  at: string;
  /**
   * The message's own source declaration, when it carried one. The Host stamps
   * real prompts `{ kind: "user" }` and harness-injected context (time samples,
   * runtime snapshots, schedule reminders) with its own kinds; no source at all
   * means an older host. The journal persists it so the transcript readers can
   * tell the two apart; the daily projection ignores it — callers decide who is
   * human before they project.
   */
  sourceKind?: string | null;
}
/**
 * Extract a capturable turn from a session event, tolerating payload shapes.
 */
declare function turnFromEvent(event: unknown): Turn | null;
/**
 * The Host surface this plugin actually touches, as a structural type.
 *
 * The plugin tolerates hosts that lack any given service (file-path mounts,
 * compositions without a web server or schedule), so it probes at runtime
 * instead of declaring hard dependencies. These interfaces document that
 * contract precisely without binding to specific `@deepseek-ai/*` types —
 * which also keeps the compiled output free of any host import.
 */
interface HostContext {
  effect(setup: () => unknown, label?: string): void;
  on(name: string, listener: (...args: never[]) => void): void;
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  logger?: {
    warn?: (format: string, ...args: unknown[]) => void;
    info?: (format: string, ...args: unknown[]) => void;
  };
  tools?: {
    register: (tool: RegisteredTool) => () => void;
  };
  [key: string]: unknown;
}
interface SessionLike {
  id?: string;
  header?: {
    id?: string;
    origin?: string;
  } & Record<string, unknown>;
  events?: unknown[];
}
/** Tool execution context the Host passes as the second execute argument. */
interface ToolExec {
  agent?: {
    session?: SessionLike;
  };
}
/**
 * `Config` is resolved lazily, and it is optional by construction.
 *
 * Declaring a schema buys the settings form (a real switch in Settings →
 * Plugins). It needs the Host's schemastery, which only resolves when this
 * package is installed inside the profile — so the import must not be allowed
 * to fail the whole module. A file-path mount therefore degrades to "no form,
 * configure through the patch entry" instead of "plugin never loads".
 */
declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
  workspace: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  language: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  agentName: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  captureEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
  rootAgentsOnly: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
  captureInterval: import("@deepseek-ai/schemastery").default<number, number, "defined">;
  searchLimit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
  maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
  reindexTtlMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
  dreamEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
  dreamCron: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  dreamTimeZone: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  dreamTitle: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  briefEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
  briefBudget: import("@deepseek-ai/schemastery").default<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  workspace: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  language: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  agentName: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  captureEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
  rootAgentsOnly: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
  captureInterval: import("@deepseek-ai/schemastery").default<number, number, "defined">;
  searchLimit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
  maxChars: import("@deepseek-ai/schemastery").default<number, number, "defined">;
  reindexTtlMs: import("@deepseek-ai/schemastery").default<number, number, "defined">;
  dreamEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
  dreamCron: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  dreamTimeZone: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  dreamTitle: import("@deepseek-ai/schemastery").default<string, string, "defined">;
  briefEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
  briefBudget: import("@deepseek-ai/schemastery").default<number, number, "defined">;
}>>, "plain"> | undefined;
/**
 * Same shape dsh-llm publishes: a frozen, deeply cloned user message carrying a
 * fresh stable id. `brandString` is erased at runtime, so a plain UUID matches.
 */
declare function createUserMessage(input: {
  content: unknown[];
  source: unknown;
}): unknown;
interface ToolParamField {
  type?: string;
  required?: boolean;
  description?: string;
  enum?: string[];
  const?: unknown;
  items?: unknown;
}
type ToolParamSpec = Record<string, ToolParamField>;
/**
 * Compile the concise parameter DSL the Host's tools use into the JSON Schema
 * the registry validates against.
 */
declare function toJsonSchema(spec?: ToolParamSpec): Record<string, unknown>;
interface ToolOutput {
  schema: unknown;
  render: (args: any, value: any) => Array<{
    type: string;
    text: unknown;
  }>;
}
interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: unknown;
    render: ToolOutput["render"];
  };
  execute: (args: any, exec?: any) => unknown;
  presentCall?: (args: any) => unknown;
}
/**
 * Boot beacon (opt-in). The Host prints load failures to its own stdout, which
 * a GUI launch makes invisible; this writes the same facts to a file so a
 * failed mount can be diagnosed without guessing. Silent by default — set
 * DSH_NODE_MEMORY_BEACON=1 when a mount needs watching.
 */
declare function beacon(message: string): void;
declare const name = "node-memory";
declare const inject: string[];
interface MemoryConfig {
  workspace: string;
  language: "zh" | "en";
  /** Stable writer identity for teams; empty = derive from each session. */
  agentName: string;
  captureEnabled: boolean;
  rootAgentsOnly: boolean;
  captureInterval: number;
  searchLimit: number;
  maxChars: number;
  reindexTtlMs: number;
  dreamEnabled: boolean;
  dreamCron: string;
  dreamTimeZone: string | null;
  dreamTitle: string;
  /** Opt-in session-start brief; off is the default and on is an experiment. */
  briefEnabled: boolean;
  /** Character budget for the whole brief, title and headings included. */
  briefBudget: number;
}
/**
 * Working language. `auto` (the default) follows the system locale, so the
 * plugin speaks whatever the machine speaks; an explicit zh/en wins and is what
 * the settings dropdown writes.
 */
declare function resolveLanguage(requested: string | undefined, env?: NodeJS.ProcessEnv): "zh" | "en";
/**
 * Who is writing or searching. A configured `agentName` wins (the stable
 * identity a team mount wants), then the session's agent preset, then the
 * session's short id. Background paths (dream material, status) have no
 * session and fall back to "host".
 */
declare function agentIdentity(exec: ToolExec | undefined, config: Pick<MemoryConfig, "agentName">): string;
/** Short session tag for frontmatter — matches the daily page trailer. */
declare function sessionTag(exec: ToolExec | undefined): string | null;
/**
 * Whether the caller's identity survives the session. `agentName` and the
 * agent preset do; a bare session id does not — tomorrow's session derives a
 * different one. Private notes need a stable owner: a note private to a
 * session id would be invisible to its own writer a day later, so an unstable
 * identity writes the team layer instead of the private one.
 */
declare function stableIdentity(exec: ToolExec | undefined, config: Pick<MemoryConfig, "agentName">): boolean;
declare function resolveConfig(input?: Partial<MemoryConfig>, env?: NodeJS.ProcessEnv): MemoryConfig;
declare function memoryGuidance(language?: "zh" | "en"): string;
/**
 * The prompt the Host delivers when the reminder fires.
 */
declare function dreamReminderPrompt(language?: "zh" | "en"): string;
declare function apply(ctx: HostContext, input?: Partial<MemoryConfig>): void;
declare function formatEvidence(hits: SearchHit[]): string;
declare function hasGuidance(session: unknown, pending?: readonly unknown[]): boolean;
export { Config, MemoryConfig, RegisteredTool, ToolOutput, ToolParamField, ToolParamSpec, agentIdentity, apply, beacon, createUserMessage, dreamReminderPrompt, formatEvidence, hasGuidance, inject, memoryGuidance, name, resolveConfig, resolveLanguage, sessionTag, stableIdentity, toJsonSchema, turnFromEvent };