import { parseImageAnnotations, type ImageAnnotation } from "./image-annotations.js";

export const PROTOCOL_VERSION = 1 as const;

export type EventType =
  | "server.ready"
  | "asset.progress"
  | "session.created"
  | "turn.started"
  | "context.prepared"
  | "message.delta"
  | "message.completed"
  | "reasoning.summary.delta"
  | "tool.started"
  | "tool.output.delta"
  | "tool.completed"
  | "approval.requested"
  | "approval.resolved"
  | "file_change.proposed"
  | "file_change.applied"
  | "editor_change.proposed"
  | "editor_change.applied"
  | "editor.tool.request"
  | "provider.fallback"
  | "usage.updated"
  | "turn.completed"
  | "turn.failed";

export interface RuntimeEvent<T = unknown> {
  version: typeof PROTOCOL_VERSION;
  seq: number;
  time: string;
  type: EventType;
  session_id?: string;
  turn_id?: string;
  item_id?: string;
  data: T;
}

export type ApprovalDecision = "accept" | "accept_for_session" | "decline";

export interface TurnAttachmentReference {
  attachment_id: string;
  detail: "low" | "high";
  annotations?: ImageAnnotation[];
  annotated_from?: string;
  source?: "file" | "clipboard" | "project_resource" | "editor_viewport" | "game_frame";
  name?: string;
  run_id?: string;
  scene_id?: string;
  scene_path?: string;
  captured_at_ms?: number;
  viewport_width?: number;
  viewport_height?: number;
  frame?: number;
}

export interface EditorSceneLease {
  scene_id: string;
  scene_path: string;
  scene_revision: string;
}

export interface EditorSceneLeaseContext {
  scene_leases: EditorSceneLease[];
  primary_scene_id: string | null;
  open_scene_paths: string[];
}

export interface EditorToolRequestData {
  request_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  scene_lease?: EditorSceneLease;
}

export interface EditorChangePreview {
  scene_id: string;
  scene_path: string;
  scene_revision: string;
  changes: unknown[];
}

export interface EditorChangeProposedData {
  change_id: string;
  scene_id: string;
  scene_path: string;
  scene_revision: string;
  changes: unknown[];
  preview: EditorChangePreview;
}

export interface EditorChangeAppliedData {
  change_id: string;
  operation_id: string;
  scene_id: string;
  scene_path: string;
  previous_scene_revision: string;
  scene_revision: string;
  changes: unknown[];
  requested_changes: unknown[];
  result: Record<string, unknown>;
}

export interface EditorToolResponseError {
  code: string;
  message: string;
  data?: unknown;
}

export type EditorToolRespondParams =
  | { request_id: string; result: Record<string, unknown>; error?: never }
  | { request_id: string; result?: never; error: EditorToolResponseError };

export interface ImageGenerateParams {
  generation_id: string;
  prompt: string;
  model: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: "png" | "jpeg" | "webp";
  target_width?: number;
  target_height?: number;
}

export interface ImageEditParams {
  generation_id: string;
  source_attachment_id: string;
  mode: "reskin" | "atlas_variation";
  prompt: string;
  model: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: "png";
  input_fidelity?: "low" | "high";
  columns?: number;
  rows?: number;
}

export interface SkillSaveParams {
  scope: "user" | "project";
  name: string;
  description: string;
  instructions: string;
  triggers?: string[];
  capabilities?: string[];
  enabled?: boolean;
}

export type ClientRequest =
  | {
      id: string;
      method: "configure";
      params: RuntimeConfig;
    }
  | {
      id: string;
      method: "providers.list";
      params?: Record<string, never>;
    }
  | {
      id: string;
      method: "models.list";
      params?: Record<string, never>;
    }
  | {
      id: string;
      method: "image.capabilities";
      params?: Record<string, never>;
    }
  | {
      id: string;
      method: "image.generate";
      params: ImageGenerateParams;
    }
  | {
      id: string;
      method: "image.edit";
      params: ImageEditParams;
    }
  | {
      id: string;
      method: "image.cancel";
      params: { generation_id: string };
    }
  | {
      id: string;
      method: "ui_kit.generate";
      params: Record<string, unknown>;
    }
  | {
      id: string;
      method: "attachment.register";
      params: { attachment_id: string };
    }
  | {
      id: string;
      method: "attachment.get";
      params: { attachment_id: string };
    }
  | {
      id: string;
      method: "session.create";
      params?: { system_prompt?: string; title?: string };
    }
  | {
      id: string;
      method: "index.status" | "index.rebuild";
      params?: Record<string, never>;
    }
  | {
      id: string;
      method: "skills.list" | "skills.refresh";
      params?: Record<string, never>;
    }
  | {
      id: string;
      method: "skills.get";
      params: { id: string };
    }
  | {
      id: string;
      method: "skills.save";
      params: SkillSaveParams;
    }
  | {
      id: string;
      method: "skills.delete";
      params: { id: string };
    }
  | {
      id: string;
      method: "skills.set_enabled";
      params: { id: string; enabled: boolean };
    }
  | {
      id: string;
      method: "session.list";
      params?: Record<string, never>;
    }
  | {
      id: string;
      method: "session.get";
      params: { session_id: string };
    }
  | {
      id: string;
      method: "session.rename";
      params: { session_id: string; title: string };
    }
  | {
      id: string;
      method: "session.delete";
      params: { session_id: string };
    }
  | {
      id: string;
      method: "turn.start";
      params: {
        session_id: string;
        prompt: string;
        display_prompt?: string;
        model?: string;
        reasoning_effort?: string;
        scene_leases?: EditorSceneLease[];
        primary_scene_id?: string | null;
        open_scene_paths?: string[];
        runtime_automation_enabled?: boolean;
        attachments?: TurnAttachmentReference[];
      };
    }
  | {
      id: string;
      method: "turn.cancel";
      params: { session_id: string };
    }
  | {
      id: string;
      method: "approval.respond";
      params: { request_id: string; decision: ApprovalDecision };
    }
  | {
      id: string;
      method: "editor.tool.respond";
      params: EditorToolRespondParams;
    }
  | {
      id: string;
      method: "ping";
      params?: Record<string, never>;
    }
  | {
      id: string;
      method: "shutdown";
      params?: Record<string, never>;
    };

export interface RuntimeConfig {
  provider_id?: string;
  provider_config?: Record<string, unknown>;
  /** @deprecated v1 compatibility alias for the OpenAI-compatible provider. */
  base_url?: string;
  /** @deprecated v1 compatibility alias for the OpenAI-compatible provider. */
  api_key?: string;
  model: string;
  /** @deprecated v1 compatibility alias for the OpenAI-compatible provider. */
  api_mode?: "auto" | "responses" | "chat_completions";
  approval_mode?: "ask" | "auto";
  /** @deprecated Omit this compatibility limit to use the adaptive progress-driven loop. */
  max_steps?: number;
  write_allowlist?: string[];
}

export interface ServerResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string; data?: unknown };
}

export function parseTurnAttachmentReferences(value: unknown): TurnAttachmentReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  if (value.length > 4) throw new Error("attachments may contain at most 4 images");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const field = `attachments[${index}]`;
    if (!isRecord(entry)) throw new Error(`${field} must be an object`);
    const allowedKeys = new Set([
      "attachment_id",
      "detail",
      "annotations",
      "annotated_from",
      "source",
      "name",
      "run_id",
      "scene_id",
      "scene_path",
      "captured_at_ms",
      "viewport_width",
      "viewport_height",
      "frame",
    ]);
    const unknownKey = Object.keys(entry).find((key) => !allowedKeys.has(key));
    if (unknownKey) throw new Error(`${field} contains unsupported field: ${unknownKey}`);
    if (!("attachment_id" in entry) || !("detail" in entry)) throw new Error(`${field} requires attachment_id and detail`);
    if (typeof entry.attachment_id !== "string" || !/^[a-f0-9]{64}$/u.test(entry.attachment_id)) {
      throw new Error(`${field}.attachment_id must be a lowercase SHA-256 hex digest`);
    }
    if (seen.has(entry.attachment_id)) throw new Error(`${field}.attachment_id is duplicated`);
    seen.add(entry.attachment_id);
    if (entry.detail !== "low" && entry.detail !== "high") {
      throw new Error(`${field}.detail must be low or high`);
    }
    const annotations = entry.annotations === undefined
      ? undefined
      : parseImageAnnotations(entry.annotations, `${field}.annotations`);
    if (
      entry.annotated_from !== undefined &&
      (typeof entry.annotated_from !== "string" || !/^[a-f0-9]{64}$/u.test(entry.annotated_from))
    ) {
      throw new Error(`${field}.annotated_from must be a lowercase SHA-256 hex digest`);
    }
    const annotatedFrom = entry.annotated_from as string | undefined;
    const sources = ["file", "clipboard", "project_resource", "editor_viewport", "game_frame"] as const;
    if (entry.source !== undefined && (
      typeof entry.source !== "string" || !sources.includes(entry.source as (typeof sources)[number])
    )) {
      throw new Error(`${field}.source is invalid`);
    }
    const source = entry.source as NonNullable<TurnAttachmentReference["source"]> | undefined;
    const name = readOptionalAttachmentText(entry.name, `${field}.name`, 256);
    const runId = readOptionalAttachmentText(entry.run_id, `${field}.run_id`, 128);
    const sceneId = readOptionalAttachmentText(entry.scene_id, `${field}.scene_id`, 128);
    const scenePath = readOptionalAttachmentText(entry.scene_path, `${field}.scene_path`, 1_024);
    const capturedAtMs = readOptionalAttachmentInteger(entry.captured_at_ms, `${field}.captured_at_ms`, 0, 9_007_199_254_740_991);
    const viewportWidth = readOptionalAttachmentInteger(entry.viewport_width, `${field}.viewport_width`, 1, 16_384);
    const viewportHeight = readOptionalAttachmentInteger(entry.viewport_height, `${field}.viewport_height`, 1, 16_384);
    const frame = readOptionalAttachmentInteger(entry.frame, `${field}.frame`, 0, 9_007_199_254_740_991);
    if ((viewportWidth === undefined) !== (viewportHeight === undefined)) {
      throw new Error(`${field}.viewport_width and viewport_height must be provided together`);
    }
    if (source === "game_frame" && (!runId || viewportWidth === undefined || viewportHeight === undefined)) {
      throw new Error(`${field} game_frame sources require run_id and viewport dimensions`);
    }
    return {
      attachment_id: entry.attachment_id,
      detail: entry.detail,
      ...(annotations !== undefined ? { annotations } : {}),
      ...(annotatedFrom !== undefined ? { annotated_from: annotatedFrom } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(runId !== undefined ? { run_id: runId } : {}),
      ...(sceneId !== undefined ? { scene_id: sceneId } : {}),
      ...(scenePath !== undefined ? { scene_path: scenePath } : {}),
      ...(capturedAtMs !== undefined ? { captured_at_ms: capturedAtMs } : {}),
      ...(viewportWidth !== undefined ? { viewport_width: viewportWidth } : {}),
      ...(viewportHeight !== undefined ? { viewport_height: viewportHeight } : {}),
      ...(frame !== undefined ? { frame } : {}),
    };
  });
}

function readOptionalAttachmentText(
  value: unknown,
  field: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} must be a non-empty safe string of at most ${maximumLength} characters`);
  }
  return value;
}

function readOptionalAttachmentInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export function parseEditorSceneLease(value: unknown, field = "scene_lease"): EditorSceneLease {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const allowedKeys = new Set(["scene_id", "scene_path", "scene_revision"]);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`${field} contains unsupported field: ${unknownKey}`);
  if (Object.keys(value).length !== allowedKeys.size) {
    throw new Error(`${field} requires scene_id, scene_path, and scene_revision`);
  }
  const sceneId = readSafeOpaqueValue(value.scene_id, `${field}.scene_id`, 128);
  const sceneRevision = readSafeOpaqueValue(value.scene_revision, `${field}.scene_revision`, 128);
  const scenePath = readCanonicalScenePath(value.scene_path, `${field}.scene_path`);
  return {
    scene_id: sceneId,
    scene_path: scenePath,
    scene_revision: sceneRevision,
  };
}

export function parseEditorSceneLeaseContext(
  leasesValue: unknown,
  primarySceneIdValue: unknown,
  openScenePathsValue: unknown,
  leasesField = "scene_leases",
  primaryField = "primary_scene_id",
  openScenePathsField = "open_scene_paths",
): EditorSceneLeaseContext {
  if (leasesValue !== undefined && !Array.isArray(leasesValue)) {
    throw new Error(`${leasesField} must be an array`);
  }
  const rawLeases = leasesValue as unknown[] | undefined;
  if ((rawLeases?.length ?? 0) > 64) throw new Error(`${leasesField} exceeds the 64 scene limit`);
  const sceneLeases = (rawLeases ?? []).map((lease, index) =>
    parseEditorSceneLease(lease, `${leasesField}[${index}]`)
  );
  const ids = new Set<string>();
  for (const lease of sceneLeases) {
    if (ids.has(lease.scene_id)) throw new Error(`${leasesField} contains duplicate scene_id: ${lease.scene_id}`);
    ids.add(lease.scene_id);
  }
  const primarySceneId = primarySceneIdValue === undefined || primarySceneIdValue === null
    ? null
    : readSafeOpaqueValue(primarySceneIdValue, primaryField, 128);
  if (primarySceneId !== null && !ids.has(primarySceneId)) {
    throw new Error(`${primaryField} must identify a scene in ${leasesField}`);
  }
  if (openScenePathsValue !== undefined && !Array.isArray(openScenePathsValue)) {
    throw new Error(`${openScenePathsField} must be an array`);
  }
  const rawOpenScenePaths = openScenePathsValue as unknown[] | undefined;
  if ((rawOpenScenePaths?.length ?? 0) > 128) {
    throw new Error(`${openScenePathsField} exceeds the 128 scene limit`);
  }
  const openScenePaths = (rawOpenScenePaths ?? []).map((scenePath, index) => {
    const parsed = readCanonicalScenePath(scenePath, `${openScenePathsField}[${index}]`);
    if (!parsed) throw new Error(`${openScenePathsField}[${index}] must be a canonical res:// path`);
    return parsed;
  });
  if (new Set(openScenePaths).size !== openScenePaths.length) {
    throw new Error(`${openScenePathsField} must not contain duplicate paths`);
  }
  return {
    scene_leases: sceneLeases,
    primary_scene_id: primarySceneId,
    open_scene_paths: openScenePaths,
  };
}

export class EventFactory {
  #seq = 0;

  create<T>(
    type: EventType,
    data: T,
    context: { sessionId?: string; turnId?: string; itemId?: string } = {},
  ): RuntimeEvent<T> {
    return {
      version: PROTOCOL_VERSION,
      seq: ++this.#seq,
      time: new Date().toISOString(),
      type,
      ...(context.sessionId ? { session_id: context.sessionId } : {}),
      ...(context.turnId ? { turn_id: context.turnId } : {}),
      ...(context.itemId ? { item_id: context.itemId } : {}),
      data,
    };
  }
}

function readSafeOpaqueValue(value: unknown, field: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} must be a non-empty safe string with at most ${maximumLength} characters`);
  }
  return value;
}

function readCanonicalScenePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 2_048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f\\]/u.test(value)
  ) {
    throw new Error(`${field} must be an empty unsaved path or a canonical res:// path`);
  }
  if (value === "") return value;
  if (!value.startsWith("res://")) {
    throw new Error(`${field} must be an empty unsaved path or a canonical res:// path`);
  }
  const relative = value.slice("res://".length);
  const segments = relative.split("/");
  if (
    relative.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${field} must be an empty unsaved path or a canonical res:// path`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
