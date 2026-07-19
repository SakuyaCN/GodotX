<p align="center">
  <picture>
	<source media="(prefers-color-scheme: dark)" srcset="assets/branding/godotx-logo-v2a-dark-ui.png">
	<source media="(prefers-color-scheme: light)" srcset="assets/branding/godotx-logo-v2a.png">
	<img alt="GodotX" src="assets/branding/godotx-logo-v2a.png" width="520">
  </picture>
</p>

<h1 align="center">GodotX</h1>

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong>
</p>

<p align="center">
  An in-editor AI development agent for Godot 4.
  Understand projects, edit scripts and scenes, run game tests, and generate visual assets in one workflow.
</p>

<p align="center">
  <strong>Godot 4.6+</strong> · <strong>Node.js 22+</strong> · <strong>Self-contained Windows packaging</strong> · <strong>Preview 0.1.0</strong>
</p>

> [!IMPORTANT]
> GodotX is currently a functional MVP for trying workflows, validation, and contribution. Commit your work to version control and inspect changes before applying them to important projects.

## Why GodotX

Ordinary chat tools can only see what you manually paste into them. GodotX runs inside the Godot editor and connects models to the real state of your project:

- Read project files, symbols, references, scene trees, node properties, and resource metadata.
- Stream replies, reasoning summaries, tool calls, change logs, and token usage.
- Edit code through transactional patches and open scenes through `EditorUndoRedoManager`.
- Bind each task to its submitted scene lease, so changing editor tabs cannot redirect a model to another scene.
- Start, inspect, and stop games from the existing editor, with optional structured interaction tests.
- Use ImageX to generate UI assets, single images, sprite reskins, and fixed-grid atlas variants.
- Use SkillX to manage reusable project-level or personal instructions.
- Switch among model providers on one shared Runtime and tool system.

## Three Workspaces

| Workspace | Purpose |
| --- | --- |
| **GodotX** | Streaming chat, project discovery, code and scene edits, approvals, game debugging, and automated testing |
| **ImageX** | Single-image generation, AI UI kits, sprite reskins, atlas variants, transparent backgrounds, and visual review |
| **SkillX** | Create, enable, and reuse project or personal skills |

## Core Capabilities

### Project Understanding And Editing

- Incremental semantic indexing for GDScript, shaders, scenes, resources, and `project.godot`.
- Symbol search, reference search, dependency analysis, and automatic context retrieval.
- Workspace-confined file reads, searches, and transactional patches.
- Structured reads and undoable edits for open scenes.
- Godot API queries based on the current editor's `ClassDB`, rather than model-memory guesses.

### Agent Experience

- Streamed text and reasoning summaries.
- Recoverable multi-conversation history, paged timelines, and context compaction.
- Expandable tool details, before-and-after diffs, success and failure states, and follow-to-bottom scrolling.
- `Ask for approval` and `Approve for me` modes.
- English and Simplified Chinese UI that follows the host language without changing project localization.

### Game And Visual Workflows

- Game debugging through the current Godot editor, without launching a second editor or headless instance.
- Optional runtime simulation automation for clicks, InputMap actions, waits, and property assertions.
- Attach images from files, Godot resources, the clipboard, 2D/3D editor viewports, and running games.
- Image annotations with arrows, circles, and rectangles.
- Generated assets are saved under `res://assets/generated/` and never overwrite source assets.

## Architecture Overview

```text
Godot EditorPlugin
	|  versioned WebSocket protocol
	V
Agent Runtime
	|- sessions / turns / context
	|- approval manager
	|- ToolKernel
	|  |- workspace tools
	|  `- EditorBridge tools
	`- ProviderRegistry
	   |- OpenAI-compatible
	   |- DeepSeek
	   `- OpenCode Zen
```

Providers only convert requests and parse streams. Sessions, tools, approvals, scene leases, and workspace safety are all managed by the GodotX Runtime. See the [architecture document](docs/architecture.md) for the detailed design.

## Quick Start

### Requirements

- Godot `4.6` or later.
- Node.js `22` or later.
- The current packaging script targets Windows.

### Run From Source

```powershell
npm.cmd install
npm.cmd run build
```

Then open the repository root in Godot and enable the plugin from **Project > Project Settings > Plugins**. The plugin starts the local Runtime and adds the GodotX, ImageX, and SkillX docks to the editor.

### Install Into An Existing Project

From the repository root, run:

```powershell
package_addon.bat
```

The script builds the Runtime, installs production dependencies, and packages Windows Node.js. Copy the generated `addons/godetx` directory into the target Godot project's `addons/` directory, then enable it in the plugin manager.

`godetx` remains a compatibility-focused technical namespace for the addon directory, existing EditorSettings, sessions, attachments, and project skill paths. The product name and all user-visible text use `GodotX`. New command-line variables use `GODOTX_*`, with the previous `GODETX_*` variables still supported.

### Connect A Model

1. Open GodotX settings in the upper-right corner.
2. Choose a Provider.
3. Enter an API key. The OpenAI-compatible Provider also requires a Base URL.
4. Click Apply and wait for the model list to synchronize.
5. Choose the model, reasoning effort, and approval mode below the composer.

Support matrix:

| Provider | Chat And Tools | Reasoning Summaries | ImageX |
| --- | :---: | :---: | :---: |
| OpenAI-compatible | Yes | Depends on the model and endpoint | Depends on the service image API |
| DeepSeek | Yes | Yes | No |
| OpenCode Zen | Yes | Depends on the model | No |

For installation, configuration, and troubleshooting details, see [Quick Start](docs/en/getting-started.md) and the [Provider Guide](docs/en/providers.md).

## Example Requests

```text
Explain the node structure of the current scene and find the script that controls the pause menu.
```

```text
Change StartButton in the current scene to a TextureButton while preserving its existing signal connections.
```

```text
Inspect the player damage logic, fix duplicate damage application, and run the relevant scene to verify it.
```

```text
Generate a set of transparent-background sci-fi buttons and panels for the current UI.
```

## Safety Boundaries

- The Runtime listens only on a loopback address and uses a freshly generated connection-capability token for each launch.
- File tools are constrained by workspace boundaries, symlink checks, sensitive-path protection, and write allowlists.
- File writes show a diff first and verify the original file hash again before application.
- Scene changes bind to the session, task, scene instance, and Undo history revision.
- Commands do not pass through a shell and use only controlled executables.
- `Approve for me` skips only known approval categories; it does not remove workspace or command safety restrictions.
- API keys are never written to project files, command arguments, session snapshots, or Runtime logs.

See the [Security Policy](SECURITY_EN.md) for the full policy.

## Documentation

| Document | Contents |
| --- | --- |
| [Documentation index](docs/en/README.md) | Entry point for all English documents |
| [Quick Start](docs/en/getting-started.md) | Installation, configuration, basic usage, and troubleshooting |
| [Feature Guide](docs/en/features.md) | GodotX, ImageX, SkillX, and game testing |
| [Provider Guide](docs/en/providers.md) | Provider capabilities, configuration, and extension |
| [Architecture](docs/architecture.md) | Runtime, ToolKernel, EditorBridge, and state boundaries |
| [Protocol](docs/en/protocol.md) | WebSocket events and client methods |
| [Development Guide](docs/en/development.md) | Build, test, package, and acceptance workflow |
| [Contributing Guide](CONTRIBUTING_EN.md) | Issue and Pull Request conventions |
| [Security Policy](SECURITY_EN.md) | Safety boundaries and vulnerability reporting |

## Development And Verification

```powershell
# TypeScript static checks
npm.cmd run check

# Build the Runtime
npm.cmd run build

# Run the complete Runtime test suite
npm.cmd test
```

`npm test` does not launch Godot. The verification scripts under `tests/godot/` must run through an already-running Godot 4.6 editor; neither the Agent nor the plugin launches another Godot process for testing.

## Current Limitations

- This is a feature-preview release, not a complete Codex or OpenCode implementation.
- Closed scenes are still handled through transaction-protected text changes.
- Editable instance overrides, scripted Resource assignment, typed Array writes, and broader Variant support remain planned work.
- DeepSeek and OpenCode Zen currently do not provide ImageX image generation.
- Platforms other than Windows do not yet have a self-contained packaging script.

Read the [Contributing Guide](CONTRIBUTING_EN.md) before contributing. Implementation details and extension boundaries are documented in the [architecture document](docs/architecture.md).
