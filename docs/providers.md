# Provider 指南

**中文** | [English](en/providers.md)

GodotX 的 Agent、工具和编辑器 UI 不依赖具体模型厂商。Provider 只负责模型发现、能力声明、请求转换和流式响应解析。

## 内置 Provider

| Provider | 配置 | 传输 | 工具调用 | 图片输入 | ImageX |
| --- | --- | --- | :---: | :---: | :---: |
| OpenAI-compatible | Base URL、API Key、API 模式 | Responses / Chat Completions | 是 | 取决于模型 | 取决于服务 |
| Anthropic | Base URL、API Key | 原生 Messages | 是 | 是 | 否 |
| DeepSeek | API Key | 官方 Chat Completions | 是 | 否 | 否 |
| OpenCode Zen | Zen API Key | 按模型选择 Responses / Chat | 是 | 当前未开放 | 否 |

## OpenAI-compatible

默认模型为 `gpt-5.6-sol`。API 模式支持：

- `auto`：优先 Responses，必要时回退 Chat Completions。
- `responses`：只使用 Responses API。
- `chat_completions`：只使用 Chat Completions API。

该 Provider 适用于实现兼容接口的托管服务或本地网关。兼容并不意味着所有可选能力都存在；模型列表、推理摘要、图片输入、图片生成和图片编辑会分别探测或按模型能力声明控制。

Base URL 规则：

- 远程地址必须使用 HTTPS。
- HTTP 只允许精确回环主机。
- 拒绝 URL 用户信息、查询参数和片段。
- API Key 不会拼入 URL。

## Anthropic

Anthropic Provider 使用原生 Messages API，而不是 OpenAI 兼容协议。它支持：

- `/models` 模型发现与分页。
- Messages SSE 文本和 Thinking 内容块。
- `tool_use` 与 `tool_result` 多轮工具调用。
- PNG、JPEG 和 WebP 聊天图片输入。
- Anthropic 原生用量统计与错误分类。

填写裸主机地址时会自动使用 `/v1`；也可以直接填写完整 API 根地址。远程地址默认必须使用 HTTPS。测试私有网关时可以显式开启 **允许不安全的 HTTP**，但这会让 API Key 未经加密地通过网络，仅应在可信隔离网络中临时使用。

Anthropic Provider 不实现图片生成或编辑，因此可以在 GodotX 对话中查看图片，但不能供 ImageX 使用。

## DeepSeek

内置适配器固定使用：

```text
https://api.deepseek.com
```

默认模型是 `deepseek-v4-flash`，并支持 `deepseek-v4-pro`。V4 模型暴露 `high` 和 `max` 推理强度；`deepseek-chat` 兼容路径关闭 thinking。

DeepSeek 的工具调用过程中会保留所需 reasoning content。当前明确声明不支持图片输入，因此聊天附件和 ImageX 不会错误发送给该 Provider。

## OpenCode Zen

内置端点固定为：

```text
https://opencode.ai/zen/v1
```

模型列表来自两个来源的交集：

1. Zen 认证后的实时 `/models`。
2. models.dev 提供的协议与工具能力元数据。

GodotX 只展示 Zen 适配器已完整支持且能够调用工具的路由。独立 Anthropic Provider 已支持原生 Messages，但 Zen 的 Anthropic 路由尚未接通；这类路由与 Gemini 原生协议模型仍会被过滤。

Zen API Key 只发送到 `opencode.ai`，匿名元数据请求不会携带该密钥。

## 模型能力

Provider 返回的模型能力用于控制 UI，而不是通过模型名字猜测：

- 可用推理强度及默认值。
- 图片输入状态、MIME 类型、细节等级和数量限制。
- 图片生成或编辑能力。
- 工具调用与协议类型。

因此模型选择变化后，推理下拉框和附件按钮会同步更新。

## 模型列表同步

应用 Provider 配置后，Runtime 会立即验证连接并同步模型。以下情况会阻止正常使用：

- API Key 无效。
- 账户余额或额度不足。
- Base URL 不符合安全约束。
- 模型端点不支持所选 API 模式。
- Provider 返回的模型没有当前 Runtime 支持的工具协议。

已保存的本地会话不依赖模型列表，可以在服务暂时不可用时继续浏览。

## 错误分类

Provider 错误进入编辑器前会被归一化：

- 认证失败。
- 余额或额度不足。
- 限流。
- 超时或网络故障。
- 无效响应。
- Provider 内部错误。

结构化余额错误即使使用 HTTP 401，也会显示为额度问题而不是 API Key 问题。原始账单 URL、工作区标识和配置密钥不会渲染或写入会话。

## 密钥持久化

启用 **记住密钥** 后，密钥以明文存储在 Godot 用户级 `EditorSettings` 中，位于仓库之外，并按项目路径哈希与 Provider 隔离。

关闭该选项并应用设置会删除已保存密钥，但当前已连接会话在重连前仍可继续使用内存中的配置。

## 添加新 Provider

在 `runtime/src/provider/types.ts` 实现 `ModelProvider`：

```ts
interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
  getModelCapabilities?(model: string): ProviderModelCapabilities | undefined;
  getImageGenerationCapabilities?(): ImageGenerationCapabilities;
  generateImage?(request: ImageGenerationRequest): Promise<GeneratedImage>;
  streamTurn(request: ProviderRequest): Promise<ProviderTurnResult>;
  dispose?(): void | Promise<void>;
}
```

然后在 `runtime/src/provider/registry.ts` 注册 `ProviderDefinition`：

- 稳定的 Provider ID。
- 用户可见名称。
- 默认模型。
- 声明式配置 schema。
- 配置验证函数。
- Provider 工厂。

Provider 必须把原生事件转换为统一的文本增量、推理增量、工具调用增量、Usage 和最终消息。不要把厂商字段泄漏到 GDScript UI 或 ToolKernel。

新增 Provider 至少应覆盖：

- 配置验证。
- 模型发现。
- 能力声明。
- 文本和工具流式事件。
- 取消和超时。
- 401/403、余额、限流和畸形响应。
- 多轮工具调用消息兼容。

[返回文档索引](README.md)
