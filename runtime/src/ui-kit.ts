import { createHash } from "node:crypto";
import type { AttachmentStore, ResolvedAttachment } from "./attachment-store.js";
import {
  generateProcessedImage,
  type TransparencyMode,
} from "./image-processing.js";
import type {
  ContentPart,
  GeneratedImage,
  ImageOutputFormat,
  ModelProvider,
  ProviderResolvedAttachment,
} from "./provider/types.js";
import type { Workspace } from "./workspace.js";

export type UiKitAssetRole = "panel" | "button" | "icon" | "decoration";
export type UiKitProgressPhase = "planning" | "planned" | "generating" | "reviewing" | "completed";

export interface UiKitGenerationRequest {
  workflowId: string;
  prompt: string;
  plannerModel: string;
  imageModel: string;
  size: string;
  quality: string;
  background: string;
  outputFormat: ImageOutputFormat;
  maxAssets: number;
  reviewEnabled: boolean;
  context: Record<string, unknown>;
  contextAttachmentId?: string;
  targetWidth?: number;
  targetHeight?: number;
}

export interface UiKitAssetPlan {
  id: string;
  name: string;
  role: UiKitAssetRole;
  prompt: string;
}

export interface UiKitPlan {
  summary: string;
  style: string;
  assets: UiKitAssetPlan[];
}

export interface UiKitGeneratedAsset extends UiKitAssetPlan {
  path: string;
  resourcePath: string;
  mimeType: GeneratedImage["mimeType"];
  byteSize: number;
  transparencyMode: TransparencyMode;
  normalized: boolean;
  resized: boolean;
  sourceWidth?: number;
  sourceHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  revisedPrompt?: string;
}

export interface UiKitReviewIssue {
  assetId: string;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface UiKitReview {
  status: "completed" | "skipped" | "failed";
  passed: boolean;
  score: number;
  summary: string;
  issues: UiKitReviewIssue[];
}

export interface UiKitProgress {
  workflowId: string;
  phase: UiKitProgressPhase;
  message: string;
  current?: number;
  total?: number;
  assetId?: string;
  assetName?: string;
  plan?: UiKitPlan;
}

export interface UiKitGenerationResult {
  workflowId: string;
  plannerModel: string;
  imageModel: string;
  outputDirectory: string;
  plan: UiKitPlan;
  assets: UiKitGeneratedAsset[];
  review: UiKitReview;
}

export interface GenerateUiKitOptions {
  request: UiKitGenerationRequest;
  provider: ModelProvider;
  workspace: Workspace;
  attachmentStore: AttachmentStore;
  signal: AbortSignal;
  emit: (progress: UiKitProgress) => void;
}

const MAX_CONTEXT_CHARACTERS = 24_000;
const MAX_PLAN_RESPONSE_CHARACTERS = 24_000;
const MAX_REVIEW_RESPONSE_CHARACTERS = 16_000;
const ROLES = new Set<UiKitAssetRole>(["panel", "button", "icon", "decoration"]);

const PLANNER_SYSTEM_PROMPT = `You are a game UI art director working inside the Godot editor.
Return one strict JSON object and no Markdown. Plan a coherent, production-oriented set of visual UI assets.
The image model must not render words, letters, numbers, logos, or watermarks; Godot will render all text.
Treat visual states of the same component as one geometry family: default, hover, pressed, focused, and disabled
variants must keep exactly the same silhouette, proportions, border thickness, corner radius, camera, and padding.
Use exactly this shape:
{"summary":"...","style":"...","assets":[{"id":"snake_case","name":"...","role":"panel|button|icon|decoration","prompt":"..."}]}
Keep each asset isolated and suitable for a transparent PNG. Do not request source code, fonts, or complete screenshots.`;

const REVIEW_SYSTEM_PROMPT = `You are a visual QA reviewer for a Godot game UI asset kit.
Inspect every supplied image as one member of the same kit. Check style consistency, clean isolation, useful padding,
absence of generated text or watermarks, and whether the asset visually matches its declared role.
Return one strict JSON object and no Markdown using exactly this shape:
{"passed":true,"score":0,"summary":"...","issues":[{"asset_id":"...","severity":"low|medium|high","message":"..."}]}`;

export function parseUiKitGenerationRequest(value: unknown): UiKitGenerationRequest {
  if (!isRecord(value)) throw new Error("ui_kit.generate params are required");
  const workflowId = readIdentifier(value.workflow_id, "workflow_id");
  const prompt = readText(value.prompt, "prompt", 8_000);
  const plannerModel = readText(value.planner_model, "planner_model", 512);
  const imageModel = readText(value.image_model, "image_model", 512);
  const size = readText(value.size ?? "1024x1024", "size", 64);
  const quality = readText(value.quality ?? "auto", "quality", 64);
  const background = readText(value.background ?? "transparent", "background", 64);
  const outputFormat = value.output_format ?? "png";
  if (outputFormat !== "png" && outputFormat !== "jpeg" && outputFormat !== "webp") {
    throw new Error("output_format must be png, jpeg, or webp");
  }
  const maxAssets = value.max_assets ?? 3;
  if (!Number.isInteger(maxAssets) || (maxAssets as number) < 1 || (maxAssets as number) > 4) {
    throw new Error("max_assets must be an integer between 1 and 4");
  }
  if (value.review_enabled !== undefined && typeof value.review_enabled !== "boolean") {
    throw new Error("review_enabled must be a boolean");
  }
  const context = value.context ?? {};
  if (!isRecord(context)) throw new Error("context must be an object");
  const serializedContext = JSON.stringify(context);
  if (serializedContext.length > MAX_CONTEXT_CHARACTERS) {
    throw new Error(`context exceeds the ${MAX_CONTEXT_CHARACTERS} character limit`);
  }
  const contextAttachmentId = value.context_attachment_id === undefined
    ? undefined
    : readAttachmentId(value.context_attachment_id);
  const targetWidth = readOptionalDimension(value.target_width, "target_width");
  const targetHeight = readOptionalDimension(value.target_height, "target_height");
  if ((targetWidth === undefined) !== (targetHeight === undefined)) {
    throw new Error("target_width and target_height must be provided together");
  }
  if (targetWidth !== undefined && targetHeight !== undefined && targetWidth * targetHeight > 16_777_216) {
    throw new Error("Target image dimensions exceed the pixel safety limit");
  }
  return {
    workflowId,
    prompt,
    plannerModel,
    imageModel,
    size,
    quality,
    background,
    outputFormat,
    maxAssets: maxAssets as number,
    reviewEnabled: value.review_enabled ?? true,
    context: JSON.parse(serializedContext) as Record<string, unknown>,
    ...(contextAttachmentId ? { contextAttachmentId } : {}),
    ...(targetWidth !== undefined ? { targetWidth } : {}),
    ...(targetHeight !== undefined ? { targetHeight } : {}),
  };
}

export async function generateUiKit(options: GenerateUiKitOptions): Promise<UiKitGenerationResult> {
  const { request, provider, workspace, attachmentStore, signal, emit } = options;
  if (!provider.generateImage) throw new Error("The configured provider does not support image generation");
  signal.throwIfAborted();
  emit({ workflowId: request.workflowId, phase: "planning", message: "Planning UI kit" });

  const plannerContent: ContentPart[] = [{
    type: "text",
    text: buildPlannerPrompt(request),
  }];
  let contextAttachment: ResolvedAttachment | undefined;
  const plannerImageStatus = provider.getModelCapabilities?.(request.plannerModel)?.image_input?.status;
  if (request.contextAttachmentId && plannerImageStatus !== "unsupported") {
    contextAttachment = attachmentStore.read(request.contextAttachmentId);
    plannerContent.push({
      type: "image",
      attachmentId: contextAttachment.id,
      mimeType: contextAttachment.mimeType,
      detail: "high",
    });
  }
  const plannerResult = await provider.streamTurn({
    model: request.plannerModel,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: plannerContent }],
    tools: [],
    ...(contextAttachment
      ? { resolveAttachment: async (id: string) => resolveStoredAttachment(id, contextAttachment!) }
      : {}),
    signal,
    onEvent: () => undefined,
  });
  const plan = parseUiKitPlan(plannerResult.message.content, request.maxAssets);
  emit({
    workflowId: request.workflowId,
    phase: "planned",
    message: "UI kit plan ready",
    total: plan.assets.length,
    plan,
  });

  const directory = `assets/generated/ui-kits/${Date.now()}-${request.workflowId.slice(0, 8)}`;
  const generatedAssets: UiKitGeneratedAsset[] = [];
  const generatedImages = new Map<string, GeneratedImage>();
  for (let index = 0; index < plan.assets.length; index += 1) {
    signal.throwIfAborted();
    const asset = plan.assets[index]!;
    emit({
      workflowId: request.workflowId,
      phase: "generating",
      message: "Generating UI asset",
      current: index + 1,
      total: plan.assets.length,
      assetId: asset.id,
      assetName: asset.name,
    });
    const processed = await generateProcessedImage(provider, {
      model: request.imageModel,
      prompt: buildImagePrompt(request, plan, asset),
      size: request.size,
      quality: request.quality,
      background: request.background,
      outputFormat: request.outputFormat,
      signal,
    }, {
      normalizeUiRole: asset.role,
      styleHint: plan.style,
      ...(request.targetWidth !== undefined ? { targetWidth: request.targetWidth } : {}),
      ...(request.targetHeight !== undefined ? { targetHeight: request.targetHeight } : {}),
    });
    const image = processed.image;
    const extension = imageExtension(image.mimeType);
    const path = await workspace.writeBinary(`${directory}/${asset.id}.${extension}`, image.bytes);
    generatedAssets.push({
      ...asset,
      path,
      resourcePath: `res://${path}`,
      mimeType: image.mimeType,
      byteSize: image.bytes.byteLength,
      transparencyMode: processed.transparencyMode,
      normalized: processed.normalized,
      resized: processed.resized,
      ...(processed.sourceWidth !== undefined ? { sourceWidth: processed.sourceWidth } : {}),
      ...(processed.sourceHeight !== undefined ? { sourceHeight: processed.sourceHeight } : {}),
      ...(processed.outputWidth !== undefined ? { outputWidth: processed.outputWidth } : {}),
      ...(processed.outputHeight !== undefined ? { outputHeight: processed.outputHeight } : {}),
      ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
    });
    generatedImages.set(asset.id, image);
  }

  let review: UiKitReview;
  const reviewImageStatus = provider.getModelCapabilities?.(request.plannerModel)?.image_input?.status;
  if (!request.reviewEnabled) {
    review = skippedReview("Vision review was disabled for this request");
  } else if (reviewImageStatus === "unsupported") {
    review = skippedReview(`Planner model ${request.plannerModel} does not support image input`);
  } else {
    emit({
      workflowId: request.workflowId,
      phase: "reviewing",
      message: "Reviewing UI kit",
      total: generatedAssets.length,
    });
    review = await reviewUiKit(provider, request, plan, generatedAssets, generatedImages, signal);
  }
  emit({
    workflowId: request.workflowId,
    phase: "completed",
    message: "UI kit generation completed",
    current: generatedAssets.length,
    total: generatedAssets.length,
  });
  return {
    workflowId: request.workflowId,
    plannerModel: request.plannerModel,
    imageModel: request.imageModel,
    outputDirectory: `res://${directory}`,
    plan,
    assets: generatedAssets,
    review,
  };
}

function buildPlannerPrompt(request: UiKitGenerationRequest): string {
  return [
    `User request:\n${request.prompt}`,
    `Maximum asset count: ${request.maxAssets}`,
    `Godot project context:\n${JSON.stringify(request.context)}`,
    request.contextAttachmentId
      ? "The attached image is the current Godot 2D editor viewport. Use it only as project visual context."
      : "No viewport image is attached; infer only from the structured project context.",
  ].join("\n\n");
}

function buildImagePrompt(
  request: UiKitGenerationRequest,
  plan: UiKitPlan,
  asset: UiKitAssetPlan,
): string {
  return [
    `Create one isolated ${asset.role} asset for a Godot game UI kit.`,
    `Shared art direction: ${plan.style}`,
    `Asset requirement: ${asset.prompt}`,
    `Original game request: ${request.prompt}`,
    ...(request.targetWidth !== undefined && request.targetHeight !== undefined
      ? [`Final output canvas: ${request.targetWidth}x${request.targetHeight} pixels.`]
      : []),
    roleCompositionContract(asset.role),
    "Keep a centered front-facing view, even padding, and a clean silhouette.",
    "Every asset with the same role must use identical visual scale, border weight, camera, and canvas occupancy.",
    "If this is a state variant, preserve the exact component geometry and change only state styling such as color, light, or depth.",
    "Do not render any text, letters, numbers, logos, signatures, watermarks, screenshots, or device frames.",
    request.background === "transparent"
      ? "Use a transparent background and do not add a rectangular backdrop unless the asset itself is a panel."
      : "Use only the requested background treatment.",
  ].join("\n");
}

function roleCompositionContract(role: UiKitAssetRole): string {
  if (role === "button") {
    return "Composition contract: one wide 5:2 button face centered in the canvas, occupying about 74% width and 30% height.";
  }
  if (role === "panel") {
    return "Composition contract: one centered panel with stable border thickness, occupying at most 84% width and 70% height.";
  }
  if (role === "icon") {
    return "Composition contract: one centered square icon, occupying at most 42% of the canvas in either dimension.";
  }
  return "Composition contract: one centered decoration, occupying at most 56% of the canvas in either dimension.";
}

async function reviewUiKit(
  provider: ModelProvider,
  request: UiKitGenerationRequest,
  plan: UiKitPlan,
  assets: UiKitGeneratedAsset[],
  images: ReadonlyMap<string, GeneratedImage>,
  signal: AbortSignal,
): Promise<UiKitReview> {
  const resolved = new Map<string, ProviderResolvedAttachment>();
  const parts: ContentPart[] = [{
    type: "text",
    text: [
      `Review this generated Godot UI kit. Shared style: ${plan.style}`,
      ...assets.map((asset, index) => `Image ${index + 1}: asset_id=${asset.id}, role=${asset.role}, name=${asset.name}`),
    ].join("\n"),
  }];
  for (const asset of assets) {
    const image = images.get(asset.id);
    if (!image) continue;
    const id = createHash("sha256").update(image.bytes).digest("hex");
    resolved.set(id, {
      id,
      mimeType: image.mimeType,
      bytes: image.bytes,
      width: 1,
      height: 1,
      byteSize: image.bytes.byteLength,
    });
    parts.push({ type: "image", attachmentId: id, mimeType: image.mimeType, detail: "high" });
  }
  try {
    const result = await provider.streamTurn({
      model: request.plannerModel,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts }],
      tools: [],
      resolveAttachment: async (id: string) => {
        const attachment = resolved.get(id);
        if (!attachment) throw new Error(`Generated review attachment is unavailable: ${id}`);
        return attachment;
      },
      signal,
      onEvent: () => undefined,
    });
    return parseUiKitReview(result.message.content, new Set(assets.map((asset) => asset.id)));
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: "failed",
      passed: false,
      score: 0,
      summary: `Vision review failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
      issues: [],
    };
  }
}

function parseUiKitPlan(text: string, maxAssets: number): UiKitPlan {
  const raw = parseJsonObject(text, MAX_PLAN_RESPONSE_CHARACTERS, "UI kit plan");
  const summary = readText(raw.summary, "plan.summary", 1_000);
  const style = readText(raw.style, "plan.style", 1_500);
  if (!Array.isArray(raw.assets) || raw.assets.length < 1 || raw.assets.length > maxAssets) {
    throw new Error(`UI kit plan must contain 1-${maxAssets} assets`);
  }
  const ids = new Set<string>();
  const assets = raw.assets.map((value, index): UiKitAssetPlan => {
    if (!isRecord(value)) throw new Error(`plan.assets[${index}] must be an object`);
    const baseId = safeAssetId(readText(value.id, `plan.assets[${index}].id`, 64));
    let id = baseId;
    let suffix = 2;
    while (ids.has(id)) id = `${baseId.slice(0, 56)}_${suffix++}`;
    ids.add(id);
    const roleValue = readText(value.role, `plan.assets[${index}].role`, 32).toLowerCase();
    const role: UiKitAssetRole = ROLES.has(roleValue as UiKitAssetRole)
      ? roleValue as UiKitAssetRole
      : "decoration";
    return {
      id,
      name: readText(value.name, `plan.assets[${index}].name`, 120),
      role,
      prompt: readText(value.prompt, `plan.assets[${index}].prompt`, 2_500),
    };
  });
  return { summary, style, assets };
}

function parseUiKitReview(text: string, assetIds: ReadonlySet<string>): UiKitReview {
  const raw = parseJsonObject(text, MAX_REVIEW_RESPONSE_CHARACTERS, "UI kit review");
  const scoreValue = typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : 0;
  const issuesValue = Array.isArray(raw.issues) ? raw.issues.slice(0, 32) : [];
  const issues: UiKitReviewIssue[] = [];
  for (let index = 0; index < issuesValue.length; index += 1) {
    const issue = issuesValue[index];
    if (!isRecord(issue)) continue;
    const assetId = typeof issue.asset_id === "string" && assetIds.has(issue.asset_id) ? issue.asset_id : "kit";
    const severityValue = typeof issue.severity === "string" ? issue.severity.toLowerCase() : "medium";
    const severity: UiKitReviewIssue["severity"] = severityValue === "low" || severityValue === "high"
      ? severityValue
      : "medium";
    const message = typeof issue.message === "string" ? issue.message.trim().slice(0, 1_000) : "";
    if (message) issues.push({ assetId, severity, message });
  }
  return {
    status: "completed",
    passed: raw.passed === true,
    score: Math.max(0, Math.min(100, Math.round(scoreValue))),
    summary: readText(raw.summary, "review.summary", 1_500),
    issues,
  };
}

function parseJsonObject(text: string, maximum: number, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > maximum) throw new Error(`${label} response is empty or too large`);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error(`${label} response did not contain a JSON object`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as unknown;
  } catch (error) {
    throw new Error(`${label} response contained invalid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${label} response must be a JSON object`);
  return parsed;
}

function resolveStoredAttachment(id: string, attachment: ResolvedAttachment): ProviderResolvedAttachment {
  if (id !== attachment.id) throw new Error(`Context attachment is unavailable: ${id}`);
  return attachment;
}

function skippedReview(summary: string): UiKitReview {
  return { status: "skipped", passed: false, score: 0, summary, issues: [] };
}

function safeAssetId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized || "asset";
}

function imageExtension(mimeType: GeneratedImage["mimeType"]): "png" | "jpg" | "webp" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

function readIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) {
    throw new Error(`${field} must be an 8-128 character safe identifier`);
  }
  return value;
}

function readAttachmentId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("context_attachment_id must be a lowercase SHA-256 hex digest");
  }
  return value;
}

function readOptionalDimension(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 16 || (value as number) > 3840) {
    throw new Error(`${field} must be an integer from 16 to 3840`);
  }
  return value as number;
}

function readText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const clean = value.trim();
  if (!clean || clean.length > maximum || clean.includes("\0")) {
    throw new Error(`${field} must contain 1-${maximum} safe characters`);
  }
  return clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
