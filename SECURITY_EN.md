# Security Policy

[中文](SECURITY.md) | **English**

GodotX can read and modify projects, execute controlled commands, and run game code. Security issues can directly affect a developer workspace, so do not disclose exploitable details in public issues.

## Supported Versions

The project is in a `0.x` feature-preview stage. Security fixes are guaranteed only for the latest main branch and latest release; older preview versions may not receive separate backports.

## Reporting A Vulnerability

Use the repository's **Security > Report a vulnerability** flow to create a private report. Include the affected version or commit, environment, issue type and impact, minimal reproduction or proof of concept, required prerequisites, and suggested mitigation.

Do not include real API keys, private project source, or unredacted user directories. If private GitHub vulnerability reports are unavailable, contact the repository maintainer to enable them instead of opening a public issue.

## Primary Security Boundaries

### Local Transport

- The Runtime listens only on loopback.
- Every plugin start uses a new random capability token.
- WebSocket upgrade validates that capability token.
- The editor validates the Runtime workspace and protocol version.
- An idle Runtime exits after a grace period when the editor disconnects.

### Provider Connections

- Remote Base URLs must use HTTPS.
- HTTP is accepted only for an exact local loopback address.
- URL user information, query parameters, and fragments are rejected.
- API keys never enter process arguments, project files, session snapshots, or logs.
- Provider errors are classified and redacted before display.

When **Remember secrets** is enabled, secrets are stored as plaintext in Godot user-level `EditorSettings` outside the repository and isolated by project and Provider hashes. Do not enable it on shared accounts or untrusted machines.

### Workspace And Scene Editing

- Absolute paths, `..`, external symlinks, and boundary escapes are rejected.
- `.git`, `.godot`, `.godetx`, `.env`, and common private-key files are protected.
- Dependencies, caches, virtual environments, and temporary directories are skipped.
- File writes revalidate the SHA-256 base state and roll back an incomplete transaction.
- EditorBridge accesses only open scenes frozen when the task was submitted; leases bind session, task, scene instance, path, and Undo revision.
- Scene writes require dedicated approval and a one-time grant, then form undoable unsaved editor actions.

### Commands, Games, Images, And Web

- Commands do not pass through a shell and use only allowlisted executables.
- Directly starting `godot`, `godot4`, or a Godot executable path is rejected.
- `Approve for me` does not remove command allowlists or workspace boundaries.
- Game starts are a separate approval category; only the owned, handshaken `run_id` can be stopped.
- Runtime automation is off by default and supports only bounded waits, Control clicks, InputMap actions, and property assertions. It cannot invoke arbitrary methods, traverse outside the current scene, or edit scripts.
- Attachments and image responses have count, size, format, and decoded-memory limits. Base64 images are neither sent over WebSocket nor stored in session JSON.
- Web tools reject private addresses, unsafe redirects, credential URLs, non-text responses, and oversized bodies. Project source, image annotations, and web content are untrusted model input.

## Not Usually A Vulnerability

- Known approval categories automatically pass after a user enables `Approve for me`.
- A user-approved model produces poor output or incorrect advice.
- Existing side effects from running the project's own code.
- A user pastes an API key into chat content and heuristic redaction does not recognize every format.
- A local administrator or the same user account reads intentionally persisted secrets from Godot `EditorSettings`.

Report the behavior privately if it bypasses an explicit workspace, approval, command, lease, or credential boundary.
