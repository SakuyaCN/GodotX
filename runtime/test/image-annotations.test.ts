import assert from "node:assert/strict";
import test from "node:test";
import {
  formatImageAnnotations,
  MAX_IMAGE_ANNOTATIONS,
  parseImageAnnotations,
} from "../src/image-annotations.js";

test("image annotations use one provider-independent normalized shape protocol", () => {
  const annotations = parseImageAnnotations([
    { id: 1, type: "arrow", start: [0, 0.25], end: [1, 0.75] },
    { id: 2, type: "rectangle", start: [0.1, 0.2], end: [0.4, 0.6] },
    { id: 3, type: "circle", start: [0.5, 0.1], end: [0.9, 0.5] },
  ]);

  assert.deepEqual(annotations, [
    { id: 1, type: "arrow", start: [0, 0.25], end: [1, 0.75] },
    { id: 2, type: "rectangle", start: [0.1, 0.2], end: [0.4, 0.6] },
    { id: 3, type: "circle", start: [0.5, 0.1], end: [0.9, 0.5] },
  ]);
  assert.equal(
    formatImageAnnotations(annotations, 2),
    "[Image 2 annotations; normalized x,y from top-left: #1 arrow (0,0.25)->(1,0.75) (target=end); #2 rectangle bbox (0.1,0.2)-(0.4,0.6); #3 circle bbox (0.5,0.1)-(0.9,0.5)]",
  );
});

test("image annotations strictly reject excess, malformed, and unsafe coordinates", () => {
  assert.throws(
    () => parseImageAnnotations(Array.from({ length: MAX_IMAGE_ANNOTATIONS + 1 }, (_, index) => ({
      id: index + 1,
      type: "arrow",
      start: [0, 0],
      end: [1, 1],
    }))),
    /at most 32 annotations/u,
  );
  assert.throws(
    () => parseImageAnnotations([{ id: 1, type: "arrow", start: [0], end: [1, 1] }]),
    /exactly 2 coordinates/u,
  );
  assert.throws(
    () => parseImageAnnotations([{ id: 33, type: "arrow", start: [0, 0], end: [1, 1] }]),
    /integer between 1 and 32/u,
  );
  assert.throws(
    () => parseImageAnnotations([{ id: 1, type: "arrow", start: [Number.NaN, 0], end: [1, 1] }]),
    /finite numbers between 0 and 1/u,
  );
  assert.throws(
    () => parseImageAnnotations([{ id: 1, type: "arrow", start: [0, 0], end: [1.01, 1] }]),
    /finite numbers between 0 and 1/u,
  );
  assert.throws(
    () => parseImageAnnotations([
      { id: 1, type: "arrow", start: [0, 0], end: [1, 1] },
      { id: 1, type: "circle", start: [0, 0], end: [1, 1] },
    ]),
    /id is duplicated/u,
  );
  assert.throws(
    () => parseImageAnnotations([{
      id: 1,
      type: "rectangle",
      start: [0, 0],
      end: [1, 1],
      label: "not part of the protocol",
    }]),
    /unsupported field: label/u,
  );
  assert.throws(
    () => parseImageAnnotations([{ id: 1, type: "circle", start: [0.5, 0], end: [0.5, 1] }]),
    /non-zero bounding box/u,
  );
});
