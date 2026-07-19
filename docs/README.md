# GodotX 文档

**中文** | [English](en/README.md)

这里保存 GodotX 的使用、架构和开发文档。第一次使用时建议按“快速开始 → 功能指南 → Provider 指南”的顺序阅读；实现贡献者应继续阅读架构、协议和开发指南。

## 使用者文档

| 文档 | 适合解决的问题 |
| --- | --- |
| [快速开始](getting-started.md) | 如何安装、启用、连接模型和排查常见问题 |
| [功能指南](features.md) | GodotX、ImageX、SkillX 分别能做什么 |
| [Provider 指南](providers.md) | 如何选择、配置和扩展模型 Provider |
| [安全策略](../SECURITY.md) | 哪些操作受保护，如何报告安全问题 |

## 开发者文档

| 文档 | 内容 |
| --- | --- |
| [架构](architecture.md) | Runtime、ToolKernel、EditorBridge、会话和安全边界 |
| [协议](protocol.md) | Godot 与 Runtime 之间的 WebSocket 协议 |
| [开发指南](development.md) | 构建、测试、打包和编辑器验收 |
| [贡献指南](../CONTRIBUTING.md) | Issue、代码修改和 Pull Request 约定 |

## 推荐阅读路径

### 我只想使用插件

1. 阅读 [快速开始](getting-started.md) 并完成安装。
2. 根据服务选择 [Provider](providers.md)。
3. 在 [功能指南](features.md) 中查看代码编辑、场景编辑、游戏测试或 ImageX 工作流。

### 我要添加 Provider

1. 阅读 [Provider 指南](providers.md) 的扩展部分。
2. 阅读 [架构](architecture.md) 中的 Runtime ownership 和 Provider compatibility。
3. 使用 [开发指南](development.md) 中的检查与测试命令。

### 我要添加 Godot 编辑器工具

1. 阅读 [架构](architecture.md) 中的 EditorBridge lifecycle。
2. 保持工具 schema、Runtime 路由和 Godot 主线程执行边界分离。
3. 为 Runtime 和 `tests/godot/` 同时补充验证。

## 术语

| 术语 | 含义 |
| --- | --- |
| Runtime | 独立 Node.js 进程，负责 Agent 循环、Provider、会话和 Runtime 工具 |
| Provider | 将统一请求转换为具体模型服务协议的适配器 |
| ToolKernel | Provider 无关的工具注册、路由和执行层 |
| EditorBridge | 在 Godot 编辑器主线程读取或修改实时编辑器状态的桥接层 |
| 场景租约 | 任务提交时冻结的场景实例、路径和 Undo 历史版本 |
| ImageX | 图片生成与编辑工作区 |
| SkillX | 可复用模型指令管理工作区 |

[返回项目首页](../README.md)
