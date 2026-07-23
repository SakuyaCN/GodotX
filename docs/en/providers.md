# Provider Guide

[中文](../providers.md) | **English**

GodotX's Agent, tools, and editor UI do not depend on a particular model vendor. Providers handle model discovery, capability declaration, request conversion, and streamed-response parsing.

## Built-In Providers

| Provider | Configuration | Transport | Tool Calls | Image Input | ImageX |
| --- | --- | --- | :---: | :---: | :---: |
| OpenAI-compatible | Base URL, API key, API mode | Responses / Chat Completions | Yes | Model dependent | Service dependent |
| Anthropic | Base URL, API key | Native Messages | Yes | Yes | No |
| DeepSeek | API key | Official Chat Completions | Yes | No | No |
| OpenCode Zen | Zen API key | Responses or Chat by model | Yes | Not currently exposed | No |

## OpenAI-Compatible

The default model is `gpt-5.6-sol`. API modes are:

- `auto`: prefer Responses and fall back to Chat Completions when needed.
- `responses`: use the Responses API only.
- `chat_completions`: use the Chat Completions API only.

This Provider is for hosted services or local gateways that implement a compatible interface. Compatibility does not imply every optional feature exists: model lists, reasoning summaries, image input, image generation, and image editing are discovered or controlled independently by declared model capabilities.

Base URL rules:

- Remote addresses must use HTTPS.
- HTTP is permitted only for an exact loopback host.
- URL user information, query parameters, and fragments are rejected.
- API keys are never appended to URLs.

## Anthropic

The Anthropic Provider uses the native Messages API rather than an OpenAI-compatible transport. It supports:

- Paginated `/models` discovery.
- Streamed Messages text and Thinking blocks.
- Multi-turn `tool_use` and `tool_result` calls.
- PNG, JPEG, and WebP chat image input.
- Native Anthropic usage and normalized errors.

A bare host automatically uses `/v1`; a complete API root can also be entered. Remote addresses require HTTPS by default. **Allow insecure HTTP** is an explicit test-only override that sends the API key without encryption and should be used only on an isolated trusted network.

The Anthropic Provider does not implement image generation or editing. Images can be inspected in GodotX chat, but Anthropic is unavailable to ImageX.

## DeepSeek

The built-in adapter uses:

```text
https://api.deepseek.com
```

Its default model is `deepseek-v4-flash`; `deepseek-v4-pro` is also supported. V4 models expose `high` and `max` reasoning effort. The `deepseek-chat` compatibility path disables thinking.

Required reasoning content is preserved through tool-call rounds. DeepSeek explicitly declares no image input, so chat attachments and ImageX are never sent to it accidentally.

## OpenCode Zen

The built-in endpoint is:

```text
https://opencode.ai/zen/v1
```

The model list is the intersection of:

1. Zen's authenticated live `/models` response.
2. Protocol and tool-capability metadata from models.dev.

GodotX shows only routes that the Zen adapter fully supports and that can call tools. The standalone Anthropic Provider now supports native Messages, but Zen's Anthropic routes are not connected yet; those routes and native Gemini models remain filtered.

The Zen API key is sent only to `opencode.ai`; anonymous metadata requests do not include it.

## Model Capabilities

Provider model capabilities control the UI instead of model-name heuristics:

- Available reasoning efforts and defaults.
- Image-input state, MIME types, detail levels, and quantity limits.
- Image-generation and image-editing support.
- Tool-calling and transport type.

As a result, changing the selected model updates the reasoning dropdown and attachment controls.

## Model List Synchronization

After Provider configuration is applied, the Runtime validates the connection and synchronizes models immediately. Normal use is blocked when:

- The API key is invalid.
- Account balance or quota is insufficient.
- The Base URL violates safety constraints.
- The model endpoint does not support the selected API mode.
- Returned models do not expose a tool protocol supported by the Runtime.

Saved local sessions do not depend on the model list and remain browsable during a temporary service outage.

## Error Classification

Provider errors are normalized before reaching the editor:

- Authentication failure.
- Insufficient balance or quota.
- Rate limiting.
- Timeout or network failure.
- Invalid response.
- Provider-internal error.

A structured balance error is shown as a balance issue even if it uses HTTP 401. Raw billing URLs, workspace identifiers, and configuration secrets are neither rendered nor persisted in sessions.

## Secret Persistence

When **Remember secrets** is enabled, secrets are stored as plaintext in Godot user-level `EditorSettings`, outside the repository and isolated by project-path and Provider hashes.

Disable the setting and apply it to delete stored secrets. The currently connected session can still use its in-memory configuration until it reconnects.

## Add a Provider

Implement `ModelProvider` in `runtime/src/provider/types.ts`:

```ts
interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
  getModelCapabilities?(model: string): ProviderModelCapabilities | undefined;
  getImageGenerationCapabilities?(): ImageGenerationCapabilities;
  generateImage?(request: ImageGenerationRequest): Promise<GeneratedImage>;
  streamTurn(request: ProviderRequest): Promise<ProviderTurnResult>;
  dispose?(): void | Promise<void>;
}
```

Then register a `ProviderDefinition` in `runtime/src/provider/registry.ts` with:

- A stable Provider ID.
- A user-visible name.
- A default model.
- A declarative configuration schema.
- A configuration validation function.
- A Provider factory.

Providers must translate native events into unified text deltas, reasoning deltas, tool-call deltas, usage, and final messages. Do not leak vendor-specific fields into the GDScript UI or ToolKernel.

At minimum, a new Provider should cover:

- Configuration validation.
- Model discovery.
- Capability declarations.
- Streamed text and tool events.
- Cancellation and timeouts.
- 401/403, billing, rate-limit, and malformed-response handling.
- Multi-turn tool-call message compatibility.

[Back to the documentation index](README.md)
