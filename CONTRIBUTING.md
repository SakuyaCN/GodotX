# 贡献指南

感谢你改进 GodotX。项目同时包含 Godot 编辑器代码和 Node.js Agent Runtime，修改时需要保持两侧协议与安全边界一致。

## 提交 Issue

请先搜索已有 Issue。Bug 报告至少包含：

- Godot 完整版本。
- 操作系统和架构。
- Node.js 版本。
- 使用的 Provider 与 API 模式，不要提供 API Key。
- 可复现步骤。
- 预期行为与实际行为。
- Godot 输出面板或 Runtime 的脱敏错误。
- 是否能在最小项目中复现。

图片或日志中请移除本地用户名、项目私密内容、密钥、账单链接和工作区标识。

安全问题不要创建公开 Issue，请按 [安全策略](SECURITY.md) 私下报告。

## 开发环境

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
```

Godot 侧需要 4.6+。不要为验证插件启动第二个或无头 Godot；使用已经运行的宿主编辑器和 `tests/godot/` 中的验证入口。

## 修改原则

- 保持 Provider、Agent Runtime、ToolKernel 和 EditorBridge 的职责分离。
- 优先复用已有 schema、事件和工具注册模式。
- 文件与场景变更必须保留预览、审批、冲突检查和回滚。
- 不要放宽工作区、命令、场景租约或游戏运行所有权限制。
- 不要把 API Key、Base64 图片或 Provider 原生事件写入会话协议。
- 用户可见文案必须补充英文源文本与简体中文翻译。
- GDScript 使用显式类型处理容易触发 Godot 类型推断错误的 Variant。
- 不要提交 `node_modules/`、`runtime/dist/`、`.godot/`、打包 Runtime 或本地用户数据。

## 测试要求

修改范围决定测试范围：

| 修改 | 最低验证 |
| --- | --- |
| Provider 或协议 | `npm.cmd run check`、目标 Provider/协议测试、`npm.cmd test` |
| Agent 或 ToolKernel | 目标 Agent/工具测试、`npm.cmd test` |
| Godot UI | 现有 Godot LSP 零诊断、相关 `tests/godot/` 验证 |
| EditorBridge/场景 | 租约、修订、Undo/Redo 和多场景验证 |
| ImageX | Runtime 图片测试、Godot UI 测试、实际输出尺寸与预览 |
| 文档 | 相对链接、标题层级、命令和路径检查 |

涉及 Runtime 发布产物时，必须重新构建并确认打包目录与 `runtime/dist/src` 一致。

## Pull Request

PR 应：

- 聚焦一个明确问题。
- 描述用户可见行为变化。
- 说明架构或安全影响。
- 列出执行过的测试。
- 提供 UI 修改前后截图。
- 明确尚未验证的环境或残余风险。

避免将无关重构、生成文件和格式化噪声混入功能修改。

## 文档风格

- README 保持面向首次访问者，不堆放实现细节。
- 详细行为放入 `docs/` 并从文档索引链接。
- 命令必须可直接执行，密钥一律使用 `<key>`。
- 对尚未实现的能力使用“当前不支持”，不要写成已完成。
- 用户可见品牌写作 **GodotX**；内部兼容路径和环境变量按源码实际拼写。
