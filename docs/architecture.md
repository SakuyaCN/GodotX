# GodotX architecture

**English** | [中文文档索引](README.md)

This document is the implementation-level architecture reference for contributors. For installation and user workflows, start with the [English documentation index](en/README.md).

## Runtime ownership

The runtime, rather than any model provider, owns:

1. Session history and turn cancellation.
2. The iterative model -> tool -> model loop.
3. Tool schemas and execution.
4. File previews, approvals, conflict checks, writes, and rollback.
5. Provider-neutral events sent to the editor.

`AgentRuntime` depends on the `ToolKernel` interface rather than a concrete Provider or a fixed tool switch. The default kernel registers Runtime-owned file/command tools and, when an `EditorToolClient` is available, Godot-owned live read tools plus the approved live-scene writer. This keeps Provider adapters limited to stream translation while allowing future tool executors to be added without changing the Agent loop.

The provider owns only request translation and stream decoding. This keeps future providers from leaking their event formats into GDScript.

`ProviderRegistry` owns adapter discovery, public configuration schemas, provider-specific validation, construction, and required default-model metadata. Configuration uses `provider_id` plus an opaque `provider_config`; the protocol v1 legacy OpenAI-compatible fields are normalized at the server boundary. `AgentRuntime` never interprets provider connection settings.

## Durable conversations and context

The Runtime owns a Provider-neutral `AgentMessage` history and a separate read-only UI timeline. Each workspace stores independent versioned session snapshots under Godot's user-data directory; standalone Runtime launches fall back to the workspace `.godot` cache. A snapshot contains no Provider configuration or API key. It stores only the project-specific system-prompt suffix, bounded model messages, user-visible turn prompts, completed assistant/reasoning text, bounded tool records, terminal status, context statistics, and token usage. Revision-checked same-directory temporary writes, `fsync`, and atomic replacement protect checkpoints. In-process turn ownership and optimistic snapshot revisions prevent two editor connections from running or overwriting the same conversation and prevent stale state from recreating a deleted file. Corrupt, oversized, or unreadable files are isolated without hiding healthy sessions and are returned as safe diagnostics to the Dock.

The editor uses `session.list/get/rename/delete` to restore and manage histories. `turn.start.display_prompt` is stored for presentation while the context-wrapped `prompt` remains internal model input. Restored approvals, EditorBridge requests, scene revisions, and game-run capabilities are never replayed; historical tool records are display-only. A `running` turn left by a crash becomes `interrupted`: complete tool outputs are retained, missing outputs receive protocol-valid local interruption results, and the next Provider call is told to inspect current project state. Live events carry `session_id`, and the Dock renders them only for the selected active conversation. The Dock pages restored histories at bounded turn/entry counts so every older turn remains reachable without constructing thousands of controls at once.

Before each Provider call, the Runtime prepares a bounded context without changing Provider adapters. It keeps the current and most recent complete user turns, preserves every retained assistant tool call with its matching tool output, compacts older large tool results, and replaces omitted turns with a bounded local historical record. The latest user instruction is protected from truncation: wrapped editor metadata is compacted first, and a request that still cannot fit is rejected before contacting the Provider instead of being partially executed. Provider tool-call batches, identifiers, and JSON arguments are bounded before tools run; persisted call/output pairs are normalized together. The default live request budget is 160,000 characters and the persisted model history budget is 400,000 characters. These are deterministic character-pressure controls, not guessed model token windows. Actual Provider input/output/total token usage and context/history character counts are accumulated separately and displayed per turn.

For a relevant local-project request, `ProjectContextEngine` also prepares one immutable retrieval pack after `turn.started` and before the first Provider request. It extracts only the user-authored request, combines frozen editor targets with explicit paths and deterministic symbol/reference/dependency matches, then reads bounded snippets from workspace-confined saved files. At most six sources and 8,000 prompt characters are included. Common credential shapes are redacted, source text is explicitly marked as untrusted data, and the prompt warns that unsaved EditorBridge state may be newer than serialized scenes. The pack is reused unchanged across all model/tool steps, so a watcher refresh or tab switch cannot retarget the turn. General greetings and planning questions do not pay this context cost. Its `context.prepared` timeline entry stores the bounded retrieval explanation and supports source navigation after session restoration.

## Per-turn tool routing

Before the first Provider request, `AgentRuntime` passes the user-authored portion of the prompt and the registered `ToolSchema` list to a deterministic, Provider-independent router. The router deliberately ignores the `<godot_editor_context>` wrapper so an open scene or current script does not make every task look like a scene edit. It combines code, live-scene, closed-scene, game, web, and read capabilities when several intents are explicit, preserves ToolRegistry order, and freezes the resulting definitions for the model/tool loop. Short continuation commands and otherwise ambiguous action requests use the current policy's full set instead of guessing.

Routing reduces request size without moving authority into the classifier. The ToolKernel still validates every call and retains all workspace, approval, scene-lease, automation, and run-ownership checks. `runtime_automation_enabled=false`, explicit read-only language, and explicit no-game language remove the corresponding tools from both the narrow route and its full fallback. If a Provider requests a registered but unadvertised tool, the Runtime does not execute it or request approval; it returns a controlled routing result and expands only the next model step to the policy-allowed full schemas. A disabled or unknown tool never triggers expansion.

`turn.started` reports the selected profile, names, count, routed schema bytes, policy-full bytes, and selected SkillX metadata for diagnostics; these fields do not affect Provider adapters or the Godot protocol version.

## Godot intelligence and SkillX

`ProjectIndex` is a Runtime-owned, Provider-neutral navigation service. It incrementally scans bounded `.gd`, `.gdshader`, `.tscn`, `.tres`, and `project.godot` files, extracting symbols, exact identifier/resource/node references, and dependency edges. It skips symlinks, GodotX's own addon, caches, dependencies, and build output; a disposable versioned snapshot is stored under `.godot/godetx`. A recursive watcher marks the index dirty where the platform supports it. Otherwise semantic queries perform an incremental metadata scan before serving results. The three ToolKernel reads are `project_symbol_search`, `project_find_references`, and `project_dependency_graph`; results are navigation metadata, so the Agent still reads relevant source before editing.

`ProjectContextEngine` is a consumer of `ProjectIndex`, not a Provider feature and not a ToolKernel authority. Its ranker prioritizes explicit paths, the frozen current script and primary scene, other open scenes, exact or prefix symbol matches, exact references, and one-hop resource relationships. It uses a small bilingual Godot-domain term expansion for Chinese requests but no embedding service or additional model call. The retrieved outline and snippets help the first model step start with project-specific semantics; the Agent must still use live editor tools for unsaved state and normal read tools before a mutation when exact source is required.

`godot_api_query` is an EditorBridge read that runs on the existing editor thread and is not scene-bound. It queries the host's live `ClassDB` for engine classes, inheritance, properties, methods, signals, enums, and constants, plus `ProjectSettings.get_global_class_list()` for registered script classes. This avoids freezing API knowledge into the Runtime or a Provider adapter. Script member bodies remain the semantic index's responsibility. Query sizes and result counts are bounded, and no engine object is instantiated.

`SkillRegistry` discovers bounded `SKILL.md` documents from the bundled addon, Godot user data, and `.godetx/skills`. Project scope shadows personal scope, which shadows built-ins with the same name. Selection is deterministic and local: explicit `$skill-name`, exact trigger phrases, and descriptive keyword overlap choose at most three skills with a combined prompt budget. Capability hints can add only schemas already registered and permitted for the current turn; the ToolKernel, approval manager, workspace, scene leases, automation opt-in, and command allowlist remain authoritative. Skill files and roots must resolve inside their configured boundaries and cannot be symbolic links. The SkillX dock manages project/personal documents and enabled state while built-in instructions remain read-only.

## Adaptive agent loop

The GodotX client omits the legacy `max_steps` configuration field. Agent turns therefore use a progress-driven loop instead of a small fixed model-step ceiling. Each new successful combination of canonical tool arguments and output renews progress, so a large task may continue beyond sixteen model requests. Call IDs and JSON object key order do not create false novelty. Cached replays, unavailable tools, failed results, and previously observed successful outcomes do not renew progress.

The Runtime stops a loop when the same normalized tool batch has produced the same outputs twice and the Provider requests it a third time, or after eight consecutive tool-bearing model steps produce no novel successful result. After four stalled steps, the next Provider prompt explicitly requests a changed strategy, batching, or a clear finish. Independent high emergency fuses remain for defective Providers; they are not normal task budgets. A legacy client may still send `max_steps` to request the previous fixed behavior.

Loop fingerprints are bounded canonical SHA-256 records rather than retained raw tool payloads. Active in-memory conversation state remains available to the running turn, while the crash-recovery snapshot stores a separately compacted message copy. Long-turn timeline persistence keeps the latest 512 entries so the most recent result is not discarded when an adaptive task exceeds the former entry bound.

## File transaction lifecycle

```text
model function call
  -> tool.started
  -> validate arguments and workspace path
  -> prepare all changes in memory
  -> file_change.proposed (unified diff)
  -> approval.requested
  -> approval.resolved
  -> verify every base hash
  -> apply all changes or roll back
  -> file_change.applied
  -> tool.completed
  -> tool result returned to the model
```

The model never receives direct filesystem authority. A textual claim that a file was modified is not treated as success.

## Local transport security

The editor generates a new random capability for every plugin launch. The raw capability is used only in the local WebSocket handshake; the runtime receives its SHA-256 digest in the process arguments and verifies the handshake before accepting a connection. The service also validates approval/configuration values at runtime rather than trusting TypeScript types.

The server exits after an idle grace period when its editor connection disappears, preventing a crashed editor from leaving an unauthenticated or permanently blocking sidecar behind.

## EditorBridge lifecycle

The EditorBridge is implemented for live editor state, including unsaved scene changes:

```text
model function call
  -> ToolKernel validates bounded arguments
  -> editor.tool.request (request_id + tool + arguments + selected scene lease)
  -> Godot Dock validates the turn-bound host lease
  -> Godot Dock executes EditorBridge on the editor main thread against that captured root
  -> scene tree / selection / node properties / resource metadata, or an undoable scene action
  -> editor.tool.respond (same request_id)
  -> tool.completed
  -> result returned to the model
```

The transport tracks each pending call, rejects malformed, duplicate, and unknown responses, times out after 30 seconds, and cancels pending calls on turn cancellation, Runtime reconfiguration, or editor disconnect. Godot converts Variants to JSON-safe values and bounds tree depth, node count, property scanning, collection sizes, strings, dependencies, paths, and the final serialized response. Nested values share a global item and string budget, dictionaries use typed key/value entries, and integers outside JavaScript's safe range use tagged decimal strings.

## Editor-hosted game debugging

Game verification uses the existing Godot editor instead of spawning a second editor or a headless process. The provider-neutral ToolKernel exposes `game_debug_start`, `game_debug_status`, and `game_debug_stop` only when the editor executor is connected. Starting a game crosses the `editor_game` approval boundary because it executes project code; the Dock asks in normal mode and automatically accepts it in `Approve for me` mode. Status is read-only, while stop is accepted only for the run token owned by the current GodotX debugger instance.

The editor controls play through public `EditorInterface` APIs. `main` runs the configured main scene, `current` means the scene active when the approved editor call is executed, and `scene` uses a validated canonical `res://*.tscn` or `res://*.scn` path. Callers should use the explicit scene mode whenever tab changes must not affect the target. Existing manual or foreign runs are never adopted, replaced, or stopped.

The plugin installs a project autoload probe only while it owns the matching autoload setting. A GodotX-started game receives an unguessable run ID after the command-line user-argument separator. Runs without that ID remain inert. In the game process, a Godot `Logger` captures bounded output and structured errors into a mutex-protected queue; the main thread sends small batches through a namespaced `EngineDebugger` message. The editor debugger validates the run ID, serializes lifecycle state, and stores a bounded sequence-numbered history. This avoids private editor nodes and does not claim access to built-in breakpoint stack frames or local variables, which Godot's public scripting debugger API does not expose.

The composer exposes `Ask for approval` and `Approve for me` as a project-persisted host policy. The Runtime remains in `ask` mode so every sensitive operation still crosses the host policy boundary. In `Approve for me`, the Dock automatically accepts every currently supported project-file, closed-scene, live-scene, command, and game-start category; unknown future categories still require a dialog. Workspace restrictions, command allowlists, and game-run ownership validation are independent of this confirmation policy. The selector is locked for the duration of a task, and the settings toggle mirrors the same committed policy.

### Runtime simulation automation

Runtime simulation automation extends an owned debug run without changing the game-debug ownership model. `Runtime simulation automation` is a project-scoped setting, disabled by default, whose committed value is copied into `turn.start`. The Runtime stores that immutable value in the task's tool context. Enabling or disabling the setting while a task is already running therefore affects only later tasks.

When the snapshot is enabled, the provider-neutral ToolKernel exposes the composite `game_test` fast path alongside `game_automation_run`, `game_automation_status`, and `game_automation_cancel`. The Agent should prefer one `game_test` call for a fresh verification. The Runtime, rather than the model, waits for launch readiness and the terminal automation result. The lower-level tools remain available for an already-running owned game, intermediate inspection, or explicit cancellation. A plan may contain frame waits, clicks on current-scene `Control` nodes, InputMap action presses/releases, and bounded node-existence or property assertions.

```text
model game_test plan
  -> ToolKernel validates the task opt-in, target, cleanup policy, and bounded steps
  -> one editor_game approval starts the frozen target
  -> Runtime locally waits for the exact run_id and Probe handshake
  -> EditorDebuggerSession sends the complete plan to RuntimeProbe
  -> RuntimeProbe executes one step machine on game frames
  -> Runtime locally waits for the correlated terminal automation_id
  -> bounded tool.output.delta events update the existing tool card without model calls
  -> Runtime collects recent logs and cleans up only the exact owned run
  -> one compact terminal report returns to the model
```

The first implementation uses short, abortable EditorBridge status requests at a bounded local interval, so no individual bridge call is held open beyond its normal timeout. This removes model-driven polling while preserving the existing request/response transport. A later event subscription can replace the local status queries without changing the `game_test` provider contract.

The editor-to-game send operation has no transport-level acknowledgement, so the automation protocol supplies its own random `automation_id`, acknowledgement state, timeout, and final event. Both sides bind every request to the exact `run_id` and active `EditorDebuggerSession`; a stale session, manually started game, or superseded run cannot receive or report the plan. Only one plan may be active, and cancel must match both identifiers. Stopping or losing the owned game run terminates its automation state and releases any simulated held input.

The request is capped at 64 KiB, 64 steps, and 7,200 aggregate scheduled frames across waits, action durations, and assertion timeouts. Node paths stay below `SceneTree.current_scene`, traversal and subnames are rejected, and click targets must resolve to bounded `Control` nodes. Input is limited to declared events and InputMap actions. There is no arbitrary object lookup, method call, expression evaluation, shell command, or project-file mutation. RuntimeProbe processes accepted work on game frames rather than mutating the scene from the debugger capture callback, and automation status, per-step results, failures, and retained history all have independent output bounds.

This opt-in is separate from approval mode. `game_automation_run` and `game_automation_cancel` reject disabled task snapshots, but they do not create a second approval category after the user has explicitly enabled simulation. Starting project code remains a distinct `editor_game` operation that asks normally and is auto-accepted only by `Approve for me`. File, scene, and command approvals retain their existing policy, and simulation never starts a second Godot or headless process; it operates entirely through the already-running host editor and its owned game session.

## Localization boundary

GodotX owns a custom `addons/godetx` `TranslationDomain`. The plugin installs an in-memory Simplified Chinese `Translation` when enabled, sets only that domain's locale override from `OS.get_locale_language()`, assigns the domain to the Dock subtree, and removes it when disabled. Chinese host locales resolve to `zh_CN`; unsupported locales use the English source messages. It never calls `TranslationServer.set_locale()`, adds messages to the main domain, or changes project internationalization settings.

Only GodotX presentation text is translated: controls, status and approval messages, tool titles, argument labels, and generated change summaries. Provider/model identifiers, reasoning enums, protocol fields, paths, scene revisions, code, diffs, commands, user input, model replies, reasoning content, and raw command output remain byte-for-byte presentation inputs. Their controls disable automatic translation so content that happens to equal a message key is not rewritten. Dynamic UI strings translate the template before inserting project values.

The available read tools are `scene_get_tree`, `editor_get_selection`, `node_get_properties`, and `resource_inspect`. The live writer is `scene_apply_operations`. When a task is submitted, the Dock captures every open scene root, path, and undo-history revision; the Runtime stores those leases per turn and chooses one explicitly for each scene-bound request. `scene_get_tree` and `node_get_properties` can target any leased root, while editor selection remains associated with the primary scene. Switching tabs therefore cannot retarget a pending request, and scenes opened later are outside that turn's authority. Node paths exposed for live scene operations are relative to the selected scene root. Top-level NodePath properties are resolved through their owning node and normalized to that form; nested or ownerless NodePaths that cannot be normalized are marked as stored, non-writable metadata instead of being emitted as a valid write tag. Resource reads are confined to `res://` and return public `uid://` identifiers, metadata, dependencies, and bounded properties rather than raw binary asset contents.

These calls run synchronously on Godot's editor thread. `ResourceLoader.load()`, custom `_get_property_list()` implementations, and project-defined property getters cannot be preempted by the Runtime timeout and may execute project code. The current limits bound traversal and returned data, but projects containing hostile or pathological `@tool` code remain outside the read-only safety guarantee.

## Scene write strategy

`godot_scene` remains the structured writer for closed text scenes. The runtime translates its `add_node` and `set_property` operations to a normal file transaction so the user sees a diff and stale scene content is rejected.

The text-scene tool publishes the same value whitelist that its serializer enforces: primitives, one-dimensional arrays, and tagged `Vector2`, `Vector2i`, `Vector3`, `Vector3i`, and `Color` values. Property maps are flat (`theme_override_font_sizes/font_size`); a compatibility path safely expands one level of `theme_override_colors`, `theme_override_constants`, and `theme_override_font_sizes`. Arbitrary dictionaries, raw Godot expressions, and unverified resource references are rejected. Existing multi-line property values are not replaced by the line-oriented serializer because doing so could corrupt the remainder of the scene.

For any scene leased at turn submission, `scene_apply_operations` supports `add_node`, `set_property`, `rename_node`, `remove_node`, `duplicate_node`, `reparent_node`, and `instantiate_scene`. The Runtime validates the provider-facing request, selects the exact lease by scene ID, emits `editor_change.proposed`, obtains `editor_scene` approval, injects a canonical operation ID, and sends the request through the existing EditorBridge correlation. This keeps the opaque concurrency token in the control plane instead of relying on each model to copy it correctly. On approval, the Dock checks that the target root is still open and unchanged, records a one-time grant bound to that turn, operation ID, scene ID, scene revision, and exact normalized preview, then consumes it before dispatch. Godot validates the complete batch against a virtual scene plan, rechecks the revision after any resource load or PackedScene instantiation, and commits it as one `EditorUndoRedoManager` action in that root's history. The scene remains unsaved so the user can inspect, undo, or save it in the host editor. A task that edits several scenes produces one independent Undo action per scene; cross-scene atomic Undo is not claimed.

`scene_revision` is an opaque token derived from each leased root's editor undo history. Lease state is keyed by session, turn, and scene ID rather than being shared across a conversation. Reads must return the same scene ID, path, and revision and cannot silently rebind the target. Only a successful write result may advance that scene's turn-local revision, while Godot still compares the bound token immediately before commit. This rejects tab drift, closed/reopened roots, ordinary stale edits, and undo/redo changes. Direct project `@tool` mutations that bypass editor UndoRedo may not change this token, so node ownership, paths, property metadata, and values are also validated immediately before commit.

The operation journal makes a retried request idempotent within the plugin lifetime only while its recorded result revision is still current. Removed subtrees retain their object identity and owner map for undo, and added, duplicated, or instantiated nodes are held by matching do references. Duplication verifies class, script, child names, order, and structure before commit. Packed scenes use editor instance state, and only the instance root is assigned to the current scene owner so its internal ownership boundary is preserved. Direct edits inside non-editable instantiated subscenes are rejected until editable-instance overrides are implemented.

Generic property writes cannot modify structural identity, ownership, scripts, or scene IDs. Values are constrained to primitives, primitive/numeric-tag flat arrays, tagged 2D/3D/4D vectors and colors, exact signed `int64` strings, scalar typed Resource references, and scalar scene-root-relative NodePaths. Resource references accept canonical `res://` paths and/or registered `uid://` identifiers, require both locators to agree when supplied together, and are checked against native property metadata. NodePaths bind to node identities during planning and are converted from the final virtual tree to the property owner's relative storage path immediately before commit, so a rename or reparent in the same batch cannot leave a stale path.

Typed Arrays, script-defined Resource property types, and Resource or NodePath elements inside ordinary arrays are rejected before creating the UndoRedo action. They remain unsupported until element/script type metadata and owner-relative conversion can be validated without relying on a setter failure during commit.

After commit, the mutator reads the actual node paths, names, indexes, types, and property values and returns those as `changes`. The Runtime validates the returned scene/revision causality and publishes these actual changes separately from `requested_changes`, so the operation log does not treat the model's request as proof of what Godot applied.

The actual-change serializer has its own result budget and marks truncated or non-writable metadata explicitly. This is separate from the request limit: a large pre-existing property value must not cause the Dock's response-size guard to turn an already committed scene action into a failed acknowledgement. JavaScript-unsafe integers retain exact `int64` tags; writable NodePath results are normalized back to scene-root-relative form, while unresolved/stored NodePaths and subresources are labeled non-writable.

`npm test` covers the Runtime and WebSocket contracts. The GDScript verification scripts under `tests/godot/` are a separate Godot-side suite and are not launched by Agent turns; real `EditorUndoRedoManager`, editor instance state, and host UI acceptance must be checked in the already-running Godot editor.

Validation may still invoke project-defined `@tool` property-list/getter code, and committing an approved property change may invoke a project-defined setter. Those calls run synchronously on the editor thread and `UndoRedo` cannot provide exception-style rollback if project code fails during commit. The approval boundary and operation whitelist reduce authority, but hostile or pathological editor scripts remain outside the mutation guarantee.

This executor does not change `ModelProvider`, the Agent loop, or the public event envelope. Later scene milestones can add editable-instance overrides, editor-native resource creation, and broader Variant codecs while preserving the same approval, revision, and undo contract.

## Public web tools

`web_search` and `web_open` are Runtime-owned read tools, independent of the selected model Provider. Search first calls the fixed `web_search_exa` tool on Exa's anonymous public MCP endpoint. The Runtime accepts JSON or SSE JSON-RPC responses, normalizes their text or structured results into the existing bounded title/URL/snippet contract, caps the MCP response at 512 KB, and returns at most 6,000 characters of supplemental hosted context. No Exa API key is sent. HTTP `402/429` and equivalent MCP quota errors start a process-local cooldown (honoring `Retry-After`); transient hosted failures use a shorter circuit-breaker cooldown. During either cooldown, or whenever the hosted call fails, the same `web_search` invocation immediately falls back to Naver, Yandex, Bing, and DuckDuckGo in order. This fallback accepts only result cards that overlap the query.

The public MCP is a third-party service: public search queries are sent to Exa and remain subject to its availability, limits, and data handling. Project content and secrets are prohibited in queries. Opening a result remains a separate direct request and resolves and rejects local, private, link-local, reserved, and non-global addresses before every request and redirect; the connection dispatcher repeats that policy check during its own DNS lookup to resist rebinding. URL credentials, non-default ports, HTTPS downgrades, non-text responses, excessive redirects, timeouts, and bodies over 2 MB are rejected. Extracted text is capped separately before it enters model context. Hosted highlights may be used without opening the page when sufficient, which lets blocked or script-heavy sites remain researchable without weakening `web_open` network controls.

Search results and page content are explicitly untrusted data. The Agent prompt prohibits following instructions embedded in pages or sending credentials and private project content through queries or URLs. These controls reduce accidental authority and data disclosure, but they do not make arbitrary third-party content trustworthy.

## Provider compatibility

`OpenAICompatibleProvider` first calls `/responses` with SSE streaming. In `auto` mode, endpoint compatibility failures fall back to `/chat/completions`. Both transports produce the same normalized provider events and `AgentMessage` history.

`DeepSeekProvider` fixes the endpoint to `https://api.deepseek.com` and delegates only the Chat Completions transport. Its V4 capability metadata exposes `high` and `max` reasoning, marks image input and ImageX generation as unsupported, and preserves `reasoning_content` only for assistant messages that perform tool calls so DeepSeek can continue thinking on the next tool step without leaking vendor fields into the Agent loop.

`OpenCodeZenProvider` requires only a Zen API key and fixes its endpoint to `https://opencode.ai/zen/v1`. Model discovery intersects the authenticated Zen `/models` response with models.dev protocol and capability metadata, with a bounded embedded metadata snapshot keeping discovery usable when models.dev is temporarily unavailable. The public metadata request carries no authorization header; the Zen credential is sent only to `opencode.ai`. This phase exposes only tool-capable models whose Zen route uses the Runtime's complete Responses or Chat Completions transport. Claude and Qwen models routed through Anthropic Messages, Gemini models routed through its native API, unknown protocols, and models without tool calls are filtered from the selector instead of being allowed to fail during a task. Models assigned to `@ai-sdk/openai` delegate to Responses, while models assigned to `@ai-sdk/openai-compatible` delegate to Chat Completions; interleaved reasoning is preserved only where metadata declares it.

The Zen adapter intentionally does not implement image generation or editing. `ImageX` never treats access to Zen chat models as access to a Zen-hosted image service; users must select a Provider that explicitly implements the optional image capability.

Image generation and editing are optional capabilities on `ModelProvider`, separate from `streamTurn`. The `ImageX` editor dock reuses the active Provider connection but does not create an Agent session or add image data to chat history. Its direct modes query `image.capabilities`, send cancellable `image.generate` or `image.edit` requests, and receive only bounded artifact metadata after the Runtime validates and writes the binary result under `assets/generated`. OpenAI-compatible image editing maps to multipart `/images/edits`; Provider-specific field names do not cross the adapter boundary.

Sprite reskin and atlas variation requests reference a content-addressed project attachment. The Runtime resolves authoritative source bytes and dimensions from `AttachmentStore`, bounds each edge to 16-2048 pixels, validates atlas divisibility and a 256-frame ceiling, and never accepts client-provided source geometry. The Provider receives a strict canvas and grid contract. After editing, local PNG processing restores the exact source canvas and removes only connected chroma-key background pixels before writing a new artifact. Frame count and cell geometry are deterministic; the model remains responsible for the requested visual content within those cells.

The model-driven UI-kit mode composes two provider-neutral capabilities instead of adding a vendor-specific endpoint. Godot freezes a bounded Control-tree snapshot and may register one current-viewport attachment. The Runtime calls `streamTurn` on the selected planner model for a strict JSON plan, calls `generateImage` sequentially for no more than four assets, then optionally calls `streamTurn` once more with those generated images for visual QA. Progress is normalized as `asset.progress`; the final response contains the plan, review, and project paths, never image Base64. Scene identity is checked after asynchronous viewport capture so switching editor tabs cannot substitute a different scene image. There is no automatic regeneration loop in this phase.

Transparent output is a Runtime-level derived capability rather than a claim that every image model supports native alpha. A transparent request is forced to PNG and tries the Provider once. An explicit unsupported-background response, or an opaque PNG response, records that model limitation for the lifetime of the Provider instance and retries with an opaque solid-green composition contract. A bounded pure-JavaScript PNG stage flood-fills only chroma-like pixels connected to the canvas boundary, applies alpha and green-spill suppression, then normalizes UI-kit assets into role-specific content boxes. Independent Provider adapters therefore receive the same request contract without needing to implement background removal themselves.

Final artifact size is also separated from Provider generation size. Paired `target_width` and `target_height` values are bounded to 16-3840 with a decoded-pixel ceiling. GPT Image 2 custom source sizes follow its multiple-of-16, aspect-ratio, edge, and total-pixel constraints; a requested edge below 1024 is first enlarged proportionally. The post-processing stage resamples into the exact target canvas before the workspace transaction writes the file and validates the encoded PNG again. Godot previews the source bytes independently, schedules one editor filesystem scan for new paths, and enables resource navigation only after `ResourceLoader.exists` confirms import completion.

The OpenAI-compatible adapter maps the optional image contract to `/images/generations`, filters image-capable IDs from the authenticated `/models` response, and prefers `gpt-image-2` only when that ID is actually present. Other Providers can implement the same `generateImage` contract with their native image API; providers without it report unsupported while all coding and chat behavior remains available.

Model-specific controls are described by `ProviderModel.capabilities`. The editor builds its reasoning choices from those capabilities; model names and reasoning enums are not hard-coded in `AgentRuntime` or GDScript.

Additional providers are independent adapters registered through `ProviderDefinition`, not branches inside `AgentRuntime`. Reconfiguration creates a new provider generation, aborts outstanding requests from the previous generation, and disposes the old adapter so a delayed model response cannot overwrite the new provider's model list.
