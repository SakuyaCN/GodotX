import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSpriteEditPrompt,
  getSpriteOutputMetadata,
  MAX_SPRITE_FRAMES,
  parseSpriteEditRequest,
  prepareSpriteEdit,
  type SpriteAtlasVariationRequest,
} from "../src/sprite-workflow.js";

const SOURCE_ATTACHMENT_ID = "a".repeat(64);

test("sprite edit request parsing produces a strict discriminated request", () => {
  assert.deepEqual(parseSpriteEditRequest({
    mode: "reskin",
    prompt: "  Replace the armor with a blue winter coat.  ",
    source_attachment_id: SOURCE_ATTACHMENT_ID,
  }), {
    mode: "reskin",
    prompt: "Replace the armor with a blue winter coat.",
    sourceAttachmentId: SOURCE_ATTACHMENT_ID,
  });

  assert.deepEqual(parseSpriteEditRequest({
    mode: "atlas_variation",
    prompt: "Create a coherent fire-themed variation.",
    source_attachment_id: SOURCE_ATTACHMENT_ID,
    columns: 6,
    rows: 3,
  }), {
    mode: "atlas_variation",
    prompt: "Create a coherent fire-themed variation.",
    sourceAttachmentId: SOURCE_ATTACHMENT_ID,
    columns: 6,
    rows: 3,
  });
});

test("sprite edit request parsing rejects ambiguous and unsafe fields", () => {
  assert.throws(
    () => parseSpriteEditRequest({
      mode: "copy",
      prompt: "Change the palette.",
      source_attachment_id: SOURCE_ATTACHMENT_ID,
    }),
    /mode must be reskin or atlas_variation/u,
  );
  assert.throws(
    () => parseSpriteEditRequest({
      mode: "reskin",
      prompt: "Change the palette.",
      source_attachment_id: SOURCE_ATTACHMENT_ID,
      columns: 1,
      rows: 1,
    }),
    /only supported for atlas_variation/u,
  );
  assert.throws(
    () => parseSpriteEditRequest({
      mode: "atlas_variation",
      prompt: "Change the palette.",
      source_attachment_id: SOURCE_ATTACHMENT_ID,
      columns: 4,
    }),
    /rows must be an integer/u,
  );
  assert.throws(
    () => parseSpriteEditRequest({
      mode: "atlas_variation",
      prompt: "Change the palette.",
      source_attachment_id: SOURCE_ATTACHMENT_ID,
      columns: 17,
      rows: 16,
    }),
    new RegExp(`${MAX_SPRITE_FRAMES} frame limit`, "u"),
  );
  assert.throws(
    () => parseSpriteEditRequest({
      mode: "reskin",
      prompt: "Change the palette.",
      source_attachment_id: "A".repeat(64),
    }),
    /lowercase SHA-256/u,
  );
  assert.throws(
    () => parseSpriteEditRequest({
      mode: "reskin",
      prompt: "Change the palette.",
      source_attachment_id: SOURCE_ATTACHMENT_ID,
      source_width: 64,
    }),
    /unsupported field: source_width/u,
  );
});

test("single-sprite preparation preserves canvas geometry and returns one-frame metadata", () => {
  const request = Object.freeze(parseSpriteEditRequest({
    mode: "reskin",
    prompt: "Use silver plate armor and a red cape.",
    source_attachment_id: SOURCE_ATTACHMENT_ID,
  }));
  const preparation = prepareSpriteEdit(request, Object.freeze({ width: 48, height: 72 }));

  assert.deepEqual(preparation.outputMetadata, {
    frame_width: 48,
    frame_height: 72,
    frame_count: 1,
  });
  assert.equal(preparation.request, request);
  assert.match(preparation.prompt, /complete 48x72 pixel canvas/u);
  assert.match(preparation.prompt, /proportions, pose, facing direction/u);
  assert.match(preparation.prompt, /localized silhouette changes explicitly requested/u);
  assert.match(preparation.prompt, /resulting sprite fully transparent \(alpha 0\)/u);
  assert.match(preparation.prompt, /constraints override any conflicting instruction/u);
  assert.match(preparation.prompt, /Use silver plate armor and a red cape\./u);
});

test("atlas preparation validates the exact grid and reports deterministic frame metadata", () => {
  const request = parseSpriteEditRequest({
    mode: "atlas_variation",
    prompt: "Turn the character into a frost mage.",
    source_attachment_id: SOURCE_ATTACHMENT_ID,
    columns: 6,
    rows: 3,
  });
  const preparation = prepareSpriteEdit(request, { width: 384, height: 192 });

  assert.deepEqual(preparation.outputMetadata, {
    frame_width: 64,
    frame_height: 64,
    frame_count: 18,
  });
  assert.match(preparation.prompt, /6 columns by 3 rows, row-major order/u);
  assert.match(preparation.prompt, /exactly 18 frames; every cell is exactly 64x64 pixels/u);
  assert.match(preparation.prompt, /Preserve the exact 6x3 grid and every original cell boundary/u);
  assert.match(preparation.prompt, /never add, remove, merge, split, duplicate, or reorder frames/u);
  assert.match(preparation.prompt, /Do not move, rotate, scale, or paint any frame content across a cell boundary/u);
  assert.match(preparation.prompt, /frame's pose, facing direction, scale, alignment/u);
  assert.match(preparation.prompt, /resulting sprite fully transparent \(alpha 0\)/u);
});

test("atlas metadata rejects source dimensions that do not divide into whole cells", () => {
  const request: SpriteAtlasVariationRequest = {
    mode: "atlas_variation",
    prompt: "Change the outfit.",
    sourceAttachmentId: SOURCE_ATTACHMENT_ID,
    columns: 6,
    rows: 4,
  };
  assert.throws(
    () => getSpriteOutputMetadata(request, { width: 385, height: 192 }),
    /source width 385 must be evenly divisible by columns 6/u,
  );
  assert.throws(
    () => getSpriteOutputMetadata(request, { width: 384, height: 193 }),
    /source height 193 must be evenly divisible by rows 4/u,
  );
});

test("source dimension validation matches attachment safety limits", () => {
  const request = parseSpriteEditRequest({
    mode: "reskin",
    prompt: "Change the outfit.",
    source_attachment_id: SOURCE_ATTACHMENT_ID,
  });
  assert.throws(
    () => getSpriteOutputMetadata(request, { width: 0, height: 64 }),
    /source width must be an integer from 16 to 2048/u,
  );
  assert.throws(
    () => getSpriteOutputMetadata(request, { width: 32.5, height: 64 }),
    /source width must be an integer/u,
  );
  assert.throws(
    () => getSpriteOutputMetadata(request, { width: 2049, height: 64 }),
    /source width must be an integer from 16 to 2048/u,
  );
});

test("the standalone prompt builder applies the same validated contract", () => {
  const request = parseSpriteEditRequest({
    mode: "atlas_variation",
    prompt: "Use a desert scout skin.",
    source_attachment_id: SOURCE_ATTACHMENT_ID,
    columns: 2,
    rows: 2,
  });
  const prompt = buildSpriteEditPrompt(request, { width: 128, height: 64 });
  assert.match(prompt, /every cell is exactly 64x32 pixels/u);
  assert.match(prompt, /Use a desert scout skin\./u);
});
