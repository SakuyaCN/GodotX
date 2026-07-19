import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createScenePatch, type GodotSceneOperation } from "./godot-scene.js";
import type { EditorToolClient } from "./editor-bridge.js";
import type {
  EditorChangeAppliedData,
  EditorChangePreview,
  EditorChangeProposedData,
  EditorSceneLease,
  EditorSceneLeaseContext,
} from "./protocol.js";
import { parseEditorSceneLeaseContext } from "./protocol.js";
import type { ToolCall, ToolSchema } from "./provider/types.js";
import type { ProjectIndex } from "./project-index.js";
import type { ToolContext, ToolDefinition, ToolExecutionResult, ToolKernel } from "./tool-kernel.js";
import { createWebToolDefinitions, WebClient, type WebToolClient } from "./web.js";
import {
  normalizeRelative,
  Workspace,
  type WorkspaceFileIdentity,
  type PatchOperation,
  type PreparedTransaction,
} from "./workspace.js";

export type { ToolContext, ToolDefinition, ToolKernel } from "./tool-kernel.js";

const ALLOWED_EXECUTABLES = new Set([
  "node",
  "node.exe",
  "npm",
  "npm.cmd",
  "npx",
  "npx.cmd",
  "git",
  "git.exe",
  "dotnet",
  "dotnet.exe",
]);
const GODOT_EXECUTABLES = new Set(["godot", "godot.exe", "godot4", "godot4.exe"]);
const MAX_EDITOR_SCENE_REVISION_BINDINGS = 256;
const GAME_TEST_POLL_INTERVAL_MS = 50;
const GAME_TEST_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_GAME_TEST_READY_TIMEOUT_MS = 15_000;
const DEFAULT_GAME_TEST_AUTOMATION_TIMEOUT_MS = 120_000;
const MAX_GAME_TEST_OUTPUT_BYTES = 64 * 1024;

interface EditorSceneTurnState {
  readonly sourceFingerprint: string;
  readonly primarySceneId: string | null;
  readonly leases: Map<string, EditorSceneLease>;
  readonly protectedScenePaths: Map<string, string>;
  readonly revisionBindings: Map<string, string>;
}

export interface ToolRegistryOptions {
  editorClient?: EditorToolClient;
  webClient?: WebToolClient;
  projectIndex?: ProjectIndex;
}

export class ToolRegistry implements ToolKernel {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #editorSceneTurns = new Map<string, EditorSceneTurnState>();

  constructor(readonly workspace: Workspace, options: ToolRegistryOptions = {}) {
    const webClient = options.webClient ?? new WebClient();
    for (const definition of createWebToolDefinitions(webClient)) this.register(definition);
    const projectIndex = options.projectIndex;
    if (projectIndex) {
      this.register({
        schema: projectSymbolSearchSchema,
        executor: "runtime",
        effect: "read",
        execute: async (args) => {
          rejectUnknownArgumentKeys(args, ["query", "kinds", "path_prefix", "limit"]);
          return {
            matches: await projectIndex.searchSymbols(
              readLimitedIdentifier(args.query, "query", 256),
              {
                ...(args.kinds !== undefined ? { kinds: readOptionalStringList(args.kinds, "kinds", 16, 64) } : {}),
                ...(args.path_prefix !== undefined ? { pathPrefix: readLimitedIdentifier(args.path_prefix, "path_prefix", 1024) } : {}),
                limit: readBoundedInteger(args.limit, 100, 1, 500, "limit"),
              },
            ),
          };
        },
      });
      this.register({
        schema: projectFindReferencesSchema,
        executor: "runtime",
        effect: "read",
        execute: async (args) => {
          rejectUnknownArgumentKeys(args, ["name", "path_prefix", "limit"]);
          return {
            references: await projectIndex.findReferences(
              readLimitedIdentifier(args.name, "name", 256),
              {
                ...(args.path_prefix !== undefined ? { pathPrefix: readLimitedIdentifier(args.path_prefix, "path_prefix", 1024) } : {}),
                limit: readBoundedInteger(args.limit, 200, 1, 500, "limit"),
              },
            ),
          };
        },
      });
      this.register({
        schema: projectDependencyGraphSchema,
        executor: "runtime",
        effect: "read",
        execute: async (args) => {
          rejectUnknownArgumentKeys(args, ["path", "direction", "depth", "limit"]);
          const direction = args.direction ?? "both";
          if (direction !== "dependencies" && direction !== "dependents" && direction !== "both") {
            throw new Error("direction must be dependencies, dependents, or both");
          }
          return projectIndex.dependencyGraph(
            readLimitedIdentifier(args.path, "path", 1024),
            {
              direction,
              depth: readBoundedInteger(args.depth, 3, 1, 8, "depth"),
              limit: readBoundedInteger(args.limit, 200, 1, 500, "limit"),
            },
          );
        },
      });
    }
    this.register({
      schema: listFilesSchema,
      executor: "runtime",
      effect: "read",
      execute: async (args) => ({
        files: await this.workspace.listFiles(
          readOptionalNumber(args.limit, 500),
          readOptionalString(args.file_suffix),
        ),
      }),
    });
    this.register({
      schema: readFileSchema,
      executor: "runtime",
      effect: "read",
      execute: async (args) => {
        const path = readRequiredString(args.path);
        return { path, content: await this.workspace.readText(path) };
      },
    });
    this.register({
      schema: searchTextSchema,
      executor: "runtime",
      effect: "read",
      execute: async (args) => ({
        matches: await this.workspace.search(
          readRequiredString(args.query),
          readOptionalString(args.file_suffix),
          readOptionalNumber(args.limit, 100),
        ),
      }),
    });
    this.register({
      schema: applyPatchSchema,
      executor: "runtime",
      effect: "write",
      execute: (args, context) => this.#applyPatch(readPatchOperations(args.operations), context),
    });
    this.register({
      schema: godotSceneSchema,
      executor: "runtime",
      effect: "write",
      execute: (args, context) => this.#editGodotScene(
        readRequiredString(args.scene_path),
        readSceneOperations(args.operations),
        context,
      ),
    });
    this.register({
      schema: runCommandSchema,
      executor: "runtime",
      effect: "execute",
      execute: (args, context) => {
        rejectUnknownArgumentKeys(args, ["command", "timeout_ms"]);
        return this.#runCommand(
          readStringArray(args.command),
          readOptionalNumber(args.timeout_ms, 120_000),
          context,
        );
      },
    });

    const editorClient = options.editorClient;
    if (editorClient) {
      for (const schema of editorReadToolSchemas) {
        this.register({
          schema,
          executor: "editor",
          effect: "read",
          execute: async (args, context) => {
            const normalizedArgs = normalizeEditorToolArguments(schema.name, args);
            const state = this.#getEditorSceneTurnState(context);
            const sceneLease = this.#selectEditorReadLease(schema.name, normalizedArgs, state);
            if (sceneLease && (
              schema.name === sceneGetTreeSchema.name ||
              schema.name === nodeGetPropertiesSchema.name
            )) {
              normalizedArgs.scene_id = sceneLease.scene_id;
            }
            const result = await editorClient.execute(
              schema.name,
              normalizedArgs,
              {
                signal: context.signal,
                sessionId: context.sessionId,
                turnId: context.turnId,
                itemId: context.itemId,
                ...(sceneLease ? { sceneLease } : {}),
              },
            );
            if (sceneLease && result.ok === true) {
              const validationError = validateEditorSceneReadResult(result, sceneLease);
              if (validationError) return { ok: false, error: validationError };
            }
            return result;
          },
        });
      }
      this.register({
        schema: sceneApplyOperationsSchema,
        executor: "editor",
        effect: "write",
        execute: (args, context) => this.#applyEditorSceneOperations(
          editorClient,
          readEditorSceneChange(args),
          context,
        ),
      });
      this.register({
        schema: gameDebugStartSchema,
        executor: "editor",
        effect: "execute",
        execute: (args, context) => this.#startEditorGame(
          editorClient,
          readGameDebugStartArguments(args),
          context,
        ),
      });
      this.register({
        schema: gameDebugStatusSchema,
        executor: "editor",
        effect: "read",
        execute: (args, context) => editorClient.execute(
          gameDebugStatusSchema.name,
          readGameDebugStatusArguments(args),
          editorToolExecutionContext(context),
        ),
      });
      this.register({
        schema: gameCaptureScreenshotSchema,
        executor: "editor",
        effect: "read",
        execute: async (args, context) => {
          const request = readGameCaptureScreenshotArguments(args);
          const output = await editorClient.execute(
            gameCaptureScreenshotSchema.name,
            {
              run_id: request.run_id,
              max_dimension: request.max_dimension,
            },
            editorToolExecutionContext(context),
          );
          if (output.ok !== true) return output;
          const observation = readGameScreenshotObservation(output, request.run_id, request.detail);
          return {
            output,
            observations: [
              { type: "text", text: observation.text },
              observation.image,
            ],
          };
        },
      });
      this.register({
        schema: gameDebugStopSchema,
        executor: "editor",
        effect: "execute",
        execute: (args, context) => editorClient.execute(
          gameDebugStopSchema.name,
          readGameDebugStopArguments(args),
          editorToolExecutionContext(context),
        ),
      });
      this.register({
        schema: gameAutomationRunSchema,
        executor: "editor",
        effect: "execute",
        execute: (args, context) => {
          requireRuntimeAutomationEnabled(context);
          return editorClient.execute(
            gameAutomationRunSchema.name,
            readGameAutomationRunArguments(args),
            editorToolExecutionContext(context),
          );
        },
      });
      this.register({
        schema: gameAutomationStatusSchema,
        executor: "editor",
        effect: "read",
        execute: (args, context) => editorClient.execute(
          gameAutomationStatusSchema.name,
          readGameAutomationIdentity(args),
          editorToolExecutionContext(context),
        ),
      });
      this.register({
        schema: gameAutomationCancelSchema,
        executor: "editor",
        effect: "execute",
        execute: (args, context) => {
          requireRuntimeAutomationEnabled(context);
          return editorClient.execute(
            gameAutomationCancelSchema.name,
            readGameAutomationIdentity(args),
            editorToolExecutionContext(context),
          );
        },
      });
      this.register({
        schema: gameTestSchema,
        executor: "editor",
        effect: "execute",
        execute: (args, context) => {
          requireRuntimeAutomationEnabled(context);
          return this.#runGameTest(editorClient, readGameTestArguments(args), context);
        },
      });
    }
  }

  register(definition: ToolDefinition): this {
    const name = definition.schema.name.trim();
    if (!name) throw new Error("Tool name must not be empty");
    if (this.#tools.has(name)) throw new Error(`Tool is already registered: ${name}`);
    this.#tools.set(name, definition);
    return this;
  }

  definitions(): ToolSchema[] {
    return [...this.#tools.values()].map((definition) => definition.schema);
  }

  async execute(call: ToolCall, context: ToolContext): Promise<Record<string, unknown>> {
    const result = await this.#executeDefinition(call, context);
    return isToolExecutionResult(result) ? result.output : result;
  }

  async executeWithObservations(call: ToolCall, context: ToolContext): Promise<ToolExecutionResult> {
    const result = await this.#executeDefinition(call, context);
    if (isToolExecutionResult(result)) {
      return {
        output: result.output,
        observations: result.observations.map((part) => ({ ...part })),
      };
    }
    return { output: result };
  }

  async #executeDefinition(
    call: ToolCall,
    context: ToolContext,
  ): Promise<Record<string, unknown> | ToolExecutionResult> {
    const args = parseArguments(call.arguments);
    const definition = this.#tools.get(call.name);
    if (!definition) throw new Error(`Unknown tool: ${call.name}`);
    return definition.execute(args, context, call);
  }

  releaseTurn(sessionId: string, turnId: string): void {
    this.#editorSceneTurns.delete(makeEditorSceneTurnKey({ sessionId, turnId }));
  }

  async #applyPatch(operations: PatchOperation[], context: ToolContext): Promise<Record<string, unknown>> {
    await this.#assertPathsAreNotOpenScenes(operations.map((operation) => operation.path), context);
    const transaction = await this.workspace.preparePatch(operations);
    return this.#approveAndApply(transaction, context, "file_change");
  }

  async #editGodotScene(
    scenePath: string,
    operations: GodotSceneOperation[],
    context: ToolContext,
  ): Promise<Record<string, unknown>> {
    await this.#assertPathsAreNotOpenScenes([scenePath], context);
    const content = await this.workspace.readText(scenePath);
    const patch = createScenePatch(scenePath, content, operations);
    const transaction = await this.workspace.preparePatch([patch]);
    return this.#approveAndApply(transaction, context, "godot_scene");
  }

  async #applyEditorSceneOperations(
    editorClient: EditorToolClient,
    request: EditorSceneChangeRequest,
    context: ToolContext,
  ): Promise<Record<string, unknown>> {
    const state = this.#getEditorSceneTurnState(context);
    const sceneLease = this.#requireEditorSceneLease(request.scene_id, state);
    const change = this.#bindEditorSceneRevision(request, context, sceneLease, state);
    const operationId = makeEditorOperationId(change, context);
    const changeId = operationId;
    const preview: EditorChangePreview = {
      scene_id: change.scene_id,
      scene_path: sceneLease.scene_path,
      scene_revision: change.scene_revision,
      changes: change.operations,
    };
    const proposed: EditorChangeProposedData = {
      change_id: changeId,
      scene_id: change.scene_id,
      scene_path: sceneLease.scene_path,
      scene_revision: change.scene_revision,
      changes: change.operations,
      preview,
    };
    context.emit("editor_change.proposed", proposed, context.itemId);
    const approval = await context.approvals.request(
      context.sessionId,
      "editor_scene",
      context.approvalMode,
      (requestId) => {
        context.emit(
          "approval.requested",
          {
            request_id: requestId,
            category: "editor_scene",
            title: "Modify the live Godot scene",
            change_id: changeId,
            preview,
          },
          context.itemId,
        );
      },
    );
    context.emit(
      "approval.resolved",
      { request_id: approval.requestId, decision: approval.decision },
      context.itemId,
    );
    if (approval.decision !== "accept" && approval.decision !== "accept_for_session") {
      return { ok: false, error: "User declined the editor scene change" };
    }
    this.#rememberEditorSceneRevisionBinding(
      state,
      makeEditorSceneBindingKey(request, context),
      change.scene_revision,
    );

    const result = await editorClient.execute(
      sceneApplyOperationsSchema.name,
      { ...change, operation_id: operationId },
      {
        signal: context.signal,
        sessionId: context.sessionId,
        turnId: context.turnId,
        itemId: context.itemId,
        sceneLease: { ...sceneLease, scene_revision: change.scene_revision },
      },
    );
    if (result.ok !== true) {
      return result.ok === false
        ? result
        : { ok: false, error: "Godot editor bridge returned an invalid scene change result" };
    }
    if (result.scene_id !== change.scene_id) {
      return { ok: false, error: "Godot editor bridge returned a result for a different scene" };
    }
    if (result.scene_path !== sceneLease.scene_path) {
      return { ok: false, error: "Godot editor bridge returned a result for a different scene path" };
    }
    if (result.previous_scene_revision !== change.scene_revision) {
      return { ok: false, error: "Godot editor bridge returned a mismatched previous scene revision" };
    }
    if (!isSafeOpaqueValue(result.scene_revision, 128)) {
      return { ok: false, error: "Godot editor bridge returned an invalid new scene revision" };
    }
    const latestLease = state.leases.get(change.scene_id);
    if (!latestLease || latestLease.scene_revision !== change.scene_revision) {
      return {
        ok: false,
        error: "Editor scene lease advanced while this operation was in flight; refusing a stale result",
      };
    }
    state.leases.set(change.scene_id, {
      ...latestLease,
      scene_revision: result.scene_revision,
    });
    const appliedChanges = Array.isArray(result.changes) ? result.changes : change.operations;
    const appliedRevision = result.scene_revision;
    const applied: EditorChangeAppliedData = {
      change_id: changeId,
      operation_id: operationId,
      scene_id: change.scene_id,
      scene_path: sceneLease.scene_path,
      scene_revision: appliedRevision,
      previous_scene_revision: result.previous_scene_revision as string,
      changes: appliedChanges,
      requested_changes: change.operations,
      result,
    };
    context.emit("editor_change.applied", applied, context.itemId);
    return result;
  }

  async #startEditorGame(
    editorClient: EditorToolClient,
    args: GameDebugStartArguments,
    context: ToolContext,
  ): Promise<Record<string, unknown>> {
    const target = resolveEditorGameTarget(args, context);
    const approval = await context.approvals.request(
      context.sessionId,
      "editor_game",
      "ask",
      (requestId) => {
        context.emit(
          "approval.requested",
          {
            request_id: requestId,
            category: "editor_game",
            title: "Start the game in the Godot editor",
            tool: gameDebugStartSchema.name,
            arguments: target,
          },
          context.itemId,
        );
      },
    );
    context.emit(
      "approval.resolved",
      { request_id: approval.requestId, decision: approval.decision },
      context.itemId,
    );
    if (approval.decision !== "accept" && approval.decision !== "accept_for_session") {
      return { ok: false, error: "User declined starting the game in the Godot editor" };
    }
    return editorClient.execute(
      gameDebugStartSchema.name,
      target,
      editorToolExecutionContext(context),
    );
  }

  async #runGameTest(
    editorClient: EditorToolClient,
    args: GameTestArguments,
    context: ToolContext,
  ): Promise<Record<string, unknown> | ToolExecutionResult> {
    const startedAt = Date.now();
    let readyStartedAt = 0;
    let automationStartedAt = 0;
    let cleanupStartedAt = 0;
    let readyElapsedMs = 0;
    let automationElapsedMs = 0;
    let cleanupElapsedMs = 0;
    let runId: string | null = null;
    let automationId: string | null = null;
    let state = "validating";
    let failure: string | null = null;
    let abortReason: unknown;
    let automationTerminal = false;
    let launchStart: Record<string, unknown> | null = null;
    let launchStatus: Record<string, unknown> | null = null;
    let automationStart: Record<string, unknown> | null = null;
    let automationStatus: Record<string, unknown> | null = null;
    let cancelResult: Record<string, unknown> | null = null;
    let stopResult: Record<string, unknown> | null = null;
    let cancelAttempted = false;
    let stopAttempted = false;
    let alreadyStopped = false;
    let cleanupWarning: string | null = null;
    let visualCapture: Record<string, unknown> | null = null;
    let visualWarning: string | null = null;
    let visualObservation: ReturnType<typeof readGameScreenshotObservation> | null = null;
    let debugAfterSeq = 0;
    const debugEntries: Record<string, unknown>[] = [];

    emitGameTestProgress(context, "validating", "Validating the game test plan.");
    try {
      context.signal.throwIfAborted();
      state = "starting";
      emitGameTestProgress(context, "starting", "Starting the requested scene in the Godot editor.");
      launchStart = await this.#startEditorGame(editorClient, args.target, context);
      if (launchStart.ok !== true) {
        throw new GameTestWorkflowError(
          "launch_failed",
          readEditorResultError(launchStart, "The Godot editor declined or failed to start the game"),
        );
      }
      try {
        runId = readAutomationIdentifier(launchStart.run_id, "run_id");
      } catch (error) {
        throw new GameTestWorkflowError(
          "launch_failed",
          `The Godot editor returned an invalid run_id: ${errorMessage(error)}`,
        );
      }

      state = "waiting_for_probe";
      readyStartedAt = Date.now();
      emitGameTestProgress(
        context,
        "waiting_for_probe",
        "Waiting for the runtime probe to become ready.",
        { run_id: runId },
      );
      const readyTimeout = createLinkedTimeoutSignal(context.signal, args.ready_timeout_ms);
      try {
        while (true) {
          readyTimeout.signal.throwIfAborted();
          const snapshot = await editorClient.execute(
            gameDebugStatusSchema.name,
            { history_limit: 100, after_seq: debugAfterSeq },
            editorToolExecutionContext(context, readyTimeout.signal),
          );
          launchStatus = snapshot;
          if (snapshot.ok !== true) {
            throw new GameTestWorkflowError(
              "launch_failed",
              readEditorResultError(snapshot, "Unable to read the game debug session"),
            );
          }
          if (snapshot.run_id !== runId) {
            throw new GameTestWorkflowError(
              "launch_failed",
              "The Godot editor returned status for a different game run",
            );
          }
          appendBoundedGameDebugEntries(debugEntries, snapshot.entries);
          debugAfterSeq = readNonNegativeSafeInteger(snapshot.next_seq, debugAfterSeq);
          if (
            snapshot.launch_observed === true &&
            snapshot.probe_confirmed === true &&
            snapshot.owned === true &&
            snapshot.playing === true
          ) {
            break;
          }
          if (isEndedGameDebugSnapshot(snapshot)) {
            throw new GameTestWorkflowError(
              "launch_failed",
              readGameLaunchFailure(snapshot),
            );
          }
          await waitForGameTestPoll(readyTimeout.signal);
        }
      } catch (error) {
        if (readyTimeout.didTimeout() && !context.signal.aborted) {
          throw new GameTestWorkflowError(
            "ready_timeout",
            `The runtime probe did not become ready within ${args.ready_timeout_ms} ms`,
          );
        }
        throw error;
      } finally {
        readyTimeout.dispose();
        readyElapsedMs = Date.now() - readyStartedAt;
      }

      state = "running_automation";
      automationStartedAt = Date.now();
      const automationTimeout = createLinkedTimeoutSignal(
        context.signal,
        args.automation_timeout_ms,
      );
      try {
        emitGameTestProgress(
          context,
          "running_automation",
          "Submitting the local runtime automation plan.",
          { run_id: runId, current_step: 0, step_count: args.steps.length },
        );
        automationStart = await editorClient.execute(
          gameAutomationRunSchema.name,
          {
            run_id: runId,
            steps: args.steps,
            stop_on_failure: args.stop_on_failure,
          },
          editorToolExecutionContext(context, automationTimeout.signal),
        );
        if (automationStart.ok !== true) {
          throw new GameTestWorkflowError(
            "automation_failed",
            readEditorResultError(automationStart, "The runtime automation plan was rejected"),
          );
        }
        if (automationStart.run_id !== runId) {
          throw new GameTestWorkflowError(
            "automation_failed",
            "The Godot editor returned automation for a different game run",
          );
        }
        try {
          automationId = readAutomationIdentifier(automationStart.automation_id, "automation_id");
        } catch (error) {
          throw new GameTestWorkflowError(
            "automation_failed",
            `The Godot editor returned an invalid automation_id: ${errorMessage(error)}`,
          );
        }

        let reportedStep = -1;
        while (true) {
          automationTimeout.signal.throwIfAborted();
          const snapshot = await editorClient.execute(
            gameAutomationStatusSchema.name,
            { run_id: runId, automation_id: automationId },
            editorToolExecutionContext(context, automationTimeout.signal),
          );
          automationStatus = snapshot;
          if (snapshot.ok !== true) {
            throw new GameTestWorkflowError(
              "automation_failed",
              readEditorResultError(snapshot, "Unable to read runtime automation status"),
            );
          }
          if (snapshot.run_id !== runId || snapshot.automation_id !== automationId) {
            throw new GameTestWorkflowError(
              "automation_failed",
              "The Godot editor returned status for a different automation plan",
            );
          }
          const currentStep = readNonNegativeSafeInteger(snapshot.current_step, 0);
          const stepCount = readNonNegativeSafeInteger(snapshot.step_count, args.steps.length);
          if (currentStep !== reportedStep) {
            reportedStep = currentStep;
            emitGameTestProgress(
              context,
              "running_automation",
              `Running local automation (${currentStep}/${stepCount}).`,
              {
                run_id: runId,
                automation_id: automationId,
                current_step: currentStep,
                step_count: stepCount,
              },
            );
          }
          const automationState = typeof snapshot.state === "string" ? snapshot.state : "";
          if (isTerminalAutomationState(automationState)) {
            automationTerminal = true;
            state = automationState;
            if (automationState !== "passed") {
              failure = readEditorResultError(
                snapshot,
                automationState === "cancelled"
                  ? "Runtime automation was cancelled"
                  : "Runtime automation failed",
              );
            }
            break;
          }
          if (automationState !== "queued" && automationState !== "running") {
            throw new GameTestWorkflowError(
              "automation_failed",
              `The Godot editor returned an invalid automation state: ${automationState || "<empty>"}`,
            );
          }
          await waitForGameTestPoll(automationTimeout.signal);
        }
      } catch (error) {
        if (automationTimeout.didTimeout() && !context.signal.aborted) {
          throw new GameTestWorkflowError(
            "automation_timeout",
            `Runtime automation did not finish within ${args.automation_timeout_ms} ms`,
          );
        }
        throw error;
      } finally {
        automationTimeout.dispose();
        automationElapsedMs = Date.now() - automationStartedAt;
      }
    } catch (error) {
      if (context.signal.aborted) {
        state = "cancelled";
        failure = "The game test was cancelled";
        abortReason = context.signal.reason ?? error;
      } else if (error instanceof GameTestWorkflowError) {
        state = error.state;
        failure = error.message;
      } else {
        state = "failed";
        failure = errorMessage(error);
      }
    } finally {
      if (runId && !context.signal.aborted) {
        const drainTimeout = createLinkedTimeoutSignal(
          context.signal,
          GAME_TEST_CLEANUP_TIMEOUT_MS,
        );
        try {
          const snapshot = await editorClient.execute(
            gameDebugStatusSchema.name,
            { history_limit: 64, after_seq: 0 },
            editorToolExecutionContext(context, drainTimeout.signal),
          );
          if (snapshot.ok === true && snapshot.run_id === runId) {
            launchStatus = snapshot;
            appendBoundedGameDebugEntries(debugEntries, snapshot.entries);
            debugAfterSeq = readNonNegativeSafeInteger(snapshot.next_seq, debugAfterSeq);
          }
        } catch {
          // Log collection is best-effort and must not hide the actual test result.
        } finally {
          drainTimeout.dispose();
        }
      }

      if (context.signal.aborted && abortReason === undefined) {
        state = "cancelled";
        failure = "The game test was cancelled";
        abortReason = context.signal.reason ?? new Error(failure);
      }

      const hasLiveOwnedRun = Boolean(
        runId &&
        launchStatus?.run_id === runId &&
        launchStatus.playing === true &&
        launchStatus.owned === true &&
        launchStatus.probe_confirmed === true,
      );
      const shouldCaptureFrame = Boolean(
        !context.signal.aborted &&
        hasLiveOwnedRun &&
        args.capture !== "never" &&
        (
          args.capture === "always" ||
          (args.capture === "after" && automationTerminal) ||
          (args.capture === "on_failure" && state !== "passed")
        ),
      );
      if (shouldCaptureFrame && runId) {
        emitGameTestProgress(
          context,
          "capturing_frame",
          "Capturing the rendered game frame before cleanup.",
          { run_id: runId },
        );
        try {
          visualCapture = await executeIndependentEditorRequest(
            editorClient,
            gameCaptureScreenshotSchema.name,
            { run_id: runId, max_dimension: args.capture_max_dimension },
            context,
          );
          if (visualCapture.ok === true) {
            visualObservation = readGameScreenshotObservation(
              visualCapture,
              runId,
              args.capture_detail,
            );
          } else {
            visualWarning = readEditorResultError(
              visualCapture,
              "The rendered game frame could not be captured",
            );
          }
        } catch (error) {
          visualCapture = { ok: false, error: errorMessage(error) };
          visualWarning = errorMessage(error);
        }
        if (visualWarning && state === "passed") {
          state = "visual_capture_failed";
          failure = visualWarning;
        }
      }

      const shouldCancelAutomation = Boolean(runId && automationId && !automationTerminal);
      alreadyStopped = Boolean(
        runId &&
        launchStatus?.run_id === runId &&
        launchStatus.playing === false &&
        launchStatus.owned === false,
      );
      const shouldStopRun = Boolean(
        runId &&
        !alreadyStopped &&
        (
          context.signal.aborted ||
          args.cleanup === "always" ||
          (args.cleanup === "on_success" && state === "passed")
        ),
      );
      if (shouldCancelAutomation || shouldStopRun) {
        cleanupStartedAt = Date.now();
        emitGameTestProgress(
          context,
          "cleaning_up",
          "Cleaning up the GodotX-owned game test run.",
          {
            ...(runId ? { run_id: runId } : {}),
            ...(automationId ? { automation_id: automationId } : {}),
          },
        );
        try {
          if (shouldCancelAutomation && runId && automationId) {
            cancelAttempted = true;
            try {
              cancelResult = await executeIndependentEditorRequest(
                editorClient,
                gameAutomationCancelSchema.name,
                { run_id: runId, automation_id: automationId },
                context,
              );
            } catch (error) {
              cancelResult = { ok: false, error: errorMessage(error) };
            }
          }
          if (shouldStopRun && runId) {
            stopAttempted = true;
            try {
              stopResult = await executeIndependentEditorRequest(
                editorClient,
                gameDebugStopSchema.name,
                { run_id: runId },
                context,
              );
            } catch (error) {
              stopResult = { ok: false, error: errorMessage(error) };
            }
            if (stopResult.ok === true) {
              const confirmParent = new AbortController();
              const confirmTimeout = createLinkedTimeoutSignal(confirmParent.signal, 1_000);
              try {
                while (!confirmTimeout.signal.aborted) {
                  const afterStop = await editorClient.execute(
                    gameDebugStatusSchema.name,
                    { history_limit: 1, after_seq: debugAfterSeq },
                    editorToolExecutionContext(context, confirmTimeout.signal),
                  );
                  if (afterStop.ok !== true || afterStop.run_id !== runId) break;
                  launchStatus = afterStop;
                  appendBoundedGameDebugEntries(debugEntries, afterStop.entries);
                  debugAfterSeq = readNonNegativeSafeInteger(afterStop.next_seq, debugAfterSeq);
                  alreadyStopped = afterStop.playing === false && afterStop.owned === false;
                  if (alreadyStopped) break;
                  await waitForGameTestPoll(confirmTimeout.signal);
                }
              } catch {
                // Confirmation is bounded; the successful stop request remains visible in cleanup.stop.
              } finally {
                confirmTimeout.dispose();
              }
              if (!alreadyStopped) {
                cleanupWarning = "The stop request was accepted but the game exit was not confirmed";
              }
            } else {
              try {
                const afterStop = await executeIndependentEditorRequest(
                  editorClient,
                  gameDebugStatusSchema.name,
                  { history_limit: 1, after_seq: debugAfterSeq },
                  context,
                );
                if (afterStop.ok === true && afterStop.run_id === runId) {
                  launchStatus = afterStop;
                  appendBoundedGameDebugEntries(debugEntries, afterStop.entries);
                  debugAfterSeq = readNonNegativeSafeInteger(afterStop.next_seq, debugAfterSeq);
                  alreadyStopped = afterStop.playing === false && afterStop.owned === false;
                }
              } catch {
                // A failed stop remains a cleanup failure unless exact status proves it already ended.
              }
            }
          }
        } finally {
          cleanupElapsedMs = Date.now() - cleanupStartedAt;
        }
      }
    }

    const stopped = alreadyStopped;
    if (state === "passed" && stopAttempted && !stopped) {
      state = "cleanup_failed";
      failure = stopResult?.ok === true
        ? "The stop request was accepted but the game exit was not confirmed"
        : readEditorResultError(stopResult ?? {}, "Failed to stop the GodotX-owned game run");
    }
    emitGameTestProgress(
      context,
      "completed",
      state === "passed" ? "Game test completed successfully." : "Game test completed with a failure.",
      {
        state,
        ...(runId ? { run_id: runId } : {}),
        ...(automationId ? { automation_id: automationId } : {}),
      },
    );

    if (abortReason !== undefined) throw normalizeAbortReason(abortReason);

    const output = boundGameTestOutput({
      ok: state === "passed",
      state,
      run_id: runId,
      automation_id: automationId,
      launch: {
        start: compactGameTestRecord(launchStart),
        status: compactGameDebugStatus(launchStatus, debugEntries),
      },
      automation: {
        start: compactGameTestRecord(automationStart),
        status: compactAutomationStatus(automationStatus),
      },
      cleanup: {
        policy: args.cleanup,
        attempted: cancelAttempted || stopAttempted,
        cancel_attempted: cancelAttempted,
        cancel: compactGameTestRecord(cancelResult),
        stop_attempted: stopAttempted,
        stop_requested: stopResult?.ok === true,
        stop: compactGameTestRecord(stopResult),
        already_stopped: alreadyStopped,
        stopped,
        warning: cleanupWarning,
      },
      visual: {
        policy: args.capture,
        attempted: visualCapture !== null,
        capture: compactGameTestRecord(visualCapture),
        warning: visualWarning,
      },
      stopped,
      failure,
      timings_ms: {
        total: Date.now() - startedAt,
        ready: readyElapsedMs,
        automation: automationElapsedMs,
        cleanup: cleanupElapsedMs,
      },
    });
    if (!visualObservation) return output;
    return {
      output,
      observations: [
        { type: "text", text: visualObservation.text },
        visualObservation.image,
      ],
    };
  }

  #bindEditorSceneRevision(
    request: EditorSceneChangeRequest,
    context: ToolContext,
    sceneLease: Readonly<EditorSceneLease>,
    state: EditorSceneTurnState,
  ): EditorSceneChange {
    const bindingKey = makeEditorSceneBindingKey(request, context);
    const boundRevision = state.revisionBindings.get(bindingKey);
    if (boundRevision) {
      if (request.scene_revision && request.scene_revision !== boundRevision) {
        throw new Error(
          "scene_revision does not match the revision already bound to this scene operation",
        );
      }
      if (boundRevision !== sceneLease.scene_revision) {
        throw new Error(
          "editor scene operation was already bound to an earlier revision; start a new turn before repeating it",
        );
      }
      return { ...request, scene_revision: boundRevision };
    }
    if (request.scene_revision && request.scene_revision !== sceneLease.scene_revision) {
      throw new Error(
        "scene_revision does not match the scene lease revision for this turn",
      );
    }
    const revision = sceneLease.scene_revision;
    if (state.revisionBindings.size >= MAX_EDITOR_SCENE_REVISION_BINDINGS) {
      throw new Error(`A turn cannot bind more than ${MAX_EDITOR_SCENE_REVISION_BINDINGS} editor scene operations`);
    }
    return { ...request, scene_revision: revision };
  }

  #getEditorSceneTurnState(context: ToolContext): EditorSceneTurnState {
    const parsed = parseEditorSceneLeaseContext(
      context.sceneLeases,
      context.primarySceneId,
      context.openScenePaths,
      "sceneLeases",
      "primarySceneId",
      "openScenePaths",
    );
    const sourceFingerprint = makeEditorSceneContextFingerprint(parsed);
    const turnKey = makeEditorSceneTurnKey(context);
    const existing = this.#editorSceneTurns.get(turnKey);
    if (existing) {
      if (existing.sourceFingerprint !== sourceFingerprint) {
        throw new Error("Editor scene context changed during an active turn");
      }
      this.#editorSceneTurns.delete(turnKey);
      this.#editorSceneTurns.set(turnKey, existing);
      return existing;
    }
    const protectedScenePaths = new Map<string, string>();
    for (const scenePath of parsed.open_scene_paths) {
      const normalized = normalizeSceneFilePath(scenePath);
      protectedScenePaths.set(sceneFilePathKey(normalized), normalized);
    }
    for (const lease of parsed.scene_leases) {
      if (lease.scene_path) {
        const normalized = normalizeSceneFilePath(lease.scene_path);
        protectedScenePaths.set(sceneFilePathKey(normalized), normalized);
      }
    }
    const state: EditorSceneTurnState = {
      sourceFingerprint,
      primarySceneId: parsed.primary_scene_id,
      leases: new Map(parsed.scene_leases.map((lease) => [lease.scene_id, { ...lease }])),
      protectedScenePaths,
      revisionBindings: new Map(),
    };
    this.#editorSceneTurns.set(turnKey, state);
    return state;
  }

  #selectEditorReadLease(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    state: EditorSceneTurnState,
  ): EditorSceneLease | undefined {
    if (toolName === resourceInspectSchema.name || toolName === godotApiQuerySchema.name) return undefined;
    const requestedSceneId = toolName === editorGetSelectionSchema.name
      ? state.primarySceneId
      : typeof args.scene_id === "string"
        ? args.scene_id
        : state.primarySceneId;
    if (!requestedSceneId) {
      throw new Error(`${toolName} requires a primary scene lease or an explicit scene_id`);
    }
    return this.#requireEditorSceneLease(requestedSceneId, state);
  }

  #requireEditorSceneLease(sceneId: string, state: EditorSceneTurnState): EditorSceneLease {
    const lease = state.leases.get(sceneId);
    if (!lease) throw new Error(`No editor scene lease is available for scene_id: ${sceneId}`);
    return { ...lease };
  }

  async #assertPathsAreNotOpenScenes(paths: readonly string[], context: ToolContext): Promise<void> {
    const state = this.#getEditorSceneTurnState(context);
    const protectedIdentities = await Promise.all(
      [...state.protectedScenePaths.values()].map((scenePath) => this.workspace.fileIdentity(scenePath)),
    );
    for (const candidate of paths) {
      const normalized = normalizeSceneFilePath(candidate);
      const candidateIdentity = await this.workspace.fileIdentity(normalized);
      if (
        state.protectedScenePaths.has(sceneFilePathKey(normalized)) ||
        (candidateIdentity && protectedIdentities.some((identity) => sameSceneFileIdentity(candidateIdentity, identity)))
      ) {
        throw new Error(
          `Open editor scene must be modified with scene_apply_operations: ${normalizeDisplayScenePath(candidate)}`,
        );
      }
    }
  }

  #rememberEditorSceneRevisionBinding(
    state: EditorSceneTurnState,
    bindingKey: string,
    revision: string,
  ): void {
    const existing = state.revisionBindings.get(bindingKey);
    if (existing && existing !== revision) {
      throw new Error("Editor scene operation binding changed while awaiting approval");
    }
    state.revisionBindings.set(bindingKey, revision);
  }

  async #approveAndApply(
    transaction: PreparedTransaction,
    context: ToolContext,
    category: string,
  ): Promise<Record<string, unknown>> {
    const files = transaction.changes.map((change) => ({ path: change.path, kind: change.kind }));
    context.emit("file_change.proposed", { transaction_id: transaction.id, files, diff: transaction.diff }, context.itemId);
    const approval = await context.approvals.request(
      context.sessionId,
      category,
      context.approvalMode,
      (requestId) => {
        context.emit(
          "approval.requested",
          {
            request_id: requestId,
            category,
            title: category === "godot_scene" ? "Modify Godot scene" : "Modify project files",
            files,
            diff: transaction.diff,
          },
          context.itemId,
        );
      },
    );
    context.emit(
      "approval.resolved",
      { request_id: approval.requestId, decision: approval.decision },
      context.itemId,
    );
    if (approval.decision !== "accept" && approval.decision !== "accept_for_session") {
      return { ok: false, error: "User declined the file change" };
    }
    const changed = await this.workspace.apply(transaction);
    context.emit("file_change.applied", { transaction_id: transaction.id, files: changed }, context.itemId);
    return { ok: true, files: changed, diff: transaction.diff };
  }

  async #runCommand(
    command: string[],
    timeoutMs: number,
    context: ToolContext,
  ): Promise<Record<string, unknown>> {
    if (command.length === 0) throw new Error("command must contain an executable");
    const executable = command[0]!;
    if (isReadFileCommandAlias(executable)) {
      const compatibilityReadPath = readFileCompatibilityCommandPath(command);
      if (!compatibilityReadPath) {
        throw new Error("File-reading command aliases accept exactly one project-relative path; use read_file");
      }
      return {
        ok: true,
        path: compatibilityReadPath,
        content: await this.workspace.readText(compatibilityReadPath),
        handled_by: "read_file",
      };
    }
    if (isGodotExecutable(executable)) {
      throw new Error("Launching another Godot process is disabled because GodotX is hosted by the running editor");
    }
    if (!isAllowedExecutable(executable)) throw new Error(`Executable is not allowed: ${executable}`);
    const approval = await context.approvals.request(
      context.sessionId,
      "command",
      context.approvalMode,
      (requestId) => {
        context.emit(
          "approval.requested",
          {
            request_id: requestId,
            category: "command",
            title: "Run project command",
            command,
            cwd: this.workspace.root,
          },
          context.itemId,
        );
      },
    );
    context.emit("approval.resolved", { request_id: approval.requestId, decision: approval.decision }, context.itemId);
    if (approval.decision !== "accept" && approval.decision !== "accept_for_session") {
      return { ok: false, error: "User declined the command" };
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(executable, command.slice(1), {
        cwd: this.workspace.root,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const append = (chunk: Buffer): void => {
        const delta = chunk.toString("utf8");
        output += delta;
        context.emit("tool.output.delta", { delta }, context.itemId);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => {
        child.kill();
      }, Math.min(Math.max(timeoutMs, 1_000), 300_000));
      const abort = (): void => {
        child.kill();
      };
      context.signal.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
        resolve({ ok: code === 0, exit_code: code, signal, output: output.slice(-100_000) });
      });
    });
  }
}

const listFilesSchema: ToolSchema = {
  name: "list_files",
  description:
    "List project files. Generated, temporary, and dependency directories are omitted. Use file_suffix such as .tscn to discover scenes without shell commands.",
  parameters: {
    type: "object",
    properties: {
      file_suffix: { type: "string", description: "Optional suffix such as .tscn or .gd" },
      limit: { type: "integer", minimum: 1, maximum: 2000 },
    },
    additionalProperties: false,
  },
};

const readFileSchema: ToolSchema = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the project. Paths are relative to the project root. Always use this instead of run_command with cat, type, or Get-Content.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

const searchTextSchema: ToolSchema = {
  name: "search_text",
  description: "Search literal text across project files.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      file_suffix: { type: "string", description: "Optional suffix such as .gd" },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const projectSymbolSearchSchema: ToolSchema = {
  name: "project_symbol_search",
  description:
    "Search the local incremental Godot semantic index for script classes, methods, signals, variables, constants, scene nodes, resources, autoloads, input actions, and shaders. Prefer this over broad text search when locating a definition, then read the matched source before editing.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 256 },
      kinds: {
        type: "array",
        maxItems: 16,
        items: {
          type: "string",
          enum: ["class", "method", "signal", "variable", "constant", "enum", "shader", "uniform", "scene_node", "resource", "autoload", "input_action", "section"],
        },
      },
      path_prefix: { type: "string", minLength: 1, maxLength: 1024 },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const projectFindReferencesSchema: ToolSchema = {
  name: "project_find_references",
  description:
    "Find indexed references to one exact Godot identifier or res:// resource path across GDScript, scenes, resources, shaders, and project settings. Results identify definitions when known and include file, line, and column navigation metadata.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 256 },
      path_prefix: { type: "string", minLength: 1, maxLength: 1024 },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

const projectDependencyGraphSchema: ToolSchema = {
  name: "project_dependency_graph",
  description:
    "Inspect indexed scene, script, resource, shader, and project-setting dependencies without loading project code. Use dependents to see what consumes a resource, dependencies to see what a file uses, or both for a bounded neighborhood.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1024 },
      direction: { type: "string", enum: ["dependencies", "dependents", "both"], default: "both" },
      depth: { type: "integer", minimum: 1, maximum: 8, default: 3 },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const patchOperationSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "replace" },
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["action", "path", "old_text", "new_text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { const: "create" }, path: { type: "string" }, content: { type: "string" } },
      required: ["action", "path", "content"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { const: "delete" }, path: { type: "string" } },
      required: ["action", "path"],
      additionalProperties: false,
    },
  ],
};

const applyPatchSchema: ToolSchema = {
  name: "apply_patch",
  description:
    "Apply an exact, transactional text patch. Read files first, then use unique old_text. The user reviews a diff before changes are written.",
  parameters: {
    type: "object",
    properties: { operations: { type: "array", minItems: 1, items: patchOperationSchema } },
    required: ["operations"],
    additionalProperties: false,
  },
};

const GODOT_ATOMIC_VALUE_VARIANTS: Record<string, unknown>[] = [
  { type: "string" },
  { type: "number", description: "A finite number" },
  { type: "boolean" },
  { type: "null" },
  taggedNumericValueSchema("Vector2", ["x", "y"]),
  taggedNumericValueSchema("Vector2i", ["x", "y"], true),
  taggedNumericValueSchema("Vector3", ["x", "y", "z"]),
  taggedNumericValueSchema("Vector3i", ["x", "y", "z"], true),
  {
    type: "object",
    properties: {
      godot_type: { const: "Color" },
      r: { type: "number" },
      g: { type: "number" },
      b: { type: "number" },
      a: { type: "number" },
    },
    required: ["godot_type", "r", "g", "b", "a"],
    additionalProperties: false,
  },
];

const godotSceneValueSchema = {
  description:
    "A primitive, a flat array, or a tagged Vector2/Vector2i/Vector3/Vector3i/Color object. Color requires r, g, b, and a.",
  oneOf: [
    ...GODOT_ATOMIC_VALUE_VARIANTS,
    {
      type: "array",
      maxItems: 256,
      items: { oneOf: GODOT_ATOMIC_VALUE_VARIANTS },
    },
  ],
};

const LIVE_EDITOR_SCENE_ROUNDTRIP_VALUE_VARIANTS: Record<string, unknown>[] = [
  {
    type: "object",
    properties: {
      godot_type: { const: "int64" },
      value: {
        type: "string",
        minLength: 1,
        maxLength: 20,
        pattern: "^(?:0|-?[1-9][0-9]*)$",
        description: "A canonical decimal integer in the signed 64-bit range",
      },
    },
    required: ["godot_type", "value"],
    additionalProperties: false,
  },
  taggedNumericValueSchema("Vector4", ["x", "y", "z", "w"]),
  taggedNumericValueSchema("Vector4i", ["x", "y", "z", "w"], true),
];

const liveEditorSceneArrayValueVariants: Record<string, unknown>[] = [
  ...GODOT_ATOMIC_VALUE_VARIANTS,
  ...LIVE_EDITOR_SCENE_ROUNDTRIP_VALUE_VARIANTS,
];

const liveEditorSceneAtomicValueVariants: Record<string, unknown>[] = [
  ...liveEditorSceneArrayValueVariants,
  {
    type: "object",
    properties: {
      godot_type: { const: "NodePath" },
      path: {
        type: "string",
        minLength: 0,
        maxLength: 512,
        description:
          "A current-scene root-relative target path; use . for the root or an empty path to clear the reference",
      },
    },
    required: ["godot_type", "path"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      godot_type: { const: "Resource" },
      path: {
        type: "string",
        minLength: 7,
        maxLength: 1024,
        pattern: "^res://",
        description: "A project resource path beginning with res://",
      },
      expected_type: {
        type: "string",
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        maxLength: 128,
        description: "Optional Godot resource class used to reject a type mismatch",
      },
      uid: {
        type: "string",
        minLength: 7,
        maxLength: 128,
        pattern: "^uid://[a-z0-9]+$",
        description: "Optional resource UID used to reject a path/UID mismatch",
      },
      resource_type: {
        type: "string",
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        maxLength: 128,
        description: "Resource type returned by editor inspection; normalized to expected_type on writes",
      },
      name: {
        type: "string",
        maxLength: 512,
        description: "Optional display metadata returned by editor inspection; ignored on writes",
      },
    },
    required: ["godot_type"],
    anyOf: [{ required: ["path"] }, { required: ["uid"] }],
    additionalProperties: false,
  },
];

const liveEditorSceneValueSchema = {
  description:
    "A primitive, flat array, tagged int64/vector/Color, scalar tagged NodePath, or scalar project Resource reference. int64 uses a canonical signed 64-bit decimal string. Resources require a res:// path, uid:// UID, or both.",
  oneOf: [
    ...liveEditorSceneAtomicValueVariants,
    {
      type: "array",
      maxItems: 256,
      items: { oneOf: liveEditorSceneArrayValueVariants },
    },
  ],
};

const NODE_PATH_PATTERN = "^(?:\\.|[A-Za-z_][A-Za-z0-9_]*(?:/[A-Za-z_][A-Za-z0-9_]*)*)$";
const PROPERTY_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*(?:/[A-Za-z_][A-Za-z0-9_]*)*$";
const LIVE_NODE_SEGMENT_PATTERN =
  "(?!\\s)(?![^/]*\\s(?:/|$))[^\\u0000-\\u001F\\u007F\\.:@/\"%\\\\]+";
const LIVE_NODE_PATH_PATTERN = `^(?:\\.|${LIVE_NODE_SEGMENT_PATTERN}(?:/${LIVE_NODE_SEGMENT_PATTERN})*)$`;
const LIVE_NODE_NAME_PATTERN = "^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001F\\u007F\\.:@/\"%\\\\]+$";
const BLOCKED_LIVE_SCENE_PROPERTY_ROOTS = new Set([
  "name",
  "owner",
  "script",
  "scene_file_path",
  "scene_unique_id",
  "unique_name_in_owner",
]);
const MAX_EDITOR_SCENE_CHANGE_BYTES = 512 * 1024;

const godotSceneSchema: ToolSchema = {
  name: "godot_scene",
  description:
    "Safely modify a closed or non-current Godot text scene using structured operations. Never use this for the scene currently open in the host editor; if its live scene tools fail, report the failure instead of editing its serialized file. Property maps must be flat: use theme_override_font_sizes/font_size, never a nested theme_override_font_sizes object. Use tagged Color and vector values. Prefer this over apply_patch for eligible .tscn files.",
  parameters: {
    type: "object",
    properties: {
      scene_path: { type: "string" },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                action: { const: "add_node" },
                name: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
                node_type: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
                parent: {
                  type: "string",
                  pattern: NODE_PATH_PATTERN,
                  description: "Path relative to the scene root; use . for the root",
                },
                properties: {
                  type: "object",
                  maxProperties: 64,
                  additionalProperties: godotSceneValueSchema,
                  description:
                    "Optional flat Godot properties. Example: theme_override_colors/font_color maps to a tagged Color value.",
                },
              },
              required: ["action", "name", "node_type", "parent"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "set_property" },
                node_path: {
                  type: "string",
                  pattern: NODE_PATH_PATTERN,
                  description: "Path relative to the root: . for root, AgentLabel for a direct child",
                },
                property: {
                  type: "string",
                  pattern: PROPERTY_PATTERN,
                  description:
                    "A flat Godot property name, for example text or theme_override_font_sizes/font_size",
                },
                value: godotSceneValueSchema,
              },
              required: ["action", "node_path", "property", "value"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ["scene_path", "operations"],
    additionalProperties: false,
  },
};

const runCommandSchema: ToolSchema = {
  name: "run_command",
  description:
    "Run an allowlisted non-Godot build, test, or package command without a shell. Do not use it to read, list, or search project files: use read_file, list_files, or search_text. Shell utilities and built-ins such as cat, type, Get-Content, ls, dir, grep, find, and rg are not portable command tools. Godot is already running as the host editor, so starting Godot, godot4, a headless editor, or another Godot process is unavailable. Pass the executable and each argument as separate array elements.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "array", minItems: 1, items: { type: "string" } },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const sceneGetTreeSchema: ToolSchema = {
  name: "scene_get_tree",
  description:
    "Read the live node tree of a scene that was open when this turn started, including unsaved editor state. Pass its listed scene_id when targeting a non-primary scene. Returns root-relative NodePaths, node types, scripts, ownership, groups, and truncation status; the Runtime keeps the opaque leased revision out of model control.",
  parameters: {
    type: "object",
    properties: {
      scene_id: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Optional leased scene id; defaults to the turn's primary scene",
      },
      max_depth: { type: "integer", minimum: 0, maximum: 8, default: 6 },
      max_nodes: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      include_internal: { type: "boolean", default: false },
      root_path: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        description: "Optional root-relative subtree NodePath; use . for the scene root",
      },
    },
    additionalProperties: false,
  },
};

const editorGetSelectionSchema: ToolSchema = {
  name: "editor_get_selection",
  description:
    "Read nodes and project files selected in the turn's primary Godot scene. Use this when the user refers to the selected node, resource, or asset; it never retargets to another tab during the turn.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 128, default: 64 },
    },
    additionalProperties: false,
  },
};

const nodeGetPropertiesSchema: ToolSchema = {
  name: "node_get_properties",
  description:
    "Inspect editor-visible properties of a node in a leased open scene. Pass scene_id for a non-primary target. node_path is relative to that scene root; use . for the root. Values are returned as JSON-safe tagged Godot values.",
  parameters: {
    type: "object",
    properties: {
      node_path: { type: "string", minLength: 1, maxLength: 512 },
      scene_id: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Optional scene id returned by scene_get_tree; rejects stale scene switches",
      },
      property_names: {
        type: "array",
        maxItems: 64,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 256 },
      },
      max_properties: { type: "integer", minimum: 1, maximum: 256, default: 128 },
      include_storage: { type: "boolean", default: false },
    },
    required: ["node_path"],
    additionalProperties: false,
  },
};

const resourceInspectSchema: ToolSchema = {
  name: "resource_inspect",
  description:
    "Inspect an imported Godot resource or asset through the running editor. Paths are relative to the project root or may begin with res://. Returns type, UID, dependencies, and editor-visible properties without reading binary asset data.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1024 },
      property_names: {
        type: "array",
        maxItems: 64,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 256 },
      },
      max_properties: { type: "integer", minimum: 1, maximum: 256, default: 128 },
      include_dependencies: { type: "boolean", default: true },
      dependency_limit: { type: "integer", minimum: 1, maximum: 256, default: 128 },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const godotApiQuerySchema: ToolSchema = {
  name: "godot_api_query",
  description:
    "Query the ClassDB and global script-class registry of the currently running Godot editor. Use this before making version-sensitive claims about engine classes, inheritance, properties, methods, signals, enums, or constants. Script-defined member bodies remain available through project_symbol_search and read_file.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "describe", "inheriters"], default: "search" },
      query: { type: "string", maxLength: 128, description: "Class-name search text; may be empty" },
      class_name: { type: "string", minLength: 1, maxLength: 128 },
      member_query: { type: "string", maxLength: 128 },
      include_inherited: { type: "boolean", default: true },
      limit: { type: "integer", minimum: 1, maximum: 256, default: 64 },
    },
    additionalProperties: false,
  },
};

const sceneApplyOperationsSchema: ToolSchema = {
  name: "scene_apply_operations",
  description:
    "Apply structured changes to one scene leased when this turn started. Pass that target's scene_id; the Runtime securely binds its exact turn-local revision, so the model must not copy or invent the opaque token. Supports node creation, property/resource changes, duplication, reparenting, packed-scene instantiation, renaming, and removal. Each call requires approval, creates one Godot undo action in the target scene history, and leaves the scene unsaved for review. Re-read the same scene_id after applying.",
  parameters: {
    type: "object",
    properties: {
      scene_id: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Required scene id returned by scene_get_tree",
      },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                action: { const: "add_node" },
                parent_path: {
                  type: "string",
                  minLength: 1,
                  maxLength: 512,
                  pattern: LIVE_NODE_PATH_PATTERN,
                  description: "Root-relative parent NodePath; use . for the scene root",
                },
                node_type: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 128 },
                name: { type: "string", pattern: LIVE_NODE_NAME_PATTERN, maxLength: 128 },
                properties: {
                  type: "object",
                  maxProperties: 64,
                  propertyNames: { pattern: PROPERTY_PATTERN },
                  additionalProperties: liveEditorSceneValueSchema,
                },
              },
              required: ["action", "parent_path", "node_type", "name"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "set_property" },
                node_path: { type: "string", minLength: 1, maxLength: 512, pattern: LIVE_NODE_PATH_PATTERN },
                property: { type: "string", pattern: PROPERTY_PATTERN, maxLength: 256 },
                value: liveEditorSceneValueSchema,
              },
              required: ["action", "node_path", "property", "value"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "rename_node" },
                node_path: { type: "string", minLength: 1, maxLength: 512, pattern: LIVE_NODE_PATH_PATTERN },
                new_name: { type: "string", pattern: LIVE_NODE_NAME_PATTERN, maxLength: 128 },
              },
              required: ["action", "node_path", "new_name"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "remove_node" },
                node_path: { type: "string", minLength: 1, maxLength: 512, pattern: LIVE_NODE_PATH_PATTERN },
              },
              required: ["action", "node_path"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "duplicate_node" },
                node_path: { type: "string", minLength: 1, maxLength: 512, pattern: LIVE_NODE_PATH_PATTERN },
                parent_path: { type: "string", minLength: 1, maxLength: 512, pattern: LIVE_NODE_PATH_PATTERN },
                name: { type: "string", pattern: LIVE_NODE_NAME_PATTERN, maxLength: 128 },
              },
              required: ["action", "node_path"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "reparent_node" },
                node_path: { type: "string", minLength: 1, maxLength: 512, pattern: LIVE_NODE_PATH_PATTERN },
                new_parent_path: { type: "string", minLength: 1, maxLength: 512, pattern: LIVE_NODE_PATH_PATTERN },
                index: { type: "integer", minimum: 0, maximum: 1000000 },
                new_name: { type: "string", pattern: LIVE_NODE_NAME_PATTERN, maxLength: 128 },
                keep_global_transform: {
                  type: "boolean",
                  default: true,
                  description: "Preserve a CanvasItem or Node3D global transform while reparenting",
                },
              },
              required: ["action", "node_path", "new_parent_path"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "instantiate_scene" },
                parent_path: { type: "string", minLength: 1, maxLength: 512, pattern: LIVE_NODE_PATH_PATTERN },
                scene_path: { type: "string", minLength: 7, maxLength: 1024, pattern: "^res://" },
                name: { type: "string", pattern: LIVE_NODE_NAME_PATTERN, maxLength: 128 },
                properties: {
                  type: "object",
                  maxProperties: 64,
                  propertyNames: { pattern: PROPERTY_PATTERN },
                  additionalProperties: liveEditorSceneValueSchema,
                },
              },
              required: ["action", "parent_path", "scene_path"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ["scene_id", "operations"],
    additionalProperties: false,
  },
};

const gameDebugStartSchema: ToolSchema = {
  name: "game_debug_start",
  description:
    "Start the project, the turn's frozen current scene, or a specific project scene inside the existing Godot editor. This requires user approval. Current mode is resolved to the primary scene captured when the turn started, so switching tabs cannot retarget it. Omit scene_path for main and current because any supplied value is safely ignored. Use mode scene with scene_path for a specific .tscn or .scn resource; do not launch a separate Godot process.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["main", "current", "scene"],
        description: "main runs the project entry point, current runs the current editor scene, and scene runs scene_path",
      },
      scene_path: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        description: "Project-relative or res:// .tscn/.scn path; required and validated for scene, ignored for main and current",
      },
    },
    required: ["mode"],
    additionalProperties: false,
  },
};

const gameDebugStatusSchema: ToolSchema = {
  name: "game_debug_status",
  description:
    "Read the status and recent captured output of a game started through GodotX in the existing Godot editor. Start only requests a launch, so poll until launch_observed and probe_confirmed are true or the run ends/fails before claiming runtime validation. This is read-only and does not require approval.",
  parameters: {
    type: "object",
    properties: {
      history_limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        default: 100,
        description: "Maximum number of recent output records to return",
      },
      after_seq: {
        type: "integer",
        minimum: 0,
        description: "Return records after this sequence; reuse next_seq from the previous status result",
      },
    },
    additionalProperties: false,
  },
};

const gameDebugStopSchema: ToolSchema = {
  name: "game_debug_stop",
  description:
    "Stop the matching game owned by the current GodotX editor host. Pass the run_id returned by game_debug_start or game_debug_status. Ownership and stale-run checks are enforced by the host. This does not require approval.",
  parameters: {
    type: "object",
    properties: {
      run_id: {
        type: "string",
        minLength: 16,
        maxLength: 128,
        pattern: "^[A-Za-z0-9_-]+$",
      },
    },
    required: ["run_id"],
    additionalProperties: false,
  },
};

const gameCaptureScreenshotSchema: ToolSchema = {
  name: "game_capture_screenshot",
  description:
    "Capture the current rendered frame from the exact GodotX-owned running game. The host binds the request to run_id, debugger session, capture_id, scene, frame number, and viewport dimensions. The image is attached as a visual observation on the next model step; do not poll for it or use desktop screenshots.",
  parameters: {
    type: "object",
    properties: {
      run_id: {
        type: "string",
        minLength: 16,
        maxLength: 128,
        pattern: "^[A-Za-z0-9_-]+$",
      },
      max_dimension: {
        type: "integer",
        minimum: 64,
        maximum: 2048,
        default: 1600,
        description: "Maximum encoded width or height before the frame is attached",
      },
      detail: {
        type: "string",
        enum: ["low", "high"],
        default: "high",
        description: "Vision detail sent to the selected model",
      },
    },
    required: ["run_id"],
    additionalProperties: false,
  },
};

const automationIdentifierSchema = {
  type: "string",
  minLength: 16,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
};

const automationNodePathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: LIVE_NODE_PATH_PATTERN,
};

const automationAssertionValueSchema = {
  description: "A bounded JSON value used for a runtime property comparison",
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string", maxLength: 4096 },
    {
      type: "array",
      maxItems: 64,
      items: {
        anyOf: [
          { type: "null" },
          { type: "boolean" },
          { type: "number" },
          { type: "string", maxLength: 4096 },
        ],
      },
    },
    {
      type: "object",
      maxProperties: 64,
      propertyNames: { minLength: 1, maxLength: 128 },
      additionalProperties: {
        anyOf: [
          { type: "null" },
          { type: "boolean" },
          { type: "number" },
          { type: "string", maxLength: 4096 },
        ],
      },
    },
  ],
};

const gameAutomationRunSchema: ToolSchema = {
  name: "game_automation_run",
  description:
    "Queue one bounded input-and-assertion plan inside the matching GodotX-owned game run. The host executes the whole plan locally and returns an automation_id immediately; poll game_automation_status instead of driving each step through model turns. Available only when Runtime Automation is enabled for this turn.",
  parameters: {
    type: "object",
    properties: {
      run_id: automationIdentifierSchema,
      stop_on_failure: {
        type: "boolean",
        default: true,
        description: "Stop at the first failed action or assertion",
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        description: "Ordered local steps with an aggregate scheduled budget of at most 7200 frames",
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                type: { const: "wait_frames" },
                frames: { type: "integer", minimum: 1, maximum: 3600 },
              },
              required: ["type", "frames"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "click_control" },
                node_path: automationNodePathSchema,
                button: {
                  type: "integer",
                  enum: [1, 2, 3],
                  default: 1,
                  description: "Godot mouse button index: 1 left, 2 right, 3 middle",
                },
              },
              required: ["type", "node_path"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "press_action" },
                action: { type: "string", minLength: 1, maxLength: 128 },
                pressed: { type: "boolean", default: true },
                duration_frames: {
                  type: "integer",
                  minimum: 1,
                  maximum: 600,
                  default: 1,
                  description: "Frames before an automatic release; omit duration_frames when pressed is false",
                },
              },
              required: ["type", "action"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "assert_node" },
                node_path: automationNodePathSchema,
                check: { const: "exists" },
                exists: { type: "boolean", default: true },
                timeout_frames: { type: "integer", minimum: 0, maximum: 600, default: 0 },
              },
              required: ["type", "node_path", "check"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "assert_node" },
                node_path: automationNodePathSchema,
                check: { type: "string", enum: ["property_equals", "property_contains"] },
                property: { type: "string", minLength: 1, maxLength: 256, pattern: PROPERTY_PATTERN },
                value: automationAssertionValueSchema,
                timeout_frames: { type: "integer", minimum: 0, maximum: 600, default: 0 },
              },
              required: ["type", "node_path", "check", "property", "value"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ["run_id", "steps"],
    additionalProperties: false,
  },
};

const gameAutomationStatusSchema: ToolSchema = {
  name: "game_automation_status",
  description:
    "Read progress, assertion results, and the terminal outcome of one runtime automation plan. Pass the exact run_id and automation_id returned by game_automation_run. This remains read-only when Runtime Automation is disabled.",
  parameters: {
    type: "object",
    properties: {
      run_id: automationIdentifierSchema,
      automation_id: automationIdentifierSchema,
    },
    required: ["run_id", "automation_id"],
    additionalProperties: false,
  },
};

const gameAutomationCancelSchema: ToolSchema = {
  name: "game_automation_cancel",
  description:
    "Cancel one queued or running runtime automation plan using its exact run_id and automation_id. Available only when Runtime Automation is enabled for this turn.",
  parameters: {
    type: "object",
    properties: {
      run_id: automationIdentifierSchema,
      automation_id: automationIdentifierSchema,
    },
    required: ["run_id", "automation_id"],
    additionalProperties: false,
  },
};

const gameTestSchema: ToolSchema = {
  name: "game_test",
  description:
    "Run one complete provider-neutral game verification workflow through the existing Godot editor: request launch approval, wait locally for the exact owned run and runtime probe, execute one bounded automation plan, wait locally for its terminal result, and safely clean up according to the requested policy. Prefer this over manually alternating game debug and automation tools when one plan can express the test.",
  parameters: {
    type: "object",
    properties: {
      target: gameDebugStartSchema.parameters,
      steps: (gameAutomationRunSchema.parameters.properties as Record<string, unknown>).steps,
      stop_on_failure: {
        type: "boolean",
        default: true,
        description: "Stop the local automation plan at its first failed action or assertion",
      },
      cleanup: {
        type: "string",
        enum: ["always", "on_success", "never"],
        default: "always",
        description:
          "Whether to stop the exact GodotX-owned game after every outcome, only after success, or never",
      },
      capture: {
        type: "string",
        enum: ["never", "after", "on_failure", "always"],
        default: "never",
        description:
          "Optionally capture a bound rendered frame before cleanup: after a terminal automation result, only on failure, or whenever a live owned run is available. The frame becomes a visual observation for the next model step.",
      },
      capture_max_dimension: {
        type: "integer",
        minimum: 64,
        maximum: 2048,
        default: 1600,
        description: "Maximum encoded width or height for the optional visual observation",
      },
      capture_detail: {
        type: "string",
        enum: ["low", "high"],
        default: "high",
        description: "Vision detail for the optional rendered-frame observation",
      },
      ready_timeout_ms: {
        type: "integer",
        minimum: 100,
        maximum: 300000,
        default: DEFAULT_GAME_TEST_READY_TIMEOUT_MS,
        description: "Maximum local wait for launch observation and the runtime probe handshake",
      },
      automation_timeout_ms: {
        type: "integer",
        minimum: 100,
        maximum: 300000,
        default: DEFAULT_GAME_TEST_AUTOMATION_TIMEOUT_MS,
        description: "Maximum local wait for the submitted automation plan to reach a terminal state",
      },
    },
    required: ["target", "steps"],
    additionalProperties: false,
  },
};

const editorReadToolSchemas: ToolSchema[] = [
  godotApiQuerySchema,
  sceneGetTreeSchema,
  editorGetSelectionSchema,
  nodeGetPropertiesSchema,
  resourceInspectSchema,
];

type GameDebugStartMode = "main" | "current" | "scene";

type GameDebugStartArguments = Record<string, unknown> & {
  mode: GameDebugStartMode;
  scene_path?: string;
};

type GameTestCleanup = "always" | "on_success" | "never";

interface GameTestArguments {
  target: GameDebugStartArguments;
  steps: GameAutomationStep[];
  stop_on_failure: boolean;
  cleanup: GameTestCleanup;
  capture: "never" | "after" | "on_failure" | "always";
  capture_max_dimension: number;
  capture_detail: "low" | "high";
  ready_timeout_ms: number;
  automation_timeout_ms: number;
}

export type EditorSceneOperation =
  | {
      action: "add_node";
      parent_path: string;
      node_type: string;
      name: string;
      properties?: Record<string, unknown>;
    }
  | { action: "set_property"; node_path: string; property: string; value: unknown }
  | { action: "rename_node"; node_path: string; new_name: string }
  | { action: "remove_node"; node_path: string }
  | { action: "duplicate_node"; node_path: string; parent_path?: string; name?: string }
  | {
      action: "reparent_node";
      node_path: string;
      new_parent_path: string;
      index?: number;
      new_name?: string;
      keep_global_transform: boolean;
    }
  | {
      action: "instantiate_scene";
      parent_path: string;
      scene_path: string;
      name?: string;
      properties?: Record<string, unknown>;
    };

export type EditorSceneChange = Record<string, unknown> & {
  scene_id: string;
  scene_revision: string;
  operations: EditorSceneOperation[];
};

export type EditorSceneChangeRequest = Record<string, unknown> & {
  scene_id: string;
  scene_revision?: string;
  operations: EditorSceneOperation[];
};

function readEditorSceneChange(args: Readonly<Record<string, unknown>>): EditorSceneChangeRequest {
  rejectUnknownArgumentKeys(args, ["scene_id", "scene_revision", "operations"]);
  const sceneId = readLimitedIdentifier(args.scene_id, "scene_id", 128);
  const sceneRevision = args.scene_revision === undefined || args.scene_revision === ""
    ? undefined
    : readLimitedIdentifier(args.scene_revision, "scene_revision", 128);
  if (!Array.isArray(args.operations) || args.operations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
  if (args.operations.length > 64) throw new Error("operations exceeds the 64 item limit");
  const change: EditorSceneChangeRequest = {
    scene_id: sceneId,
    ...(sceneRevision ? { scene_revision: sceneRevision } : {}),
    operations: args.operations.map((operation, index) => readEditorSceneOperation(operation, index)),
  };
  if (Buffer.byteLength(JSON.stringify(change), "utf8") > MAX_EDITOR_SCENE_CHANGE_BYTES) {
    throw new Error("scene_apply_operations normalized request exceeds the 512 KiB limit");
  }
  return change;
}

function readEditorSceneOperation(value: unknown, index: number): EditorSceneOperation {
  if (!isRecord(value)) throw new Error(`operations[${index}] must be an object`);
  const field = (name: string): string => `operations[${index}].${name}`;
  switch (value.action) {
    case "add_node": {
      rejectUnknownKeys(value, ["action", "parent_path", "node_type", "name", "properties"], index);
      const properties = value.properties === undefined
        ? undefined
        : readEditorSceneProperties(value.properties, field("properties"));
      return {
        action: "add_node",
        parent_path: readLiveNodePath(value.parent_path, field("parent_path")),
        node_type: readEditorIdentifier(value.node_type, field("node_type")),
        name: readEditorNodeName(value.name, field("name")),
        ...(properties !== undefined ? { properties } : {}),
      };
    }
    case "set_property":
      rejectUnknownKeys(value, ["action", "node_path", "property", "value"], index);
      if (!Object.hasOwn(value, "value")) throw new Error(`${field("value")} is required`);
      return {
        action: "set_property",
        node_path: readLiveNodePath(value.node_path, field("node_path")),
        property: readEditorProperty(value.property, field("property")),
        value: readEditorSceneValue(value.value, field("value")),
      };
    case "rename_node":
      rejectUnknownKeys(value, ["action", "node_path", "new_name"], index);
      return {
        action: "rename_node",
        node_path: readLiveNodePath(value.node_path, field("node_path")),
        new_name: readEditorNodeName(value.new_name, field("new_name")),
      };
    case "remove_node":
      rejectUnknownKeys(value, ["action", "node_path"], index);
      return {
        action: "remove_node",
        node_path: readLiveNodePath(value.node_path, field("node_path")),
      };
    case "duplicate_node":
      rejectUnknownKeys(value, ["action", "node_path", "parent_path", "name"], index);
      return {
        action: "duplicate_node",
        node_path: readLiveNodePath(value.node_path, field("node_path")),
        ...(value.parent_path !== undefined
          ? { parent_path: readLiveNodePath(value.parent_path, field("parent_path")) }
          : {}),
        ...(value.name !== undefined
          ? { name: readEditorNodeName(value.name, field("name")) }
          : {}),
      };
    case "reparent_node":
      rejectUnknownKeys(
        value,
        ["action", "node_path", "new_parent_path", "index", "new_name", "keep_global_transform"],
        index,
      );
      return {
        action: "reparent_node",
        node_path: readLiveNodePath(value.node_path, field("node_path")),
        new_parent_path: readLiveNodePath(value.new_parent_path, field("new_parent_path")),
        ...(value.index !== undefined
          ? { index: readEditorChildIndex(value.index, field("index")) }
          : {}),
        ...(value.new_name !== undefined
          ? { new_name: readEditorNodeName(value.new_name, field("new_name")) }
          : {}),
        keep_global_transform: readOptionalBoolean(
          value.keep_global_transform,
          true,
          field("keep_global_transform"),
        ),
      };
    case "instantiate_scene": {
      rejectUnknownKeys(value, ["action", "parent_path", "scene_path", "name", "properties"], index);
      const properties = value.properties === undefined
        ? undefined
        : readEditorSceneProperties(value.properties, field("properties"));
      return {
        action: "instantiate_scene",
        parent_path: readLiveNodePath(value.parent_path, field("parent_path")),
        scene_path: readLiveResourcePath(value.scene_path, field("scene_path")),
        ...(value.name !== undefined
          ? { name: readEditorNodeName(value.name, field("name")) }
          : {}),
        ...(properties !== undefined ? { properties } : {}),
      };
    }
    default:
      throw new Error(
        `operations[${index}].action must be add_node, set_property, rename_node, remove_node, duplicate_node, reparent_node, or instantiate_scene`,
      );
  }
}

function readEditorSceneProperties(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error(`${field} exceeds the 64 property limit`);
  return Object.fromEntries(entries.map(([name, propertyValue]) => [
    readEditorProperty(name, `${field} property name`),
    readEditorSceneValue(propertyValue, `${field}.${name}`),
  ]));
}

function readEditorSceneValue(value: unknown, field: string): unknown {
  if (!Array.isArray(value)) return readEditorSceneAtomicValue(value, field);
  if (value.length > 256) throw new Error(`${field} exceeds the 256 item array limit`);
  return value.map((entry, index) => {
    const normalized = readEditorSceneAtomicValue(entry, `${field}[${index}]`);
    if (
      isRecord(normalized) &&
      (normalized.godot_type === "NodePath" || normalized.godot_type === "Resource")
    ) {
      throw new Error(`${field}[${index}] Resource and NodePath tags are only supported as scalar properties`);
    }
    return normalized;
  });
}

function readEditorSceneAtomicValue(value: unknown, field: string): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 16_384) throw new Error(`${field} exceeds the 16384 character limit`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${field} must be a safe integer when it has no fractional component`);
    }
    return value;
  }
  if (!isRecord(value) || typeof value.godot_type !== "string") {
    throw new Error(`${field} must be a supported JSON-safe Godot value`);
  }
  if (value.godot_type === "int64") {
    const unknown = Object.keys(value).find((key) => !["godot_type", "value"].includes(key));
    if (unknown) throw new Error(`${field} contains unsupported field: ${unknown}`);
    return {
      godot_type: "int64",
      value: readCanonicalInt64(value.value, `${field}.value`),
    };
  }
  if (value.godot_type === "NodePath") {
    const unknown = Object.keys(value).find((key) => !["godot_type", "path"].includes(key));
    if (unknown) throw new Error(`${field} contains unsupported field: ${unknown}`);
    return {
      godot_type: "NodePath",
      path: readPropertyNodePath(value.path, `${field}.path`),
    };
  }
  if (value.godot_type === "Resource") {
    const allowed = ["godot_type", "path", "expected_type", "resource_type", "uid", "name"];
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new Error(`${field} contains unsupported field: ${unknown}`);
    const expectedType = value.expected_type === undefined
      ? undefined
      : readEditorIdentifier(value.expected_type, `${field}.expected_type`);
    const resourceType = value.resource_type === undefined
      ? undefined
      : readEditorIdentifier(value.resource_type, `${field}.resource_type`);
    if (value.path === undefined && value.uid === undefined) {
      throw new Error(`${field} Resource requires a res:// path, uid:// UID, or both`);
    }
    if (value.name !== undefined) readSafeMetadataString(value.name, `${field}.name`, 512);
    return {
      godot_type: "Resource",
      ...(value.path !== undefined
        ? { path: readLiveResourcePath(value.path, `${field}.path`) }
        : {}),
      ...(expectedType || resourceType ? { expected_type: expectedType ?? resourceType } : {}),
      ...(value.uid !== undefined
        ? { uid: readResourceUid(value.uid, `${field}.uid`) }
        : {}),
    };
  }
  const specs: Record<string, { fields: string[]; integers: boolean }> = {
    Vector2: { fields: ["x", "y"], integers: false },
    Vector2i: { fields: ["x", "y"], integers: true },
    Vector3: { fields: ["x", "y", "z"], integers: false },
    Vector3i: { fields: ["x", "y", "z"], integers: true },
    Vector4: { fields: ["x", "y", "z", "w"], integers: false },
    Vector4i: { fields: ["x", "y", "z", "w"], integers: true },
    Color: { fields: ["r", "g", "b", "a"], integers: false },
  };
  const spec = specs[value.godot_type];
  if (!spec) throw new Error(`${field}.godot_type is not supported`);
  const allowed = ["godot_type", ...spec.fields];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${field} contains unsupported field: ${unknown}`);
  const result: Record<string, unknown> = { godot_type: value.godot_type };
  for (const component of spec.fields) {
    const componentValue = value[component];
    if (
      typeof componentValue !== "number" ||
      !Number.isFinite(componentValue) ||
      (spec.integers && (
        !Number.isInteger(componentValue) ||
        componentValue < -2_147_483_648 ||
        componentValue > 2_147_483_647
      ))
    ) {
      throw new Error(
        `${field}.${component} must be ${spec.integers ? "a signed 32-bit integer" : "a finite number"}`,
      );
    }
    result[component] = componentValue;
  }
  return result;
}

function readCanonicalInt64(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 20 ||
    !/^(?:0|-?[1-9][0-9]*)$/u.test(value)
  ) {
    throw new Error(`${field} must be a canonical signed decimal int64 string`);
  }
  const integer = BigInt(value);
  if (integer < -9_223_372_036_854_775_808n || integer > 9_223_372_036_854_775_807n) {
    throw new Error(`${field} must be within the signed 64-bit range`);
  }
  return value;
}

function readLiveNodePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${field} must be a non-empty NodePath of at most 512 characters`);
  }
  if (value !== ".") {
    const parts = value.split("/");
    if (parts.some((part) => part.length === 0)) {
      throw new Error(`${field} must be a root-relative NodePath using safe node names`);
    }
    for (let index = 0; index < parts.length; index += 1) {
      readEditorNodeName(parts[index], `${field} segment ${index}`);
    }
  }
  return value;
}

function readPropertyNodePath(value: unknown, field: string): string {
  if (value === "") return value;
  try {
    return readLiveNodePath(value, field);
  } catch {
    throw new Error(
      `${field} must be empty or a safe current-scene root-relative NodePath of at most 512 characters`,
    );
  }
}

function readLiveResourcePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 7 || value.length > 1024 || !value.startsWith("res://")) {
    throw new Error(`${field} must be a res:// project resource path of at most 1024 characters`);
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f?#]/u.test(value)) {
    throw new Error(`${field} must be a safe res:// project resource path`);
  }
  const relative = value.slice("res://".length);
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${field} must stay within the res:// project resource tree`);
  }
  return value;
}

function readResourceUid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^uid:\/\/[a-z0-9]+$/u.test(value)
  ) {
    throw new Error(`${field} must use the Godot uid:// format with lowercase letters and digits`);
  }
  return value;
}

function readEditorChildIndex(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${field} must be an integer between 0 and 1000000`);
  }
  return value;
}

function readSafeMetadataString(value: unknown, field: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} must be a safe string of at most ${maximumLength} characters`);
  }
  return value;
}

function readEditorNodeName(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f\.:@/"%\\]/u.test(value)
  ) {
    throw new Error(`${field} must be a safe Godot node name of at most 128 characters`);
  }
  return value;
}

function readEditorIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
  ) {
    throw new Error(`${field} must be a safe Godot identifier of at most 128 characters`);
  }
  return value;
}

function readEditorProperty(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !new RegExp(PROPERTY_PATTERN, "u").test(value)
  ) {
    throw new Error(`${field} must be a flat safe Godot property name of at most 256 characters`);
  }
  const propertyRoot = value.split("/", 1)[0]!;
  if (BLOCKED_LIVE_SCENE_PROPERTY_ROOTS.has(propertyRoot)) {
    throw new Error(
      `${field} cannot modify protected structural or script property ${propertyRoot}; use a dedicated scene operation`,
    );
  }
  return value;
}

function makeEditorSceneBindingKey(request: EditorSceneChangeRequest, context: ToolContext): string {
  const canonicalRequest = JSON.stringify(canonicalizeJson({
    scene_id: request.scene_id,
    operations: request.operations,
  }));
  return createHash("sha256")
    .update(context.sessionId)
    .update("\0")
    .update(context.turnId)
    .update("\0")
    .update(canonicalRequest)
    .digest("hex");
}

function makeEditorOperationId(change: EditorSceneChange, context: ToolContext): string {
  const canonicalChange = JSON.stringify(canonicalizeJson(change));
  const digest = createHash("sha256")
    .update(context.sessionId)
    .update("\0")
    .update(context.turnId)
    .update("\0")
    .update(canonicalChange)
    .digest("hex");
  return `editor_operation_${digest}`;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key])]),
  );
}

function makeEditorSceneTurnKey(context: Pick<ToolContext, "sessionId" | "turnId">): string {
  return `${context.sessionId}\0${context.turnId}`;
}

function makeEditorSceneContextFingerprint(context: Readonly<EditorSceneLeaseContext>): string {
  return JSON.stringify({
    primary_scene_id: context.primary_scene_id,
    scene_leases: [...context.scene_leases]
      .sort((left, right) => left.scene_id.localeCompare(right.scene_id))
      .map((lease) => ({ ...lease })),
    open_scene_paths: [...context.open_scene_paths].sort(),
  });
}

function normalizeSceneFilePath(input: string): string {
  const portable = input.replaceAll("\\", "/");
  const relative = portable.startsWith("res://") ? portable.slice("res://".length) : portable;
  const normalized = normalizeRelative(relative);
  if (
    process.platform === "win32" &&
    normalized.split("/").some((segment) => segment.includes(":") || /[. ]$/u.test(segment))
  ) {
    throw new Error(`Unsafe Windows path alias is not allowed: ${input}`);
  }
  return normalized;
}

function sceneFilePathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sameSceneFileIdentity(
  left: WorkspaceFileIdentity,
  right: WorkspaceFileIdentity | undefined,
): boolean {
  if (!right) return false;
  return left.realPath === right.realPath || Boolean(left.fileId && left.fileId === right.fileId);
}

function normalizeDisplayScenePath(input: string): string {
  const portable = input.replaceAll("\\", "/");
  const relative = portable.startsWith("res://") ? portable.slice("res://".length) : portable;
  return normalizeRelative(relative);
}

function normalizeEditorToolArguments(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  switch (toolName) {
    case "scene_get_tree":
      rejectUnknownArgumentKeys(args, ["scene_id", "max_depth", "max_nodes", "include_internal", "root_path"]);
      return {
        ...(args.scene_id !== undefined
          ? { scene_id: readLimitedIdentifier(args.scene_id, "scene_id", 128) }
          : {}),
        max_depth: readBoundedInteger(args.max_depth, 6, 0, 8, "max_depth"),
        max_nodes: readBoundedInteger(args.max_nodes, 200, 1, 500, "max_nodes"),
        include_internal: readOptionalBoolean(args.include_internal, false, "include_internal"),
        ...(args.root_path !== undefined ? { root_path: readEditorNodePath(args.root_path) } : {}),
      };
    case "editor_get_selection":
      rejectUnknownArgumentKeys(args, ["limit"]);
      return { limit: readBoundedInteger(args.limit, 64, 1, 128, "limit") };
    case "node_get_properties": {
      rejectUnknownArgumentKeys(args, [
        "node_path",
        "scene_id",
        "property_names",
        "max_properties",
        "include_storage",
      ]);
      return {
        node_path: readEditorNodePath(args.node_path),
        ...(args.scene_id !== undefined ? { scene_id: readLimitedIdentifier(args.scene_id, "scene_id", 128) } : {}),
        ...(args.property_names !== undefined
          ? { property_names: readPropertyNames(args.property_names) }
          : {}),
        max_properties: readBoundedInteger(args.max_properties, 128, 1, 256, "max_properties"),
        include_storage: readOptionalBoolean(args.include_storage, false, "include_storage"),
      };
    }
    case "resource_inspect":
      rejectUnknownArgumentKeys(args, [
        "path",
        "property_names",
        "max_properties",
        "include_dependencies",
        "dependency_limit",
      ]);
      return {
        path: readEditorResourcePath(args.path),
        ...(args.property_names !== undefined
          ? { property_names: readPropertyNames(args.property_names) }
          : {}),
        max_properties: readBoundedInteger(args.max_properties, 128, 1, 256, "max_properties"),
        include_dependencies: readOptionalBoolean(args.include_dependencies, true, "include_dependencies"),
        dependency_limit: readBoundedInteger(args.dependency_limit, 128, 1, 256, "dependency_limit"),
      };
    case "godot_api_query": {
      rejectUnknownArgumentKeys(args, ["action", "query", "class_name", "member_query", "include_inherited", "limit"]);
      const action = args.action ?? "search";
      if (action !== "search" && action !== "describe" && action !== "inheriters") {
        throw new Error("action must be search, describe, or inheriters");
      }
      if (action !== "search" && args.class_name === undefined) {
        throw new Error("class_name is required for describe and inheriters");
      }
      return {
        action,
        ...(args.query !== undefined ? { query: readSafeString(args.query, "query", 128, true) } : {}),
        ...(args.class_name !== undefined
          ? { class_name: readLimitedIdentifier(args.class_name, "class_name", 128) }
          : {}),
        ...(args.member_query !== undefined
          ? { member_query: readSafeString(args.member_query, "member_query", 128, true) }
          : {}),
        include_inherited: readOptionalBoolean(args.include_inherited, true, "include_inherited"),
        limit: readBoundedInteger(args.limit, 64, 1, 256, "limit"),
      };
    }
    default:
      throw new Error(`Unknown editor tool: ${toolName}`);
  }
}

function readGameDebugStartArguments(
  args: Readonly<Record<string, unknown>>,
): GameDebugStartArguments {
  rejectUnknownArgumentKeys(args, ["mode", "scene_path"]);
  const mode = args.mode;
  if (mode !== "main" && mode !== "current" && mode !== "scene") {
    throw new Error("mode must be one of: main, current, scene");
  }
  if (mode === "scene") {
    if (args.scene_path === undefined) {
      throw new Error("scene_path is required when mode is scene");
    }
    return { mode, scene_path: readGameDebugScenePath(args.scene_path) };
  }
  // Only scene mode owns a caller-supplied target. Ignore a redundant path
  // before path validation so main cannot be retargeted and current remains
  // bound to the turn's frozen primary scene.
  return { mode };
}

function readGameDebugStatusArguments(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  rejectUnknownArgumentKeys(args, ["history_limit", "after_seq"]);
  return {
    history_limit: readBoundedInteger(args.history_limit, 100, 1, 500, "history_limit"),
    after_seq: readBoundedInteger(args.after_seq, 0, 0, Number.MAX_SAFE_INTEGER, "after_seq"),
  };
}

function readGameDebugStopArguments(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  rejectUnknownArgumentKeys(args, ["run_id"]);
  if (
    typeof args.run_id !== "string" ||
    args.run_id.length < 16 ||
    args.run_id.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(args.run_id)
  ) {
    throw new Error("run_id must be a safe string of 16 to 128 characters");
  }
  return { run_id: args.run_id };
}

interface GameCaptureScreenshotArguments {
  run_id: string;
  max_dimension: number;
  detail: "low" | "high";
}

function readGameCaptureScreenshotArguments(
  args: Readonly<Record<string, unknown>>,
): GameCaptureScreenshotArguments {
  rejectUnknownArgumentKeys(args, ["run_id", "max_dimension", "detail"]);
  const runId = readAutomationIdentifier(args.run_id, "run_id");
  const detail = args.detail ?? "high";
  if (detail !== "low" && detail !== "high") throw new Error("detail must be low or high");
  return {
    run_id: runId,
    max_dimension: readBoundedInteger(args.max_dimension, 1600, 64, 2048, "max_dimension"),
    detail,
  };
}

function readGameScreenshotObservation(
  output: Readonly<Record<string, unknown>>,
  expectedRunId: string,
  detail: "low" | "high",
): {
  text: string;
  image: {
    type: "image";
    attachmentId: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    detail: "low" | "high";
  };
} {
  if (output.run_id !== expectedRunId) {
    throw new Error("The game screenshot belongs to a different run_id");
  }
  const attachmentId = output.attachment_id;
  if (typeof attachmentId !== "string" || !/^[a-f0-9]{64}$/u.test(attachmentId)) {
    throw new Error("The game screenshot returned an invalid attachment_id");
  }
  const mimeType = output.mime_type;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    throw new Error("The game screenshot returned an unsupported image MIME type");
  }
  const width = readBoundedInteger(output.width, -1, 1, 2048, "screenshot width");
  const height = readBoundedInteger(output.height, -1, 1, 2048, "screenshot height");
  const frame = readNonNegativeSafeInteger(output.frame, 0);
  const scenePath = typeof output.scene_path === "string" && output.scene_path.length <= 1_024
    ? output.scene_path
    : "";
  const location = scenePath ? ` in ${scenePath}` : "";
  return {
    text: `Visual observation from GodotX-owned run ${expectedRunId}${location}, frame ${frame}, ${width}x${height}. Inspect this rendered game frame together with the structured debug and scene data.`,
    image: {
      type: "image",
      attachmentId,
      mimeType,
      detail,
    },
  };
}

type GameAutomationStep =
  | { type: "wait_frames"; frames: number }
  | { type: "click_control"; node_path: string; button: number }
  | { type: "press_action"; action: string; pressed: true; duration_frames: number }
  | { type: "press_action"; action: string; pressed: false }
  | {
      type: "assert_node";
      node_path: string;
      check: "exists";
      exists: boolean;
      timeout_frames: number;
    }
  | {
      type: "assert_node";
      node_path: string;
      check: "property_equals" | "property_contains";
      property: string;
      value: unknown;
      timeout_frames: number;
    };

function readGameAutomationRunArguments(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  rejectUnknownArgumentKeys(args, ["run_id", "steps", "stop_on_failure"]);
  const runId = readAutomationIdentifier(args.run_id, "run_id");
  return {
    run_id: runId,
    ...readGameAutomationPlan(args.steps, args.stop_on_failure),
  };
}

function readGameTestArguments(
  args: Readonly<Record<string, unknown>>,
): GameTestArguments {
  rejectUnknownArgumentKeys(args, [
    "target",
    "steps",
    "stop_on_failure",
    "cleanup",
    "capture",
    "capture_max_dimension",
    "capture_detail",
    "ready_timeout_ms",
    "automation_timeout_ms",
  ]);
  if (!isRecord(args.target)) throw new Error("target must be an object");
  const target = readGameDebugStartArguments(args.target);
  const cleanup = args.cleanup ?? "always";
  if (cleanup !== "always" && cleanup !== "on_success" && cleanup !== "never") {
    throw new Error("cleanup must be one of: always, on_success, never");
  }
  const capture = args.capture ?? "never";
  if (capture !== "never" && capture !== "after" && capture !== "on_failure" && capture !== "always") {
    throw new Error("capture must be one of: never, after, on_failure, always");
  }
  const captureDetail = args.capture_detail ?? "high";
  if (captureDetail !== "low" && captureDetail !== "high") {
    throw new Error("capture_detail must be low or high");
  }
  const plan = readGameAutomationPlan(args.steps, args.stop_on_failure);
  return {
    target,
    steps: plan.steps,
    stop_on_failure: plan.stop_on_failure,
    cleanup,
    capture,
    capture_max_dimension: readBoundedInteger(
      args.capture_max_dimension,
      1600,
      64,
      2048,
      "capture_max_dimension",
    ),
    capture_detail: captureDetail,
    ready_timeout_ms: readBoundedInteger(
      args.ready_timeout_ms,
      DEFAULT_GAME_TEST_READY_TIMEOUT_MS,
      100,
      300_000,
      "ready_timeout_ms",
    ),
    automation_timeout_ms: readBoundedInteger(
      args.automation_timeout_ms,
      DEFAULT_GAME_TEST_AUTOMATION_TIMEOUT_MS,
      100,
      300_000,
      "automation_timeout_ms",
    ),
  };
}

function readGameAutomationPlan(
  stepValues: unknown,
  stopOnFailure: unknown,
): { steps: GameAutomationStep[]; stop_on_failure: boolean } {
  if (!Array.isArray(stepValues) || stepValues.length < 1 || stepValues.length > 64) {
    throw new Error("steps must be an array with between 1 and 64 entries");
  }
  let scheduledFrames = 0;
  const steps = stepValues.map((value, index) => {
    const step = readGameAutomationStep(value, index);
    if (step.type === "wait_frames") scheduledFrames += step.frames;
    else if (step.type === "press_action" && step.pressed) scheduledFrames += step.duration_frames;
    else if (step.type === "assert_node") scheduledFrames += step.timeout_frames;
    return step;
  });
  if (scheduledFrames > 7_200) {
    throw new Error("automation plan scheduled frame budget must not exceed 7200 frames");
  }
  return {
    steps,
    stop_on_failure: readOptionalBoolean(stopOnFailure, true, "stop_on_failure"),
  };
}

function readGameAutomationStep(value: unknown, index: number): GameAutomationStep {
  const field = `steps[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const step = value as Record<string, unknown>;
  switch (step.type) {
    case "wait_frames":
      rejectUnknownArgumentKeys(step, ["type", "frames"], field);
      return {
        type: "wait_frames",
        frames: readBoundedInteger(step.frames, -1, 1, 3_600, `${field}.frames`),
      };
    case "click_control":
      rejectUnknownArgumentKeys(step, ["type", "node_path", "button"], field);
      return {
        type: "click_control",
        node_path: readLiveNodePath(step.node_path, `${field}.node_path`),
        button: readBoundedInteger(step.button, 1, 1, 3, `${field}.button`),
      };
    case "press_action": {
      rejectUnknownArgumentKeys(step, ["type", "action", "pressed", "duration_frames"], field);
      const action = readAutomationAction(step.action, `${field}.action`);
      const pressed = readOptionalBoolean(step.pressed, true, `${field}.pressed`);
      if (!pressed) {
        if (step.duration_frames !== undefined) {
          throw new Error(`${field}.duration_frames is not allowed when pressed is false`);
        }
        return { type: "press_action", action, pressed: false };
      }
      return {
        type: "press_action",
        action,
        pressed: true,
        duration_frames: readBoundedInteger(
          step.duration_frames,
          1,
          1,
          600,
          `${field}.duration_frames`,
        ),
      };
    }
    case "assert_node": {
      if (step.check === "exists") {
        rejectUnknownArgumentKeys(step, ["type", "node_path", "check", "exists", "timeout_frames"], field);
        return {
          type: "assert_node",
          node_path: readLiveNodePath(step.node_path, `${field}.node_path`),
          check: "exists",
          exists: readOptionalBoolean(step.exists, true, `${field}.exists`),
          timeout_frames: readBoundedInteger(
            step.timeout_frames,
            0,
            0,
            600,
            `${field}.timeout_frames`,
          ),
        };
      }
      if (step.check === "property_equals" || step.check === "property_contains") {
        rejectUnknownArgumentKeys(step, ["type", "node_path", "check", "property", "value", "timeout_frames"], field);
        if (!Object.hasOwn(step, "value")) throw new Error(`${field}.value is required`);
        return {
          type: "assert_node",
          node_path: readLiveNodePath(step.node_path, `${field}.node_path`),
          check: step.check,
          property: readAutomationProperty(step.property, `${field}.property`),
          value: readAutomationJsonValue(step.value, `${field}.value`),
          timeout_frames: readBoundedInteger(
            step.timeout_frames,
            0,
            0,
            600,
            `${field}.timeout_frames`,
          ),
        };
      }
      throw new Error(`${field}.check must be one of: exists, property_equals, property_contains`);
    }
    default:
      throw new Error(`${field}.type must be one of: wait_frames, click_control, press_action, assert_node`);
  }
}

function readGameAutomationIdentity(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  rejectUnknownArgumentKeys(args, ["run_id", "automation_id"]);
  return {
    run_id: readAutomationIdentifier(args.run_id, "run_id"),
    automation_id: readAutomationIdentifier(args.automation_id, "automation_id"),
  };
}

function readAutomationIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error(`${field} must be a safe string of 16 to 128 characters`);
  }
  return value;
}

function readAutomationAction(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} must be a non-empty safe action name of at most 128 characters`);
  }
  return value;
}

function readAutomationProperty(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !new RegExp(PROPERTY_PATTERN, "u").test(value)
  ) {
    throw new Error(`${field} must be a flat safe Godot property name of at most 256 characters`);
  }
  return value;
}

function readAutomationJsonValue(value: unknown, field: string): unknown {
  const state = { entries: 0 };
  const result = readBoundedJsonValue(value, field, 0, state);
  const encoded = JSON.stringify(result);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 16_384) {
    throw new Error(`${field} must serialize to at most 16384 UTF-8 bytes`);
  }
  return result;
}

function readBoundedJsonValue(
  value: unknown,
  field: string,
  depth: number,
  state: { entries: number },
): unknown {
  state.entries += 1;
  if (state.entries > 256) throw new Error(`${field} exceeds the 256 value limit`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} numbers must be finite`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 4_096) throw new Error(`${field} strings must not exceed 4096 characters`);
    return value;
  }
  if (depth >= 4) throw new Error(`${field} must not exceed 4 nested levels`);
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error(`${field} arrays must not exceed 64 entries`);
    return value.map((entry, index) => readBoundedJsonValue(entry, `${field}[${index}]`, depth + 1, state));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 64) throw new Error(`${field} objects must not exceed 64 properties`);
    return Object.fromEntries(entries.map(([key, entry]) => {
      if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key)) {
        throw new Error(`${field} object keys must be safe strings of at most 128 characters`);
      }
      return [key, readBoundedJsonValue(entry, `${field}.${key}`, depth + 1, state)];
    }));
  }
  throw new Error(`${field} must be JSON-safe`);
}

function requireRuntimeAutomationEnabled(context: ToolContext): void {
  if (!context.runtimeAutomationEnabled) {
    throw new Error("Runtime game automation is disabled for this turn");
  }
}

function resolveEditorGameTarget(
  args: GameDebugStartArguments,
  context: ToolContext,
): GameDebugStartArguments {
  if (args.mode !== "current") return args;
  if (!context.primarySceneId) {
    throw new Error("current mode requires a primary scene captured when the turn started");
  }
  const lease = context.sceneLeases?.find(
    (candidate) => candidate.scene_id === context.primarySceneId,
  );
  if (!lease?.scene_path) {
    throw new Error("the turn's primary scene does not have a saved project path");
  }
  return { mode: "scene", scene_path: readGameDebugScenePath(lease.scene_path) };
}

function readGameDebugScenePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error("scene_path must be a non-empty project scene path without surrounding whitespace");
  }
  const relative = readEditorResourcePath(value);
  if (!/\.(?:tscn|scn)$/iu.test(relative)) {
    throw new Error("scene_path must reference a .tscn or .scn project scene");
  }
  return `res://${relative}`;
}

function editorToolExecutionContext(context: ToolContext, signal: AbortSignal = context.signal): {
  signal: AbortSignal;
  sessionId: string;
  turnId: string;
  itemId: string;
} {
  return {
    signal,
    sessionId: context.sessionId,
    turnId: context.turnId,
    itemId: context.itemId,
  };
}

class GameTestWorkflowError extends Error {
  constructor(readonly state: string, message: string) {
    super(message);
    this.name = "GameTestWorkflowError";
  }
}

interface LinkedTimeoutSignal {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
}

function createLinkedTimeoutSignal(parent: AbortSignal, timeoutMs: number): LinkedTimeoutSignal {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) onParentAbort();
  else parent.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Game test phase timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function waitForGameTestPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(normalizeAbortReason(signal.reason));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(normalizeAbortReason(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, GAME_TEST_POLL_INTERVAL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function emitGameTestProgress(
  context: ToolContext,
  phase: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): void {
  context.emit(
    "tool.output.delta",
    {
      kind: "game_test.progress",
      tool: gameTestSchema.name,
      phase,
      delta: `${message}\n`,
      ...details,
    },
    context.itemId,
  );
}

function isTerminalAutomationState(state: string): boolean {
  return state === "passed" || state === "failed" || state === "cancelled";
}

function isEndedGameDebugSnapshot(snapshot: Readonly<Record<string, unknown>>): boolean {
  if (typeof snapshot.ended_at_ms === "number" && snapshot.ended_at_ms > 0) return true;
  return (
    snapshot.launch_observed === true &&
    snapshot.playing === false &&
    snapshot.owned === false
  );
}

function readGameLaunchFailure(snapshot: Readonly<Record<string, unknown>>): string {
  if (typeof snapshot.runtime_probe_error === "string" && snapshot.runtime_probe_error.trim()) {
    return limitedGameTestText(snapshot.runtime_probe_error, 2_048);
  }
  if (Array.isArray(snapshot.entries)) {
    for (const value of [...snapshot.entries].reverse()) {
      if (!isRecord(value) || value.level !== "error" || typeof value.text !== "string") continue;
      if (value.text.trim()) return limitedGameTestText(value.text, 2_048);
    }
  }
  return "The game run ended before its runtime probe became ready";
}

function readEditorResultError(
  result: Readonly<Record<string, unknown>>,
  fallback: string,
): string {
  for (const key of ["failure", "error"] as const) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) {
      return limitedGameTestText(value, 2_048);
    }
  }
  return fallback;
}

function readNonNegativeSafeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

async function executeIndependentEditorRequest(
  editorClient: EditorToolClient,
  tool: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Game test cleanup request timed out: ${tool}`)),
    GAME_TEST_CLEANUP_TIMEOUT_MS,
  );
  try {
    return await editorClient.execute(
      tool,
      args,
      editorToolExecutionContext(context, controller.signal),
    );
  } finally {
    clearTimeout(timer);
  }
}

function appendBoundedGameDebugEntries(
  output: Record<string, unknown>[],
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  const knownSequences = new Set(
    output.flatMap((entry) => typeof entry.seq === "number" ? [entry.seq] : []),
  );
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.seq === "number" && knownSequences.has(entry.seq)) continue;
    output.push(copyCompactRuntimeEntry(entry));
    if (typeof entry.seq === "number") knownSequences.add(entry.seq);
  }
  if (output.length > 64) output.splice(0, output.length - 64);
}

function compactGameTestRecord(
  value: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> | null {
  if (!value) return null;
  const encoded = safeJsonStringify(value);
  if (Buffer.byteLength(encoded, "utf8") <= 4_096) {
    return JSON.parse(encoded) as Record<string, unknown>;
  }
  return {
    ok: value.ok === true,
    truncated: true,
    ...(typeof value.run_id === "string" ? { run_id: value.run_id } : {}),
    ...(typeof value.automation_id === "string" ? { automation_id: value.automation_id } : {}),
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(typeof value.error === "string"
      ? { error: limitedGameTestText(value.error, 2_048) }
      : {}),
  };
}

function compactGameDebugStatus(
  value: Readonly<Record<string, unknown>> | null,
  collectedEntries: readonly Readonly<Record<string, unknown>>[] = [],
): Record<string, unknown> | null {
  if (!value) return null;
  const output = copyGameTestFields(value, [
    "ok",
    "run_id",
    "mode",
    "requested_scene_path",
    "playing_scene_path",
    "scene_path",
    "armed",
    "owned",
    "playing",
    "launch_observed",
    "probe_confirmed",
    "probe_active",
    "runtime_probe_available",
    "runtime_probe_error",
    "stop_requested",
    "breaked",
    "paused",
    "started_at_ms",
    "ended_at_ms",
    "elapsed_ms",
    "latest_seq",
    "next_seq",
    "has_more",
    "truncated",
    "discarded_entries",
    "dropped_count",
    "error",
  ]);
  const entries = collectedEntries.length > 0 ? collectedEntries : value.entries;
  if (Array.isArray(entries)) {
    output.entries = entries.slice(-16).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      return [copyCompactRuntimeEntry(entry)];
    });
  }
  return output;
}

function compactAutomationStatus(
  value: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> | null {
  if (!value) return null;
  const output = copyGameTestFields(value, [
    "ok",
    "automation_id",
    "run_id",
    "state",
    "current_step",
    "step_count",
    "started_at_ms",
    "ended_at_ms",
    "cancel_requested",
    "failure",
    "error",
  ]);
  if (Array.isArray(value.results)) {
    output.results = value.results.slice(0, 64).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const result = copyGameTestFields(entry, ["index"]);
      if (typeof entry.type === "string") result.type = limitedGameTestText(entry.type, 64);
      if (typeof entry.state === "string") result.state = limitedGameTestText(entry.state, 32);
      if (typeof entry.message === "string") {
        result.message = limitedGameTestText(entry.message, 256);
      }
      return [result];
    });
  }
  return output;
}

function copyCompactRuntimeEntry(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output = copyGameTestFields(entry, [
    "seq",
    "timestamp_ms",
    "probe_seq",
    "session_id",
    "line",
  ]);
  if (typeof entry.kind === "string") output.kind = limitedGameTestText(entry.kind, 64);
  if (typeof entry.level === "string") output.level = limitedGameTestText(entry.level, 32);
  if (typeof entry.source === "string") output.source = limitedGameTestText(entry.source, 256);
  if (typeof entry.function === "string") output.function = limitedGameTestText(entry.function, 256);
  if (typeof entry.text === "string") output.text = limitedGameTestText(entry.text, 512);
  return output;
}

function boundGameTestOutput(output: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(safeJsonStringify(output), "utf8") <= MAX_GAME_TEST_OUTPUT_BYTES) {
    return output;
  }
  output.output_truncated = true;
  const launch = isRecord(output.launch) ? output.launch : undefined;
  const launchStatus = launch && isRecord(launch.status) ? launch.status : undefined;
  if (launchStatus && Array.isArray(launchStatus.entries)) {
    if (launchStatus.entries.length > 8) launchStatus.entries_truncated = true;
    launchStatus.entries = launchStatus.entries.slice(-8);
  }
  const automation = isRecord(output.automation) ? output.automation : undefined;
  const automationStatus = automation && isRecord(automation.status) ? automation.status : undefined;
  if (automationStatus && Array.isArray(automationStatus.results)) {
    automationStatus.results = automationStatus.results.map((value) => {
      if (!isRecord(value) || typeof value.message !== "string") return value;
      return { ...value, message: limitedGameTestText(value.message, 128) };
    });
  }
  if (Buffer.byteLength(safeJsonStringify(output), "utf8") <= MAX_GAME_TEST_OUTPUT_BYTES) {
    return output;
  }
  if (automationStatus && Array.isArray(automationStatus.results)) {
    const allResults = automationStatus.results;
    automationStatus.result_count = allResults.length;
    automationStatus.results_truncated = allResults.length > 32;
    automationStatus.results = allResults.slice(0, 32);
  }
  if (launchStatus && Array.isArray(launchStatus.entries)) {
    launchStatus.entries_truncated = launchStatus.entries.length > 0;
    launchStatus.entries = [];
  }
  if (Buffer.byteLength(safeJsonStringify(output), "utf8") <= MAX_GAME_TEST_OUTPUT_BYTES) {
    return output;
  }
  if (launch) launch.start = compactGameTestSummary(launch.start);
  if (automation) automation.start = compactGameTestSummary(automation.start);
  if (isRecord(output.cleanup)) {
    output.cleanup.cancel = compactGameTestSummary(output.cleanup.cancel);
    output.cleanup.stop = compactGameTestSummary(output.cleanup.stop);
  }
  if (Buffer.byteLength(safeJsonStringify(output), "utf8") <= MAX_GAME_TEST_OUTPUT_BYTES) {
    return output;
  }
  return {
    ok: output.ok === true,
    state: typeof output.state === "string" ? limitedGameTestText(output.state, 64) : "failed",
    run_id: typeof output.run_id === "string" ? limitedGameTestText(output.run_id, 128) : null,
    automation_id: typeof output.automation_id === "string"
      ? limitedGameTestText(output.automation_id, 128)
      : null,
    launch: compactMinimalGameTestSection(output.launch),
    automation: compactMinimalGameTestSection(output.automation),
    cleanup: compactMinimalGameTestCleanup(output.cleanup),
    stopped: output.stopped === true,
    failure: typeof output.failure === "string" ? limitedGameTestText(output.failure, 512) : null,
    timings_ms: isRecord(output.timings_ms)
      ? copyGameTestFields(output.timings_ms, ["total", "ready", "automation", "cleanup"])
      : {},
    output_truncated: true,
  };
}

function compactGameTestSummary(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return copyGameTestFields(value, [
    "ok",
    "run_id",
    "automation_id",
    "state",
    "launch_requested",
    "stop_requested",
    "failure",
    "error",
  ]);
}

function compactMinimalGameTestSection(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { start: null, status: null };
  return {
    start: compactMinimalGameTestRecord(value.start),
    status: compactMinimalGameTestRecord(value.status),
  };
}

function compactMinimalGameTestCleanup(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return {
    ...copyGameTestFields(value, [
      "policy",
      "attempted",
      "cancel_attempted",
      "stop_attempted",
      "stop_requested",
      "already_stopped",
      "stopped",
    ]),
    cancel: compactMinimalGameTestRecord(value.cancel),
    stop: compactMinimalGameTestRecord(value.stop),
    warning: typeof value.warning === "string" ? limitedGameTestText(value.warning, 256) : null,
  };
}

function compactMinimalGameTestRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const output = copyGameTestFields(value, [
    "ok",
    "run_id",
    "automation_id",
    "state",
    "launch_requested",
    "stop_requested",
  ]);
  if (typeof value.failure === "string") output.failure = limitedGameTestText(value.failure, 256);
  if (typeof value.error === "string") output.error = limitedGameTestText(value.error, 256);
  return output;
}

function copyGameTestFields(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      output[key] = typeof value === "string" ? limitedGameTestText(value, 2_048) : value;
    }
  }
  return output;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

function limitedGameTestText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

function errorMessage(error: unknown): string {
  return limitedGameTestText(error instanceof Error ? error.message : String(error), 2_048);
}

function normalizeAbortReason(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("The game test was cancelled");
  error.name = "AbortError";
  return error;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("arguments must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid tool arguments: ${raw.slice(0, 500)}`, { cause: error });
  }
}

function readRequiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a non-empty string");
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readOptionalNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function readLimitedIdentifier(value: unknown, field: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} must be a non-empty safe string of at most ${maximumLength} characters`);
  }
  return value;
}

function readSafeString(
  value: unknown,
  field: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value) ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} must be ${allowEmpty ? "a" : "a non-empty"} safe string of at most ${maximumLength} characters`);
  }
  return value;
}

function readOptionalStringList(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${field} must be an array with at most ${maximumItems} entries`);
  }
  const result = value.map((entry, index) => readLimitedIdentifier(entry, `${field}[${index}]`, maximumLength));
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates`);
  return result;
}

function isSafeOpaqueValue(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validateEditorSceneReadResult(
  result: Readonly<Record<string, unknown>>,
  lease: Readonly<EditorSceneLease>,
): string | undefined {
  if (
    !isSafeOpaqueValue(result.scene_id, 128) ||
    typeof result.scene_path !== "string" ||
    !isSafeOpaqueValue(result.scene_revision, 128)
  ) {
    return "Godot editor returned a scene result without a valid scene_id, scene_path, and scene_revision";
  }
  if (result.scene_id !== lease.scene_id) {
    return "Godot editor returned a result for a different scene than the selected scene lease";
  }
  if (result.scene_path !== lease.scene_path) {
    return "Godot editor returned a result for a different scene path than the selected scene lease";
  }
  if (result.scene_revision !== lease.scene_revision) {
    return "Godot editor scene changed after the turn started; start a new turn before continuing";
  }
  return undefined;
}

function readOptionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function readPropertyNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("property_names must be an array with at most 64 entries");
  }
  const names = value.map((entry) => {
    if (typeof entry !== "string" || !entry || entry.length > 256) {
      throw new Error("property_names entries must be non-empty strings of at most 256 characters");
    }
    return entry;
  });
  if (new Set(names).size !== names.length) throw new Error("property_names must not contain duplicates");
  return names;
}

function readEditorNodePath(value: unknown): string {
  const path = readRequiredString(value);
  if (path.length > 512) throw new Error("node_path exceeds the 512 character limit");
  if (path === ".") return path;
  if (
    path.startsWith("/") ||
    path.includes(":") ||
    path.includes("%") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("node_path must be a root-relative NodePath without subnames or traversal");
  }
  return path;
}

function readEditorResourcePath(value: unknown): string {
  const path = readRequiredString(value).replaceAll("\\", "/");
  if (path.length > 1024) throw new Error("path exceeds the 1024 character limit");
  const relative = path.startsWith("res://") ? path.slice("res://".length) : path;
  if (
    !relative ||
    relative.startsWith("/") ||
    /^[a-zA-Z]:/u.test(relative) ||
    /[\u0000-\u001f\u007f]/u.test(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("path must stay within the project resource tree");
  }
  return relative;
}

function rejectUnknownArgumentKeys(
  args: Readonly<Record<string, unknown>>,
  allowed: string[],
  field?: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(args).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(field ? `${field} contains unsupported field: ${unknown}` : `Unsupported tool argument: ${unknown}`);
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Expected a non-empty string array");
  }
  return value as string[];
}

function readPatchOperations(value: unknown): PatchOperation[] {
  if (!Array.isArray(value)) throw new Error("operations must be an array");
  return value as PatchOperation[];
}

function readSceneOperations(value: unknown): GodotSceneOperation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("operations must be a non-empty array");
  if (value.length > 64) throw new Error("operations exceeds the 64 item limit");
  return value.map((rawOperation, index) => {
    if (!isRecord(rawOperation)) throw new Error(`operations[${index}] must be an object`);
    const action = rawOperation.action;
    if (action === "add_node") {
      rejectUnknownKeys(rawOperation, ["action", "name", "node_type", "parent", "properties"], index);
      const properties = rawOperation.properties;
      if (properties !== undefined && !isRecord(properties)) {
        throw new Error(`operations[${index}].properties must be an object`);
      }
      if (properties && Object.keys(properties).length > 64) {
        throw new Error(`operations[${index}].properties exceeds the 64 property limit`);
      }
      return {
        action,
        name: readSceneString(rawOperation.name, `operations[${index}].name`),
        node_type: readSceneString(rawOperation.node_type, `operations[${index}].node_type`),
        parent: readSceneString(rawOperation.parent, `operations[${index}].parent`),
        ...(properties ? { properties } : {}),
      };
    }
    if (action === "set_property") {
      rejectUnknownKeys(rawOperation, ["action", "node_path", "property", "value"], index);
      if (!Object.hasOwn(rawOperation, "value")) throw new Error(`operations[${index}].value is required`);
      return {
        action,
        node_path: readSceneString(rawOperation.node_path, `operations[${index}].node_path`),
        property: readSceneString(rawOperation.property, `operations[${index}].property`),
        value: rawOperation.value,
      };
    }
    throw new Error(`operations[${index}].action must be add_node or set_property`);
  });
}

function readSceneString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function rejectUnknownKeys(operation: Record<string, unknown>, allowed: string[], index: number): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(operation).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`operations[${index}] contains unsupported field: ${unknown}`);
}

function taggedNumericValueSchema(type: string, fields: string[], integers = false): Record<string, unknown> {
  const properties: Record<string, unknown> = { godot_type: { const: type } };
  for (const field of fields) {
    properties[field] = integers
      ? { type: "integer", minimum: -2_147_483_648, maximum: 2_147_483_647 }
      : { type: "number" };
  }
  return {
    type: "object",
    properties,
    required: ["godot_type", ...fields],
    additionalProperties: false,
  };
}

function isToolExecutionResult(value: unknown): value is ToolExecutionResult & { observations: NonNullable<ToolExecutionResult["observations"]> } {
  return isRecord(value) && isRecord(value.output) && Array.isArray(value.observations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAllowedExecutable(executable: string): boolean {
  if (executable.includes("/") || executable.includes("\\") || executable.includes(":")) return false;
  return ALLOWED_EXECUTABLES.has(executable.toLowerCase());
}

function readFileCompatibilityCommandPath(command: readonly string[]): string | undefined {
  if (command.length !== 2) return undefined;
  let candidate = command[1]?.trim() ?? "";
  if (!candidate || candidate.startsWith("-")) return undefined;
  if (candidate.toLowerCase().startsWith("res://")) candidate = candidate.slice("res://".length);
  return normalizeRelative(candidate);
}

function isReadFileCommandAlias(executable: string): boolean {
  const normalized = executable.trim().toLowerCase();
  return normalized === "cat" || normalized === "type" || normalized === "get-content";
}

function isGodotExecutable(executable: string): boolean {
  return GODOT_EXECUTABLES.has(executable.toLowerCase());
}

export function makeItemId(): string {
  return `item_${randomUUID()}`;
}
