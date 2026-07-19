import { PNG } from "pngjs";
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerationRequest,
  ModelProvider,
} from "./provider/types.js";

export type TransparencyMode = "none" | "native" | "chroma_key";
export type NormalizedUiRole = "panel" | "button" | "icon" | "decoration";

export interface ProcessedGeneratedImage {
  image: GeneratedImage;
  transparencyMode: TransparencyMode;
  normalized: boolean;
  resized: boolean;
  sourceWidth?: number;
  sourceHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
}

export interface GenerateProcessedImageOptions {
  normalizeUiRole?: NormalizedUiRole;
  styleHint?: string;
  targetWidth?: number;
  targetHeight?: number;
  spriteEdit?: boolean;
}

export interface ChromaKeyResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  transparentPixels: number;
}

const MAX_DECODED_PIXELS = 16_777_216;
const CHROMA_PROMPT = `Post-processing requirement: render the asset over one perfectly flat, solid chroma-key green
background with exact color #00FF00 covering every background pixel edge-to-edge. Do not use green anywhere in the
asset. Do not add a floor, cast shadow, glow, texture, checkerboard, vignette, border, or gradient to the background.`;
const unsupportedNativeTransparency = new WeakMap<ModelProvider, Set<string>>();

export async function generateProcessedImage(
  provider: ModelProvider,
  request: ImageGenerationRequest,
  options: GenerateProcessedImageOptions = {},
): Promise<ProcessedGeneratedImage> {
  if (!provider.generateImage) throw new Error("The configured provider does not support image generation");
  const target = readTargetDimensions(options);
  const effectiveRequest: ImageGenerationRequest = target
    ? { ...request, outputFormat: "png" }
    : request;
  if (request.background !== "transparent") {
    const image = await provider.generateImage(effectiveRequest);
    return finalizeImage(image, "none", options, target);
  }

  const pngRequest: ImageGenerationRequest = { ...effectiveRequest, outputFormat: "png" };
  const unsupportedModels = transparencyCache(provider);
  if (!unsupportedModels.has(request.model)) {
    try {
      const nativeImage = await provider.generateImage(pngRequest);
      if (nativeImage.mimeType !== "image/png") {
        throw new Error("A transparent image request returned a non-PNG image");
      }
      if (pngHasUsefulTransparency(nativeImage.bytes)) {
        return finalizeImage(nativeImage, "native", options, target);
      }
      unsupportedModels.add(request.model);
    } catch (error) {
      if (!isUnsupportedTransparencyError(error)) throw error;
      unsupportedModels.add(request.model);
    }
  }

  request.signal?.throwIfAborted();
  const chromaImage = await provider.generateImage({
    ...pngRequest,
    prompt: `${request.prompt}\n\n${CHROMA_PROMPT}`,
    background: "opaque",
    outputFormat: "png",
  });
  if (chromaImage.mimeType !== "image/png") {
    throw new Error("Green-screen fallback requires the image provider to return PNG");
  }
  const keyed = removeConnectedChromaKey(chromaImage.bytes);
  const minimumBackgroundPixels = Math.max(16, Math.floor((keyed.width + keyed.height) * 0.25));
  if (keyed.transparentPixels < minimumBackgroundPixels) {
    throw new Error("The image model did not produce a usable solid green-screen background");
  }
  return finalizeImage({
    ...chromaImage,
    bytes: keyed.bytes,
    mimeType: "image/png",
  }, "chroma_key", options, target);
}

export async function editProcessedImage(
  provider: ModelProvider,
  request: ImageEditRequest,
  options: GenerateProcessedImageOptions = {},
): Promise<ProcessedGeneratedImage> {
  if (!provider.editImage) throw new Error("The configured provider does not support image editing");
  const target = readTargetDimensions(options);
  const effectiveRequest: ImageEditRequest = target
    ? { ...request, outputFormat: "png" }
    : request;
  if (options.spriteEdit) {
    return editSpriteWithChromaKey(provider, effectiveRequest, options, target);
  }
  if (request.background !== "transparent") {
    const image = await provider.editImage(effectiveRequest);
    return finalizeImage(image, "none", options, target);
  }

  const pngRequest: ImageEditRequest = { ...effectiveRequest, outputFormat: "png" };
  const unsupportedModels = transparencyCache(provider);
  if (!unsupportedModels.has(request.model)) {
    try {
      const nativeImage = await provider.editImage(pngRequest);
      if (nativeImage.mimeType !== "image/png") {
        throw new Error("A transparent image edit returned a non-PNG image");
      }
      if (pngHasUsefulTransparency(nativeImage.bytes)) {
        return finalizeImage(nativeImage, "native", options, target);
      }
      unsupportedModels.add(request.model);
    } catch (error) {
      if (!isUnsupportedTransparencyError(error)) throw error;
      unsupportedModels.add(request.model);
    }
  }

  request.signal?.throwIfAborted();
  const chromaImage = await provider.editImage({
    ...pngRequest,
    prompt: `${request.prompt}\n\n${CHROMA_PROMPT}`,
    background: "opaque",
    outputFormat: "png",
  });
  if (chromaImage.mimeType !== "image/png") {
    throw new Error("Green-screen fallback requires the image provider to return PNG");
  }
  const keyed = removeConnectedChromaKey(chromaImage.bytes);
  const minimumBackgroundPixels = Math.max(16, Math.floor((keyed.width + keyed.height) * 0.25));
  if (keyed.transparentPixels < minimumBackgroundPixels) {
    throw new Error("The image model did not produce a usable solid green-screen background");
  }
  return finalizeImage({
    ...chromaImage,
    bytes: keyed.bytes,
    mimeType: "image/png",
  }, "chroma_key", options, target);
}

async function editSpriteWithChromaKey(
  provider: ModelProvider,
  request: ImageEditRequest,
  options: GenerateProcessedImageOptions,
  target: { width: number; height: number } | undefined,
): Promise<ProcessedGeneratedImage> {
  if (!provider.editImage) throw new Error("The configured provider does not support image editing");
  const canvas = prepareSpriteEditCanvas(request.image.bytes, request.size);
  const adapterPrompt = canvas.adapted
    ? [
        "TECHNICAL CANVAS ADAPTER:",
        `- The supplied API input canvas is ${canvas.width}x${canvas.height} pixels only to match the provider output ratio.`,
        `- The intended sprite work area is x=${canvas.cropX}, y=${canvas.cropY}, width=${canvas.cropWidth}, height=${canvas.cropHeight}.`,
        "- Keep every source element at the same coordinates inside that work area.",
        "- Do not scale, center, spread, or move the sprite content into the temporary padding.",
        "- This adapter overrides only earlier provider-canvas dimensions; the intended final sprite canvas remains the work area.",
      ].join("\n")
    : "";
  const image = await provider.editImage({
    ...request,
    image: { bytes: canvas.bytes, mimeType: "image/png" },
    prompt: [request.prompt, adapterPrompt, CHROMA_PROMPT].filter(Boolean).join("\n\n"),
    background: "opaque",
    outputFormat: "png",
  });
  if (image.mimeType !== "image/png") {
    throw new Error("Sprite transparency processing requires the image provider to return PNG");
  }
  request.signal?.throwIfAborted();
  let canvasBytes = resizePngExactly(image.bytes, canvas.width, canvas.height, true);
  if (canvas.adapted) {
    canvasBytes = cropPng(
      canvasBytes,
      canvas.cropX,
      canvas.cropY,
      canvas.cropWidth,
      canvas.cropHeight,
    );
  }
  const keyed = removeConnectedChromaKey(canvasBytes);
  const minimumBackgroundPixels = Math.max(
    16,
    Math.floor((keyed.width + keyed.height) * 0.25),
  );
  if (keyed.transparentPixels < minimumBackgroundPixels) {
    throw new Error("The image model did not produce a usable solid green-screen background for the sprite edit");
  }
  return finalizeImage({
    ...image,
    bytes: keyed.bytes,
    mimeType: "image/png",
  }, "chroma_key", options, target);
}

export function pngHasUsefulTransparency(bytes: Uint8Array): boolean {
  const png = decodePng(bytes);
  for (let offset = 3; offset < png.data.length; offset += 4) {
    if ((png.data[offset] ?? 255) < 250) return true;
  }
  return false;
}

export function removeConnectedChromaKey(bytes: Uint8Array): ChromaKeyResult {
  const png = decodePng(bytes);
  const { width, height, data } = png;
  const key = estimateBorderKey(data, width, height);
  const pixelCount = width * height;
  const candidate = new Uint8Array(pixelCount);
  const strength = new Float32Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const dominance = green - Math.max(red, blue);
    if (green < 48 || dominance < 12) continue;
    const distance = Math.sqrt(
      ((red - key.red) ** 2 * 0.8)
      + ((green - key.green) ** 2 * 1.2)
      + ((blue - key.blue) ** 2 * 0.8)
    );
    const distanceScore = clamp01((220 - distance) / 180);
    const dominanceScore = clamp01((dominance - 12) / 110);
    const backgroundStrength = Math.max(distanceScore, dominanceScore);
    if (backgroundStrength <= 0.04) continue;
    candidate[index] = 1;
    strength[index] = backgroundStrength;
  }

  const connected = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let read = 0;
  let write = 0;
  const enqueue = (index: number): void => {
    if (candidate[index] !== 1 || connected[index] === 1) return;
    connected[index] = 1;
    queue[write++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (read < write) {
    const index = queue[read++]!;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }

  let transparentPixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (connected[index] !== 1) continue;
    const offset = index * 4;
    const backgroundStrength = clamp01((strength[index] ?? 0) * 1.18);
    const originalAlpha = data[offset + 3] ?? 255;
    const alpha = Math.round(originalAlpha * (1 - backgroundStrength));
    data[offset + 3] = alpha;
    if (alpha < 250) transparentPixels += 1;
    const red = data[offset] ?? 0;
    const blue = data[offset + 2] ?? 0;
    data[offset + 1] = Math.min(data[offset + 1] ?? 0, Math.max(red, blue) + 8);
  }
  return {
    bytes: PNG.sync.write(png),
    width,
    height,
    transparentPixels,
  };
}

export function normalizeTransparentUiAsset(
  bytes: Uint8Array,
  role: NormalizedUiRole,
  styleHint = "",
  targetWidth?: number,
  targetHeight?: number,
): Uint8Array {
  const source = decodePng(bytes);
  const bounds = alphaBounds(source.data, source.width, source.height);
  if (!bounds) return bytes;
  const outputWidth = targetWidth ?? source.width;
  const outputHeight = targetHeight ?? source.height;
  const layout = roleLayout(role, outputWidth, outputHeight, bounds.width, bounds.height);
  const output = new PNG({ width: outputWidth, height: outputHeight, colorType: 6 });
  output.data.fill(0);
  const pixelArt = /(?:pixel|8-bit|16-bit|像素)/iu.test(styleHint);
  for (let y = 0; y < layout.height; y += 1) {
    for (let x = 0; x < layout.width; x += 1) {
      const sourceX = bounds.x + ((x + 0.5) * bounds.width / layout.width) - 0.5;
      const sourceY = bounds.y + ((y + 0.5) * bounds.height / layout.height) - 0.5;
      const color = pixelArt
        ? sampleNearest(source.data, source.width, source.height, sourceX, sourceY)
        : sampleBilinear(source.data, source.width, source.height, sourceX, sourceY);
      const outputOffset = ((layout.y + y) * outputWidth + layout.x + x) * 4;
      output.data[outputOffset] = color[0];
      output.data[outputOffset + 1] = color[1];
      output.data[outputOffset + 2] = color[2];
      output.data[outputOffset + 3] = color[3];
    }
  }
  return PNG.sync.write(output);
}

export function resizePngProportionally(
  bytes: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  contain: boolean,
  pixelArt = false,
): Uint8Array {
  const source = decodePng(bytes);
  if (source.width === targetWidth && source.height === targetHeight) return bytes;
  const scale = contain
    ? Math.min(targetWidth / source.width, targetHeight / source.height)
    : Math.max(targetWidth / source.width, targetHeight / source.height);
  const scaledWidth = source.width * scale;
  const scaledHeight = source.height * scale;
  const offsetX = (targetWidth - scaledWidth) / 2;
  const offsetY = (targetHeight - scaledHeight) / 2;
  const output = new PNG({ width: targetWidth, height: targetHeight, colorType: 6 });
  output.data.fill(0);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = ((x + 0.5) - offsetX) / scale - 0.5;
      const sourceY = ((y + 0.5) - offsetY) / scale - 0.5;
      if (sourceX < -0.5 || sourceY < -0.5 || sourceX >= source.width - 0.5 || sourceY >= source.height - 0.5) {
        continue;
      }
      const color = pixelArt
        ? sampleNearest(source.data, source.width, source.height, sourceX, sourceY)
        : sampleBilinear(source.data, source.width, source.height, sourceX, sourceY);
      const outputOffset = (y * targetWidth + x) * 4;
      output.data[outputOffset] = color[0];
      output.data[outputOffset + 1] = color[1];
      output.data[outputOffset + 2] = color[2];
      output.data[outputOffset + 3] = color[3];
    }
  }
  return PNG.sync.write(output);
}

export function resizePngExactly(
  bytes: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  pixelArt = false,
): Uint8Array {
  const source = decodePng(bytes);
  if (source.width === targetWidth && source.height === targetHeight) return bytes;
  const output = new PNG({ width: targetWidth, height: targetHeight, colorType: 6 });
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = ((x + 0.5) * source.width / targetWidth) - 0.5;
      const sourceY = ((y + 0.5) * source.height / targetHeight) - 0.5;
      const color = pixelArt
        ? sampleNearest(source.data, source.width, source.height, sourceX, sourceY)
        : sampleBilinear(source.data, source.width, source.height, sourceX, sourceY);
      const outputOffset = (y * targetWidth + x) * 4;
      output.data[outputOffset] = color[0];
      output.data[outputOffset + 1] = color[1];
      output.data[outputOffset + 2] = color[2];
      output.data[outputOffset + 3] = color[3];
    }
  }
  return PNG.sync.write(output);
}

interface SpriteEditCanvas {
  bytes: Uint8Array;
  width: number;
  height: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  adapted: boolean;
}

function prepareSpriteEditCanvas(bytes: Uint8Array, providerSize?: string): SpriteEditCanvas {
  const source = decodePng(bytes);
  const providerRatio = parseImageSizeRatio(providerSize) ?? 1;
  const sourceRatio = source.width / source.height;
  const ratioDifference = Math.abs(Math.log(sourceRatio / providerRatio));
  if (ratioDifference < 0.01) {
    return {
      bytes,
      width: source.width,
      height: source.height,
      cropX: 0,
      cropY: 0,
      cropWidth: source.width,
      cropHeight: source.height,
      adapted: false,
    };
  }

  let width = source.width;
  let height = source.height;
  if (sourceRatio > providerRatio) height = Math.ceil(source.width / providerRatio);
  else width = Math.ceil(source.height * providerRatio);
  if (width * height > MAX_DECODED_PIXELS) {
    throw new Error("The sprite edit padding canvas exceeds the decoded-pixel safety limit");
  }
  const cropX = Math.floor((width - source.width) / 2);
  const cropY = Math.floor((height - source.height) / 2);
  const padded = new PNG({ width, height, colorType: 6 });
  padded.data.fill(0);
  for (let y = 0; y < source.height; y += 1) {
    const sourceOffset = y * source.width * 4;
    const targetOffset = ((cropY + y) * width + cropX) * 4;
    padded.data.set(
      source.data.subarray(sourceOffset, sourceOffset + source.width * 4),
      targetOffset,
    );
  }
  return {
    bytes: PNG.sync.write(padded),
    width,
    height,
    cropX,
    cropY,
    cropWidth: source.width,
    cropHeight: source.height,
    adapted: true,
  };
}

function parseImageSizeRatio(value?: string): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    return undefined;
  }
  return width / height;
}

function cropPng(
  bytes: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array {
  const source = decodePng(bytes);
  if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > source.width || y + height > source.height) {
    throw new Error("Sprite edit crop is outside the provider canvas");
  }
  const output = new PNG({ width, height, colorType: 6 });
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((y + row) * source.width + x) * 4;
    const targetOffset = row * width * 4;
    output.data.set(
      source.data.subarray(sourceOffset, sourceOffset + width * 4),
      targetOffset,
    );
  }
  return PNG.sync.write(output);
}

function finalizeImage(
  image: GeneratedImage,
  transparencyMode: TransparencyMode,
  options: GenerateProcessedImageOptions,
  target: { width: number; height: number } | undefined,
): ProcessedGeneratedImage {
  if (!options.normalizeUiRole && !target) {
    return { image, transparencyMode, normalized: false, resized: false };
  }
  if (image.mimeType !== "image/png") {
    throw new Error("Custom image sizing and UI normalization require PNG output");
  }
  const source = decodePng(image.bytes);
  const pixelArt = /(?:pixel|8-bit|16-bit|像素)/iu.test(options.styleHint ?? "");
  let bytes = image.bytes;
  if (options.normalizeUiRole) {
    bytes = normalizeTransparentUiAsset(
      image.bytes,
      options.normalizeUiRole,
      options.styleHint,
      target?.width,
      target?.height,
    );
  } else if (target) {
    bytes = options.spriteEdit
      ? resizePngExactly(image.bytes, target.width, target.height, pixelArt)
      : resizePngProportionally(
        image.bytes,
        target.width,
        target.height,
        transparencyMode !== "none",
        pixelArt,
      );
  }
  const output = decodePng(bytes);
  return {
    image: { ...image, bytes, mimeType: "image/png" },
    transparencyMode,
    normalized: Boolean(options.normalizeUiRole),
    resized: source.width !== output.width || source.height !== output.height,
    sourceWidth: source.width,
    sourceHeight: source.height,
    outputWidth: output.width,
    outputHeight: output.height,
  };
}

function readTargetDimensions(
  options: GenerateProcessedImageOptions,
): { width: number; height: number } | undefined {
  if (options.targetWidth === undefined && options.targetHeight === undefined) return undefined;
  if (
    !Number.isInteger(options.targetWidth)
    || !Number.isInteger(options.targetHeight)
    || options.targetWidth! < 16
    || options.targetHeight! < 16
    || options.targetWidth! > 3840
    || options.targetHeight! > 3840
    || options.targetWidth! * options.targetHeight! > MAX_DECODED_PIXELS
  ) {
    throw new Error("Target image dimensions must be integers from 16 to 3840 within the pixel safety limit");
  }
  return { width: options.targetWidth!, height: options.targetHeight! };
}

function transparencyCache(provider: ModelProvider): Set<string> {
  let models = unsupportedNativeTransparency.get(provider);
  if (!models) {
    models = new Set<string>();
    unsupportedNativeTransparency.set(provider, models);
  }
  return models;
}

function isUnsupportedTransparencyError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const mentionsTransparency = message.includes("transparent") || message.includes("background");
  const rejectsCapability = (
    message.includes("not supported")
    || message.includes("unsupported")
    || message.includes("invalid_value")
    || message.includes("invalid value")
  );
  return mentionsTransparency && rejectsCapability;
}

function decodePng(bytes: Uint8Array): PNG {
  if (bytes.byteLength < 24 || !Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) {
    throw new Error("Image post-processing requires a valid PNG image");
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width <= 0 || height <= 0 || width * height > MAX_DECODED_PIXELS) {
    throw new Error("PNG dimensions exceed the image post-processing safety limit");
  }
  try {
    return PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
  } catch (error) {
    throw new Error("Image post-processing could not decode the generated PNG", { cause: error });
  }
}

function estimateBorderKey(
  data: Buffer,
  width: number,
  height: number,
): { red: number; green: number; blue: number } {
  const samples: Array<[number, number, number]> = [];
  const sample = (index: number): void => {
    const offset = index * 4;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    if (green >= 80 && green - Math.max(red, blue) >= 35) samples.push([red, green, blue]);
  };
  for (let x = 0; x < width; x += 1) {
    sample(x);
    sample((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(y * width);
    sample(y * width + width - 1);
  }
  if (samples.length === 0) return { red: 0, green: 255, blue: 0 };
  const median = (channel: number): number => {
    const values = samples.map((value) => value[channel]!).sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)]!;
  };
  return { red: median(0), green: median(1), blue: median(2) };
}

function alphaBounds(
  data: Buffer,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | undefined {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) <= 12) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return undefined;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function roleLayout(
  role: NormalizedUiRole,
  canvasWidth: number,
  canvasHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): { x: number; y: number; width: number; height: number } {
  const targets: Record<NormalizedUiRole, { width: number; height: number; stretch: boolean }> = {
    panel: { width: 0.84, height: 0.70, stretch: false },
    button: { width: 0.74, height: 0.30, stretch: true },
    icon: { width: 0.42, height: 0.42, stretch: false },
    decoration: { width: 0.56, height: 0.56, stretch: false },
  };
  const target = targets[role];
  const maximumWidth = Math.max(1, Math.round(canvasWidth * target.width));
  const maximumHeight = Math.max(1, Math.round(canvasHeight * target.height));
  let width = maximumWidth;
  let height = maximumHeight;
  if (!target.stretch) {
    const scale = Math.min(maximumWidth / sourceWidth, maximumHeight / sourceHeight);
    width = Math.max(1, Math.round(sourceWidth * scale));
    height = Math.max(1, Math.round(sourceHeight * scale));
  }
  return {
    x: Math.floor((canvasWidth - width) / 2),
    y: Math.floor((canvasHeight - height) / 2),
    width,
    height,
  };
}

function sampleNearest(
  data: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const sampleX = Math.max(0, Math.min(width - 1, Math.round(x)));
  const sampleY = Math.max(0, Math.min(height - 1, Math.round(y)));
  const offset = (sampleY * width + sampleX) * 4;
  return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, data[offset + 3] ?? 0];
}

function sampleBilinear(
  data: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = clamp01(x - x0);
  const fy = clamp01(y - y0);
  const samples: Array<[number, number]> = [
    [y0 * width + x0, (1 - fx) * (1 - fy)],
    [y0 * width + x1, fx * (1 - fy)],
    [y1 * width + x0, (1 - fx) * fy],
    [y1 * width + x1, fx * fy],
  ];
  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const [index, weight] of samples) {
    const offset = index * 4;
    const sampleAlpha = (data[offset + 3] ?? 0) / 255;
    alpha += sampleAlpha * weight;
    red += (data[offset] ?? 0) * sampleAlpha * weight;
    green += (data[offset + 1] ?? 0) * sampleAlpha * weight;
    blue += (data[offset + 2] ?? 0) * sampleAlpha * weight;
  }
  if (alpha <= 0.0001) return [0, 0, 0, 0];
  return [
    Math.round(red / alpha),
    Math.round(green / alpha),
    Math.round(blue / alpha),
    Math.round(alpha * 255),
  ];
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0)) >>> 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
