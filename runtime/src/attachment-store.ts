import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_DIMENSION = 4_096;
export const MAX_ATTACHMENT_PIXELS = 16_000_000;

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface AttachmentMetadata {
  id: string;
  mimeType: SupportedImageMimeType;
  byteSize: number;
  width: number;
  height: number;
}

export interface ResolvedAttachment extends AttachmentMetadata {
  bytes: Uint8Array;
}

const EXTENSIONS: ReadonlyArray<{ extension: string; mimeType: SupportedImageMimeType }> = [
  { extension: ".png", mimeType: "image/png" },
  { extension: ".jpg", mimeType: "image/jpeg" },
  { extension: ".jpeg", mimeType: "image/jpeg" },
  { extension: ".webp", mimeType: "image/webp" },
];

export class AttachmentStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  static forWorkspace(workspace: string, dataDirectory?: string): AttachmentStore {
    const directory = dataDirectory
      ? path.join(path.resolve(dataDirectory), "godetx", "attachments")
      : path.join(path.resolve(workspace), ".godot", "godetx", "attachments");
    return new AttachmentStore(directory);
  }

  register(attachmentId: string): AttachmentMetadata {
    const resolved = this.#resolve(attachmentId, false);
    const { bytes: _bytes, ...metadata } = resolved;
    return metadata;
  }

  read(attachmentId: string): ResolvedAttachment {
    return this.#resolve(attachmentId, true);
  }

  has(attachmentId: string): boolean {
    try {
      this.register(attachmentId);
      return true;
    } catch {
      return false;
    }
  }

  #resolve(attachmentId: string, includeBytes: boolean): ResolvedAttachment {
    const id = normalizeAttachmentId(attachmentId);
    const candidates = EXTENSIONS.flatMap(({ extension, mimeType }) => {
      const filepath = path.join(this.directory, `${id}${extension}`);
      return existsSync(filepath) ? [{ filepath, mimeType }] : [];
    });
    if (candidates.length === 0) throw new Error(`Attachment is unavailable: ${id}`);
    if (candidates.length > 1) throw new Error(`Attachment has conflicting files: ${id}`);

    const candidate = candidates[0]!;
    const fileSize = statSync(candidate.filepath).size;
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${id}`);
    }
    const bytes = readFileSync(candidate.filepath);
    if (bytes.byteLength !== fileSize) throw new Error(`Attachment changed while it was being read: ${id}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== id) throw new Error(`Attachment content does not match its SHA-256 id: ${id}`);

    const image = inspectImage(bytes);
    if (image.mimeType !== candidate.mimeType) {
      throw new Error(`Attachment extension does not match its image format: ${id}`);
    }
    validateDimensions(image.width, image.height, id);
    return {
      id,
      mimeType: image.mimeType,
      byteSize: bytes.byteLength,
      width: image.width,
      height: image.height,
      bytes: includeBytes ? bytes : new Uint8Array(),
    };
  }
}

export function normalizeAttachmentId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized) || normalized !== value) {
    throw new Error("attachment_id must be a lowercase SHA-256 hex digest");
  }
  return normalized;
}

function inspectImage(bytes: Uint8Array): {
  mimeType: SupportedImageMimeType;
  width: number;
  height: number;
} {
  const png = inspectPng(bytes);
  if (png) return { mimeType: "image/png", ...png };
  const jpeg = inspectJpeg(bytes);
  if (jpeg) return { mimeType: "image/jpeg", ...jpeg };
  const webp = inspectWebp(bytes);
  if (webp) return { mimeType: "image/webp", ...webp };
  throw new Error("Attachment is not a supported PNG, JPEG, or WebP image");
}

function inspectPng(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value)) return undefined;
  if (ascii(bytes, 12, 4) !== "IHDR") return undefined;
  return { width: readUint32Be(bytes, 16), height: readUint32Be(bytes, 20) };
}

function inspectJpeg(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) break;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if (startOfFrame.has(marker)) {
      if (length < 7) break;
      return {
        height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
        width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
      };
    }
    offset += length;
  }
  throw new Error("Attachment contains an invalid or unsupported JPEG image");
}

function inspectWebp(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (
    bytes.byteLength < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return undefined;
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return {
      width: 1 + readUint24Le(bytes, 24),
      height: 1 + readUint24Le(bytes, 27),
    };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f || bytes.byteLength < 25) throw new Error("Attachment contains an invalid WebP image");
    return {
      width: 1 + ((bytes[21] ?? 0) | (((bytes[22] ?? 0) & 0x3f) << 8)),
      height: 1 + (((bytes[22] ?? 0) >> 6) | ((bytes[23] ?? 0) << 2) | (((bytes[24] ?? 0) & 0x0f) << 10)),
    };
  }
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new Error("Attachment contains an invalid WebP image");
    }
    return {
      width: (((bytes[27] ?? 0) << 8) | (bytes[26] ?? 0)) & 0x3fff,
      height: (((bytes[29] ?? 0) << 8) | (bytes[28] ?? 0)) & 0x3fff,
    };
  }
  throw new Error("Attachment contains an unsupported WebP image");
}

function validateDimensions(width: number, height: number, id: string): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_ATTACHMENT_DIMENSION ||
    height > MAX_ATTACHMENT_DIMENSION ||
    width * height > MAX_ATTACHMENT_PIXELS
  ) {
    throw new Error(`Attachment has unsupported dimensions: ${id}`);
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}
