# Provider 指南

GodotX 的 Agent、工具和编辑器 UI 不依赖具体模型厂商。Provider 只负责模型发现、能力声明、请求转换和流式响应解析。

## 内置 Provider

| Provider | 配置 | 传输 | 工具调用 | 图片输入 | ImageX |
| --- | --- | --- | :---: | :---: | :---: |
| OpenAI-compatible | Base URL、API Key、API 模式 | Responses / Chat Completions | 是 | 取决于模型 | 取决于服务 |
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

GodotX 只展示 Runtime 已完整支持且能够调用工具的路由。需要原生 Anthropic Messages 或 Gemini 协议的模型会被过滤，直到对应传输适配器完成。

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
