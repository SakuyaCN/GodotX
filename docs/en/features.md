# Feature Guide

[中文](../features.md) | **English**

GodotX separates conversational Agent work, visual generation, and reusable skills into three workspaces. They share Provider configuration and project boundaries while serving different workflows.

## GodotX Workspace

### Streaming Conversation

- Streamed replies and reasoning summaries.
- Markdown headings, lists, quotes, code blocks, links, and bounded tables.
- Distinct visual hierarchy for user, assistant, reasoning, and tool records.
- Expandable tool logs with arguments, output, and file-change details.
- Automatic scrolling only while the user remains at the bottom of the timeline.

### Conversation Management

- Create, switch, rename, and delete conversations.
- Local persistence isolated by project.
- Restore completed timelines and the last selection after an editor restart.
- Page through long histories.
- Provider-independent context compaction that preserves tool calls and their results as pairs.

Session snapshots do not store Provider configuration or API keys. A task that was running during a crash recovers as interrupted; approvals and editor requests are not replayed.

### Project Semantic Index

The incremental index covers `.gd`, `.gdshader`, `.tscn`, `.tres`, and `project.godot`. It provides symbol search, reference search, and dependency graphs. For relevant local tasks, the Runtime prepares a bounded context pack before the first model request; greetings and general questions skip retrieval.

### Godot API Query

`godot_api_query` reads the current editor's `ClassDB` and global script-class registry. It can query inheritance, properties and types, methods and arguments, signals, enums, and constants. Models therefore use the API from the installed Godot version rather than relying on training-data memory.

### File Editing

Runtime tools include file listing, reading, text search, transactional patches, and controlled command execution. File changes follow this lifecycle:

```text
Prepare an in-memory change
  -> show unified diff
  -> request approval
  -> verify the base hash again
  -> atomically write or roll back
```

An assistant's written claim is not evidence of a change. Only an applied tool result enters the timeline as a successful modification.

### Live Scene Reads And Edits

EditorBridge can read unsaved editor state: scene trees, current selection, node properties, and project-resource metadata. A task can access only scenes open when it was submitted. It is rejected if a scene closes, its root instance changes, or its revision no longer matches.

Structured edits can add nodes, set properties, rename, remove, duplicate, reparent, and instantiate `PackedScene`. Each batch becomes one independent Undo action per scene and remains unsaved. Multi-scene tasks create a separate Undo record for every scene.

### Game Debugging And Simulation

GodotX uses the current editor to start the project main scene, current scene, or a specified scene; inspect debugger lifecycle, structured errors, and bounded output; and stop the exact owned `run_id`. A manually started game is never adopted or stopped.

Runtime simulation automation is disabled by default and enabled per project in settings. It can wait a bounded number of frames, click a Control in the current scene, send InputMap actions, and assert node-property equality or containment. The composite `game_test` tool is preferred: it starts the run, waits for the probe, executes the plan, collects results, and cleans up locally with fewer model turns. Its setting is independent from approval mode.

### Public Web Tools

`web_search` and `web_open` retrieve current public information. Search prefers public MCP and falls back to multiple search sources when the service is unavailable or free quota is exhausted. Web content is always untrusted external input; private addresses, unsafe redirects, credential URLs, non-text responses, and oversized bodies are rejected.

## ImageX Workspace

### Single Image

Generate one image from a prompt with model, size, quality, background, and format controls. The requested Provider canvas is separate from the final custom dimensions; the Runtime creates a locally resized PNG with the exact target size.

### AI UI Kit

1. Freeze the current Control tree and an optional 2D viewport.
2. Ask the active chat model for a strict asset plan.
3. Generate up to four visually consistent assets in sequence.
4. Optionally perform one visual review.

To control cost, a failed review does not trigger unbounded automatic regeneration.

### Sprite Reskin And Atlas Variant

Sprite reskin accepts a 16 to 2048 pixel project texture, preserves the source canvas dimensions, writes a new transparent PNG, and never overwrites the source. Atlas variants accept a fixed-grid atlas whose rows and columns divide the source exactly, support up to 256 frames, and preserve the original grid and canvas geometry.

### Transparent Background

The Runtime first requests native transparency. If a Provider explicitly rejects it or returns an opaque image, it retries once with a green background, removes only green regions connected to the canvas edge, and suppresses green spill.

### Visual Input And Annotation

Attachments are stored in GodotX user data. WebSocket messages contain attachment IDs and metadata, not Base64 image payloads. Each turn supports at most four images, with arrows, circles, and rectangle annotations available on each image.

## SkillX Workspace

Skills are bounded `SKILL.md` instruction documents:

- Built-in skills ship with the plugin.
- Personal skills live in Godot user data.
- Project skills live under `.godetx/skills/<name>/SKILL.md` and may be committed to version control.

Skills with the same name shadow in the order project, personal, then built-in. Select one explicitly with `$skill-name`, or match it locally by trigger phrases and description. At most three skills load for a task.

Skills can suggest only tools already allowed by current task policy; they cannot expand workspace, approval, command, scene-lease, or automation permissions.

## Localization

The plugin provides English and Simplified Chinese. It uses the host operating-system language and falls back to English for unsupported languages. This affects only the plugin and does not change the project's own localization settings.

[Back to the documentation index](README.md)
