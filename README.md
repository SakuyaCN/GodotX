<p align="center">
  <picture>
	<source media="(prefers-color-scheme: dark)" srcset="assets/branding/godotx-logo-v2a-dark-ui.png">
	<source media="(prefers-color-scheme: light)" srcset="assets/branding/godotx-logo-v2a.png">
	<img alt="GodotX" src="assets/branding/godotx-logo-v2a.png" width="520">
  </picture>
</p>

<h1 align="center">GodotX</h1>

<p align="center">
  面向 Godot 4 的编辑器内 AI 开发 Agent。
  在同一个工作流中理解项目、修改脚本与场景、运行游戏测试，并生成视觉素材。
</p>

<p align="center">
  <strong>Godot 4.6+</strong> · <strong>Node.js 22+</strong> · <strong>Windows 自包含打包</strong> · <strong>功能预览版 0.1.0</strong>
</p>

> [!IMPORTANT]
> GodotX 当前是功能性 MVP，适合试用、验证工作流和参与开发。将它用于重要项目之前，请提交版本控制，并在应用修改前检查差异。

## 为什么使用 GodotX

普通聊天工具只能看到你主动粘贴的内容。GodotX 运行在 Godot 编辑器内，可以把模型与当前项目的真实状态连接起来：

- 读取项目文件、符号、引用关系、场景树、节点属性和资源信息。
- 流式显示回复、思考摘要、工具调用、修改日志和 Token 使用量。
- 通过事务补丁修改代码，通过 `EditorUndoRedoManager` 修改已打开场景。
- 将任务绑定到提交时的场景租约，切换标签页不会让模型误改另一个场景。
- 在当前编辑器中启动、检查和停止游戏，并可选择执行结构化交互测试。
- 使用 ImageX 生成 UI 素材、单张图片、精灵换皮和固定网格图集变体。
- 使用 SkillX 管理项目级或个人级可复用指令。
- 在同一套 Runtime 和工具系统上切换不同模型 Provider。

## 三个工作区

| 工作区 | 用途 |
| --- | --- |
| **GodotX** | 流式对话、项目检索、代码与场景编辑、审批、游戏调试和自动化测试 |
| **ImageX** | 单图生成、AI UI 套件、精灵换皮、图集变体、透明背景与视觉复核 |
| **SkillX** | 创建、启用和复用项目技能或个人技能 |

## 核心能力

### 项目理解与修改

- GDScript、Shader、场景、资源和 `project.godot` 的增量语义索引。
- 符号搜索、引用查找、依赖关系分析和自动上下文检索。
- 工作区内文件读取、搜索和事务式补丁。
- 已打开场景的结构化读取和可撤销编辑。
- 基于当前 Godot 版本 `ClassDB` 的 API 查询，不依赖模型记忆猜测接口。

### Agent 体验

- 流式文本与推理摘要。
- 可恢复的多会话历史、分页时间线和上下文压缩。
- 展开的工具详情、修改前后 Diff、成功/失败状态和底部跟随滚动。
- `请求批准` 与 `替我审批` 两种模式。
- 英文与简体中文界面，跟随主机语言，不修改项目自身语言设置。

### 游戏与视觉

- 使用当前 Godot 编辑器进行游戏调试，不启动第二个编辑器或无头实例。
- 可选的运行时模拟自动化：点击、InputMap 动作、等待和属性断言。
- 图片文件、Godot 资源、剪贴板图片、2D/3D 视口和运行画面附件。
- 图片批注：箭头、圆形和矩形。
- 生成结果保存到 `res://assets/generated/`，不会覆盖源素材。

## 架构概览

```text
Godot EditorPlugin
	│  versioned WebSocket protocol
	▼
Agent Runtime
	├── sessions / turns / context
	├── approval manager
	├── ToolKernel
	│   ├── workspace tools
	│   └── EditorBridge tools
	└── ProviderRegistry
		├── OpenAI-compatible
		├── DeepSeek
		└── OpenCode Zen
```

Provider 只负责请求转换和流解析；会话、工具、审批、场景租约与工作区安全均由 GodotX Runtime 统一管理。详细设计见 [架构文档](docs/architecture.md)。

## 快速开始

### 环境要求

- Godot `4.6` 或更高版本。
- Node.js `22` 或更高版本。
- 当前打包脚本面向 Windows。

### 从源码运行

```powershell
npm.cmd install
npm.cmd run build
```

随后使用 Godot 打开仓库根目录，在 **项目 > 项目设置 > 插件** 中启用插件。插件会启动本地 Runtime，并在编辑器中添加 GodotX、ImageX 和 SkillX。

### 安装到已有项目

在仓库根目录执行：

```powershell
package_addon.bat
```

脚本会构建 Runtime、安装生产依赖并打包 Windows Node.js。将生成的 `addons/godetx` 目录复制到目标 Godot 项目的 `addons/` 下，然后在插件管理器中启用。

`godetx` 仍作为兼容性技术命名空间使用，包括插件目录、已有 EditorSettings、会话、附件和项目技能路径；产品名称及所有用户可见文案统一为 `GodotX`。新的命令行环境变量使用 `GODOTX_*`，并继续兼容旧的 `GODETX_*` 名称。

### 连接模型

1. 打开 GodotX 右上角的设置。
2. 选择 Provider。
3. 填写 API Key；OpenAI-compatible Provider 还需要 Base URL。
4. 点击应用，等待模型列表同步。
5. 在聊天框下方选择模型、推理强度和审批模式。

支持情况：

| Provider | 对话与工具 | 推理摘要 | ImageX |
| --- | :---: | :---: | :---: |
| OpenAI-compatible | 是 | 取决于模型与接口 | 取决于服务是否实现图片接口 |
| DeepSeek | 是 | 是 | 否 |
| OpenCode Zen | 是 | 取决于模型 | 否 |

更多安装、配置与故障排查信息见 [快速开始](docs/getting-started.md) 和 [Provider 指南](docs/providers.md)。

## 可以这样提问

```text
解释当前场景的节点结构，并找出控制暂停菜单的脚本。
```

```text
把当前场景中的 StartButton 改成 TextureButton，保持现有信号连接。
```

```text
检查玩家受伤逻辑，修复重复扣血问题并运行相关场景验证。
```

```text
为当前 UI 生成一套透明背景的科幻风格按钮和面板。
```

## 安全边界

- Runtime 只监听回环地址，并使用每次启动随机生成的连接能力令牌。
- 文件工具受工作区边界、符号链接检查、敏感路径保护和写入白名单约束。
- 文件写入先展示 Diff，并在应用前再次核验原文件哈希。
- 场景修改绑定会话、任务、场景实例和 Undo 历史版本。
- 命令不经过 Shell，只允许受控的可执行程序。
- `替我审批` 只跳过已知审批类别，不会取消工作区或命令安全限制。
- API Key 不会写入项目文件、命令参数、会话快照或 Runtime 日志。

完整说明见 [安全策略](SECURITY.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 全部文档入口 |
| [快速开始](docs/getting-started.md) | 安装、配置、基础使用和故障排查 |
| [功能指南](docs/features.md) | GodotX、ImageX、SkillX 与游戏测试 |
| [Provider 指南](docs/providers.md) | Provider 能力、配置与扩展方式 |
| [架构](docs/architecture.md) | Runtime、ToolKernel、EditorBridge 与状态边界 |
| [协议](docs/protocol.md) | WebSocket 事件与客户端方法 |
| [开发指南](docs/development.md) | 构建、测试、打包和验收流程 |
| [贡献指南](CONTRIBUTING.md) | Issue 与 Pull Request 约定 |
| [安全策略](SECURITY.md) | 安全边界与漏洞报告 |

## 开发与验证

```powershell
# TypeScript 静态检查
npm.cmd run check

# 构建 Runtime
npm.cmd run build

# 运行 Runtime 全量测试
npm.cmd test
```

`npm test` 不会启动 Godot。`tests/godot/` 下的验证脚本应通过已经运行的 Godot 4.6 编辑器执行，Agent 和插件不会为了测试再启动一个 Godot 进程。

## 当前限制

- 这是功能预览版，不等同于 Codex 或 OpenCode 的完整实现。
- 关闭的场景目前仍通过受事务保护的文本变更处理。
- 可编辑实例覆盖、脚本化 Resource 赋值、强类型 Array 写入和更广泛的 Variant 类型仍在后续计划中。
- DeepSeek 与 OpenCode Zen 当前不提供 ImageX 图片生成。
- Windows 之外的平台尚未提供自包含打包脚本。

参与开发前请阅读 [贡献指南](CONTRIBUTING.md)。项目的实现细节和后续扩展边界记录在 [架构文档](docs/architecture.md) 中。
