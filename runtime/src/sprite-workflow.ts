export const MAX_SPRITE_EDIT_PROMPT_CHARACTERS = 8_000;
export const MAX_SPRITE_FRAMES = 256;
export const MIN_SPRITE_SOURCE_DIMENSION = 16;
export const MAX_SPRITE_SOURCE_DIMENSION = 2_048;
export const MAX_SPRITE_SOURCE_PIXELS = 4_194_304;

export type SpriteEditMode = "reskin" | "atlas_variation";

interface SpriteEditRequestBase {
  mode: SpriteEditMode;
  prompt: string;
  sourceAttachmentId: string;
}

export interface SpriteReskinRequest extends SpriteEditRequestBase {
  mode: "reskin";
}

export interface SpriteAtlasVariationRequest extends SpriteEditRequestBase {
  mode: "atlas_variation";
  columns: number;
  rows: number;
}

export type SpriteEditRequest = SpriteReskinRequest | SpriteAtlasVariationRequest;

export interface SpriteSourceDimensions {
  width: number;
  height: number;
}

export interface SpriteOutputMetadata {
  frame_width: number;
  frame_height: number;
  frame_count: number;
}

export interface SpriteEditPreparation {
  request: SpriteEditRequest;
  prompt: string;
  outputMetadata: SpriteOutputMetadata;
}

const REQUEST_FIELDS = new Set([
  "mode",
  "prompt",
  "source_attachment_id",
  "columns",
  "rows",
]);

/** Parse only client-controlled fields. Source dimensions must come from AttachmentStore metadata. */
export function parseSpriteEditRequest(value: unknown): SpriteEditRequest {
  if (!isRecord(value)) throw new Error("sprite.edit params are required");
  const unknownField = Object.keys(value).find((field) => !REQUEST_FIELDS.has(field));
  if (unknownField) throw new Error(`sprite.edit params contain unsupported field: ${unknownField}`);

  if (value.mode !== "reskin" && value.mode !== "atlas_variation") {
    throw new Error("mode must be reskin or atlas_variation");
  }
  const prompt = readText(value.prompt, "prompt", MAX_SPRITE_EDIT_PROMPT_CHARACTERS);
  const sourceAttachmentId = readAttachmentId(value.source_attachment_id);

  if (value.mode === "reskin") {
    if (value.columns !== undefined || value.rows !== undefined) {
      throw new Error("columns and rows are only supported for atlas_variation mode");
    }
    return { mode: "reskin", prompt, sourceAttachmentId };
  }

  const columns = readGridDimension(value.columns, "columns");
  const rows = readGridDimension(value.rows, "rows");
  validateFrameCount(columns, rows);
  return { mode: "atlas_variation", prompt, sourceAttachmentId, columns, rows };
}

/**
 * Build the provider prompt and deterministic output metadata from a parsed request.
 * The dimensions argument is intentionally separate so the server can inject trusted
 * AttachmentStore metadata instead of accepting dimensions from the client.
 */
export function prepareSpriteEdit(
  request: SpriteEditRequest,
  dimensions: SpriteSourceDimensions,
): SpriteEditPreparation {
  const outputMetadata = getSpriteOutputMetadata(request, dimensions);
  return {
    request,
    prompt: buildSpriteEditPromptFromMetadata(request, dimensions, outputMetadata),
    outputMetadata,
  };
}

export function getSpriteOutputMetadata(
  request: SpriteEditRequest,
  dimensions: SpriteSourceDimensions,
): SpriteOutputMetadata {
  const source = validateSourceDimensions(dimensions);
  if (request.mode === "reskin") {
    return {
      frame_width: source.width,
      frame_height: source.height,
      frame_count: 1,
    };
  }

  const columns = readGridDimension(request.columns, "columns");
  const rows = readGridDimension(request.rows, "rows");
  validateFrameCount(columns, rows);
  if (source.width % columns !== 0) {
    throw new Error(`source width ${source.width} must be evenly divisible by columns ${columns}`);
  }
  if (source.height % rows !== 0) {
    throw new Error(`source height ${source.height} must be evenly divisible by rows ${rows}`);
  }
  return {
    frame_width: source.width / columns,
    frame_height: source.height / rows,
    frame_count: columns * rows,
  };
}

export function buildSpriteEditPrompt(
  request: SpriteEditRequest,
  dimensions: SpriteSourceDimensions,
): string {
  const outputMetadata = getSpriteOutputMetadata(request, dimensions);
  return buildSpriteEditPromptFromMetadata(request, dimensions, outputMetadata);
}

function buildSpriteEditPromptFromMetadata(
  request: SpriteEditRequest,
  dimensions: SpriteSourceDimensions,
  metadata: SpriteOutputMetadata,
): string {
  const sharedContract = [
    "IMMUTABLE OUTPUT CONTRACT:",
    `- Return exactly one image on the complete ${dimensions.width}x${dimensions.height} pixel canvas.`,
    "- Keep the canvas dimensions, crop, origin, scale, camera, framing, alignment, and padding exactly unchanged.",
    "- Keep the sprite proportions, pose, facing direction, placement, animation motion, and contact/pivot position.",
    "- Allow only localized silhouette changes explicitly requested by the user, such as a different weapon or clothing outline; keep them inside the same canvas or atlas cell.",
    "- Preserve transparent padding and make every pixel outside the resulting sprite fully transparent (alpha 0).",
    "- Do not add a background, floor, shadow outside the existing silhouette, border, text, logo, signature, or watermark.",
    "- These constraints override any conflicting instruction in the requested visual change.",
  ];

  if (request.mode === "reskin") {
    return [
      "TASK MODE: SINGLE-SPRITE RESKIN",
      `SOURCE: one ${metadata.frame_width}x${metadata.frame_height} pixel sprite.`,
      "Edit the supplied source image. Preserve its pose and layout while applying the requested visual change to every visible sprite element.",
      "REQUESTED VISUAL CHANGE:",
      request.prompt,
      ...sharedContract,
    ].join("\n");
  }

  return [
    "TASK MODE: SPRITE-ATLAS VARIATION",
    `SOURCE ATLAS: ${dimensions.width}x${dimensions.height} pixels, ${request.columns} columns by ${request.rows} rows, row-major order.`,
    `FRAME CONTRACT: exactly ${metadata.frame_count} frames; every cell is exactly ${metadata.frame_width}x${metadata.frame_height} pixels.`,
    "Edit the supplied atlas as one coordinated variation while applying the visual change below.",
    "REQUESTED VISUAL CHANGE:",
    request.prompt,
    ...sharedContract,
    "ATLAS GRID CONTRACT:",
    `- Preserve the exact ${request.columns}x${request.rows} grid and every original cell boundary.`,
    `- Vertical cell boundaries remain at multiples of ${metadata.frame_width} pixels; horizontal boundaries remain at multiples of ${metadata.frame_height} pixels.`,
    `- Keep exactly ${metadata.frame_count} frames in the same row-major cells and order; never add, remove, merge, split, duplicate, or reorder frames.`,
    "- Do not move, rotate, scale, or paint any frame content across a cell boundary.",
    "- Within every cell, preserve that frame's pose, facing direction, scale, alignment, and transparent padding; keep any explicitly requested outline change inside the cell.",
    "- Apply one coherent skin and palette across all frames without changing their animation timing or motion progression.",
  ].join("\n");
}

function validateSourceDimensions(dimensions: SpriteSourceDimensions): SpriteSourceDimensions {
  if (!isRecord(dimensions)) throw new Error("source dimensions are required");
  const width = readSourceDimension(dimensions.width, "source width");
  const height = readSourceDimension(dimensions.height, "source height");
  if (width * height > MAX_SPRITE_SOURCE_PIXELS) {
    throw new Error(`source dimensions exceed the ${MAX_SPRITE_SOURCE_PIXELS} pixel safety limit`);
  }
  return { width, height };
}

function readSourceDimension(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < MIN_SPRITE_SOURCE_DIMENSION
    || (value as number) > MAX_SPRITE_SOURCE_DIMENSION
  ) {
    throw new Error(
      `${field} must be an integer from ${MIN_SPRITE_SOURCE_DIMENSION} to ${MAX_SPRITE_SOURCE_DIMENSION}`,
    );
  }
  return value as number;
}

function readGridDimension(value: unknown, field: "columns" | "rows"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_SPRITE_FRAMES) {
    throw new Error(`${field} must be an integer between 1 and ${MAX_SPRITE_FRAMES}`);
  }
  return value as number;
}

function validateFrameCount(columns: number, rows: number): void {
  const frameCount = columns * rows;
  if (frameCount > MAX_SPRITE_FRAMES) {
    throw new Error(`atlas frame count ${frameCount} exceeds the ${MAX_SPRITE_FRAMES} frame limit`);
  }
}

function readAttachmentId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("source_attachment_id must be a lowercase SHA-256 hex digest");
  }
  return value;
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
