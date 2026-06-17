/**
 * yu-agent — Web Search / Extract 工具
 *
 * 包装 browser/index.ts 的 webSearch/webExtract 导出。
 * 非移植——直接引用现有实现。
 */

import { registerTool, type ToolResult } from './registry.js'

async function importBrowser() {
  return import('../browser/index.js')
}

registerTool({
  name: 'web_search',
  description: 'Search the web for information. Returns up to 10 results with titles, URLs, and snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      limit: {
        type: 'number',
        description: 'Max results (default: 5, max: 10)',
      },
    },
    required: ['query'],
  },
  async execute(params): Promise<ToolResult> {
    try {
      const browser = await importBrowser()
      const query = String(params.query ?? '')
      const limit = Math.min(10, Number(params.limit ?? 5))
      const result = await browser.webSearch({ query, limit })
      return {
        success: !result.isError,
        output: result.text ?? JSON.stringify(result),
        error: result.isError ? result.text : undefined,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: msg }
    }
  },
})

registerTool({
  name: 'web_extract',
  description: 'Fetch and parse a webpage to clean text content.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to extract content from',
      },
      maxLength: {
        type: 'number',
        description: 'Maximum content length (default: 8000)',
      },
    },
    required: ['url'],
  },
  async execute(params): Promise<ToolResult> {
    try {
      const browser = await importBrowser()
      const url = String(params.url ?? '')
      const maxLength = Number(params.maxLength ?? 8000)
      const result = await browser.webExtract({ url, maxLength })
      return {
        success: !result.isError,
        output: result.text ?? JSON.stringify(result),
        error: result.isError ? result.text : undefined,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: msg }
    }
  },
})
