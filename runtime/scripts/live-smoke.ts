import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentRuntime } from "../src/agent.js";
import { isReasoningEffort, type ReasoningEffort } from "../src/model-options.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible.js";
import type { RuntimeEvent } from "../src/protocol.js";
import { ToolRegistry } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";

const mode = process.argv[2] ?? "hi";
const baseUrl = process.env.GODOTX_BASE_URL ?? process.env.GODETX_BASE_URL ?? "https://ptai.cc/v1";
const apiKey = process.env.GODOTX_API_KEY ?? process.env.GODETX_API_KEY;
const model = process.env.GODOTX_MODEL ?? process.env.GODETX_MODEL ?? "gpt-5.6-sol";
const reasoningEffortValue = (
  process.env.GODOTX_REASONING_EFFORT ?? process.env.GODETX_REASONING_EFFORT
)?.trim();
let reasoningEffort: ReasoningEffort | undefined;

if (!apiKey) throw new Error("GODOTX_API_KEY is required");
if (mode !== "hi" && mode !== "agent") throw new Error("Mode must be hi or agent");
if (reasoningEffortValue) {
  if (!isReasoningEffort(reasoningEffortValue)) throw new Error("GODOTX_REASONING_EFFORT is invalid");
  reasoningEffort = reasoningEffortValue;
}

const turnOptions = reasoningEffort ? { reasoningEffort } : {};

const repoRoot = process.cwd();
const runRoot = path.join(repoRoot, ".tmp", `live-e2e-${randomUUID()}`);
await mkdir(path.dirname(runRoot), { recursive: true });
await cp(path.join(repoRoot, "runtime", "fixtures", "godot"), runRoot, { recursive: true });
await rm(path.join(runRoot, ".gdignore"), { force: true });
await rename(path.join(runRoot, "project.godot.fixture"), path.join(runRoot, "project.godot"));

try {
  if (mode === "hi") await runHi();
  else await runAgentTasks();
} finally {
  const keepE2E = process.env.GODOTX_KEEP_E2E ?? process.env.GODETX_KEEP_E2E;
  if (keepE2E !== "1") await rm(runRoot, { recursive: true, force: true });
}

async function runHi(): Promise<void> {
  const events: RuntimeEvent[] = [];
  const runtime = await makeRuntime(events, []);
  const sessionId = runtime.createSession("For this connectivity check, answer the user's greeting briefly without calling tools.");
  await runtime.runTurn(sessionId, "HI", turnOptions);
  const deltas = events.filter((event) => event.type === "message.delta");
  const finalEvent = events.find((event) => event.type === "turn.completed");
  assert.ok(deltas.length >= 1, "The live response did not emit a streamed message.delta event");
  assert.ok(finalEvent, "The live response did not complete");
  assert.ok(events.indexOf(deltas[0]!) < events.indexOf(finalEvent), "The first delta must arrive before completion");
  const streamed = deltas.map((event) => String((event.data as { delta?: string }).delta ?? "")).join("");
  const finalText = String((finalEvent.data as { text?: string }).text ?? "");
  assert.equal(streamed, finalText, "Streamed deltas do not match the final assistant text");
  process.stdout.write(
    `LIVE_HI_OK model=${model} reasoning=${reasoningEffort ?? "default"} deltas=${deltas.length} text=${JSON.stringify(finalText)}\n`,
  );
}

async function runAgentTasks(): Promise<void> {
  const before = await manifest(runRoot);
  const events: RuntimeEvent[] = [];
  const runtime = await makeRuntime(events, ["scripts/agent_target.gd", "main.tscn"]);
  const sessionId = runtime.createSession(
    "This is an end-to-end test. Only modify the explicitly named target. You must use tools and verify tool output before answering.",
  );

  await runtime.runTurn(
    sessionId,
    'Read scripts/agent_target.gd, then use apply_patch to change GREETING exactly to "Hello from GodotX runtime". Do not modify any other file.',
    turnOptions,
  );
  assert.match(await readFile(path.join(runRoot, "scripts", "agent_target.gd"), "utf8"), /Hello from GodotX runtime/);
  assert.ok(events.some((event) => event.type === "file_change.applied"), "Script turn did not apply a file transaction");

  const sceneEventStart = events.length;
  await runtime.runTurn(
    sessionId,
    'Read main.tscn, then use godot_scene to add a Label child of "." named AgentLabel whose text is exactly "Scene edited by GodotX". Do not modify any other file.',
    turnOptions,
  );
  const sceneEvents = events.slice(sceneEventStart);
  assert.ok(sceneEvents.some((event) => event.type === "file_change.applied"), "Scene turn did not apply a scene transaction");

  const after = await manifest(runRoot);
  const changed = [...after.keys()].filter((file) => before.get(file) !== after.get(file)).sort();
  assert.deepEqual(changed, ["main.tscn", "scripts/agent_target.gd"]);
  await verifyWithGodot(runRoot);
  process.stdout.write(
    `LIVE_AGENT_OK model=${model} changed=${changed.join(",")} events=${events.length}\n`,
  );
}

async function makeRuntime(events: RuntimeEvent[], writeAllowlist: string[]): Promise<AgentRuntime> {
  const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: apiKey!, mode: "auto" });
  const workspace = await Workspace.open(runRoot, writeAllowlist);
  return new AgentRuntime({
    provider,
    tools: new ToolRegistry(workspace),
    model,
    approvalMode: "auto",
    maxSteps: 12,
    emit: (event) => {
      events.push(event);
      if (["provider.fallback", "tool.started", "approval.requested", "file_change.applied", "turn.failed"].includes(event.type)) {
        process.stdout.write(`${event.type} ${JSON.stringify(event.data)}\n`);
      }
    },
  });
}

async function manifest(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".godot") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
        result.set(relative, createHash("sha256").update(await readFile(absolute)).digest("hex"));
      }
    }
  };
  await visit(root);
  return result;
}

async function verifyWithGodot(projectRoot: string): Promise<void> {
  const executable = process.env.GODOTX_GODOT_BIN ?? process.env.GODETX_GODOT_BIN;
  if (!executable) throw new Error("GODOTX_GODOT_BIN is required for the live agent scene verification");
  await stat(executable);
  const editor = await runProcess(executable, [
    "--headless",
    "--editor",
    "--path",
    projectRoot,
    "--log-file",
    path.join(projectRoot, "godot-editor.log"),
    "--quit",
  ]);
  assert.equal(editor.code, 0, `Godot editor import failed:\n${editor.output}`);
  const verify = await runProcess(executable, [
    "--headless",
    "--path",
    projectRoot,
    "--log-file",
    path.join(projectRoot, "godot-verify.log"),
    "--script",
    "res://.godetx_test/verify.gd",
  ]);
  assert.equal(verify.code, 0, `Godot semantic verification failed:\n${verify.output}`);
  assert.match(verify.output, /GODETX_E2E_OK/);
}

function runProcess(executable: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}
