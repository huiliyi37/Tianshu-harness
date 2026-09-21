import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dropdownSrc = readFileSync(join(here, '../../components/ui/dropdown-menu.tsx'), 'utf8')
const tooltipSrc = readFileSync(join(here, '../../components/ui/tooltip.tsx'), 'utf8')
const sidebarSrc = readFileSync(join(here, '../../surfaces/ProjectSidebar.tsx'), 'utf8')
const cssSrc = readFileSync(join(here, '../../styles.css'), 'utf8')

test('dropdown menu is not locked to the trigger width (chevron would wrap 新建任务（高级选项）)', () => {
  assert.match(dropdownSrc, /w-max/)
  assert.doesNotMatch(dropdownSrc, /w-\(--anchor-width\)/)
  assert.match(dropdownSrc, /whitespace-nowrap/)
})

test('tooltip content does not wrap CJK labels', () => {
  assert.match(tooltipSrc, /whitespace-nowrap/)
  assert.match(tooltipSrc, /w-max/)
})

test('new-task advanced item is a nowrap dropdown, not a native title on the chevron', () => {
  assert.match(sidebarSrc, /navNewTaskAdvanced/)
  assert.match(sidebarSrc, /sidebar-nav-item-split/)
  assert.match(sidebarSrc, /whitespace-nowrap/)
  const chevronBlock = sidebarSrc.slice(
    sidebarSrc.indexOf('sidebar-nav-more'),
    sidebarSrc.indexOf('DropdownMenuContent'),
  )
  assert.doesNotMatch(chevronBlock, /title=\{t\('sidebar\.navNewTaskAdvanced'\)\}/)
})

test('sidebar nav labels stay on one line when the panel is squeezed', () => {
  assert.match(cssSrc, /\.sidebar-nav-item \.sni-label[\s\S]*?white-space:\s*nowrap/)
})
