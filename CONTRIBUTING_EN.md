# Contributing Guide

[中文](CONTRIBUTING.md) | **English**

Thank you for improving GodotX. The project contains both Godot editor code and a Node.js Agent Runtime, so changes must keep their protocol and safety boundaries consistent.

## Filing An Issue

Search existing issues first. A bug report should include the complete Godot version, operating system and architecture, Node.js version, Provider and API mode without the API key, reproduction steps, expected and actual behavior, redacted Godot Output or Runtime errors, and whether the issue reproduces in a minimal project.

Remove local usernames, private project content, keys, billing links, and workspace identifiers from screenshots and logs. Do not open a public issue for security problems; report them privately through the [Security Policy](SECURITY_EN.md).

## Development Environment

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
```

Godot 4.6+ is required. Do not start a second or headless Godot to verify the plugin; use the already-running host editor and verification entries under `tests/godot/`.

## Change Principles

- Keep Provider, Agent Runtime, ToolKernel, and EditorBridge responsibilities separate.
- Reuse existing schemas, events, and tool-registration patterns.
- File and scene changes retain previews, approval, conflict checks, and rollback.
- Do not weaken workspace, command, scene-lease, or game-run ownership boundaries.
- Do not write API keys, Base64 images, or Provider-native events into the session protocol.
- Add English source text and Simplified Chinese translations for user-visible text.
- Use explicit GDScript types where Variant inference is likely to fail.
- Do not commit `node_modules/`, `runtime/dist/`, `.godot/`, bundled Runtime files, or local user data.

## Testing Requirements

| Change | Minimum verification |
| --- | --- |
| Provider or protocol | `npm.cmd run check`, focused Provider/protocol tests, and `npm.cmd test` |
| Agent or ToolKernel | Focused Agent/tool tests and `npm.cmd test` |
| Godot UI | Zero diagnostics in the existing Godot LSP and relevant `tests/godot/` verification |
| EditorBridge or scenes | Lease, revision, Undo/Redo, and multi-scene verification |
| ImageX | Runtime image tests, Godot UI tests, actual output dimensions, and preview |
| Documentation | Relative links, heading hierarchy, commands, and paths |

When Runtime release artifacts change, rebuild them and verify the packaged directory matches `runtime/dist/src`.

## Pull Requests

A pull request should focus on one clear problem, describe user-visible behavior changes, explain architecture or security effects, list tests run, provide before-and-after screenshots for UI changes, and state unverified environments or remaining risks. Avoid unrelated refactors, generated files, and formatting noise.

## Documentation Style

- Keep README pages accessible to first-time visitors and move detailed behavior into `docs/`.
- Commands must run as written; use `<key>` for every secret.
- Say "not currently supported" for unimplemented capability.
- Write the user-facing brand as **GodotX**; use internal compatibility paths and environment-variable names exactly as implemented.
