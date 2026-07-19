import { pathToFileURL } from "node:url";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { AgentRuntime } from "./agent.js";
import { AttachmentStore, type AttachmentMetadata } from "./attachment-store.js";
import { EditorToolBridge, EditorToolBridgeError } from "./editor-bridge.js";
import { editProcessedImage, generateProcessedImage } from "./image-processing.js";
import {
  EventFactory,
  parseEditorSceneLeaseContext,
  parseTurnAttachmentReferences,
  type ClientRequest,
  type ImageEditParams,
  type ImageGenerateParams,
  type RuntimeConfig,
  type ServerResponse,
} from "./protocol.js";
import {
  createDefaultProviderRegistry,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ProviderConfigurationError,
  type ProviderDefinition,
  type ProviderRegistry,
} from "./provider/registry.js";
import type { GeneratedImageMimeType, ModelProvider } from "./provider/types.js";
import { classifyProviderFailure } from "./provider/errors.js";
import { ProjectIndex } from "./project-index.js";
import { ProjectContextEngine } from "./project-context.js";
import { parseSpriteEditRequest, prepareSpriteEdit } from "./sprite-workflow.js";
import {
  SessionStore,
  type PersistedContextStats,
  type PersistedSession,
  type PersistedTurn,
  type PersistedTurnEntry,
  type PersistedUsage,
  type SessionSummary,
} from "./session-store.js";
import { ToolRegistry } from "./tools.js";
import {
  SkillRegistry,
  type SaveSkillInput,
  type SkillDocument,
  type SkillMetadata,
} from "./skills.js";
import {
  generateUiKit,
  parseUiKitGenerationRequest,
  type UiKitGenerationResult,
  type UiKitProgress,
} from "./ui-kit.js";
import { Workspace } from "./workspace.js";

export interface ServerOptions {
  workspace: string;
  tokenSha256: string;
  host?: string;
  port?: number;
  providerRegistry?: ProviderRegistry;
  dataDirectory?: string;
  sessionStore?: SessionStore;
  attachmentStore?: AttachmentStore;
}

export async function startServer(options: ServerOptions): Promise<WebSocketServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error("GodotX runtime may only listen on a loopback address");
  if (!/^[a-f0-9]{64}$/i.test(options.tokenSha256)) throw new Error("tokenSha256 must be a SHA-256 hex digest");
  const providers = options.providerRegistry ?? createDefaultProviderRegistry();
  const sessionStore = options.sessionStore ?? SessionStore.forWorkspace(options.workspace, options.dataDirectory);
  const attachmentStore = options.attachmentStore ?? AttachmentStore.forWorkspace(options.workspace, options.dataDirectory);
  const projectIndex = new ProjectIndex(options.workspace);
  const skillRegistry = new SkillRegistry({
    workspaceRoot: options.workspace,
    dataDirectory: options.dataDirectory ?? path.join(options.workspace, ".godot", "godetx-user"),
  });
  void projectIndex.initialize();
  const verifyClient: WebSocket.VerifyClientCallbackSync = (info) =>
    verifyCapability(info.req.url, options.tokenSha256);
  const server = new WebSocketServer({
    host,
    port: options.port ?? 32145,
    verifyClient,
    maxPayload: 8 * 1024 * 1024,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  let idleTimer: NodeJS.Timeout | undefined;
  const scheduleIdleShutdown = (delayMs: number): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (server.clients.size === 0) server.close();
    }, delayMs);
  };
  scheduleIdleShutdown(30_000);

  server.on("connection", (socket) => {
    if (idleTimer) clearTimeout(idleTimer);
    const state = new ConnectionState(
      options.workspace,
      socket,
      () => server.close(),
      providers,
      sessionStore,
      attachmentStore,
      projectIndex,
      skillRegistry,
    );
    state.ready();
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        state.sendError("", "INVALID_REQUEST", "Binary messages are not supported");
        return;
      }
      state.enqueue(data.toString("utf8"));
    });
    socket.on("close", () => {
      state.dispose();
      if (server.clients.size === 0 && server.address() !== null) scheduleIdleShutdown(5_000);
    });
  });
  server.on("close", () => {
    if (idleTimer) clearTimeout(idleTimer);
    projectIndex.dispose();
  });
  return server;
}

class ConnectionState {
  readonly #events = new EventFactory();
  readonly #sessions = new Set<string>();
  readonly #editorTools: EditorToolBridge;
  #provider?: ModelProvider;
  #providerController?: AbortController;
  #providerGeneration = 0;
  #runtime?: AgentRuntime;
  #workspace?: Workspace;
  readonly #imageRequests = new Map<string, AbortController>();
  #requestQueue: Promise<void> = Promise.resolve();
  readonly #connectionController = new AbortController();
  #disposed = false;

  constructor(
    readonly workspaceRoot: string,
    readonly socket: WebSocket,
    readonly shutdownServer: () => void,
    readonly providers: ProviderRegistry,
    readonly sessionStore: SessionStore,
    readonly attachmentStore: AttachmentStore,
    readonly projectIndex: ProjectIndex,
    readonly skillRegistry: SkillRegistry,
  ) {
    this.#editorTools = new EditorToolBridge((request, context) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        throw new EditorToolBridgeError("EDITOR_BRIDGE_DISCONNECTED", "Godot editor bridge is disconnected");
      }
      this.#send({
        event: this.#events.create("editor.tool.request", request, {
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.turnId ? { turnId: context.turnId } : {}),
          ...(context.itemId ? { itemId: context.itemId } : {}),
        }),
      });
    });
  }

  ready(): void {
    this.#send({
      event: this.#events.create("server.ready", {
        protocol_version: 1,
        workspace: path.resolve(this.workspaceRoot),
      }),
    });
  }

  enqueue(raw: string): void {
    if (isConcurrentMethod(raw)) {
      void this.handle(raw).catch((error: unknown) => this.#handleUnexpectedError(error));
      return;
    }
    this.#requestQueue = this.#requestQueue
      .then(() => this.handle(raw))
      .catch((error: unknown) => this.#handleUnexpectedError(error));
  }

  async handle(raw: string): Promise<void> {
    let request: ClientRequest;
    try {
      request = JSON.parse(raw) as ClientRequest;
      if (!request || typeof request.id !== "string" || typeof request.method !== "string") {
        throw new Error("Request must contain string id and method");
      }
    } catch (error) {
      this.sendError("", "INVALID_JSON", error instanceof Error ? error.message : String(error));
      return;
    }

    try {
      switch (request.method) {
        case "configure": {
          const configured = await this.#configure(request.params);
          this.#respond(request.id, {
            configured: true,
            provider_id: configured.providerId,
            model: configured.model,
            ...(configured.legacyBaseUrl ? { base_url: configured.legacyBaseUrl } : {}),
            ...(configured.legacyApiMode ? { api_mode: configured.legacyApiMode } : {}),
          });
          break;
        }
        case "providers.list":
          this.#respond(request.id, {
            providers: this.providers.definitions().map(serializeProviderDefinition),
          });
          break;
        case "models.list": {
          const provider = this.#requireProvider();
          const generation = this.#providerGeneration;
          const providerSignal = this.#providerController?.signal;
          const signal = providerSignal
            ? AbortSignal.any([this.#connectionController.signal, providerSignal])
            : this.#connectionController.signal;
          const models = await provider.listModels(signal);
          if (provider !== this.#provider || generation !== this.#providerGeneration) {
            throw new Error("Provider changed while models were loading");
          }
          this.#respond(request.id, { models });
          break;
        }
        case "image.capabilities": {
          const provider = this.#requireProvider();
          const capabilities = provider.getImageGenerationCapabilities?.();
          if (!capabilities) {
            this.#respond(request.id, { supported: false, edit_supported: false, edit_models: [] });
            break;
          }
          const generation = this.#providerGeneration;
          const providerSignal = this.#providerController?.signal;
          const signal = providerSignal
            ? AbortSignal.any([this.#connectionController.signal, providerSignal])
            : this.#connectionController.signal;
          let discoveredModels: string[] = [];
          let discoveredEditModels: string[] = [];
          let discoveryError = "";
          let editDiscoveryError = "";
          if (provider.listImageModels) {
            try {
              discoveredModels = await provider.listImageModels(signal);
            } catch (error) {
              discoveryError = error instanceof Error ? error.message : String(error);
            }
          }
          if (provider.editImage && provider.listImageEditModels) {
            try {
              discoveredEditModels = await provider.listImageEditModels(signal);
            } catch (error) {
              editDiscoveryError = error instanceof Error ? error.message : String(error);
            }
          }
          if (provider !== this.#provider || generation !== this.#providerGeneration) {
            throw new Error("Provider changed while image models were loading");
          }
          const models = orderImageModels(
            discoveredModels.length > 0 ? discoveredModels : capabilities.models,
            capabilities.defaultModel,
          );
          const defaultModel = models.includes(capabilities.defaultModel)
            ? capabilities.defaultModel
            : (models[0] ?? capabilities.defaultModel);
          const editModels = !provider.editImage
            ? []
            : provider.listImageEditModels
              ? orderImageModels(
                  discoveredEditModels.filter((model) => models.includes(model)),
                  capabilities.defaultModel,
                )
              : models;
          this.#respond(request.id, {
            supported: true,
            edit_supported: Boolean(provider.editImage),
            edit_models: editModels,
            default_model: defaultModel,
            models,
            sizes: capabilities.sizes,
            qualities: capabilities.qualities,
            backgrounds: capabilities.backgrounds,
            output_formats: capabilities.outputFormats,
            max_prompt_characters: capabilities.maxPromptCharacters,
            ...(discoveryError ? { model_discovery_error: discoveryError } : {}),
            ...(editDiscoveryError ? { edit_model_discovery_error: editDiscoveryError } : {}),
          });
          break;
        }
        case "image.generate": {
          const params = parseImageGenerateParams(request.params);
          const provider = this.#requireProvider();
          const workspace = this.#requireWorkspace();
          if (!provider.generateImage) throw new Error("The configured provider does not support image generation");
          if (this.#imageRequests.has(params.generation_id)) {
            throw new Error("An image generation with this ID is already active");
          }
          if (this.#imageRequests.size >= 1) {
            throw new Error("Another image generation is already active");
          }
          const controller = new AbortController();
          this.#imageRequests.set(params.generation_id, controller);
          const providerGeneration = this.#providerGeneration;
          const providerSignal = this.#providerController?.signal;
          const signal = AbortSignal.any([
            this.#connectionController.signal,
            controller.signal,
            ...(providerSignal ? [providerSignal] : []),
          ]);
          try {
            const processed = await generateProcessedImage(provider, {
              model: params.model,
              prompt: params.prompt,
              ...(params.size !== undefined ? { size: params.size } : {}),
              ...(params.quality !== undefined ? { quality: params.quality } : {}),
              ...(params.background !== undefined ? { background: params.background } : {}),
              ...(params.output_format !== undefined ? { outputFormat: params.output_format } : {}),
              signal,
            }, {
              ...(params.target_width !== undefined ? { targetWidth: params.target_width } : {}),
              ...(params.target_height !== undefined ? { targetHeight: params.target_height } : {}),
            });
            const generated = processed.image;
            if (
              controller.signal.aborted ||
              provider !== this.#provider ||
              workspace !== this.#workspace ||
              providerGeneration !== this.#providerGeneration
            ) {
              throw new Error("Image generation was cancelled because the provider changed");
            }
            const extension = imageExtension(generated.mimeType);
            const filename = `imagex-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
            const relativePath = await workspace.writeBinary(
              `assets/generated/${filename}`,
              generated.bytes,
              signal,
            );
            this.#respond(request.id, {
              generation_id: params.generation_id,
              path: relativePath,
              resource_path: `res://${relativePath}`,
              mime_type: generated.mimeType,
              byte_size: generated.bytes.byteLength,
              model: params.model,
              transparency_mode: processed.transparencyMode,
              resized: processed.resized,
              ...(processed.sourceWidth !== undefined ? { source_width: processed.sourceWidth } : {}),
              ...(processed.sourceHeight !== undefined ? { source_height: processed.sourceHeight } : {}),
              ...(processed.outputWidth !== undefined ? { output_width: processed.outputWidth } : {}),
              ...(processed.outputHeight !== undefined ? { output_height: processed.outputHeight } : {}),
              ...(generated.revisedPrompt ? { revised_prompt: generated.revisedPrompt } : {}),
            });
          } catch (error) {
            if (controller.signal.aborted) throw new Error("Image generation was cancelled", { cause: error });
            throw error;
          } finally {
            if (this.#imageRequests.get(params.generation_id) === controller) {
              this.#imageRequests.delete(params.generation_id);
            }
          }
          break;
        }
        case "image.edit": {
          const params = parseImageEditParams(request.params);
          const provider = this.#requireProvider();
          const workspace = this.#requireWorkspace();
          if (!provider.editImage) throw new Error("The configured provider does not support image editing");
          if (this.#imageRequests.has(params.generation_id)) {
            throw new Error("An image edit with this ID is already active");
          }
          if (this.#imageRequests.size >= 1) {
            throw new Error("Another image generation or edit is already active");
          }

          const source = this.attachmentStore.read(params.source_attachment_id);
          if (source.mimeType !== "image/png") {
            throw new Error("Sprite editing requires a PNG source image");
          }
          validateSpriteSourceDimensions(source.width, source.height);
          const spriteRequest = parseSpriteEditRequest({
            mode: params.mode,
            prompt: params.prompt,
            source_attachment_id: params.source_attachment_id,
            ...(params.columns !== undefined ? { columns: params.columns } : {}),
            ...(params.rows !== undefined ? { rows: params.rows } : {}),
          });
          const prepared = prepareSpriteEdit(spriteRequest, {
            width: source.width,
            height: source.height,
          });

          const controller = new AbortController();
          this.#imageRequests.set(params.generation_id, controller);
          const providerGeneration = this.#providerGeneration;
          const providerSignal = this.#providerController?.signal;
          const signal = AbortSignal.any([
            this.#connectionController.signal,
            controller.signal,
            ...(providerSignal ? [providerSignal] : []),
          ]);
          try {
            const processed = await editProcessedImage(provider, {
              image: {
                bytes: source.bytes,
                mimeType: source.mimeType,
              },
              model: params.model,
              prompt: prepared.prompt,
              ...(params.size !== undefined ? { size: params.size } : {}),
              ...(params.quality !== undefined ? { quality: params.quality } : {}),
              background: params.background ?? "transparent",
              outputFormat: "png",
              inputFidelity: params.input_fidelity ?? "high",
              signal,
            }, {
              targetWidth: source.width,
              targetHeight: source.height,
              styleHint: params.prompt,
              spriteEdit: true,
            });
            const generated = processed.image;
            if (
              controller.signal.aborted
              || provider !== this.#provider
              || workspace !== this.#workspace
              || providerGeneration !== this.#providerGeneration
            ) {
              throw new Error("Image edit was cancelled because the provider changed");
            }
            const extension = imageExtension(generated.mimeType);
            const filename = `imagex-${params.mode}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
            const relativePath = await workspace.writeBinary(
              `assets/generated/${filename}`,
              generated.bytes,
              signal,
            );
            this.#respond(request.id, {
              generation_id: params.generation_id,
              path: relativePath,
              resource_path: `res://${relativePath}`,
              mime_type: generated.mimeType,
              byte_size: generated.bytes.byteLength,
              model: params.model,
              mode: params.mode,
              source_attachment_id: source.id,
              source_width: source.width,
              source_height: source.height,
              transparency_mode: processed.transparencyMode,
              resized: processed.resized,
              output_width: processed.outputWidth ?? source.width,
              output_height: processed.outputHeight ?? source.height,
              ...prepared.outputMetadata,
              ...(params.mode === "atlas_variation"
                ? { columns: params.columns, rows: params.rows }
                : {}),
              ...(generated.revisedPrompt ? { revised_prompt: generated.revisedPrompt } : {}),
            });
          } catch (error) {
            if (controller.signal.aborted) throw new Error("Image edit was cancelled", { cause: error });
            throw error;
          } finally {
            if (this.#imageRequests.get(params.generation_id) === controller) {
              this.#imageRequests.delete(params.generation_id);
            }
          }
          break;
        }
        case "ui_kit.generate": {
          const params = parseUiKitGenerationRequest(request.params);
          const provider = this.#requireProvider();
          const workspace = this.#requireWorkspace();
          if (this.#imageRequests.has(params.workflowId)) {
            throw new Error("A UI kit workflow with this ID is already active");
          }
          if (this.#imageRequests.size >= 1) {
            throw new Error("Another image generation is already active");
          }
          const controller = new AbortController();
          this.#imageRequests.set(params.workflowId, controller);
          const providerGeneration = this.#providerGeneration;
          const providerSignal = this.#providerController?.signal;
          const signal = AbortSignal.any([
            this.#connectionController.signal,
            controller.signal,
            ...(providerSignal ? [providerSignal] : []),
          ]);
          try {
            const result = await generateUiKit({
              request: params,
              provider,
              workspace,
              attachmentStore: this.attachmentStore,
              signal,
              emit: (progress) => this.#emitUiKitProgress(progress),
            });
            if (
              controller.signal.aborted ||
              provider !== this.#provider ||
              workspace !== this.#workspace ||
              providerGeneration !== this.#providerGeneration
            ) {
              throw new Error("UI kit generation was cancelled because the provider changed");
            }
            this.#respond(request.id, serializeUiKitResult(result));
          } catch (error) {
            if (controller.signal.aborted) throw new Error("UI kit generation was cancelled", { cause: error });
            throw error;
          } finally {
            if (this.#imageRequests.get(params.workflowId) === controller) {
              this.#imageRequests.delete(params.workflowId);
            }
          }
          break;
        }
        case "image.cancel": {
          const generationId = readImageGenerationId(request.params?.generation_id);
          const controller = this.#imageRequests.get(generationId);
          controller?.abort();
          this.#respond(request.id, { generation_id: generationId, cancelled: Boolean(controller) });
          break;
        }
        case "attachment.register":
        case "attachment.get": {
          if (typeof request.params?.attachment_id !== "string") {
            throw new Error("attachment_id must be a string");
          }
          const attachment = this.attachmentStore.register(request.params.attachment_id);
          this.#respond(request.id, { attachment: serializeAttachmentMetadata(attachment) });
          break;
        }
        case "index.status":
          this.#respond(request.id, { index: serializeIndexStatus(this.projectIndex.status()) });
          break;
        case "index.rebuild":
          this.#respond(request.id, { index: serializeIndexStatus(await this.projectIndex.rebuild()) });
          break;
        case "skills.list":
        case "skills.refresh": {
          const snapshot = await this.skillRegistry.refresh();
          this.#respond(request.id, {
            skills: snapshot.skills.map((skill) => serializeSkill(skill)),
            diagnostics: snapshot.diagnostics,
            index: serializeIndexStatus(this.projectIndex.status()),
          });
          break;
        }
        case "skills.get":
          this.#respond(request.id, { skill: serializeSkill(await this.skillRegistry.get(request.params.id), true) });
          break;
        case "skills.save":
          this.#respond(request.id, {
            skill: serializeSkill(await this.skillRegistry.save(readSkillSaveParams(request.params)), true),
          });
          break;
        case "skills.delete":
          this.#respond(request.id, {
            deleted: await this.skillRegistry.delete(request.params.id),
            id: request.params.id,
          });
          break;
        case "skills.set_enabled": {
          if (typeof request.params.enabled !== "boolean") throw new Error("enabled must be a boolean");
          this.#respond(request.id, {
            skill: serializeSkill(await this.skillRegistry.setEnabled(request.params.id, request.params.enabled)),
          });
          break;
        }
        case "session.create": {
          if (request.params?.system_prompt !== undefined && typeof request.params.system_prompt !== "string") {
            throw new Error("system_prompt must be a string");
          }
          if (request.params?.title !== undefined && typeof request.params.title !== "string") {
            throw new Error("title must be a string");
          }
          const sessionId = this.#requireRuntime().createSession(
            request.params?.system_prompt,
            request.params?.title,
          );
          this.#sessions.add(sessionId);
          this.#respond(request.id, { session_id: sessionId });
          break;
        }
        case "session.list":
          this.#respond(request.id, {
            sessions: this.#requireRuntime().listSessions().map(serializeSessionSummary),
            diagnostics: this.sessionStore.listDiagnostics().map((diagnostic) => ({
              filename: diagnostic.filename,
              code: diagnostic.code,
            })),
          });
          break;
        case "session.get":
          this.#respond(request.id, {
            session: serializeSession(this.#requireRuntime().getSession(request.params.session_id)),
          });
          break;
        case "session.rename": {
          if (typeof request.params.title !== "string") throw new Error("title must be a string");
          const session = this.#requireRuntime().renameSession(request.params.session_id, request.params.title);
          this.#respond(request.id, { session: serializeSession(session) });
          break;
        }
        case "session.delete": {
          const deleted = this.#requireRuntime().deleteSession(request.params.session_id);
          this.#sessions.delete(request.params.session_id);
          this.#respond(request.id, { deleted, session_id: request.params.session_id });
          break;
        }
        case "turn.start": {
          const runtime = this.#requireRuntime();
          if (request.params.model !== undefined && typeof request.params.model !== "string") {
            throw new Error("model must be a string");
          }
          if (
            request.params.reasoning_effort !== undefined &&
            typeof request.params.reasoning_effort !== "string"
          ) {
            throw new Error("Invalid reasoning_effort");
          }
          if (request.params.display_prompt !== undefined && typeof request.params.display_prompt !== "string") {
            throw new Error("display_prompt must be a string");
          }
          if (
            request.params.runtime_automation_enabled !== undefined &&
            typeof request.params.runtime_automation_enabled !== "boolean"
          ) {
            throw new Error("runtime_automation_enabled must be a boolean");
          }
          const sceneContext = parseEditorSceneLeaseContext(
            request.params.scene_leases,
            request.params.primary_scene_id,
            request.params.open_scene_paths,
          );
          const attachmentReferences = parseTurnAttachmentReferences(request.params.attachments);
          const attachments = attachmentReferences.map((reference) => {
            const metadata = this.attachmentStore.register(reference.attachment_id);
            return {
              attachmentId: metadata.id,
              mimeType: metadata.mimeType,
              detail: reference.detail,
              ...(reference.annotations?.length
                ? { annotations: reference.annotations }
                : {}),
              ...(reference.annotated_from ? { annotatedFrom: reference.annotated_from } : {}),
              byteSize: metadata.byteSize,
              width: metadata.width,
              height: metadata.height,
              ...(reference.source ? { source: reference.source } : {}),
              ...(reference.name ? { name: reference.name } : {}),
              ...(reference.run_id ? { runId: reference.run_id } : {}),
              ...(reference.scene_id ? { sceneId: reference.scene_id } : {}),
              ...(reference.scene_path ? { scenePath: reference.scene_path } : {}),
              ...(reference.captured_at_ms !== undefined ? { capturedAtMs: reference.captured_at_ms } : {}),
              ...(reference.viewport_width !== undefined ? { viewportWidth: reference.viewport_width } : {}),
              ...(reference.viewport_height !== undefined ? { viewportHeight: reference.viewport_height } : {}),
              ...(reference.frame !== undefined ? { frame: reference.frame } : {}),
            };
          });
          const turnOptions = {
            ...(request.params.model !== undefined ? { model: request.params.model } : {}),
            ...(request.params.reasoning_effort !== undefined
              ? { reasoningEffort: request.params.reasoning_effort }
              : {}),
            ...(request.params.display_prompt !== undefined
              ? { displayPrompt: request.params.display_prompt }
              : {}),
            sceneLeases: sceneContext.scene_leases,
            primarySceneId: sceneContext.primary_scene_id,
            openScenePaths: sceneContext.open_scene_paths,
            runtimeAutomationEnabled: request.params.runtime_automation_enabled ?? false,
            ...(attachments.length > 0 ? { attachments } : {}),
          };
          runtime.validateTurn(request.params.session_id, request.params.prompt, turnOptions);
          this.#respond(request.id, { accepted: true });
          void runtime.runTurn(request.params.session_id, request.params.prompt, turnOptions).catch(() => undefined);
          break;
        }
        case "turn.cancel":
          this.#respond(request.id, { cancelled: this.#requireRuntime().cancel(request.params.session_id) });
          break;
        case "approval.respond":
          if (!isApprovalDecision(request.params.decision)) throw new Error("Invalid approval decision");
          this.#respond(request.id, {
            resolved: this.#requireRuntime().respondApproval(request.params.request_id, request.params.decision),
          });
          break;
        case "editor.tool.respond": {
          const requestId = this.#editorTools.respond(request.params);
          this.#respond(request.id, { resolved: true, request_id: requestId });
          break;
        }
        case "ping":
          this.#respond(request.id, { pong: true });
          break;
        case "shutdown":
          this.#respond(request.id, { shutting_down: true });
          setTimeout(() => this.shutdownServer(), 10);
          break;
        default: {
          const unsupported = request as unknown as { id: string; method: string };
          this.sendError(unsupported.id, "METHOD_NOT_FOUND", `Unknown method: ${unsupported.method}`);
        }
      }
    } catch (error) {
      if (error instanceof EditorToolBridgeError) {
        this.sendError(request.id, error.code, error.message, error.data);
      } else {
        const providerFailure = classifyProviderFailure(error);
        if (providerFailure) {
          this.sendError(
            request.id,
            providerFailure.code,
            error instanceof Error ? error.message : String(error),
            providerFailure.status !== undefined ? { status: providerFailure.status } : undefined,
          );
        } else {
          this.sendError(request.id, "REQUEST_FAILED", error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#connectionController.abort();
    for (const controller of this.#imageRequests.values()) controller.abort();
    this.#imageRequests.clear();
    this.#editorTools.close();
    this.#providerController?.abort();
    this.#providerGeneration += 1;
    this.#runtime?.dispose();
    void disposeProvider(this.#provider);
    this.#sessions.clear();
  }

  sendError(id: string, code: string, message: string, data?: unknown): void {
    this.#send({
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    } satisfies ServerResponse);
  }

  async #configure(config: RuntimeConfig): Promise<ResolvedRuntimeConfig> {
    if (this.#disposed) throw new Error("Connection is closed");
    const resolved = resolveRuntimeConfig(config);
    if (this.#runtime?.hasActiveTurns()) throw new Error("Cannot reconfigure while a turn is active");
    if (this.#imageRequests.size > 0) throw new Error("Cannot reconfigure while image generation is active");
    const validation = this.providers.validateConfig(resolved.providerId, resolved.providerConfig);
    if (!validation.ok) throw new ProviderConfigurationError(resolved.providerId, validation.issues);
    const provider = this.providers.create(resolved.providerId, validation.value);
    let workspace: Workspace;
    try {
      workspace = await Workspace.open(this.workspaceRoot, resolved.writeAllowlist);
    } catch (error) {
      await disposeProvider(provider);
      throw error;
    }
    if (this.#disposed) {
      await disposeProvider(provider);
      throw new Error("Connection is closed");
    }
    if (this.#runtime?.hasActiveTurns()) {
      await disposeProvider(provider);
      throw new Error("Cannot reconfigure while a turn is active");
    }
    if (this.#imageRequests.size > 0) {
      await disposeProvider(provider);
      throw new Error("Cannot reconfigure while image generation is active");
    }
    let runtime: AgentRuntime;
    try {
      runtime = new AgentRuntime({
        provider,
        tools: new ToolRegistry(workspace, {
          editorClient: this.#editorTools,
          projectIndex: this.projectIndex,
        }),
        model: resolved.model,
        approvalMode: resolved.approvalMode,
        ...(resolved.maxSteps !== undefined ? { maxSteps: resolved.maxSteps } : {}),
        emit: (event) => this.#send({ event }),
        eventFactory: this.#events,
        sessionStore: this.sessionStore,
        attachmentStore: this.attachmentStore,
        skillRegistry: this.skillRegistry,
        projectContextEngine: new ProjectContextEngine(this.projectIndex, workspace),
      });
    } catch (error) {
      await disposeProvider(provider);
      throw error;
    }
    const previousProvider = this.#provider;
    this.#editorTools.reset();
    this.#providerController?.abort();
    this.#runtime?.dispose();
    this.#sessions.clear();
    this.#providerController = new AbortController();
    this.#providerGeneration += 1;
    this.#provider = provider;
    this.#runtime = runtime;
    this.#workspace = workspace;
    for (const session of runtime.listSessions()) this.#sessions.add(session.id);
    await disposeProvider(previousProvider);
    return resolved;
  }

  #requireProvider(): ModelProvider {
    if (!this.#provider) throw new Error("Runtime is not configured");
    return this.#provider;
  }

  #requireRuntime(): AgentRuntime {
    if (!this.#runtime) throw new Error("Runtime is not configured");
    return this.#runtime;
  }

  #requireWorkspace(): Workspace {
    if (!this.#workspace) throw new Error("Runtime is not configured");
    return this.#workspace;
  }

  #respond(id: string, result: unknown): void {
    this.#send({ id, result } satisfies ServerResponse);
  }

  #emitUiKitProgress(progress: UiKitProgress): void {
    this.#send({
      event: this.#events.create("asset.progress", serializeUiKitProgress(progress), {
        itemId: progress.workflowId,
      }),
    });
  }

  #send(value: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }

  #handleUnexpectedError(error: unknown): void {
    if (!this.#disposed) {
      this.sendError("", "INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
    }
  }
}

interface ResolvedRuntimeConfig {
  providerId: string;
  providerConfig: Record<string, unknown>;
  model: string;
  approvalMode: "ask" | "auto";
  maxSteps?: number;
  writeAllowlist?: string[];
  legacyBaseUrl?: string;
  legacyApiMode?: "auto" | "responses" | "chat_completions";
}

function resolveRuntimeConfig(config: RuntimeConfig): ResolvedRuntimeConfig {
  if (!config || typeof config !== "object") throw new Error("configure params are required");
  if (typeof config.model !== "string" || !config.model.trim()) throw new Error("model is required");
  if (config.approval_mode !== undefined && !["ask", "auto"].includes(config.approval_mode)) {
    throw new Error("Invalid approval_mode");
  }
  if (
    config.write_allowlist !== undefined &&
    (!Array.isArray(config.write_allowlist) || config.write_allowlist.some((item) => typeof item !== "string"))
  ) {
    throw new Error("write_allowlist must be a string array");
  }
  if (
    config.max_steps !== undefined &&
    (!Number.isInteger(config.max_steps) || config.max_steps < 1 || config.max_steps > 64)
  ) {
    throw new Error("max_steps must be between 1 and 64");
  }

  const usesProviderConfig = config.provider_id !== undefined || config.provider_config !== undefined;
  const usesLegacyConfig =
    config.base_url !== undefined || config.api_key !== undefined || config.api_mode !== undefined;
  if (usesProviderConfig && usesLegacyConfig) {
    throw new Error("Do not mix provider_id/provider_config with legacy base_url/api_key/api_mode");
  }

  let providerId: string;
  let providerConfig: Record<string, unknown>;
  let legacyBaseUrl: string | undefined;
  let legacyApiMode: "auto" | "responses" | "chat_completions" | undefined;
  if (usesProviderConfig) {
    if (typeof config.provider_id !== "string" || !config.provider_id.trim()) {
      throw new Error("provider_id is required");
    }
    if (!isRecord(config.provider_config)) throw new Error("provider_config must be an object");
    if (Object.keys(config.provider_config).length > 64) {
      throw new Error("provider_config exceeds the 64 field limit");
    }
    providerId = config.provider_id.trim();
    providerConfig = config.provider_config;
  } else {
    if (typeof config.base_url !== "string") throw new Error("base_url must be a string");
    if (typeof config.api_key !== "string" || !config.api_key) throw new Error("api_key is required");
    if (
      config.api_mode !== undefined &&
      !["auto", "responses", "chat_completions"].includes(config.api_mode)
    ) {
      throw new Error("Invalid api_mode");
    }
    providerId = OPENAI_COMPATIBLE_PROVIDER_ID;
    legacyBaseUrl = config.base_url;
    legacyApiMode = config.api_mode ?? "auto";
    providerConfig = {
      base_url: config.base_url,
      api_key: config.api_key,
      api_mode: legacyApiMode,
    };
  }

  return {
    providerId,
    providerConfig,
    model: config.model.trim(),
    approvalMode: config.approval_mode ?? "ask",
    ...(config.max_steps !== undefined ? { maxSteps: config.max_steps } : {}),
    ...(config.write_allowlist ? { writeAllowlist: [...config.write_allowlist] } : {}),
    ...(legacyBaseUrl ? { legacyBaseUrl } : {}),
    ...(legacyApiMode ? { legacyApiMode } : {}),
  };
}

function parseImageGenerateParams(value: ImageGenerateParams): ImageGenerateParams {
  if (!isRecord(value)) throw new Error("image.generate params are required");
  const generationId = readImageGenerationId(value.generation_id);
  const prompt = readBoundedImageText(value.prompt, "prompt", 32_000);
  const model = readBoundedImageText(value.model, "model", 512);
  const size = readOptionalImageText(value.size, "size", 64);
  const quality = readOptionalImageText(value.quality, "quality", 64);
  const background = readOptionalImageText(value.background, "background", 64);
  const outputFormat = value.output_format;
  if (outputFormat !== undefined && !["png", "jpeg", "webp"].includes(outputFormat)) {
    throw new Error("output_format must be png, jpeg, or webp");
  }
  const targetWidth = readOptionalImageDimension(value.target_width, "target_width");
  const targetHeight = readOptionalImageDimension(value.target_height, "target_height");
  if ((targetWidth === undefined) !== (targetHeight === undefined)) {
    throw new Error("target_width and target_height must be provided together");
  }
  if (targetWidth !== undefined && targetHeight !== undefined && targetWidth * targetHeight > 16_777_216) {
    throw new Error("Target image dimensions exceed the pixel safety limit");
  }
  return {
    generation_id: generationId,
    prompt,
    model,
    ...(size !== undefined ? { size } : {}),
    ...(quality !== undefined ? { quality } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
    ...(targetWidth !== undefined ? { target_width: targetWidth } : {}),
    ...(targetHeight !== undefined ? { target_height: targetHeight } : {}),
  };
}

function parseImageEditParams(value: ImageEditParams): ImageEditParams {
  if (!isRecord(value)) throw new Error("image.edit params are required");
  const allowedFields = new Set([
    "generation_id",
    "source_attachment_id",
    "mode",
    "prompt",
    "model",
    "size",
    "quality",
    "background",
    "output_format",
    "input_fidelity",
    "columns",
    "rows",
  ]);
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknownField) throw new Error(`image.edit params contain unsupported field: ${unknownField}`);

  const sprite = parseSpriteEditRequest({
    mode: value.mode,
    prompt: value.prompt,
    source_attachment_id: value.source_attachment_id,
    ...(value.columns !== undefined ? { columns: value.columns } : {}),
    ...(value.rows !== undefined ? { rows: value.rows } : {}),
  });
  const generationId = readImageGenerationId(value.generation_id);
  const model = readBoundedImageText(value.model, "model", 512);
  const size = readOptionalImageText(value.size, "size", 64);
  const quality = readOptionalImageText(value.quality, "quality", 64);
  const background = readOptionalImageText(value.background, "background", 64);
  if (value.output_format !== undefined && value.output_format !== "png") {
    throw new Error("image.edit output_format must be png");
  }
  if (
    value.input_fidelity !== undefined
    && value.input_fidelity !== "low"
    && value.input_fidelity !== "high"
  ) {
    throw new Error("input_fidelity must be low or high");
  }

  return {
    generation_id: generationId,
    source_attachment_id: sprite.sourceAttachmentId,
    mode: sprite.mode,
    prompt: sprite.prompt,
    model,
    ...(size !== undefined ? { size } : {}),
    ...(quality !== undefined ? { quality } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(value.output_format !== undefined ? { output_format: value.output_format } : {}),
    ...(value.input_fidelity !== undefined ? { input_fidelity: value.input_fidelity } : {}),
    ...(sprite.mode === "atlas_variation" ? { columns: sprite.columns, rows: sprite.rows } : {}),
  };
}

function validateSpriteSourceDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 16
    || height < 16
    || width > 2_048
    || height > 2_048
  ) {
    throw new Error("Sprite source dimensions must be integers from 16 to 2048 pixels");
  }
}

function readOptionalImageDimension(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 16 || (value as number) > 3840) {
    throw new Error(`${field} must be an integer from 16 to 3840`);
  }
  return value as number;
}

function readImageGenerationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) {
    throw new Error("generation_id must be an 8-128 character safe identifier");
  }
  return value;
}

function readBoundedImageText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const clean = value.trim();
  if (!clean || clean.length > maximum || clean.includes("\0")) {
    throw new Error(`${field} must contain 1-${maximum} safe characters`);
  }
  return clean;
}

function readOptionalImageText(value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : readBoundedImageText(value, field, maximum);
}

function imageExtension(mimeType: GeneratedImageMimeType): "png" | "jpg" | "webp" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

function orderImageModels(values: readonly string[], preferred: string): string[] {
  const models = [...new Set(values
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)))]
    .slice(0, 256);
  models.sort((left, right) => left.localeCompare(right));
  const preferredIndex = models.indexOf(preferred);
  if (preferredIndex > 0) models.unshift(...models.splice(preferredIndex, 1));
  return models;
}

function serializeUiKitProgress(progress: UiKitProgress): Record<string, unknown> {
  return {
    workflow_id: progress.workflowId,
    phase: progress.phase,
    message: progress.message,
    ...(progress.current !== undefined ? { current: progress.current } : {}),
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    ...(progress.assetId ? { asset_id: progress.assetId } : {}),
    ...(progress.assetName ? { asset_name: progress.assetName } : {}),
    ...(progress.plan ? { plan: progress.plan } : {}),
  };
}

function serializeUiKitResult(result: UiKitGenerationResult): Record<string, unknown> {
  return {
    workflow_id: result.workflowId,
    planner_model: result.plannerModel,
    image_model: result.imageModel,
    output_directory: result.outputDirectory,
    plan: result.plan,
    assets: result.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      role: asset.role,
      prompt: asset.prompt,
      path: asset.path,
      resource_path: asset.resourcePath,
      mime_type: asset.mimeType,
      byte_size: asset.byteSize,
      transparency_mode: asset.transparencyMode,
      normalized: asset.normalized,
      resized: asset.resized,
      ...(asset.sourceWidth !== undefined ? { source_width: asset.sourceWidth } : {}),
      ...(asset.sourceHeight !== undefined ? { source_height: asset.sourceHeight } : {}),
      ...(asset.outputWidth !== undefined ? { output_width: asset.outputWidth } : {}),
      ...(asset.outputHeight !== undefined ? { output_height: asset.outputHeight } : {}),
      ...(asset.revisedPrompt ? { revised_prompt: asset.revisedPrompt } : {}),
    })),
    review: {
      status: result.review.status,
      passed: result.review.passed,
      score: result.review.score,
      summary: result.review.summary,
      issues: result.review.issues.map((issue) => ({
        asset_id: issue.assetId,
        severity: issue.severity,
        message: issue.message,
      })),
    },
  };
}

function serializeProviderDefinition(definition: ProviderDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    display_name: definition.displayName,
    default_model: definition.defaultModel,
    config_fields: definition.configSchema.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.input,
      required: field.required,
      ...(field.description ? { description: field.description } : {}),
      ...(field.defaultValue !== undefined ? { default_value: field.defaultValue } : {}),
      ...(field.options ? { options: field.options } : {}),
    })),
  };
}

function serializeSessionSummary(summary: SessionSummary): Record<string, unknown> {
  return {
    session_id: summary.id,
    title: summary.title,
    created_at: summary.createdAt,
    updated_at: summary.updatedAt,
    turn_count: summary.turnCount,
    ...(summary.lastStatus ? { last_status: summary.lastStatus } : {}),
    usage: serializeUsage(summary.usage),
  };
}

function serializeSession(session: PersistedSession): Record<string, unknown> {
  return {
    session_id: session.id,
    title: session.title,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    turn_count: session.turns.length,
    usage: serializeUsage(summarizeUsage(session.turns)),
    turns: session.turns.map(serializeTurn),
  };
}

function serializeTurn(turn: PersistedTurn): Record<string, unknown> {
  const durationMs = turn.completedAt
    ? Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt))
    : 0;
  return {
    turn_id: turn.id,
    prompt: turn.prompt,
    model: turn.model,
    ...(turn.reasoningEffort ? { reasoning_effort: turn.reasoningEffort } : {}),
    status: turn.status,
    started_at: turn.startedAt,
    ...(turn.completedAt ? { completed_at: turn.completedAt } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.errorCode ? { error_code: turn.errorCode } : {}),
    ...(turn.errorStatus !== undefined ? { error_status: turn.errorStatus } : {}),
    duration_ms: durationMs,
    usage: serializeUsage(turn.usage),
    ...(turn.context ? { context: serializeContextStats(turn.context) } : {}),
    ...(turn.attachments ? { attachments: turn.attachments.map(serializePersistedAttachment) } : {}),
    entries: turn.entries.map(serializeTurnEntry),
  };
}

function serializeAttachmentMetadata(attachment: AttachmentMetadata): Record<string, unknown> {
  return {
    attachment_id: attachment.id,
    mime_type: attachment.mimeType,
    size_bytes: attachment.byteSize,
    width: attachment.width,
    height: attachment.height,
  };
}

function serializePersistedAttachment(
  attachment: NonNullable<PersistedTurn["attachments"]>[number],
): Record<string, unknown> {
  return {
    ...serializeAttachmentMetadata({
      id: attachment.attachmentId,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      width: attachment.width,
      height: attachment.height,
    }),
    detail: attachment.detail,
    ...(attachment.annotations?.length ? { annotations: attachment.annotations } : {}),
    ...(attachment.annotatedFrom ? { annotated_from: attachment.annotatedFrom } : {}),
    ...(attachment.source ? { source: attachment.source } : {}),
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(attachment.runId ? { run_id: attachment.runId } : {}),
    ...(attachment.sceneId ? { scene_id: attachment.sceneId } : {}),
    ...(attachment.scenePath ? { scene_path: attachment.scenePath } : {}),
    ...(attachment.capturedAtMs !== undefined ? { captured_at_ms: attachment.capturedAtMs } : {}),
    ...(attachment.viewportWidth !== undefined ? { viewport_width: attachment.viewportWidth } : {}),
    ...(attachment.viewportHeight !== undefined ? { viewport_height: attachment.viewportHeight } : {}),
    ...(attachment.frame !== undefined ? { frame: attachment.frame } : {}),
  };
}

function serializeContextStats(context: PersistedContextStats): Record<string, number | boolean> {
  return {
    history_characters: context.historyCharacters,
    context_characters: context.contextCharacters,
    dropped_messages: context.droppedMessages,
    compacted_tool_messages: context.compactedToolMessages,
    context_compacted: context.compacted,
  };
}

function serializeTurnEntry(entry: PersistedTurnEntry): Record<string, unknown> {
  if (entry.kind === "assistant") {
    return {
      kind: entry.kind,
      item_id: entry.itemId,
      text: entry.text,
      reasoning: entry.reasoning,
    };
  }
  if (entry.kind === "context") {
    return {
      kind: entry.kind,
      item_id: entry.itemId,
      data: entry.data,
    };
  }
  return {
    kind: entry.kind,
    item_id: entry.itemId,
    name: entry.name,
    arguments: entry.arguments,
    output: entry.output,
  };
}

function serializeUsage(usage: PersistedUsage): Record<string, number> {
  return {
    ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
  };
}

function summarizeUsage(turns: readonly PersistedTurn[]): PersistedUsage {
  const usage: PersistedUsage = {};
  for (const turn of turns) {
    if (turn.usage.inputTokens !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + turn.usage.inputTokens;
    if (turn.usage.outputTokens !== undefined) usage.outputTokens = (usage.outputTokens ?? 0) + turn.usage.outputTokens;
    if (turn.usage.totalTokens !== undefined) usage.totalTokens = (usage.totalTokens ?? 0) + turn.usage.totalTokens;
  }
  return usage;
}

async function disposeProvider(provider: ModelProvider | undefined): Promise<void> {
  if (!provider?.dispose) return;
  try {
    await provider.dispose();
  } catch {
    // A provider cleanup failure must not keep the local runtime alive or roll back a new configuration.
  }
}

function serializeIndexStatus(status: ReturnType<ProjectIndex["status"]>): Record<string, unknown> {
  return {
    state: status.state,
    file_count: status.fileCount,
    symbol_count: status.symbolCount,
    reference_count: status.referenceCount,
    dependency_count: status.dependencyCount,
    last_indexed_at: status.lastIndexedAt,
    scan_duration_ms: status.scanDurationMs,
    truncated: status.truncated,
    ...(status.error ? { error: status.error } : {}),
  };
}

function serializeSkill(skill: SkillMetadata | SkillDocument, includeInstructions = false): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    enabled: skill.enabled,
    readonly: skill.readonly,
    triggers: [...skill.triggers],
    capabilities: [...skill.capabilities],
    path: `${skill.scope}://${skill.name}/SKILL.md`,
    ...(includeInstructions && "instructions" in skill ? { instructions: skill.instructions } : {}),
  };
}

function readSkillSaveParams(value: unknown): SaveSkillInput {
  if (!isRecord(value)) throw new Error("Skill save params must be an object");
  const scope = value.scope;
  if (scope !== "project" && scope !== "user") throw new Error("scope must be project or user");
  if (typeof value.name !== "string") throw new Error("name must be a string");
  if (typeof value.description !== "string") throw new Error("description must be a string");
  if (typeof value.instructions !== "string") throw new Error("instructions must be a string");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const readList = (field: "triggers" | "capabilities"): string[] | undefined => {
    const fieldValue = value[field];
    if (fieldValue === undefined) return undefined;
    if (!Array.isArray(fieldValue) || fieldValue.some((entry) => typeof entry !== "string")) {
      throw new Error(`${field} must be a string array`);
    }
    return fieldValue as string[];
  };
  const triggers = readList("triggers");
  const capabilities = readList("capabilities");
  return {
    scope,
    name: value.name,
    description: value.description,
    instructions: value.instructions,
    ...(triggers ? { triggers } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function parseArgs(args: string[]): ServerOptions {
  let workspace = process.cwd();
  let host = "127.0.0.1";
  let port = 32145;
  let tokenSha256 = "";
  let dataDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace") workspace = requireArg(args, ++index, "--workspace");
    else if (arg === "--host") host = requireArg(args, ++index, "--host");
    else if (arg === "--port") port = Number.parseInt(requireArg(args, ++index, "--port"), 10);
    else if (arg === "--token-sha256") tokenSha256 = requireArg(args, ++index, "--token-sha256");
    else if (arg === "--data-dir") dataDirectory = requireArg(args, ++index, "--data-dir");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be between 0 and 65535");
  if (!tokenSha256) throw new Error("--token-sha256 is required");
  return { workspace, host, port, tokenSha256, ...(dataDirectory ? { dataDirectory } : {}) };
}

function verifyCapability(requestUrl: string | undefined, expectedHash: string): boolean {
  const token = new URL(requestUrl ?? "/", "ws://127.0.0.1").searchParams.get("token") ?? "";
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isApprovalDecision(value: unknown): value is "accept" | "accept_for_session" | "decline" {
  return value === "accept" || value === "accept_for_session" || value === "decline";
}

function isConcurrentMethod(raw: string): boolean {
  try {
    const request = JSON.parse(raw) as { method?: unknown };
    return (
      request.method === "providers.list" ||
      request.method === "models.list" ||
      request.method === "image.capabilities" ||
      request.method === "image.generate" ||
      request.method === "image.edit" ||
      request.method === "ui_kit.generate" ||
      request.method === "image.cancel" ||
      request.method === "editor.tool.respond" ||
      request.method === "ping" ||
      request.method === "shutdown"
    );
  } catch {
    return false;
  }
}

function requireArg(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startServer(parseArgs(process.argv.slice(2)));
    const address = server.address();
    const display = typeof address === "string" ? address : `${address?.address}:${address?.port}`;
    process.stdout.write(`GodotX runtime listening on ${display}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
