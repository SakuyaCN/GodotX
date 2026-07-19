# Quick Start

[中文](../getting-started.md) | **English**

This guide explains how to run GodotX from source, package it for an existing project, connect a model, and complete the first task.

## Requirements

- Godot `4.6` or later.
- Node.js `22` or later.
- Windows PowerShell or Command Prompt.
- An API key for a supported Provider.

> [!NOTE]
> Development mode uses the system Node.js installation. `package_addon.bat` can package Windows Node.js and production dependencies into the addon directory.

## Run From Source

From the repository root:

```powershell
npm.cmd install
npm.cmd run build
```

Then:

1. Open the repository root with Godot 4.6+.
2. Open **Project > Project Settings > Plugins**.
3. Enable the GodotX plugin.
4. Find the GodotX, ImageX, and SkillX docks on the right side of the editor.

Development mode prefers `runtime/dist` and the system `node`. If Godot cannot find Node.js, set a path before starting Godot:

```powershell
$env:GODOTX_NODE_BIN = "C:\Program Files\nodejs\node.exe"
```

The legacy `GODETX_NODE_BIN` variable remains supported for existing installations.

## Install Into An Existing Godot Project

### Use the Self-Contained Windows Package

From the repository root:

```powershell
package_addon.bat
```

After it succeeds, copy the complete `addons/godetx` directory into the target project's `addons/` directory. Do not copy only the GDScript files: the self-contained package also includes:

- The compiled Runtime.
- Production Node.js dependencies.
- A `node.exe` matching the current Windows architecture.
- Node.js version and license information.

Enable the plugin in the target project's plugin manager after copying it.

### Select the Node.js Used for Packaging

```powershell
$env:GODOTX_NODE_BIN = "D:\Tools\node-v22\node.exe"
package_addon.bat
```

The packaging script currently accepts Windows Node.js only.

## Configure a Provider

1. Click the GodotX settings button in the upper-right corner.
2. Select a service in the Provider dropdown.
3. Fill in its connection fields.
4. Enable **Remember secrets** if needed.
5. Click Apply.
6. Wait for the model list, then select the model and reasoning effort.

### OpenAI-Compatible

Required fields:

- Base URL.
- API key.
- API mode: Auto, Responses, or Chat Completions.

Remote Base URLs must use HTTPS. HTTP is allowed only for an exact local loopback address. Do not put usernames, passwords, query parameters, or fragments in the URL.

### DeepSeek

Only an API key is required. The adapter fixes the endpoint and Chat Completions transport. Its built-in model capabilities currently do not support image input or ImageX.

### OpenCode Zen

Only a Zen API key is required. GodotX intersects Zen's live model list with protocol metadata and shows only models whose tool-calling transports are fully supported by the Runtime.

See the [Provider Guide](providers.md) for the detailed differences.

## First Conversation

Send this in the composer:

```text
Inspect the current project structure. Tell me the main scene and the primary scripts without modifying files.
```

Confirm that:

- The response appears as a stream.
- Tool calls appear as expandable logs.
- The project-context card lists the files actually read.
- Completion shows elapsed time plus token and context information.

## First Change

Start with a small task:

```text
Fix an obvious type-inference error in the current script. Show the diff before applying it.
```

`Ask for approval` opens a confirmation before file edits, scene edits, commands, and game starts. `Approve for me` accepts known categories automatically, but these boundaries always remain enforced:

- Workspace confinement.
- Protected paths.
- File base hashes and stale-patch checks.
- Command executable allowlists.
- Scene leases, revisions, and game-run ownership.

## Scene Tasks

GodotX freezes leases for scenes that were open when the task was submitted. Switching tabs while the model works cannot change the target.

State the target clearly:

```text
Duplicate HUD/HealthBar in the current scene as ShieldBar. Keep its layout and do not save the scene.
```

Successful live-scene changes enter that scene's Undo history but are not saved automatically. Inspect them in the editor and save when ready.

## Image Attachments

The chat composer supports:

- Choosing an image from the file system.
- Pasting an image from the clipboard.
- Dragging a texture or previewable resource from Godot's FileSystem panel.
- Capturing the current 2D or 3D editor viewport.
- Capturing a game frame from a GodotX-owned game run.

Click an attachment preview to add arrows, circles, or rectangles. Annotations are sent with the image as structured information.

## ImageX Output

ImageX results are written to:

```text
res://assets/generated/
```

Sprite reskins and atlas variants create new PNGs and do not overwrite source textures. On success, the UI returns to the result preview; a failure remains visible until the next operation begins.

## Troubleshooting

### The Plugin Says the Runtime Is Not Connected

1. Confirm the Node.js major version is at least 22.
2. Run `npm.cmd run build`.
3. Confirm that `runtime/dist/src/server.js` exists.
4. Set `GODOTX_NODE_BIN` when necessary.
5. Disable and re-enable the plugin.

### Invalid API Key or Insufficient Balance

GodotX distinguishes authentication failures from insufficient balance and removes billing URLs, workspace identifiers, and secrets from displayed errors. If model synchronization fails, first check the Provider, endpoint, account balance, and key permissions.

### Old Errors After Editing Plugin Scripts

Godot tool-script hot reload can retain old plugin instances. After changing `res://addons/godetx/`, disable and re-enable the plugin, then clear the Output panel before inspecting fresh logs. The plugin intentionally does not force Save All from an executing `@tool` callback.

### A Game Test Refuses to Start Another Godot

This is intentional. GodotX game debugging and simulation automation run only through the already-running host editor.

### ImageX Is Available but Image Editing Is Not

Image generation, image input, and image editing are independent capabilities. ImageX disables related tasks when the Provider or model does not declare the needed capability. DeepSeek and OpenCode Zen currently do not expose ImageX.

[Back to the documentation index](README.md)
