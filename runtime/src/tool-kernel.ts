import type { ApprovalManager } from "./approval.js";
import type { EditorSceneLease, EventType, RuntimeEvent } from "./protocol.js";
import type { ContentPart, ToolCall, ToolSchema } from "./provider/types.js";

export interface ToolContext {
  sessionId: string;
  turnId: string;
  itemId: string;
  sceneLeases?: readonly Readonly<EditorSceneLease>[];
  primarySceneId?: string | null;
  openScenePaths?: readonly string[];
  runtimeAutomationEnabled: boolean;
  approvalMode: "ask" | "auto";
  signal: AbortSignal;
  approvals: ApprovalManager;
  emit: (type: EventType, data: unknown, itemId?: string) => RuntimeEvent;
}

export interface ToolKernel {
  definitions(): ToolSchema[];
  execute(call: ToolCall, context: ToolContext): Promise<Record<string, unknown>>;
  executeWithObservations?(call: ToolCall, context: ToolContext): Promise<ToolExecutionResult>;
  releaseTurn?(sessionId: string, turnId: string): void;
}

export interface ToolExecutionResult extends Record<string, unknown> {
  output: Record<string, unknown>;
  observations?: ContentPart[];
}

export type ToolEffect = "read" | "write" | "execute";
export type ToolExecutorKind = "runtime" | "editor";

export interface ToolDefinition {
  schema: ToolSchema;
  executor: ToolExecutorKind;
  effect: ToolEffect;
  execute(
    args: Readonly<Record<string, unknown>>,
    context: ToolContext,
    call: ToolCall,
  ): Promise<Record<string, unknown> | ToolExecutionResult> | Record<string, unknown> | ToolExecutionResult;
}
