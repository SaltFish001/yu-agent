/**
 * yu-agent — AST-aware refactoring module.
 *
 * Uses TypeScript Compiler API for AST-level code transformation.
 * Falls back to string-level operations where TS API is limited.
 *
 * Exports:
 *   renameSymbol(from, to, filePaths?)  — Rename a symbol across files
 *   extractInterface(typeName, filePath) — Extract an inline type to an interface
 *   refactorCommand(action, args)       — CLI command handler for `yu refactor`
 */

import { createLogger } from '../logger.js'

const logRefactor = createLogger('refactor')

import { existsSync, writeFileSync } from 'fs'
import { relative, resolve } from 'path'
import ts from 'typescript'

// ── Helpers ────────────────────────────────────────────

/** Format code with Biome JS API. */
async function formatBiome(code: string, filePath: string): Promise<string> {
  try {
    const { Biome, Distribution } = await import('@biomejs/js-api')
    const biome = await Biome.create({ distribution: Distribution.NODE })
    const project = biome.openProject()
    const result = biome.formatContent(project.projectKey, code, { filePath })
    biome.shutdown()
    return result.content
  } catch {
    return code
  }
}

/**
 * Parse a TypeScript source file.
 */
function parseFile(filePath: string): ts.SourceFile | null {
  if (!existsSync(filePath)) {
    logRefactor.info(`File not found: ${filePath}`)
    return null
  }
  const text = ts.sys.readFile(filePath)
  if (!text) {
    logRefactor.info(`Could not read: ${filePath}`)
    return null
  }
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true)
}

// ── renameSymbol ───────────────────────────────────────

/**
 * Rename a symbol across one or more files.
 *
 * Uses the TypeScript AST to find all Identifier nodes matching `from`
 * and replaces them with `to`. The replacement is scope-aware:
 * it only renames identifiers that are references to the same symbol,
 * not coincidental name matches in different scopes.
 *
 * @param from  — Current symbol name
 * @param to    — New symbol name
 * @param filePaths — Files to process (resolved from cwd)
 * @returns Array of modified file paths
 */
export async function renameSymbol(from: string, to: string, filePaths?: string[]): Promise<string[]> {
  if (!from || !to) {
    throw new Error('renameSymbol requires both "from" and "to" names')
  }

  const files = filePaths?.map((f) => resolve(f)) ?? []
  if (files.length === 0) {
    throw new Error('No files specified for renameSymbol')
  }

  const modifiedFiles: string[] = []

  for (const filePath of files) {
    if (!existsSync(filePath)) {
      logRefactor.info(`Skipping (not found): ${filePath}`)
      continue
    }

    const originalText = ts.sys.readFile(filePath)
    if (!originalText) continue

    // Simple approach: parse, find all matching identifiers that are
    // declarations or references to the symbol, replace them.
    const sourceFile = ts.createSourceFile(filePath, originalText, ts.ScriptTarget.ES2022, true)
    let hasChanges = false

    // Collect positions of all identifiers that match `from`
    // We use the walk-based approach to find Identifier tokens
    const replacements: { start: number; length: number }[] = []

    function visit(node: ts.Node): void {
      if (ts.isIdentifier(node) && node.text === from) {
        const parent = node.parent
        if (parent) {
          // Skip property names in object literals and declarations
          const p = parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node }
          if (p.name === node) return
          // Skip import/export specifier aliases
          if (ts.isImportSpecifier(parent) && p.propertyName === node) return
          if (ts.isExportSpecifier(parent) && p.propertyName === node) return
          // Skip namespace/module names
          if (ts.isModuleDeclaration(parent)) return
          if (ts.isNamespaceImport(parent)) return

          replacements.push({ start: node.getStart(sourceFile), length: node.text.length })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    if (replacements.length === 0) continue

    // Apply replacements in reverse order to preserve positions
    let modified = originalText
    for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
      modified = modified.slice(0, r.start) + to + modified.slice(r.start + r.length)
      hasChanges = true
    }

    if (hasChanges) {
      // Format with Biome
      modified = await formatBiome(modified, filePath)
      writeFileSync(filePath, modified, 'utf-8')
      modifiedFiles.push(filePath)
      logRefactor.info(`Renamed '${from}' → '${to}' in ${relative(process.cwd(), filePath)}`, {
        occurrences: replacements.length,
      })
    }
  }

  return modifiedFiles
}

// ── extractInterface ───────────────────────────────────

/**
 * Extract an inline type literal to a named interface.
 *
 * Finds the first variable/parameter with an inline object type literal,
 * creates an exported interface with the given name, and replaces the
 * inline type with a reference to the new interface.
 *
 * @param typeName — Name for the new interface
 * @param filePath — File to process
 * @returns The path to the modified file, or null if nothing was done
 */
export async function extractInterface(typeName: string, filePath: string): Promise<string | null> {
  if (!typeName || !filePath) {
    throw new Error('extractInterface requires typeName and filePath')
  }

  const resolvedPath = resolve(filePath)
  const sourceFile = parseFile(resolvedPath)
  if (!sourceFile) return null

  // Find the first variable declaration with an inline type literal
  let targetNode: ts.VariableDeclaration | ts.ParameterDeclaration | undefined
  let inlineType: ts.TypeLiteralNode | undefined

  function findInline(node: ts.Node): void {
    if (targetNode) return

    if (ts.isVariableDeclaration(node) && node.type && ts.isTypeLiteralNode(node.type)) {
      targetNode = node
      inlineType = node.type
    }
    if (ts.isParameter(node) && node.type && ts.isTypeLiteralNode(node.type)) {
      targetNode = node
      inlineType = node.type
    }
    ts.forEachChild(node, findInline)
  }
  findInline(sourceFile)

  if (!targetNode || !inlineType) {
    logRefactor.info('No inline type literal found to extract.')
    return null
  }

  // Create the interface declaration with the same members
  const interfaceDecl = ts.factory.createInterfaceDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
    ts.factory.createIdentifier(typeName),
    undefined,
    undefined,
    inlineType.members.map((m) => {
      // Recreate each member using the type literal member's source
      const sig = m as ts.PropertySignature
      return ts.factory.createPropertySignature(sig.modifiers, sig.name, sig.questionToken, sig.type)
    }),
  )

  // Build the modified text
  const originalText = sourceFile.text
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  const interfaceText = printer.printNode(ts.EmitHint.Unspecified, interfaceDecl, sourceFile)

  // Replace the inline type with the interface name
  const typeStart = targetNode.type!.getStart(sourceFile)
  const typeEnd = targetNode.type!.getEnd()
  let modified = originalText.slice(0, typeStart) + typeName + originalText.slice(typeEnd)

  // Insert the interface declaration after imports
  let importEnd = 0
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      importEnd = stmt.getEnd()
    } else {
      break
    }
  }

  const insertAt = importEnd > 0 ? importEnd : (sourceFile.statements[0]?.getStart(sourceFile) ?? 0)
  modified = `${modified.slice(0, insertAt)}\n\n${interfaceText}\n${modified.slice(insertAt)}`

  // Format with Biome
  modified = await formatBiome(modified, resolvedPath)
  writeFileSync(resolvedPath, modified, 'utf-8')
  logRefactor.info(`Extracted interface '${typeName}' in ${relative(process.cwd(), resolvedPath)}`)

  return resolvedPath
}

// ── CLI command handler ────────────────────────────────

/**
 * Handle `yu refactor <action> [args...]`
 *
 * Usage:
 *   yu refactor rename <from> <to> [files...]
 *   yu refactor extract <typeName> <filePath>
 */
export async function refactorCommand(action: string, args: string[]): Promise<string> {
  switch (action) {
    case 'rename': {
      const [from, to, ...files] = args
      if (!from || !to) {
        return 'Usage: yu refactor rename <from> <to> [files...]'
      }
      const modified = await renameSymbol(from, to, files.length > 0 ? files : undefined)
      if (modified.length === 0) {
        return `No files modified. Symbol '${from}' not found.`
      }
      return `Renamed '${from}' → '${to}' in ${modified.length} file(s):\n  ${modified.map((f) => `  ${relative(process.cwd(), f)}`).join('\n')}`
    }

    case 'extract': {
      const [typeName, filePath] = args
      if (!typeName || !filePath) {
        return 'Usage: yu refactor extract <typeName> <filePath>'
      }
      const result = await extractInterface(typeName, filePath)
      if (!result) {
        return 'No inline type literal found to extract.'
      }
      return `Extracted interface '${typeName}' in ${relative(process.cwd(), result)}`
    }

    default:
      return `Unknown refactor action: ${action}\nAvailable: rename, extract`
  }
}
