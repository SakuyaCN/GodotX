import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { AttachmentStore } from "../src/attachment-store.js";
import type {
  GeneratedImage,
  ImageGenerationRequest,
  ModelProvider,
  ProviderModel,
  ProviderRequest,
  ProviderTurnResult,
} from "../src/provider/types.js";
import { generateUiKit, parseUiKitGenerationRequest } from "../src/ui-kit.js";
import { Workspace } from "../src/workspace.js";

test("UI kit parser bounds model, context, asset count, and attachment inputs", () => {
  const request = parseUiKitGenerationRequest({
    workflow_id: "workflow_1234",
    prompt: "Create a compact pause menu kit",
    planner_model: "gpt-5.6-sol",
    image_model: "gpt-image-2",
    context: { scene: "res://menu.tscn" },
    context_attachment_id: "a".repeat(64),
  });
  assert.equal(request.maxAssets, 3);
  assert.equal(request.reviewEnabled, true);
  assert.equal(request.outputFormat, "png");
  assert.equal(request.contextAttachmentId, "a".repeat(64));
  assert.equal(request.targetWidth, undefined);
  assert.throws(
    () => parseUiKitGenerationRequest({ ...wireRequest(), max_assets: 5 }),
    /between 1 and 4/,
  );
  assert.throws(
    () => parseUiKitGenerationRequest({ ...wireRequest(), target_width: 64 }),
    /provided together/,
  );
  assert.throws(
    () => parseUiKitGenerationRequest({ ...wireRequest(), context_attachment_id: "unsafe" }),
    /SHA-256/,
  );
});

test("UI kit pipeline plans, generates bounded assets, reviews them, and writes project artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-ui-kit-"));
  const attachments = new AttachmentStore(path.join(root, "attachments"));
  const viewportBytes = minimalPng(8, 8);
  const viewportId = createHash("sha256").update(viewportBytes).digest("hex");
  await writeFile(path.join(attachments.directory, `${viewportId}.png`), viewportBytes);
  const workspace = await Workspace.open(root);
  const provider = new UiKitProvider();
  const progress: string[] = [];
  const result = await generateUiKit({
    request: parseUiKitGenerationRequest({
      ...wireRequest(),
      context: {
        project_name: "Test Game",
        scene_path: "res://menu.tscn",
        controls: [{ name: "StartButton", type: "Button", size: [220, 56] }],
      },
      context_attachment_id: viewportId,
      max_assets: 2,
      target_width: 96,
      target_height: 48,
    }),
    provider,
    workspace,
    attachmentStore: attachments,
    signal: new AbortController().signal,
    emit: (event) => progress.push(event.phase),
  });

  assert.deepEqual(progress, ["planning", "planned", "generating", "generating", "reviewing", "completed"]);
  assert.equal(provider.turnRequests.length, 2);
  assert.equal(provider.imageRequests.length, 2);
  assert.ok(provider.imageRequests.every((request) => request.prompt.includes("Do not render any text")));
  assert.deepEqual(result.plan.assets.map((asset) => asset.role), ["panel", "button"]);
  assert.equal(result.assets.length, 2);
  assert.ok(result.assets.every((asset) => asset.transparencyMode === "native" && asset.normalized));
  assert.ok(result.assets.every((asset) => asset.outputWidth === 96 && asset.outputHeight === 48));
  assert.equal(result.review.status, "completed");
  assert.equal(result.review.passed, true);
  assert.equal(result.review.score, 88);
  for (const asset of result.assets) {
    assert.match(asset.resourcePath, /^res:\/\/assets\/generated\/ui-kits\//u);
    const stored = await readFile(path.join(root, ...asset.path.split("/")));
    assert.deepEqual([...stored.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual([PNG.sync.read(stored).width, PNG.sync.read(stored).height], [96, 48]);
  }
  const plannerMessage = provider.turnRequests[0]?.messages[0];
  assert.equal(plannerMessage?.role, "user");
  assert.ok(Array.isArray(plannerMessage?.content));
  assert.equal(
    Array.isArray(plannerMessage?.content)
      ? plannerMessage.content.filter((part) => part.type === "image").length
      : 0,
    1,
  );
  const reviewMessage = provider.turnRequests[1]?.messages[0];
  assert.equal(
    reviewMessage?.role === "user" && Array.isArray(reviewMessage.content)
      ? reviewMessage.content.filter((part) => part.type === "image").length
      : 0,
    2,
  );
});

test("UI kit pipeline stops before paid image generation when the planner contract is invalid", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "godetx-ui-kit-invalid-"));
  const provider = new UiKitProvider();
  provider.invalidPlan = true;
  await assert.rejects(
    generateUiKit({
      request: parseUiKitGenerationRequest(wireRequest()),
      provider,
      workspace: await Workspace.open(root),
      attachmentStore: new AttachmentStore(path.join(root, "attachments")),
      signal: new AbortController().signal,
      emit: () => undefined,
    }),
    /must contain 1-3 assets/,
  );
  assert.equal(provider.imageRequests.length, 0);
});

function wireRequest(): Record<string, unknown> {
  return {
    workflow_id: "workflow_1234",
    prompt: "Create a compact pause menu kit",
    planner_model: "gpt-5.6-sol",
    image_model: "gpt-image-2",
    size: "1024x1024",
    quality: "high",
    background: "transparent",
    output_format: "png",
    context: {},
  };
}

function minimalPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

class UiKitProvider implements ModelProvider {
  static readonly PNG = transparentGeneratedPng(16, 16);
  readonly turnRequests: ProviderRequest[] = [];
  readonly imageRequests: ImageGenerationRequest[] = [];
  invalidPlan = false;

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "gpt-5.6-sol" }, { id: "gpt-image-2" }];
  }

  getModelCapabilities() {
    return {
      image_input: {
        status: "supported" as const,
        mime_types: ["image/png" as const],
        detail_levels: ["high" as const],
        max_images: 4,
      },
    };
  }

  async streamTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.turnRequests.push(request);
    if (this.turnRequests.length === 1) {
      return {
        message: {
          role: "assistant",
          content: this.invalidPlan
            ? '{"summary":"bad","style":"flat","assets":[]}'
            : JSON.stringify({
                summary: "Pause menu essentials",
                style: "quiet neon arcade UI with crisp cyan borders",
                assets: [
                  { id: "pause_panel", name: "Pause panel", role: "panel", prompt: "A centered pause menu panel" },
                  { id: "resume_button", name: "Resume button", role: "button", prompt: "A wide reusable button face" },
                ],
              }),
          toolCalls: [],
        },
      };
    }
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          passed: true,
          score: 88,
          summary: "The two assets share a consistent border and palette.",
          issues: [],
        }),
        toolCalls: [],
      },
    };
  }

  async generateImage(request: ImageGenerationRequest): Promise<GeneratedImage> {
    this.imageRequests.push(request);
    return { bytes: UiKitProvider.PNG, mimeType: "image/png" };
  }
}

function transparentGeneratedPng(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height, colorType: 6 });
  png.data.fill(0);
  for (let y = 5; y < 11; y += 1) {
    for (let x = 3; x < 13; x += 1) {
      const offset = (y * width + x) * 4;
      png.data[offset] = 40;
      png.data[offset + 1] = 120;
      png.data[offset + 2] = 220;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
