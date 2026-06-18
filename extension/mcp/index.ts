/**
 * yu-agent — MCP 模块导出。
 *
 * 统一导出所有 MCP 相关模块。
 */

export { McpTransport, type McpTransportEvents, type JsonRpcMessage, type JsonRpcRequest, type JsonRpcNotification, type JsonRpcSuccess, type JsonRpcError } from './transport.js'
export { StdioTransport } from './transport-stdio.js'
export { SseTransport } from './transport-sse.js'
export { listResources, readResource, subscribeResource, unsubscribeResource, resourceContentsAsText } from './resources.js'
export type { McpResource, McpResourceContents, ResourcesListResult, ResourcesReadResult } from './resources.js'
export { listPrompts, getPrompt, promptMessagesAsText } from './prompts.js'
export type { McpPrompt, McpPromptArgument, McpPromptMessage, PromptsListResult, PromptsGetResult } from './prompts.js'
