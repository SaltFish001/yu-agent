/**
 * yu-agent — Edit 工具
 *
 * find-and-replace 编辑 + insert/append/prepend 模式。
 * Phase 1b 增强：multi-line patch + insert/append/prepend。
 */

import { createLogger } from '../logger.js'
import { registerTool, type ToolResult } from './registry.js'

const _log = createLogger('tool-edit')

registerTool({
  name: 'edit',
  description: 'Edit a file using find-and-replace, or insert/append/prepend content.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['replace', 'insert', 'append', 'prepend'],
        description: 'Edit mode. Default: replace',
      },
      path: {
        type: 'string',
        description: 'File path to edit',
      },
      old_string: {
        type: 'string',
        description: '(replace mode) Text to find and replace.',
      },
      new_string: {
        type: 'string',
        description: 'Replacement / content to insert',
      },
      replace_all: {
        type: 'boolean',
        description: '(replace mode) Replace all occurrences',
      },
      line: {
        type: 'number',
        description: '(insert mode) Line number to insert at (1-indexed)',
      },
    },
    required: ['path', 'new_string'],
  },
  async execute(params): Promise<ToolResult> {
    const mode = String(params.mode ?? 'replace')
    const filePath = String(params.path ?? '')
    const newStr = String(params.new_string ?? '')

    if (!filePath.trim()) {
      return { success: false, output: '', error: 'Empty path' }
    }

    try {
      // ── append 模式 ──────────────────────────────
      if (mode === 'append') {
        const file = Bun.file(filePath)
        const exists = await file.exists()
        if (!exists) {
          // 文件不存在则创建
          await Bun.write(filePath, newStr)
          return { success: true, output: `Created file: ${filePath}` }
        }
        const existing = await file.text()
        const newContent = existing.endsWith('\n') ? `${existing + newStr}\n` : `${existing}\n${newStr}\n`
        await Bun.write(filePath, newContent)
        return { success: true, output: 'Content appended to file' }
      }

      // ── prepend 模式 ─────────────────────────────
      if (mode === 'prepend') {
        const file = Bun.file(filePath)
        const exists = await file.exists()
        if (!exists) {
          await Bun.write(filePath, newStr)
          return { success: true, output: `Created file: ${filePath}` }
        }
        const existing = await file.text()
        const newContent = `${newStr}\n${existing}`
        await Bun.write(filePath, newContent)
        return { success: true, output: 'Content prepended to file' }
      }

      // ── insert 模式（按行号） ─────────────────────
      if (mode === 'insert') {
        const lineNum = typeof params.line === 'number' ? params.line : 1
        const file = Bun.file(filePath)
        const exists = await file.exists()
        if (!exists) {
          return { success: false, output: '', error: `File not found: ${filePath}` }
        }
        const content = await file.text()
        const lines = content.split('\n')
        const idx = Math.max(0, Math.min(lineNum - 1, lines.length))
        lines.splice(idx, 0, newStr)
        await Bun.write(filePath, lines.join('\n'))
        return { success: true, output: `Content inserted at line ${lineNum}` }
      }

      // ── replace 模式（默认） ──────────────────────
      const oldStr = String(params.old_string ?? '')
      if (!oldStr) {
        return { success: false, output: '', error: 'old_string is required in replace mode' }
      }

      const file = Bun.file(filePath)
      const exists = await file.exists()
      if (!exists) {
        return { success: false, output: '', error: `File not found: ${filePath}` }
      }

      const content = await file.text()
      const replaceAll = Boolean(params.replace_all)

      if (replaceAll) {
        const newContent = content.replaceAll(oldStr, newStr)
        if (newContent === content) {
          return { success: false, output: '', error: 'old_string not found in file' }
        }
        await Bun.write(filePath, newContent)
        return { success: true, output: 'Replaced all occurrences' }
      }

      const idx = content.indexOf(oldStr)
      if (idx === -1) {
        return { success: false, output: '', error: 'old_string not found in file' }
      }
      const secondIdx = content.indexOf(oldStr, idx + 1)
      if (secondIdx !== -1) {
        return {
          success: false,
          output: '',
          error: 'old_string appears multiple times. Use replace_all=true or provide a more specific match.',
        }
      }

      const newContent = content.replace(oldStr, newStr)
      await Bun.write(filePath, newContent)
      return { success: true, output: 'File updated successfully' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: msg }
    }
  },
})
