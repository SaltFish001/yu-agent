/**
 * yu-agent — MCP 模块导出。
 *
 * 统一导出所有 MCP 相关模块。
 */

export type { McpPrompt, McpPromptArgument, McpPromptMessage, PromptsGetResult, PromptsListResult } from './prompts.js'
export { getPrompt, listPrompts, promptMessagesAsText } from './prompts.js'
export type { McpResource, McpResourceContents, ResourcesListResult, ResourcesReadResult } from './resources.js'
export {
  listResources,
  readResource,
  resourceContentsAsText,
  subscribeResource,
  unsubscribeResource,
} from './resources.js'
export {
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  McpTransport,
  type McpTransportEvents,
} from './transport.js'
export { SseTransport } from './transport-sse.js'
export { StdioTransport } from './transport-stdio.js'
