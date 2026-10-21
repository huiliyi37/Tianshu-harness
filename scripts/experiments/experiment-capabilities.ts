import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { createServer } from 'node:net'
import { observation } from './experiment-protocol.js'

export interface CapabilityContract {
  version: 1; readable: string[]; writableRoots: string[]; protectedFiles: string[]
  generated: string[]; childProcesses: boolean; loopbackPorts: number[]
}
export function contract(files: Record<string, string>, generated: string[] = [], childProcesses = false): CapabilityContract {
  return { version: 1, readable: [...new Set([...Object.keys(files).map(p => p.split('/')[0]!), 'src', 'test', 'support', ...generated])],
    writableRoots: ['src', 'test'], protectedFiles: Object.keys(files).filter(p => !p.startsWith('src/')), generated, childProcesses, loopbackPorts: [] }
}
const under = (path: string, root: string) => path === root || path.startsWith(root + '/')
export function resolveCapability(root: string, input: unknown, mode: 'read' | 'write' | 'list', c: CapabilityContract): { path: string; absolute: string; directory: boolean } {
  if (typeof input !== 'string' || input.includes('\0')) throw new CapabilityError('invalid_path', 'Supply a project path.')
  const absolute = resolve(root, input), path = relative(root, absolute).replaceAll('\\', '/')
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new CapabilityError('outside_workspace', 'Use a path inside the project.')
  if (!path && mode === 'list') return { path, absolute, directory: true }
  if (!c.readable.some(p => under(path, p))) throw new CapabilityError('undeclared_path', 'This path is outside the declared task inputs; use list_files for visible inputs.')
  let ancestor = absolute
  while (!existsSync(ancestor) && !lstatExists(ancestor)) { if (dirname(ancestor) === ancestor) break; ancestor = dirname(ancestor) }
  let actual: string
  try { actual = realpathSync(ancestor) } catch { throw new CapabilityError('unresolved_symlink', 'The path target cannot be verified; use a declared regular file.') }
  const rel = relative(realpathSync(root), actual)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new CapabilityError('symlink_escape', 'The real path leaves the project; choose an in-project file.')
  const actualPath = relative(realpathSync(root), resolve(actual, relative(ancestor, absolute))).replaceAll('\\', '/')
  if (!c.readable.some(p => under(actualPath, p))) throw new CapabilityError('undeclared_target', 'The resolved target is not a declared task input.')
  if (mode === 'write' && (!c.writableRoots.some(p => under(path, p)) || !c.writableRoots.some(p => under(actualPath, p)) || c.protectedFiles.includes(path) || c.protectedFiles.includes(actualPath))) throw new CapabilityError('protected_path', 'Edit declared source or add a new test; this input/generated file is read-only.')
  if (mode !== 'write' && !existsSync(absolute)) throw new CapabilityError('not_found', 'The requested path does not exist; inspect its parent with list_files.')
  const directory = existsSync(absolute) && statSync(absolute).isDirectory()
  if (mode === 'read' && directory) throw new CapabilityError('directory_path', `This is a directory. Use list_files(path=${JSON.stringify(path)}).`)
  return { path, absolute, directory }
}
function lstatExists(path: string) { try { lstatSync(path); return true } catch { return false } }
export class CapabilityError extends Error { constructor(readonly code: string, readonly nextAction: string) { super(nextAction) } }
export class CapabilityEnvironmentError extends Error { readonly code = 'assigned_port_unavailable' }
export function capabilityFailure(error: unknown, hash: string) {
  const e = error instanceof CapabilityError ? error : new CapabilityError('path_unresolved', 'The real path could not be verified; inspect the declared parent path.')
  const obs = observation('policy', e.code, false, 'path-validation', hash, e.nextAction)
  return { isError: true, observation: obs, content: JSON.stringify({ observation: obs, message: e.message }) }
}
export function describe(c: CapabilityContract): string {
  return `Task capabilities: readable=${c.readable.join(', ')}; editable roots=${c.writableRoots.join(', ')}; original non-source inputs and generated files are read-only. Generated=${c.generated.join(', ') || 'none'}. `
    + `No external network or installs. Test processes may listen/connect only on 127.0.0.1 ports from EXPERIMENT_PORT_1/2; use support/test-server.mjs. `
    + `Child processes=${c.childProcesses ? 'allowed within inherited OS sandbox' : 'denied'}. Private graders, runtime state and temporary repositories are not tool-readable.`
}
const leased = new Set<number>()
export async function allocatePorts(count = 2): Promise<number[]> {
  if (count < 1 || count > 2) throw new Error('At most two loopback ports per execution')
  const held: ReturnType<typeof createServer>[] = []
  try {
    const ports = []
    for (let i = 0; i < count; i++) {
      let port = 0
      for (let attempt = 0; attempt < 16; attempt++) {
        const s = createServer(); held.push(s)
        port = await new Promise<number>((yes, no) => { s.once('error', no); s.listen(0, '127.0.0.1', () => yes((s.address() as { port: number }).port)) })
        if (!leased.has(port)) break
        await new Promise<void>(r => s.close(() => r())); port = 0
      }
      if (!port) throw new Error('Cannot allocate distinct execution ports')
      ports.push(port); leased.add(port)
    }
    return ports
  } finally { await Promise.all(held.map(s => new Promise<void>(r => s.close(() => r())))) }
}
export async function assertPortsAvailable(ports: number[]): Promise<void> {
  for (const port of ports) {
    const server = createServer()
    await new Promise<void>((yes, no) => { server.once('error', () => no(new CapabilityEnvironmentError('Assigned loopback port is unavailable; environment qualification must be repeated, not silently remapped.'))); server.listen(port, '127.0.0.1', () => server.close(() => yes())) })
  }
}
export const TEST_SERVER_HELPER = `export async function listen(server, slot=0) {
 const port=Number(process.env['EXPERIMENT_PORT_'+(slot+1)]);
 if(![0,1].includes(slot)||!Number.isInteger(port)||port<1)throw new Error('Use assigned EXPERIMENT_PORT_1/2 only');
 await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',no);yes()})});
 return {port,url:'http://127.0.0.1:'+port,close:()=>new Promise((yes,no)=>server.close(e=>e?no(e):yes()))};
}
`
export const CAPABILITY_PROBE = `import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {createServer,connect} from 'node:net';import {listen} from './test-server.mjs';
const external=process.argv[2],child=process.argv.includes('--child');
let readDenied=false,writeDenied=false;try{readFileSync(external)}catch(e){readDenied=['EPERM','EACCES','ERR_ACCESS_DENIED'].includes(e.code)}
try{writeFileSync(external,'changed')}catch(e){writeDenied=['EPERM','EACCES','ERR_ACCESS_DENIED'].includes(e.code)}
const networkDenied=await new Promise(yes=>{const s=connect({host:'127.0.0.1',port:9});s.once('connect',()=>{s.destroy();yes(false)});s.once('error',e=>yes(['EPERM','EACCES'].includes(e.code)));setTimeout(()=>{s.destroy();yes(false)},300).unref()});
let listener=true,descendant=true;
if(!child){const s=createServer(c=>c.end());const h=await listen(s);listener=await new Promise(yes=>{const c=connect({host:'127.0.0.1',port:h.port});c.on('connect',()=>{c.destroy();yes(true)});c.on('error',()=>yes(false))});await h.close();
 if(process.argv.includes('--children')){const r=spawnSync('/usr/bin/env',['-i','PATH=/usr/bin:/bin',process.execPath,'support/capability-probe.mjs',external,'--child'],{encoding:'utf8',windowsHide:true});try{const x=JSON.parse(r.stdout.trim().split('\\n').at(-1));descendant=r.status===0&&x.readDenied&&x.writeDenied&&x.networkDenied}catch{descendant=false}}
 else{try{spawnSync(process.execPath,['--version'],{windowsHide:true});descendant=false}catch(e){descendant=e.code==='ERR_ACCESS_DENIED'}}
}
console.log(JSON.stringify({readDenied,writeDenied,networkDenied,listener,descendant}));
process.exitCode=readDenied&&writeDenied&&networkDenied&&listener&&descendant?0:1;
`
