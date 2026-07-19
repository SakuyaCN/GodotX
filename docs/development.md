# 开发指南

**中文** | [English](en/development.md)

本指南适用于构建 Runtime、修改 Godot 插件、运行测试和制作发布包。

## 仓库结构

```text
addons/godetx/       Godot EditorPlugin、UI、EditorBridge 和内置资源
runtime/src/         TypeScript Agent Runtime
runtime/test/        Runtime 单元与集成测试
runtime/scripts/     在线 smoke 脚本
tests/godot/         Godot 侧验证脚本
docs/                使用与架构文档
demo/                手工验收场景
package_addon.bat    Windows 自包含插件打包
```

## 安装依赖

要求 Node.js 22+：

```powershell
npm.cmd install
```

`postinstall` 会在 `node_modules/` 下创建 `.gdignore`，防止 Godot 扫描依赖目录。

## 常用命令

```powershell
# 静态类型检查
npm.cmd run check

# 编译 Runtime
npm.cmd run build

# 编译并执行全部 Runtime 测试
npm.cmd test
```

`npm.cmd test` 只运行 TypeScript/Node 测试，不启动 Godot。

## 在线 smoke

不要把密钥写入仓库。使用临时环境变量：

```powershell
$env:GODETX_API_KEY = "<key>"
$env:GODETX_BASE_URL = "https://example.com/v1"
$env:GODETX_MODEL = "model-id"
$env:GODETX_REASONING_EFFORT = "low"

npm.cmd run smoke:models
npm.cmd run smoke:hi
npm.cmd run smoke:agent
```

脚本不得打印或持久化 API Key。

## Godot 侧验证

`tests/godot/` 覆盖：

- 附件存储。
- 自动审批。
- 聊天 UI 与本地化。
- EditorBridge。
- 游戏 debugger。
- 实时场景修改。
- 图片批注。
- 运行时自动化驱动。

这些脚本应通过已经运行的 Godot 4.6 编辑器或项目既有验证入口执行。Agent 任务和插件测试不得启动第二个 Godot 或无头编辑器进程。

修改 `@tool` 脚本后：

1. 等待现有 Godot LSP 完成解析。
2. 检查相关脚本是否为零诊断。
3. 禁用并重新启用插件。
4. 清空输出面板，确认没有新的 preload、parse 或 hot-reload 错误。

## Runtime 与内置产物同步

开发 checkout 可以从 `runtime/dist` 启动。发布包使用：

```text
addons/godetx/runtime/dist/src/
```

修改 Runtime 后必须：

1. 执行 `npm.cmd run check`。
2. 执行 `npm.cmd test`。
3. 执行 `npm.cmd run build`。
4. 确认打包脚本复制的是最新 `runtime/dist/src`。

不要手工修改编译后的 JavaScript 作为源码修复。

## Windows 自包含打包

```powershell
package_addon.bat
```

脚本执行：

1. 编译 TypeScript Runtime。
2. 重建插件内 Runtime 目录。
3. 安装生产依赖。
4. 复制或复用当前 Windows 架构的 Node.js。
5. 导入 `server.js` 验证发布产物。

如需指定 Node.js：

```powershell
$env:GODETX_NODE_BIN = "D:\Tools\node.exe"
package_addon.bat
```

打包时应先在 Godot 中禁用插件，避免正在使用的 `node.exe` 或 Runtime 文件被锁定。

## 手工验收

### 会话与本地化

- 中文主机显示简体中文；英文和未知语言回退英文。
- 项目自己的 locale 不被修改。
- 新建、重命名、切换和删除会话正常。
- 重启插件后恢复时间线、思考、工具记录和 Usage。
- 被重载中断的任务显示“已中断”，不恢复旧审批。

### 场景租约

1. 打开 `demo/main.tscn`。
2. 提交一个复制节点或修改属性的任务。
3. 模型工作期间切换到另一场景。
4. 确认任务仍修改提交时的场景。
5. 确认只创建一个对应场景的 Undo 动作。
6. 验证 Undo/Redo，确认没有自动保存。

### 游戏调试

- 启动主场景或指定场景。
- 检查 debugger 生命周期、Probe 和有界输出。
- 使用准确 `run_id` 停止。
- 手动运行的游戏不得被接管。

### 模拟自动化

- 启用项目级自动化开关后提交新任务。
- 使用一次 `game_test` 执行点击、InputMap 和属性断言。
- 确认没有模型驱动的高频状态轮询。
- 关闭设置并提交新任务，确认自动化工具被拒绝。

### ImageX

- 单图成功生成并定位到 `res://assets/generated/`。
- 精灵换皮和图集变体保持源尺寸且不覆盖原图。
- 失败状态不会立即被“就绪”覆盖。
- 不支持图片能力的 Provider 会禁用对应控件。

## 代码边界

- Provider 适配器不得直接执行工具或操作 Godot。
- ToolKernel 不得依赖某个 Provider 的事件格式。
- EditorBridge 调用必须在编辑器主线程执行并保持结果有界。
- 场景写入必须验证租约、修订和一次性授权。
- 外部网页和项目源文本都应标记为不可信输入。
- 新的持久化字段必须有版本和上限。

提交修改前阅读 [贡献指南](../CONTRIBUTING.md)。

[返回文档索引](README.md)
