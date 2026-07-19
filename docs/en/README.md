# GodotX Documentation

[中文](../README.md) | **English**

This is the English documentation entry point for GodotX. New users should start with **Quick Start**, then read the **Feature Guide** and **Provider Guide**. Contributors should continue with Architecture, Protocol, and Development.

## User Documentation

| Document | Use it for |
| --- | --- |
| [Quick Start](getting-started.md) | Installation, setup, first tasks, and troubleshooting |
| [Feature Guide](features.md) | GodotX, ImageX, SkillX, and game testing workflows |
| [Provider Guide](providers.md) | Choosing, configuring, and extending model providers |
| [Security Policy](../../SECURITY_EN.md) | Protected operations and vulnerability reporting |

## Developer Documentation

| Document | Contents |
| --- | --- |
| [Architecture](../architecture.md) | Runtime, ToolKernel, EditorBridge, sessions, and safety boundaries |
| [Protocol](protocol.md) | WebSocket protocol between Godot and the Runtime |
| [Development Guide](development.md) | Build, test, package, and editor acceptance workflow |
| [Contributing Guide](../../CONTRIBUTING_EN.md) | Issues, code changes, and pull requests |

## Suggested Paths

### I want to use the plugin

1. Read [Quick Start](getting-started.md) and install the plugin.
2. Select a model service in the [Provider Guide](providers.md).
3. Read the [Feature Guide](features.md) for code editing, scene editing, game testing, or ImageX workflows.

### I want to add a Provider

1. Read the extension section in the [Provider Guide](providers.md).
2. Read Runtime ownership and Provider compatibility in the [Architecture](../architecture.md).
3. Run the checks and tests in the [Development Guide](development.md).

### I want to add a Godot editor tool

1. Read the EditorBridge lifecycle in the [Architecture](../architecture.md).
2. Keep tool schemas, Runtime routing, and Godot main-thread execution separate.
3. Add matching Runtime and `tests/godot/` verification.

## Terms

| Term | Meaning |
| --- | --- |
| Runtime | Separate Node.js process that owns the Agent loop, Providers, sessions, and Runtime tools |
| Provider | Adapter that converts the shared request format into a model-service protocol |
| ToolKernel | Provider-independent tool registration, routing, and execution layer |
| EditorBridge | Bridge for reading or modifying live editor state on Godot's editor thread |
| Scene lease | Scene instance, path, and Undo revision frozen when a task is submitted |
| ImageX | Image generation and editing workspace |
| SkillX | Reusable model-instruction workspace |

[Back to the project home](../../README_EN.md)
