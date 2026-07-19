import assert from "node:assert/strict";
import test from "node:test";
import { parseEditorSceneLeaseContext, parseTurnAttachmentReferences } from "../src/protocol.js";

test("scene lease contexts validate multi-scene targets and unsaved roots", () => {
  assert.deepEqual(
    parseEditorSceneLeaseContext(
      [
        { scene_id: "scene-a", scene_path: "res://scenes/a.tscn", scene_revision: "history_1_v2" },
        { scene_id: "scene-b", scene_path: "", scene_revision: "history_2_v0" },
      ],
      "scene-a",
      ["res://scenes/a.tscn", "res://scenes/open-without-revision.tscn"],
    ),
    {
      scene_leases: [
        { scene_id: "scene-a", scene_path: "res://scenes/a.tscn", scene_revision: "history_1_v2" },
        { scene_id: "scene-b", scene_path: "", scene_revision: "history_2_v0" },
      ],
      primary_scene_id: "scene-a",
      open_scene_paths: ["res://scenes/a.tscn", "res://scenes/open-without-revision.tscn"],
    },
  );
});

test("scene lease contexts reject ambiguous identities and unsafe paths", () => {
  const lease = { scene_id: "scene-a", scene_path: "res://scenes/a.tscn", scene_revision: "r1" };
  assert.throws(
    () => parseEditorSceneLeaseContext([lease, lease], "scene-a", []),
    /duplicate scene_id/,
  );
  assert.throws(
    () => parseEditorSceneLeaseContext([lease], "scene-b", []),
    /must identify a scene/,
  );
  assert.throws(
    () => parseEditorSceneLeaseContext([{ ...lease, scene_path: "res://scenes/../a.tscn" }], "scene-a", []),
    /canonical res:\/\//,
  );
  assert.throws(
    () => parseEditorSceneLeaseContext([{ ...lease, extra: true }], "scene-a", []),
    /unsupported field: extra/,
  );
  assert.throws(
    () => parseEditorSceneLeaseContext([lease], "scene-a", [""]),
    /must be a canonical res:\/\/ path/,
  );
});

test("turn attachment references preserve bounded source identity metadata", () => {
  const attachmentId = "a".repeat(64);
  const annotatedFrom = "b".repeat(64);
  assert.deepEqual(parseTurnAttachmentReferences([{
    attachment_id: attachmentId,
    detail: "high",
    annotations: [
      { id: 1, type: "arrow", start: [0.1, 0.2], end: [0.8, 0.7] },
      { id: 2, type: "rectangle", start: [0, 0], end: [0.5, 0.5] },
    ],
    annotated_from: annotatedFrom,
    source: "game_frame",
    name: "Current game frame",
    run_id: "run_12345678",
    scene_id: "scene_12345678",
    scene_path: "res://demo/main.tscn",
    captured_at_ms: 123,
    viewport_width: 1280,
    viewport_height: 720,
    frame: 42,
  }]), [{
    attachment_id: attachmentId,
    detail: "high",
    annotations: [
      { id: 1, type: "arrow", start: [0.1, 0.2], end: [0.8, 0.7] },
      { id: 2, type: "rectangle", start: [0, 0], end: [0.5, 0.5] },
    ],
    annotated_from: annotatedFrom,
    source: "game_frame",
    name: "Current game frame",
    run_id: "run_12345678",
    scene_id: "scene_12345678",
    scene_path: "res://demo/main.tscn",
    captured_at_ms: 123,
    viewport_width: 1280,
    viewport_height: 720,
    frame: 42,
  }]);
  assert.throws(
    () => parseTurnAttachmentReferences([{ attachment_id: attachmentId, detail: "high", mime_type: "image/png" }]),
    /unsupported field: mime_type/u,
  );
  assert.throws(
    () => parseTurnAttachmentReferences([{ attachment_id: attachmentId, detail: "auto" }]),
    /detail must be low or high/u,
  );
  assert.throws(
    () => parseTurnAttachmentReferences([{
      attachment_id: attachmentId,
      detail: "high",
      annotations: [{ id: 1, type: "arrow", start: [0, 0, 0], end: [1, 1] }],
    }]),
    /exactly 2 coordinates/u,
  );
  assert.throws(
    () => parseTurnAttachmentReferences([{
      attachment_id: attachmentId,
      detail: "high",
      annotated_from: "B".repeat(64),
    }]),
    /lowercase SHA-256/u,
  );
  assert.throws(
    () => parseTurnAttachmentReferences([
      { attachment_id: attachmentId, detail: "low" },
      { attachment_id: attachmentId, detail: "high" },
    ]),
    /duplicated/u,
  );
});
