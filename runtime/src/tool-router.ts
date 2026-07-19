import type { ToolSchema } from "./provider/types.js";

export type ToolRoutingProfile = "read" | "code" | "scene" | "game" | "web" | "mixed" | "full";

export interface ToolRoutingInput {
  prompt: string;
  definitions: readonly ToolSchema[];
  runtimeAutomationEnabled: boolean;
  openScenePaths?: readonly string[];
  hasSceneLeases?: boolean;
}

export interface ToolRoutingResult {
  profile: ToolRoutingProfile;
  definitions: ToolSchema[];
  policyDefinitions: ToolSchema[];
  toolNames: string[];
  policyToolNames: string[];
  schemaBytes: number;
  fullSchemaBytes: number;
  userRequest: string;
}

const PROJECT_READ = ["list_files", "read_file", "search_text"] as const;
const SEMANTIC_READ = ["project_symbol_search", "project_find_references", "project_dependency_graph"] as const;
const ENGINE_API_READ = ["godot_api_query"] as const;
const CODE_WRITE = ["apply_patch"] as const;
const COMMAND = ["run_command"] as const;
const SCENE_FILE_WRITE = ["godot_scene"] as const;
const EDITOR_READ = [
  "godot_api_query",
  "scene_get_tree",
  "editor_get_selection",
  "node_get_properties",
  "resource_inspect",
] as const;
const EDITOR_WRITE = ["scene_apply_operations"] as const;
const GAME_DEBUG = [
  "game_debug_start",
  "game_debug_status",
  "game_capture_screenshot",
  "game_debug_stop",
] as const;
const GAME_AUTOMATION = [
  "game_automation_run",
  "game_automation_status",
  "game_automation_cancel",
] as const;
const GAME_TEST = ["game_test"] as const;
const WEB = ["web_search", "web_open"] as const;

const AUTOMATION_OPT_IN_TOOLS = new Set<string>([
  "game_test",
  "game_automation_run",
  "game_automation_cancel",
]);
const WRITE_OR_EXECUTE_TOOLS = new Set<string>([
  "apply_patch",
  "godot_scene",
  "run_command",
  "scene_apply_operations",
  "game_debug_start",
  "game_debug_stop",
  "game_automation_run",
  "game_automation_cancel",
  "game_test",
]);
const GAME_TOOLS = new Set<string>([...GAME_DEBUG, ...GAME_AUTOMATION, ...GAME_TEST]);

const FOLLOW_UP_ONLY = /^(?:继续(?:吧|执行|制作|实现)?|接着(?:做|来)?|再试(?:一次)?|重试|开始(?:吧|制作|实现|执行)?|按(?:刚才|上面|之前)(?:的)?(?:方案)?(?:做|执行|继续)?|好(?:的)?|可以|就这样|continue|go on|proceed|do it|try again|retry|fix it|change it)[\s.!?,，。！？]*$/iu;
const MUTATION = /(?:\b(?:add|apply|change|create|delete|edit|fix|implement|modify|move|remove|rename|replace|update|write|refactor)\b|新增|添加|增加|创建|删除|移除|修改|更改|编辑|修复|实现|重构|调整|替换|重命名|移动)/iu;
const READ_INTENT = /(?:\b(?:analy[sz]e|check|explain|find|hello|hi|inspect|list|locate|read|review|show|tell|thanks|what|why)\b|\bwhat\s+next\b|\bhow\s+should\b|分析|检查|查看|读取|查找|搜索|定位|列出|解释|说明|告诉|为什么|什么原因|结论|你好|谢谢|下一步|建议|方案|如何|是否|能否|问题)/iu;
const CODE = /(?:\.(?:gd|cs|ts|tsx|js|jsx|json|toml|yaml|yml)\b|\b(?:code|script|function|method|class|signal|parser|syntax|compile|build|lint|refactor|implementation|logic|stack trace)\b|project\.godot\b|代码|脚本|函数|方法|类|信号|解析错误|语法|编译|构建|报错|错误|功能|逻辑|实现)/iu;
const SCENE = /(?:\.tscn\b|\b(?:scene|node|node tree|inspector|property|resource|asset|material|texture|sprite|control|button|label|panel|menu|hud|ui)\b|场景|节点树|节点|检查器|属性|资源|素材|材质|纹理|精灵|控件|按钮|标签|面板|菜单|界面)/iu;
const UI_SURFACE = /(?:\b(?:title|icon|label|button|control|panel|menu|hud|ui)\b|标题|图标|标签|按钮|控件|面板|菜单|界面)/iu;
const WEB_INTENT = /(?:https?:\/\/|\b(?:web|internet|online|official docs?|documentation|latest|current api|search the web|look up)\b|联网|网页|在线搜索|搜索网络|查资料|官方文档|最新(?:版本|资料|文档|信息)|实时(?:排行|榜单|数据|价格|人数)|热门(?:游戏|排行|榜单)|排行榜|销量榜|在线人数|当前价格)/iu;
const WEB_SEARCH_ACTION = /(?:\b(?:search(?:\s+for)?|browse|google)\b|(?:搜索|搜|查询|查)(?:一下|一查|找)?)/iu;
const LOCAL_SEARCH_SCOPE = /(?:\b(?:project|workspace|repository|repo|codebase|files?|scripts?|scene|nodes?|local)\b|res:\/\/|\.(?:gd|tscn|scn|cs|ts|js|json)\b|项目|工程|工作区|仓库|代码|文件|脚本|场景|节点|目录|本地)/iu;
const CODE_COMMAND = /(?:\b(?:test|build|compile|lint|typecheck|command|cmd|npm|pnpm|yarn|cargo|gradle)\b|测试|构建|编译|检查类型|运行命令|执行命令|命令行)/iu;
const CURRENT_OR_LIVE_SCENE = /(?:\b(?:current|live|open|selected)\s+(?:scene|node|title|ui)|\blive\s+(?:title|icon|label|button|panel)\b|当前(?:场景|节点|窗口|界面|游戏)|打开的场景|实时场景|编辑器(?:场景|内)|选中(?:节点|对象))/iu;
const FRESH_GAME_TEST = /(?:\bgame_test\b|\b(?:verify|test)\b[^\n]{0,60}\b(?:current game|game locally|gameplay|scene|ui|button|control)\b|\b(?:run|play)\b[^\n]{0,60}\b(?:scene|game)\b[^\n]{0,80}\b(?:click|assert|verify|test)\b|(?:测试|验证)[^\n]{0,40}(?:当前)?(?:游戏|场景|界面|按钮|控件)|运行[^\n]{0,40}(?:游戏|场景)[^\n]{0,60}(?:点击|断言|验证|测试)|(?:点击|模拟输入)[^\n]{0,60}(?:验证|断言|结果))/iu;
const ATOMIC_GAME_DEBUG = /(?:\bgame_debug_(?:start|status|stop)\b|\b(?:debug output|debugger status|debug session|game debug|already running game|running game status|stop the game|start the game|run the project|play the project)\b|\b(?:run|play|start|debug)\s+(?:the\s+)?(?:(?:current|main|selected|specified)\s+)?(?:scene|game)\b|游戏调试|调试会话|调试输出|调试状态|已运行的?游戏|停止[^\n]{0,12}游戏|启动游戏|运行项目|(?:运行|启动|调试)(?:当前|主|指定|选中)?(?:场景|游戏))/iu;
const GAME_SCREENSHOT = /(?:\b(?:game_capture_screenshot|game screenshot|running game screenshot|capture (?:the )?(?:game|frame|screenshot))\b|游戏截图|运行画面|截取(?:游戏|当前)?画面|视觉检查)/iu;
const ATOMIC_GAME_AUTOMATION = /(?:\bgame_automation_(?:run|status|cancel)\b|\b(?:run ui automation|runtime automation|cancel automation)\b|运行时自动化|执行游戏自动化|取消自动化)/iu;
const GAME_CONTROL_DETAIL = /(?:\b(?:status|logs?|output|stop|cancel|intermediate|already running|run_id|automation_id)\b|状态|日志|输出|停止|取消|中间步骤|已经运行|运行 ID|自动化 ID)/iu;
const AUTOMATION_CONTROL_DETAIL = /(?:\b(?:cancel automation|automation_id)\b|取消自动化|自动化 ID)/iu;
const STRICT_READ_ONLY = /(?:\bread[- ]only\b|\bdo not make any changes\b|\b(?:do not|don't|without)\s+(?:modify|modifying|change|changing|edit|editing|write|writing|execute|executing|run|running)\b|\bonly\s+(?:inspect|read|explain|tell|analy[sz]e|review)\b|只读|不要(?:做)?任何(?:修改|更改|编辑|写入|执行)|不要(?:修改|更改|编辑)[\s，,。]*(?:只|仅)|(?:只|仅)(?:查看|检查|读取|分析|解释|说明|告诉|回答))/iu;
const NO_GAME = /(?:\b(?:do not|don't|without)\s+(?:run|running|start|starting|play|playing)\s+(?:the\s+)?(?:game|scene|project)\b|不要(?:运行|启动|调试|测试)(?:游戏|场景|项目)|无需(?:运行|启动)(?:游戏|场景|项目))/iu;
const NO_COMMAND = /(?:\b(?:do not|don't|without)\s+(?:run|running|execute|executing)\s+(?:a\s+)?(?:command|shell|cmd)\b|不要(?:运行|执行)(?:任何)?命令|无需命令)/iu;

const SEMANTIC_INTENT = /(?:\b(?:ClassDB|Godot API|symbol|definition|reference|dependency|inheritance|inherits|where (?:is|are).+defined)\b|项目符号|符号索引|查找引用|引用搜索|依赖关系|继承关系|在哪里定义|定义位置)/iu;

export function routeTools(input: ToolRoutingInput): ToolRoutingResult {
  const userRequest = extractUserRequest(input.prompt);
  const strictReadOnly = STRICT_READ_ONLY.test(userRequest);
  const noGame = NO_GAME.test(userRequest);
  const noCommand = NO_COMMAND.test(userRequest);
  const policyDefinitions = input.definitions.filter((definition) => {
    if (!input.runtimeAutomationEnabled && AUTOMATION_OPT_IN_TOOLS.has(definition.name)) return false;
    if (strictReadOnly && WRITE_OR_EXECUTE_TOOLS.has(definition.name)) return false;
    if (noGame && GAME_TOOLS.has(definition.name)) return false;
    if (noCommand && definition.name === "run_command") return false;
    return true;
  });
  const policyToolNames = policyDefinitions.map((definition) => definition.name);

  const mutation = MUTATION.test(userRequest) && !strictReadOnly;
  const readIntent = READ_INTENT.test(userRequest) || strictReadOnly;
  const codeCommandIntent = CODE_COMMAND.test(userRequest) && /(?:\b(?:run|execute|npm|pnpm|yarn|cargo|gradle)\b|运行|执行)/iu.test(userRequest);
  const codeIntent = CODE.test(userRequest) || codeCommandIntent;
  const semanticIntent = SEMANTIC_INTENT.test(userRequest);
  const webIntent = WEB_INTENT.test(userRequest) || (
    WEB_SEARCH_ACTION.test(userRequest) && !LOCAL_SEARCH_SCOPE.test(userRequest)
  );
  const sceneIntent = SCENE.test(userRequest) || Boolean(
    input.hasSceneLeases && mutation && UI_SURFACE.test(userRequest),
  );
  const freshGameIntent = !noGame && FRESH_GAME_TEST.test(userRequest);
  const atomicAutomationIntent = !noGame && (
    (!freshGameIntent && ATOMIC_GAME_AUTOMATION.test(userRequest)) ||
    (freshGameIntent && AUTOMATION_CONTROL_DETAIL.test(userRequest))
  );
  const atomicDebugIntent = !noGame && (
    (!freshGameIntent && ATOMIC_GAME_DEBUG.test(userRequest)) ||
    GAME_SCREENSHOT.test(userRequest) ||
    (freshGameIntent && GAME_CONTROL_DETAIL.test(userRequest) && !atomicAutomationIntent)
  );
  const atomicGameIntent = atomicDebugIntent || atomicAutomationIntent;
  const gameIntent = freshGameIntent || atomicGameIntent;

  const ambiguousFollowUp = FOLLOW_UP_ONLY.test(userRequest);
  const hasRecognizedIntent = codeIntent || semanticIntent || webIntent || sceneIntent || gameIntent || readIntent;
  const ambiguousMutation = mutation && !codeIntent && !sceneIntent && !gameIntent;
  if (ambiguousFollowUp || !hasRecognizedIntent || ambiguousMutation) {
    return makeResult("full", policyDefinitions, policyDefinitions, userRequest);
  }

  const selected = new Set<string>(PROJECT_READ);
  const categories: ToolRoutingProfile[] = [];

  if (semanticIntent) {
    addNames(selected, SEMANTIC_READ);
    addNames(selected, ENGINE_API_READ);
  }

  if (codeIntent) {
    categories.push("code");
    addNames(selected, SEMANTIC_READ);
    addNames(selected, ENGINE_API_READ);
    if (mutation) addNames(selected, CODE_WRITE);
    if (!strictReadOnly && !noCommand && (mutation || CODE_COMMAND.test(userRequest))) {
      addNames(selected, COMMAND);
    }
  }

  const scenePaths = extractScenePaths(userRequest);
  const normalizedOpenPaths = new Set((input.openScenePaths ?? []).map(normalizeScenePath));
  const referencesOpenScene = scenePaths.some((scenePath) => normalizedOpenPaths.has(scenePath));
  const referencesOnlyClosedScenes = scenePaths.length > 0 && !referencesOpenScene;
  const currentOrLiveScene = CURRENT_OR_LIVE_SCENE.test(userRequest) || referencesOpenScene;

  if (sceneIntent) {
    categories.push("scene");
    addNames(selected, SEMANTIC_READ);
    if (!referencesOnlyClosedScenes || currentOrLiveScene) addNames(selected, EDITOR_READ);
    if (referencesOnlyClosedScenes) selected.add("resource_inspect");
    if (mutation) {
      if (referencesOnlyClosedScenes && !currentOrLiveScene) {
        addNames(selected, SCENE_FILE_WRITE);
      } else if (currentOrLiveScene) {
        addNames(selected, EDITOR_WRITE);
      } else {
        addNames(selected, SCENE_FILE_WRITE);
        addNames(selected, EDITOR_WRITE);
      }
    }
  }

  if (gameIntent) {
    categories.push("game");
    if (freshGameIntent) addNames(selected, GAME_TEST);
    if (atomicDebugIntent) addNames(selected, GAME_DEBUG);
    if (atomicAutomationIntent) addNames(selected, GAME_AUTOMATION);
    if (sceneIntent && !referencesOnlyClosedScenes) addNames(selected, EDITOR_READ);
  }

  if (webIntent) {
    categories.push("web");
    addNames(selected, WEB);
  }

  const uniqueCategories = [...new Set(categories)];
  const profile: ToolRoutingProfile = uniqueCategories.length === 0
    ? "read"
    : uniqueCategories.length === 1
      ? uniqueCategories[0]!
      : "mixed";
  const routedDefinitions = policyDefinitions.filter((definition) => selected.has(definition.name));
  if (routedDefinitions.length === 0) {
    return makeResult("full", policyDefinitions, policyDefinitions, userRequest);
  }
  return makeResult(profile, routedDefinitions, policyDefinitions, userRequest);
}

export function extractUserRequest(prompt: string): string {
  const opening = prompt.indexOf("<godot_editor_context>");
  const closing = prompt.indexOf("</godot_editor_context>");
  if (opening < 0 || closing < opening) return prompt.trim();
  const suffix = prompt.slice(closing + "</godot_editor_context>".length);
  const match = /(?:^|\r?\n)User request:\s*\r?\n/iu.exec(suffix);
  if (!match || match.index === undefined) return prompt.trim();
  return suffix.slice(match.index + match[0].length).trim();
}

function makeResult(
  profile: ToolRoutingProfile,
  definitions: ToolSchema[],
  policyDefinitions: ToolSchema[],
  userRequest: string,
): ToolRoutingResult {
  return {
    profile,
    definitions,
    policyDefinitions,
    toolNames: definitions.map((definition) => definition.name),
    policyToolNames: policyDefinitions.map((definition) => definition.name),
    schemaBytes: schemaBytes(definitions),
    fullSchemaBytes: schemaBytes(policyDefinitions),
    userRequest,
  };
}

function addNames(target: Set<string>, names: readonly string[]): void {
  for (const name of names) target.add(name);
}

function schemaBytes(definitions: readonly ToolSchema[]): number {
  return Buffer.byteLength(JSON.stringify(definitions), "utf8");
}

function extractScenePaths(value: string): string[] {
  const paths: string[] = [];
  for (const match of value.matchAll(/(?:res:\/\/)?[A-Za-z0-9_.\/-]+\.tscn\b/giu)) {
    const normalized = normalizeScenePath(match[0]);
    if (normalized && !paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

function normalizeScenePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^res:\/\//iu, "").replace(/^\.\//u, "").toLowerCase();
}
