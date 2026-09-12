import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { getDefaultEditor } from '../platform.js'

export function getEditorCommand(): string {
  return process.env['VISUAL'] || process.env['EDITOR'] || getDefaultEditor()
}

export function createTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-edit-'))
  const path = join(dir, 'RIVET_INPUT.md')
  writeFileSync(path, content)
  return path
}

export function readAndCleanup(path: string): string {
  const content = readFileSync(path, 'utf-8')
  try { unlinkSync(path) } catch { /* best effort */ }
  return content
}

export function openInEditor(initialContent: string): string | null {
  const path = createTempFile(initialContent)
  const editor = getEditorCommand()
  const result = spawnSync(editor, [path], { stdio: 'inherit', windowsHide: true })
  if (result.status !== 0 && result.error) return null
  // status may be non-zero if editor was terminated but file was saved
  return readAndCleanup(path)
}
