# Development Guide

[中文](../development.md) | **English**

This guide covers building the Runtime, changing the Godot plugin, running tests, and producing a release package.

## Repository Layout

```text
addons/godetx/       Godot EditorPlugin, UI, EditorBridge, and built-in assets
runtime/src/         TypeScript Agent Runtime
runtime/test/        Runtime unit and integration tests
runtime/scripts/     Live smoke scripts
tests/godot/         Godot-side verification scripts
docs/                User and architecture documentation
demo/                Manual acceptance scene
package_addon.bat    Self-contained Windows addon packaging
```

## Install Dependencies

Node.js 22+ is required:

```powershell
npm.cmd install
```

`postinstall` creates `.gdignore` in `node_modules/` so Godot does not scan the dependency directory.

## Common Commands

```powershell
# Static type checks
npm.cmd run check

# Build the Runtime
npm.cmd run build

# Build and run the complete Runtime test suite
npm.cmd test
```

`npm.cmd test` runs TypeScript and Node tests only; it does not start Godot.

## Live Smoke Tests

Never put secrets in the repository. Use temporary environment variables:

```powershell
$env:GODOTX_API_KEY = "<key>"
$env:GODOTX_BASE_URL = "https://example.com/v1"
$env:GODOTX_MODEL = "model-id"
$env:GODOTX_REASONING_EFFORT = "low"

npm.cmd run smoke:models
npm.cmd run smoke:hi
npm.cmd run smoke:agent
```

Legacy `GODETX_*` variables continue to work. Smoke scripts must never print or persist an API key.

## Godot-Side Verification

`tests/godot/` covers attachment storage, automatic approval, chat UI and localization, EditorBridge, game debugging, live scene mutations, image annotations, and the runtime-automation driver.

Run these scripts through an already-running Godot 4.6 editor or an existing project verification entry point. Agent tasks and plugin tests must not start a second Godot or headless editor process.

After changing an `@tool` script:

1. Wait for the existing Godot LSP to parse it.
2. Confirm the relevant scripts have zero diagnostics.
3. Disable and re-enable the plugin.
4. Clear the Output panel and confirm there are no new preload, parse, or hot-reload errors.

## Runtime And Bundled Artifact Synchronization

Development checkouts can start from `runtime/dist`. Release packages use:

```text
addons/godetx/runtime/dist/src/
```

After changing the Runtime:

1. Run `npm.cmd run check`.
2. Run `npm.cmd test`.
3. Run `npm.cmd run build`.
4. Confirm the packaged copy matches the current `runtime/dist/src`.

Do not hand-edit compiled JavaScript as a source fix.

## Self-Contained Windows Packaging

```powershell
package_addon.bat
```

The script builds the TypeScript Runtime, rebuilds the bundled Runtime directory, installs production dependencies, copies or reuses Node.js for the active Windows architecture, and imports `server.js` to verify the artifact.

To select Node.js explicitly:

```powershell
$env:GODOTX_NODE_BIN = "D:\Tools\node.exe"
package_addon.bat
```

Disable the plugin in Godot before packaging so an active `node.exe` or Runtime file is not locked.

## Manual Acceptance

### Sessions And Localization

- Chinese hosts show Simplified Chinese; English and unknown locales fall back to English.
- The project's own locale remains unchanged.
- Creating, renaming, switching, and deleting conversations works.
- Reloading the plugin restores timeline, reasoning, tool records, and usage.
- A task interrupted by reload is shown as interrupted and does not restore old approvals.

### Scene Leases

1. Open `demo/main.tscn`.
2. Submit a task that duplicates a node or changes a property.
3. Switch to another scene while the model works.
4. Confirm that the original submitted scene is still modified.
5. Confirm exactly one Undo action is created for that scene.
6. Verify Undo and Redo without automatic saving.

### Game Debugging, Automation, And ImageX

- Start a main or specified scene, inspect debugger lifecycle, probe status, and bounded output, then stop it with the exact `run_id`.
- Confirm a manually started game is never adopted.
- Enable runtime automation and execute clicks, InputMap actions, and property assertions with one `game_test`; disable it and confirm new automation requests are rejected.
- Confirm single images appear in `res://assets/generated/`; sprite reskins and atlas variants preserve source size and never overwrite their source.
- Confirm a failure is not immediately replaced by a Ready status and unsupported image Providers disable their controls.

## Code Boundaries

- Provider adapters must not execute tools or manipulate Godot directly.
- ToolKernel must not depend on a Provider event format.
- EditorBridge calls run on the editor main thread and keep results bounded.
- Scene writes validate leases, revisions, and one-time grants.
- External web content and project source text are untrusted input.
- New persisted fields require a version and size limits.

Read the [Contributing Guide](../../CONTRIBUTING_EN.md) before contributing.

[Back to the documentation index](README.md)
