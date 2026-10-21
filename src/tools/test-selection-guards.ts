import { readFileSync } from 'node:fs'
import type ts from 'typescript'
import { loadTypeScript } from '../utils/typescript-runtime.js'

/** Jest's JSON omits focus modes. Reject focused definitions rather than guessing from counts. */
export function hasFocusedTestDefinition(path: string): boolean {
  try {
    const ts = loadTypeScript()
    if (!ts) return true
    const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    let focused = false
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && ['fit', 'fdescribe'].includes(node.text)) focused = true
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'only') focused = true
      if (ts.isElementAccessExpression(node)) {
        const argument = node.argumentExpression
        if (argument && ts.isStringLiteralLike(argument) && argument.text === 'only') focused = true
        else if (argument && !ts.isStringLiteralLike(argument) && /^(?:test|it|describe|suite)$/.test(node.expression.getText(tree))) focused = true
      }
      if (!focused) ts.forEachChild(node, visit)
    }
    visit(tree)
    return focused
  } catch { return true }
}
