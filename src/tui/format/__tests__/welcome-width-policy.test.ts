import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatWelcome, formatWelcomeBrand } from '../welcome.js'
import { getTheme } from '../../theme.js'
import { displayWidth } from '../../width.js'

for (const mode of ['narrow', 'wide', 'full']) {
  test(`welcome rendering fits the actual display width in ${mode} terminals`, () => {
    const previous = process.env.RIVET_AMBIGUOUS_WIDTH
    process.env.RIVET_AMBIGUOUS_WIDTH = mode
    try {
      const theme = getTheme(0)
      for (const columns of [58, 80, 120]) {
        const welcome = formatWelcome({
          modelName: 'fixture', cwd: '/fixture', sessionId: 'fixture', priorMsgCount: 0,
          compact: false, columns, rows: 40, version: 'fixture', guide: true,
        }, theme)
        for (const row of [...welcome, ...formatWelcomeBrand(columns, theme)]) {
          const cells = displayWidth(row, { ambiguousAsWide: true })
          assert.ok(cells <= columns, `${mode} ${columns} columns: ${cells} cells: ${row}`)
        }
      }
    } finally {
      if (previous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
      else process.env.RIVET_AMBIGUOUS_WIDTH = previous
    }
  })
}
