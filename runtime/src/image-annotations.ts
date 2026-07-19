export const MAX_IMAGE_ANNOTATIONS = 32;

export type ImageAnnotationType = "arrow" | "rectangle" | "circle";
export type NormalizedImagePoint = [number, number];

export interface ImageAnnotation {
  id: number;
  type: ImageAnnotationType;
  start: NormalizedImagePoint;
  end: NormalizedImagePoint;
}

export function parseImageAnnotations(value: unknown, field = "annotations"): ImageAnnotation[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > MAX_IMAGE_ANNOTATIONS) {
    throw new Error(`${field} may contain at most ${MAX_IMAGE_ANNOTATIONS} annotations`);
  }

  const ids = new Set<number>();
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    if (!isRecord(entry)) throw new Error(`${itemField} must be an object`);
    const allowedKeys = new Set(["id", "type", "start", "end"]);
    const unknownKey = Object.keys(entry).find((key) => !allowedKeys.has(key));
    if (unknownKey) throw new Error(`${itemField} contains unsupported field: ${unknownKey}`);
    if (Object.keys(entry).length !== allowedKeys.size) {
      throw new Error(`${itemField} requires id, type, start, and end`);
    }
    if (
      !Number.isSafeInteger(entry.id) ||
      (entry.id as number) < 1 ||
      (entry.id as number) > MAX_IMAGE_ANNOTATIONS
    ) {
      throw new Error(`${itemField}.id must be an integer between 1 and ${MAX_IMAGE_ANNOTATIONS}`);
    }
    const id = entry.id as number;
    if (ids.has(id)) throw new Error(`${itemField}.id is duplicated`);
    ids.add(id);
    if (entry.type !== "arrow" && entry.type !== "rectangle" && entry.type !== "circle") {
      throw new Error(`${itemField}.type must be arrow, rectangle, or circle`);
    }
    const start = parseNormalizedPoint(entry.start, `${itemField}.start`);
    const end = parseNormalizedPoint(entry.end, `${itemField}.end`);
    if (start[0] === end[0] && start[1] === end[1]) {
      throw new Error(`${itemField}.start and ${itemField}.end must identify distinct points`);
    }
    if (entry.type !== "arrow" && (start[0] === end[0] || start[1] === end[1])) {
      throw new Error(`${itemField} must have a non-zero bounding box`);
    }
    return { id, type: entry.type, start, end };
  });
}

export function formatImageAnnotations(
  annotations: readonly ImageAnnotation[],
  imageNumber: number,
): string {
  if (annotations.length === 0) return "";
  const descriptions = annotations.map((annotation) => {
    const start = formatPoint(annotation.start);
    const end = formatPoint(annotation.end);
    if (annotation.type === "arrow") {
      return `#${annotation.id} arrow ${start}->${end} (target=end)`;
    }
    return `#${annotation.id} ${annotation.type} bbox ${start}-${end}`;
  });
  return `[Image ${imageNumber} annotations; normalized x,y from top-left: ${descriptions.join("; ")}]`;
}

function parseNormalizedPoint(value: unknown, field: string): NormalizedImagePoint {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${field} must contain exactly 2 coordinates`);
  }
  const [x, y] = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    throw new Error(`${field} coordinates must be finite numbers between 0 and 1`);
  }
  return [x, y];
}

function formatPoint(point: readonly [number, number]): string {
  return `(${formatCoordinate(point[0])},${formatCoordinate(point[1])})`;
}

function formatCoordinate(value: number): string {
  return String(Number(value.toFixed(6)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
