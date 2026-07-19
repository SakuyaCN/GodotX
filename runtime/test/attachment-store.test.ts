import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AttachmentStore } from "../src/attachment-store.js";

test("AttachmentStore registers content-addressed PNG files from the shared data directory", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "godetx-attachment-workspace-"));
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "godetx-attachment-data-"));
  const store = AttachmentStore.forWorkspace(workspace, dataDirectory);
  const bytes = makePngHeader(320, 180);
  const id = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(store.directory, `${id}.png`), bytes);

  assert.deepEqual(store.register(id), {
    id,
    mimeType: "image/png",
    byteSize: bytes.byteLength,
    width: 320,
    height: 180,
  });
  assert.deepEqual(Buffer.from(store.read(id).bytes), bytes);
  assert.equal(store.has(id), true);
});

test("AttachmentStore rejects forged ids, extensions, dimensions, and unsafe identifiers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "godetx-attachment-invalid-"));
  const store = new AttachmentStore(directory);
  const bytes = makePngHeader(64, 64);
  const id = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(directory, `${"0".repeat(64)}.png`), bytes);
  await assert.rejects(async () => store.read("0".repeat(64)), /does not match its SHA-256/u);

  await writeFile(path.join(directory, `${id}.jpg`), bytes);
  await assert.rejects(async () => store.read(id), /extension does not match/u);
  assert.throws(() => store.register(id.toUpperCase()), /lowercase SHA-256/u);
  assert.throws(() => store.register("../image"), /lowercase SHA-256/u);

  const oversizedDimensions = makePngHeader(4_097, 64);
  const oversizedId = createHash("sha256").update(oversizedDimensions).digest("hex");
  await writeFile(path.join(directory, `${oversizedId}.png`), oversizedDimensions);
  assert.throws(() => store.register(oversizedId), /unsupported dimensions/u);
});

function makePngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}
