# Runtime Protocol

[中文](../protocol.md) | **English**

The Godot editor plugin and Node.js Runtime communicate through a versioned WebSocket protocol. Godot never parses Provider-native SSE; Provider events are normalized in the Runtime first.

## Transport

- The Runtime binds only to a loopback address.
- The editor generates a new 256-bit random capability token for every plugin start.
- The raw token is used only for the WebSocket handshake; child-process arguments contain only its SHA-256 digest.
- The editor validates protocol version and workspace through `server.ready`.
- Every Runtime event has a monotonically increasing `seq`.

Current protocol version:

```ts
const PROTOCOL_VERSION = 1;
```

## Client Requests

Requests have a stable ID, method, and parameters:

```json
{
  "id": "request_123",
  "method": "session.list",
  "params": {}
}
```

Responses correlate to the request ID. Long-task progress, streamed content, and tool lifecycle records use independent events.

## Event Envelope

```json
{
  "version": 1,
  "seq": 12,
  "time": "2026-07-19T00:00:00.000Z",
  "type": "message.delta",
  "session_id": "session_...",
  "turn_id": "turn_...",
  "item_id": "item_...",
  "data": { "delta": "Hello" }
}
```

`session_id`, `turn_id`, and `item_id` appear according to event semantics. `data` always contains the Provider-independent payload for that event.

## Event Types

### Service And Sessions

- `server.ready`
- `session.created`
- `turn.started`
- `turn.completed`
- `turn.failed`

### Model Output

- `context.prepared`
- `message.delta`
- `message.completed`
- `reasoning.summary.delta`
- `usage.updated`
- `provider.fallback`

### Tools And Approval

- `tool.started`
- `tool.output.delta`
- `tool.completed`
- `approval.requested`
- `approval.resolved`

### Changes And EditorBridge

- `file_change.proposed`
- `file_change.applied`
- `editor_change.proposed`
- `editor_change.applied`
- `editor.tool.request`

### Image Workflows

- `asset.progress`

## Client Methods

| Group | Methods |
| --- | --- |
| Configuration | `configure`, `providers.list`, `models.list` |
| Images | `image.capabilities`, `image.generate`, `image.edit`, `image.cancel`, `ui_kit.generate` |
| Attachments | `attachment.register`, `attachment.get` |
| Index | `index.status`, `index.rebuild` |
| Skills | `skills.list`, `skills.refresh`, `skills.get`, `skills.save`, `skills.delete`, `skills.set_enabled` |
| Sessions | `session.create`, `session.list`, `session.get`, `session.rename`, `session.delete` |
| Turns | `turn.start`, `turn.cancel` |
| Approval And Editor | `approval.respond`, `editor.tool.respond` |
| Lifecycle | `ping`, `shutdown` |

## Configuration

New clients use Provider-independent configuration:

```json
{
  "provider_id": "openai-compatible",
  "provider_config": {
    "base_url": "https://example.com/v1",
    "api_key": "<secret>",
    "api_mode": "auto"
  },
  "model": "model-id",
  "approval_mode": "ask"
}
```

Protocol v1 still accepts legacy `base_url`, `api_key`, and `api_mode` fields and normalizes them to the OpenAI-compatible Provider. New features must not add Provider-specific top-level fields.

## Starting A Turn

`turn.start` may contain a session ID, the internal prompt received by the Provider, a UI-only `display_prompt`, model and reasoning effort, all scene leases and the primary scene ID, scene paths open at submission time, a runtime-automation snapshot, and up to four image attachment references.

Scene and automation state freeze at submission; later UI changes cannot alter the turn's authority.

## EditorBridge Requests

The Runtime emits:

```json
{
  "type": "editor.tool.request",
  "data": {
    "request_id": "editor_request_...",
    "tool": "scene_get_tree",
    "arguments": {},
    "scene_lease": {
      "scene_id": "scene_...",
      "scene_path": "res://demo/main.tscn",
      "scene_revision": "..."
    }
  }
}
```

Godot must return a result or structured error through `editor.tool.respond` using the same `request_id`. Duplicate, unknown, timed-out, and post-cancellation responses are rejected.

## Compatibility Principles

- New events remain Provider independent.
- Optional fields have explicit default behavior.
- Unknown request methods fail instead of being silently ignored.
- Historical timelines never replay approvals, EditorBridge requests, or game-run capabilities.
- Provider-native chunks, URLs, and secrets never enter the Godot UI protocol.

The type definitions in [`runtime/src/protocol.ts`](../../runtime/src/protocol.ts) are authoritative.

[Back to the documentation index](README.md)
