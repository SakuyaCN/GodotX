export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export async function* decodeSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const message = parseBlock(block);
        if (message) yield message;
        boundary = buffer.indexOf("\n\n");
      }

      if (done) break;
    }

    if (buffer.trim()) {
      const message = parseBlock(buffer);
      if (message) yield message;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseMessage | undefined {
  if (!block || block.startsWith(":")) return undefined;
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    if (field === "event") event = value;
    if (field === "id") id = value;
  }

  if (data.length === 0) return undefined;
  return {
    data: data.join("\n"),
    ...(event ? { event } : {}),
    ...(id ? { id } : {}),
  };
}
