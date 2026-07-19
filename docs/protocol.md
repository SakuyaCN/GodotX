# Runtime 协议

Godot 编辑器插件与 Node.js Runtime 通过版本化 WebSocket 协议通信。Godot 不解析任何 Provider 原生 SSE；Provider 事件必须先在 Runtime 中归一化。

## 传输

- Runtime 只绑定回环地址。
- 编辑器为每次插件启动生成新的 256 位随机能力令牌。
- 原始令牌只用于 WebSocket 握手；子进程参数中只出现 SHA-256 摘要。
- 编辑器通过 `server.ready` 校验协议版本和工作区。
- 每个 Runtime 事件都有单调递增的 `seq`。

当前协议版本：

```ts
const PROTOCOL_VERSION = 1;
```

## 客户端请求

请求包含稳定 ID、方法和参数：

```json
{
  "id": "request_123",
  "method": "session.list",
  "params": {}
}
```

响应与请求 ID 关联。长任务的进度、流式内容和工具生命周期通过独立事件发送。

## 事件信封

```json
{
  "version": 1,
  "seq": 12,
  "time": "2026-07-19T00:00:00.000Z",
  "type": "message.delta",
  "session_id": "session_...",
  "turn_id": "turn_...",
  "item_id": "item_...",
  "data": {
    "delta": "Hello"
  }
}
```

`session_id`、`turn_id` 和 `item_id` 会按事件语义出现。`data` 始终保存该事件的 Provider 无关载荷。

## 事件类型

### 服务与会话

- `server.ready`
- `session.created`
- `turn.started`
- `turn.completed`
- `turn.failed`

### 模型输出

- `context.prepared`
- `message.delta`
- `message.completed`
- `reasoning.summary.delta`
- `usage.updated`
- `provider.fallback`

### 工具与审批

- `tool.started`
- `tool.output.delta`
- `tool.completed`
- `approval.requested`
- `approval.resolved`

### 变更与 EditorBridge

- `file_change.proposed`
- `file_change.applied`
- `editor_change.proposed`
- `editor_change.applied`
- `editor.tool.request`

### 图片工作流

- `asset.progress`

## 客户端方法

| 分组 | 方法 |
| --- | --- |
| 配置 | `configure`、`providers.list`、`models.list` |
| 图片 | `image.capabilities`、`image.generate`、`image.edit`、`image.cancel`、`ui_kit.generate` |
| 附件 | `attachment.register`、`attachment.get` |
| 索引 | `index.status`、`index.rebuild` |
| 技能 | `skills.list`、`skills.refresh`、`skills.get`、`skills.save`、`skills.delete`、`skills.set_enabled` |
| 会话 | `session.create`、`session.list`、`session.get`、`session.rename`、`session.delete` |
| 任务 | `turn.start`、`turn.cancel` |
| 审批与编辑器 | `approval.respond`、`editor.tool.respond` |
| 生命周期 | `ping`、`shutdown` |

## 配置

新客户端使用 Provider 无关配置：

```json
{
  "provider_id": "openai-compatible",
  "provider_config": {
    "base_url": "https://example.com/v1",
    "api_key": "<secret>",
    "api_mode": "auto"
  },
  "model": "model-id",
  "approval_mode": "ask"
}
```

协议 v1 仍接受旧 `base_url`、`api_key` 和 `api_mode` 字段，并将其归一化为 OpenAI-compatible Provider。新功能不应继续增加 Provider 专用顶层字段。

## 启动任务

`turn.start` 可以携带：

- 会话 ID。
- Provider 实际接收的内部 prompt。
- 只用于界面显示的 `display_prompt`。
- 模型和推理强度。
- 全部场景租约与主场景 ID。
- 提交时打开的场景路径。
- 运行时模拟自动化开关快照。
- 最多四个图片附件引用。

场景和自动化状态在提交时冻结，后续 UI 切换不会改变该任务权限。

## EditorBridge 请求

Runtime 发出：

```json
{
  "type": "editor.tool.request",
  "data": {
    "request_id": "editor_request_...",
    "tool": "scene_get_tree",
    "arguments": {},
    "scene_lease": {
      "scene_id": "scene_...",
      "scene_path": "res://demo/main.tscn",
      "scene_revision": "..."
    }
  }
}
```

Godot 必须使用相同 `request_id` 通过 `editor.tool.respond` 返回结果或结构化错误。重复、未知、超时或取消后的响应会被拒绝。

## 兼容性原则

- 新事件应保持 Provider 无关。
- 可选字段必须有明确缺省行为。
- 未知请求方法应失败，而不是静默忽略。
- 历史时间线不得重放审批、EditorBridge 请求或游戏运行能力。
- Provider 原生 chunk、URL 和密钥不得进入 Godot UI 协议。

类型定义以 [`runtime/src/protocol.ts`](../runtime/src/protocol.ts) 为准。

[返回文档索引](README.md)
