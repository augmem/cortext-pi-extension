/**
 * Transcribed from the INSTALLED `@earendil-works/pi-coding-agent` package
 * (v0.84.2) — dist/core/extensions/types.d.ts, dist/core/messages.d.ts,
 * dist/core/session-manager.d.ts, dist/core/compaction/compaction.d.ts, and
 * the pi-ai / pi-agent-core message types. Only the surface this extension
 * uses is transcribed.
 *
 * If pi's extension surface changes, this transcription is re-verified
 * against the real installed package's dist/ types, not against docs.
 * Runtime compatibility is structural: pi passes the real ExtensionAPI /
 * ExtensionContext objects and this extension only touches the members
 * declared here.
 */

// ---------------------------------------------------------------------------
// Message content parts (pi-ai)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  /** True when the provider redacted this thinking block for safety. */
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  namespace?: string;
}

// ---------------------------------------------------------------------------
// Messages (pi-ai + pi-coding-agent module augmentation)
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage
  | BashExecutionMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

// ---------------------------------------------------------------------------
// Assistant streaming events (pi-ai, token-level)
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "start" | "text_start" | "text_end" | "thinking_start" | "thinking_end" | "toolcall_start" | "toolcall_delta" | "toolcall_end" | "done" | "error" };

// ---------------------------------------------------------------------------
// Session entries (session-manager)
// ---------------------------------------------------------------------------

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  /** True when the entry was provided by an extension. */
  fromHook?: boolean;
}

/** Non-message entry types (model_change, thinking_level_change, custom,
 *  custom_message, branch_summary, label, session_info) share the base. */
export type SessionEntry =
  | SessionMessageEntry
  | CompactionEntry
  | (SessionEntryBase & { type: string });

// ---------------------------------------------------------------------------
// Compaction contract (compaction.d.ts)
// ---------------------------------------------------------------------------

export interface FileOperations {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface CompactionPreparation {
  /** UUID of the first entry to keep (pi's own keep-recent-tokens cut). */
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}

export interface CompactionResult<T = unknown> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  /** Omitted by zero-LLM (extension) compaction — no provider call was made. */
  usage?: unknown;
  details?: T;
}

// ---------------------------------------------------------------------------
// Events this extension subscribes to
// ---------------------------------------------------------------------------

export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

export interface MessageStartEvent {
  type: "message_start";
  message: AgentMessage;
}

export interface MessageUpdateEvent {
  type: "message_update";
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  /** The raw user prompt text (after expansion). */
  prompt: string;
  images?: ImageContent[];
  /** The fully assembled system prompt string (chained across handlers). */
  systemPrompt: string;
  systemPromptOptions: unknown;
}

export interface ContextEvent {
  type: "context";
  /** Deep copy of the messages that will be sent to the LLM; replaceable. */
  messages: AgentMessage[];
}

export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  /** All entries on the current branch, root -> leaf order. */
  branchEntries: SessionEntry[];
  customInstructions?: string;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Handler results
// ---------------------------------------------------------------------------

export interface BeforeAgentStartEventResult {
  /** Replace the system prompt for this run; chained across handlers. */
  systemPrompt?: string;
  message?: unknown;
}

export interface ContextEventResult {
  /** Replace the message list for this LLM call. */
  messages?: AgentMessage[];
}

export interface SessionBeforeCompactResult {
  cancel?: boolean;
  /** Extension-provided compaction: no LLM summary call is made. */
  compaction?: CompactionResult;
}

// ---------------------------------------------------------------------------
// Extension context + API (the members this extension uses)
// ---------------------------------------------------------------------------

export interface ReadonlySessionManager {
  getCwd(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  /** Current branch path, root -> leaf, all entry types. */
  getBranch(): SessionEntry[];
  buildContextEntries(): SessionEntry[];
}

export interface ExtensionContext {
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  cwd: string;
  sessionManager: ReadonlySessionManager;
  isIdle(): boolean;
  getSystemPrompt(): string;
}

export type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

export interface ExtensionAPI {
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
  on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
  on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
  on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
  on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
  on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void;
}
