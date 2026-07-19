import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import {
  editProcessedImage,
  generateProcessedImage,
  normalizeTransparentUiAsset,
  removeConnectedChromaKey,
  resizePngProportionally,
} from "../src/image-processing.js";
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerationRequest,
  ModelProvider,
  ProviderModel,
  ProviderRequest,
  ProviderTurnResult,
} from "../src/provider/types.js";

test("transparent generation falls back to a green-screen PNG and caches model rejection", async () => {
  const provider = new ProcessingProvider();
  const request: ImageGenerationRequest = {
    model: "no-native-alpha",
    prompt: "A reusable game button",
    background: "transparent",
    outputFormat: "webp",
  };
  const first = await generateProcessedImage(provider, request);
  assert.equal(first.transparencyMode, "chroma_key");
  assert.equal(first.image.mimeType, "image/png");
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0]?.background, "transparent");
  assert.equal(provider.requests[0]?.outputFormat, "png");
  assert.equal(provider.requests[1]?.background, "opaque");
  assert.match(provider.requests[1]?.prompt ?? "", /#00FF00/u);
  assert.equal(alphaAt(first.image.bytes, 0, 0), 0);
  assert.equal(alphaAt(first.image.bytes, 3, 3), 255);

  const second = await generateProcessedImage(provider, request);
  assert.equal(second.transparencyMode, "chroma_key");
  assert.equal(provider.requests.length, 3);
  assert.equal(provider.requests[2]?.background, "opaque");
});

test("native alpha is kept without a paid green-screen retry", async () => {
  const provider = new ProcessingProvider();
  provider.nativeTransparency = true;
  const result = await generateProcessedImage(provider, {
    model: "native-alpha",
    prompt: "A game icon",
    background: "transparent",
    outputFormat: "png",
  });
  assert.equal(result.transparencyMode, "native");
  assert.equal(provider.requests.length, 1);
});

test("connected chroma key removes only the green-screen region", () => {
  const source = greenScreenPng(8, 8);
  const result = removeConnectedChromaKey(source);
  assert.ok(result.transparentPixels >= 48);
  assert.equal(alphaAt(result.bytes, 0, 0), 0);
  assert.equal(alphaAt(result.bytes, 3, 3), 255);
});

test("button normalization produces one deterministic content box", () => {
  const narrow = transparentRectPng(100, 60, 35, 22, 30, 16);
  const wide = transparentRectPng(100, 60, 10, 12, 80, 36);
  const narrowBounds = visibleBounds(normalizeTransparentUiAsset(narrow, "button"));
  const wideBounds = visibleBounds(normalizeTransparentUiAsset(wide, "button"));
  assert.deepEqual(narrowBounds, wideBounds);
  assert.deepEqual(narrowBounds, { x: 13, y: 21, width: 74, height: 18 });
});

test("TypeScript resizing preserves aspect ratio for output below 1024", () => {
  const source = opaqueRectPng(100, 50);
  const resized = resizePngProportionally(source, 64, 64, true);
  const png = PNG.sync.read(Buffer.from(resized));
  assert.equal(png.width, 64);
  assert.equal(png.height, 64);
  assert.deepEqual(visibleBounds(resized), { x: 0, y: 16, width: 64, height: 32 });
});

test("processed generation reports exact custom output dimensions", async () => {
  const provider = new ProcessingProvider();
  provider.nativeTransparency = true;
  const result = await generateProcessedImage(provider, {
    model: "native-alpha-custom",
    prompt: "A small game icon",
    background: "transparent",
    outputFormat: "png",
  }, {
    targetWidth: 48,
    targetHeight: 24,
  });
  assert.equal(result.resized, true);
  assert.equal(result.sourceWidth, 8);
  assert.equal(result.sourceHeight, 8);
  assert.equal(result.outputWidth, 48);
  assert.equal(result.outputHeight, 24);
  const png = PNG.sync.read(Buffer.from(result.image.bytes));
  assert.deepEqual([png.width, png.height], [48, 24]);
});

test("processed sprite editing pads wide inputs, removes chroma, and preserves new outlines", async () => {
  const provider = new ProcessingProvider();
  const source = transparentRectPng(48, 24, 8, 4, 24, 12);
  const result = await editProcessedImage(provider, {
    model: "sprite-edit",
    prompt: "Replace the sword with a longer spear.",
    size: "48x48",
    background: "transparent",
    outputFormat: "png",
    inputFidelity: "high",
    image: { bytes: source, mimeType: "image/png" },
  }, {
    targetWidth: 48,
    targetHeight: 24,
    spriteEdit: true,
  });

  assert.equal(provider.editRequests.length, 1);
  assert.equal(provider.editRequests[0]?.inputFidelity, "high");
  assert.equal(provider.editRequests[0]?.background, "opaque");
  assert.match(provider.editRequests[0]?.prompt ?? "", /TECHNICAL CANVAS ADAPTER/u);
  assert.match(provider.editRequests[0]?.prompt ?? "", /#00FF00/u);
  const providerInput = PNG.sync.read(Buffer.from(provider.editRequests[0]!.image.bytes));
  assert.deepEqual([providerInput.width, providerInput.height], [48, 48]);
  assert.equal(result.transparencyMode, "chroma_key");
  assert.deepEqual([result.outputWidth, result.outputHeight], [48, 24]);
  const png = PNG.sync.read(Buffer.from(result.image.bytes));
  assert.deepEqual([png.width, png.height], [48, 24]);
  assert.equal(alphaAt(result.image.bytes, 0, 0), 0);
  assert.equal(alphaAt(result.image.bytes, 12, 2), 255);
  assert.equal(alphaAt(result.image.bytes, 34, 2), 255);
  assert.equal(alphaAt(source, 34, 2), 0);
  assert.equal(alphaAt(result.image.bytes, 36, 2), 0);
});

test("sprite editing rejects an opaque non-chroma result instead of saving a black sprite", async () => {
  const provider = new ProcessingProvider();
  provider.invalidEditBackground = true;
  const source = transparentRectPng(48, 24, 8, 4, 24, 12);
  await assert.rejects(editProcessedImage(provider, {
    model: "broken-sprite-edit",
    prompt: "Change the weapon.",
    size: "48x48",
    background: "transparent",
    outputFormat: "png",
    image: { bytes: source, mimeType: "image/png" },
  }, {
    targetWidth: 48,
    targetHeight: 24,
    spriteEdit: true,
  }), /did not produce a usable solid green-screen background/u);
});

class ProcessingProvider implements ModelProvider {
  readonly requests: ImageGenerationRequest[] = [];
  readonly editRequests: ImageEditRequest[] = [];
  nativeTransparency = false;
  invalidEditBackground = false;

  async listModels(): Promise<ProviderModel[]> {
    return [];
  }

  async streamTurn(_request: ProviderRequest): Promise<ProviderTurnResult> {
    throw new Error("Not used by this test provider");
  }

  async generateImage(request: ImageGenerationRequest): Promise<GeneratedImage> {
    this.requests.push({ ...request });
    if (request.background === "transparent") {
      if (this.nativeTransparency) return { bytes: transparentRectPng(8, 8, 2, 2, 4, 4), mimeType: "image/png" };
      throw new Error('HTTP 400: {"message":"Transparent background is not supported for this model"}');
    }
    return { bytes: greenScreenPng(8, 8), mimeType: "image/png" };
  }

  async editImage(request: ImageEditRequest): Promise<GeneratedImage> {
    this.editRequests.push({ ...request });
    if (request.background === "transparent") {
      if (this.nativeTransparency) {
        return { bytes: transparentRectPng(8, 8, 2, 2, 4, 4), mimeType: "image/png" };
      }
      throw new Error('{"message":"Transparent background is not supported for this model"}');
    }
    return {
      bytes: this.invalidEditBackground ? opaqueRectPng(8, 8) : greenScreenPng(8, 8),
      mimeType: "image/png",
    };
  }
}

function greenScreenPng(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const foreground = x >= 2 && x <= width - 3 && y >= 2 && y <= height - 3;
      png.data[offset] = foreground ? 210 : 0;
      png.data[offset + 1] = foreground ? 40 : 255;
      png.data[offset + 2] = foreground ? 40 : 0;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function transparentRectPng(
  width: number,
  height: number,
  left: number,
  top: number,
  rectWidth: number,
  rectHeight: number,
): Uint8Array {
  const png = new PNG({ width, height, colorType: 6 });
  png.data.fill(0);
  for (let y = top; y < top + rectHeight; y += 1) {
    for (let x = left; x < left + rectWidth; x += 1) {
      const offset = (y * width + x) * 4;
      png.data[offset] = 210;
      png.data[offset + 1] = 40;
      png.data[offset + 2] = 40;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function opaqueRectPng(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height, colorType: 6 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = 40;
    png.data[offset + 1] = 120;
    png.data[offset + 2] = 220;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function alphaAt(bytes: Uint8Array, x: number, y: number): number {
  const png = PNG.sync.read(Buffer.from(bytes));
  return png.data[(y * png.width + x) * 4 + 3] ?? 0;
}

function visibleBounds(bytes: Uint8Array): { x: number; y: number; width: number; height: number } | undefined {
  const png = PNG.sync.read(Buffer.from(bytes));
  let left = png.width;
  let top = png.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if ((png.data[(y * png.width + x) * 4 + 3] ?? 0) <= 12) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return undefined;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
