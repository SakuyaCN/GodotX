# 快速开始

**中文** | [English](en/getting-started.md)

本指南介绍如何从源码运行 GodotX、打包到已有项目、连接模型并完成第一次任务。

## 环境要求

- Godot `4.6` 或更高版本。
- Node.js `22` 或更高版本。
- Windows PowerShell 或命令提示符。
- 一个受支持 Provider 的 API Key。

> [!NOTE]
> 开发模式使用系统 Node.js。`package_addon.bat` 可以把 Windows Node.js 和生产依赖一起打入插件目录。

## 从源码运行

在仓库根目录执行：

```powershell
npm.cmd install
npm.cmd run build
```

然后：

1. 使用 Godot 4.6+ 打开仓库根目录。
2. 打开 **项目 > 项目设置 > 插件**。
3. 启用 GodotX 插件。
4. 在编辑器右侧找到 GodotX、ImageX 和 SkillX。

开发模式优先使用 `runtime/dist` 和系统 `node`。如果 Godot 无法找到 Node.js，可以在启动 Godot 前指定：

```powershell
$env:GODETX_NODE_BIN = "C:\Program Files\nodejs\node.exe"
```

## 安装到已有 Godot 项目

### 使用自包含 Windows 包

在仓库根目录执行：

```powershell
package_addon.bat
```

成功后，将 `addons/godetx` 整个目录复制到目标项目的 `addons/` 中。不要只复制 GDScript 文件；自包含包还包括：

- 编译后的 Runtime。
- 生产环境 Node.js 依赖。
- 与当前架构匹配的 `node.exe`。
- Node.js 版本和许可证信息。

复制完成后，在目标项目的插件管理器中启用插件。

### 指定打包使用的 Node.js

```powershell
$env:GODETX_NODE_BIN = "D:\Tools\node-v22\node.exe"
package_addon.bat
```

打包脚本当前只接受 Windows Node.js。

## 配置 Provider

1. 点击 GodotX 右上角的设置按钮。
2. 在 Provider 下拉框中选择服务。
3. 填写连接字段。
4. 根据需要启用 **记住密钥**。
5. 点击应用。
6. 等待模型列表同步后选择模型和推理强度。

### OpenAI-compatible

需要：

- Base URL。
- API Key。
- API 模式：自动、Responses 或 Chat Completions。

远程 Base URL 必须使用 HTTPS；只有准确的本地回环地址可以使用 HTTP。不要在 URL 中放入用户名、密码、查询参数或片段。

### DeepSeek

只需填写 API Key。端点和 Chat Completions 传输由适配器固定。当前内置模型能力不支持图片输入或 ImageX。

### OpenCode Zen

只需填写 Zen API Key。GodotX 会将 Zen 的实时模型列表与协议元数据相交，只显示当前 Runtime 已完整支持工具调用协议的模型。

详细差异见 [Provider 指南](providers.md)。

## 第一次对话

在输入框发送：

```text
检查当前项目结构，告诉我主场景和主要脚本分别是什么，不要修改文件。
```

确认以下内容：

- 回复以流式方式出现。
- 工具调用显示为可展开日志。
- 项目上下文卡片列出实际读取的文件。
- 任务结束后显示用时与 Token/上下文信息。

## 第一次修改

建议先使用小范围任务：

```text
在当前脚本中修复明显的类型推断错误，展示差异后再应用。
```

`请求批准` 模式会在文件、场景、命令和游戏启动等操作前弹出确认。`替我审批` 会自动接受当前已知类别，但以下边界始终保留：

- 工作区限制。
- 受保护路径。
- 文件基础哈希和过期补丁检查。
- 命令可执行程序白名单。
- 场景租约、修订和游戏运行所有权。

## 场景任务

提交任务时，GodotX 会冻结当时已经打开的场景租约。模型运行期间切换标签页不会改变目标。

建议明确说明目标：

```text
在当前场景中复制 HUD/HealthBar，命名为 ShieldBar，保持布局一致，不要保存场景。
```

成功的实时场景变更会进入对应场景的 Undo 历史，但不会自动保存。请在编辑器中检查后自行保存。

## 图片附件

聊天框支持：

- 从系统文件选择图片。
- 从剪贴板粘贴图片。
- 从 Godot FileSystem 面板拖入纹理或可预览资源。
- 截取当前 2D/3D 编辑器视口。
- 截取由 GodotX 启动并拥有的游戏画面。

点击附件预览可以添加箭头、圆形和矩形。批注会作为结构化信息与图片一起发送。

## ImageX 输出

ImageX 结果写入：

```text
res://assets/generated/
```

精灵换皮和图集变体会创建新 PNG，不覆盖源纹理。生成成功后界面会回到结果预览；失败原因会保留到下一次操作开始。

## 常见问题

### 插件提示 Runtime 未连接

1. 确认 Node.js 主版本至少为 22。
2. 执行 `npm.cmd run build`。
3. 检查 `runtime/dist/src/server.js` 是否存在。
4. 必要时设置 `GODETX_NODE_BIN`。
5. 禁用并重新启用插件。

### API Key 无效或余额不足

GodotX 会区分认证失败与额度不足，并隐藏响应中的账单 URL、工作区标识和密钥。如果模型列表同步失败，请先确认 Provider、端点、账户余额和密钥权限。

### 修改插件自己的脚本后出现旧错误

Godot 工具脚本热重载可能保留旧插件实例。修改 `res://addons/godetx/` 后，应禁用并重新启用插件，再清空输出面板检查新日志。插件不会在正在执行的 `@tool` 回调中强制触发“全部保存”。

### 游戏测试拒绝启动第二个 Godot

这是设计行为。GodotX 的游戏调试和模拟自动化只能通过当前正在运行的宿主编辑器执行。

### ImageX 可用但没有图片编辑

图片生成、图片输入和图片编辑是独立能力。Provider 或模型没有声明对应能力时，ImageX 会禁用相关任务。DeepSeek 和 OpenCode Zen 当前不提供 ImageX。

[返回文档索引](README.md)
