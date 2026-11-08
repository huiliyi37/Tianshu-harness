// TEMPORARY residency probe plugin (tianshu-imbridge task, phase: detection)
// Purpose: verify plugin module toplevel executes exactly once per process,
// heartbeats keep running while process lives, and no double-write happens
// when multiple sessions exist in the same process.
// Delete this plugin (and probe-test dir) after validation.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = 'D:/path/to/probe-home'
const DATA_FILE = join(DATA_DIR, 'heartbeat.log')
const PID = process.pid
let hbCount = 0

function log(line) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(DATA_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch (e) {
    // probe must never hurt the host process
    console.error('[probe] write failed:', e?.message ?? e)
  }
}

log(`TOPLEVEL pid=${PID} node=${process.version} entry=${process.argv[1] ?? ''} cwd=${process.cwd()}`)

const timer = setInterval(() => {
  hbCount += 1
  log(`HEARTBEAT pid=${PID} n=${hbCount}`)
}, 5000)

export const tools = [
  {
    definition: {
      name: 'probe_ping',
      description: 'Residency probe: returns process id, uptime, heartbeat count and data file path',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => {
      log(`TOOLCALL pid=${PID}`)
      return {
        content: JSON.stringify({
          pid: PID,
          uptimeSec: Math.round(process.uptime()),
          heartbeatCount: hbCount,
          dataFile: DATA_FILE,
          node: process.version,
        }),
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]
