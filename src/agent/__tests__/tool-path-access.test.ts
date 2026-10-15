import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { outOfWorkspaceFilePaths as pipelinePathAccess } from '../tool-pipeline.js'
import { outOfWorkspaceFilePaths } from '../tool-path-access.js'
import { buildApprovalSnapshot, approvalPathGrant } from '../../server/approval-snapshot.js'
import { grantPath, _resetGrantsForTest } from '../../tools/path-grants.js'
import { withWorkspaceRoots } from '../../tools/workspace-context.js'

function fixture(context: TestContext) {
  _resetGrantsForTest()
  const root = mkdtempSync(join(tmpdir(), 'rivet-tool-path-access-'))
  const workspace = join(root, 'workspace')
  const otherWorkspace = join(root, 'other-workspace')
  const external = join(root, 'external')
  for (const directory of [workspace, otherWorkspace, external]) mkdirSync(directory)
  const localFile = join(workspace, 'local.txt')
  const externalFile = join(external, 'outside.txt')
  writeFileSync(localFile, 'local')
  writeFileSync(externalFile, 'outside')
  context.after(() => {
    _resetGrantsForTest()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, workspace, otherWorkspace, external, localFile, externalFile }
}

test('file tool modes keep workspace paths local and require the correct external mode', context => {
  const { workspace, externalFile, localFile } = fixture(context)
  for (const [tool, mode] of [
    ['read_file', 'read'], ['write_file', 'write'], ['edit_file', 'write'],
    ['hash_edit', 'write'], ['ast_edit', 'write'],
  ] as const) {
    assert.equal(outOfWorkspaceFilePaths(workspace, tool, { file_path: localFile }), null)
    assert.equal(outOfWorkspaceFilePaths(workspace, tool, { file_path: 'new-file.txt' }), null)
    assert.deepEqual(outOfWorkspaceFilePaths(workspace, tool, { file_path: externalFile }), { mode, paths: [externalFile] })
  }
})

test('pipeline retains the same synchronous path-access API as the light helper', context => {
  const { workspace, externalFile } = fixture(context)
  assert.equal(pipelinePathAccess, outOfWorkspaceFilePaths)
  assert.deepEqual(pipelinePathAccess(workspace, 'read_file', { file_path: externalFile }), {
    mode: 'read', paths: [externalFile],
  })
})

test('read grants do not authorize writes and workspace-scoped write grants do not leak', context => {
  const { workspace, otherWorkspace, external, externalFile } = fixture(context)
  grantPath(external, 'read', { cwd: workspace })
  assert.equal(outOfWorkspaceFilePaths(workspace, 'read_file', { file_path: externalFile }), null)
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'write_file', { file_path: externalFile }), { mode: 'write', paths: [externalFile] })
  grantPath(external, 'write', { cwd: workspace })
  assert.equal(outOfWorkspaceFilePaths(workspace, 'write_file', { file_path: externalFile }), null)
  assert.equal(outOfWorkspaceFilePaths(workspace, 'read_file', { file_path: externalFile }), null)
  assert.deepEqual(outOfWorkspaceFilePaths(otherWorkspace, 'read_file', { file_path: externalFile }), { mode: 'read', paths: [externalFile] })
  assert.deepEqual(outOfWorkspaceFilePaths(otherWorkspace, 'write_file', { file_path: externalFile }), { mode: 'write', paths: [externalFile] })
})

test('unrecognized tools and missing or non-string operands do not invent grant requests', context => {
  const { workspace, externalFile } = fixture(context)
  for (const tool of ['bash', 'apply_patch', 'read_section', 'unknown']) {
    assert.equal(outOfWorkspaceFilePaths(workspace, tool, { file_path: externalFile }), null)
  }
  for (const input of [{}, { file_path: 42 }, { file_paths: [null, 42] }, { paths: [false] }]) {
    assert.equal(outOfWorkspaceFilePaths(workspace, 'ast_edit', input), null)
  }
  assert.equal(outOfWorkspaceFilePaths(workspace, 'ast_edit', { paths: ['.'] }), null)
})

test('relative escapes and nonexistent external descendants retain absolute output paths', context => {
  const { workspace, external } = fixture(context)
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'read_file', { file_path: '../external/outside.txt' }), {
    mode: 'read', paths: [join(external, 'outside.txt')],
  })
  const destination = '../external/new/nested/output.txt'
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'write_file', { file_path: destination }), {
    mode: 'write', paths: [resolve(workspace, destination)],
  })
})

test('multi-path operands preserve order and duplicates while filtering local and granted paths', context => {
  const { workspace, externalFile, localFile, external } = fixture(context)
  const grantedDirectory = join(external, 'granted')
  mkdirSync(grantedDirectory)
  grantPath(grantedDirectory, 'write', { cwd: workspace })
  const nextFile = join(external, 'next.txt')
  const finalFile = join(external, 'last.txt')
  const input = {
    file_path: externalFile,
    file_paths: [localFile, null, nextFile, join(grantedDirectory, 'allowed.txt')],
    paths: ['.', finalFile, externalFile, 42],
  }
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'ast_edit', input), {
    mode: 'write', paths: [externalFile, nextFile, finalFile, externalFile],
  })
})

test('export destination write access takes priority over source read access until granted', context => {
  const { workspace, externalFile, external } = fixture(context)
  const sourceDirectory = join(external, 'source')
  mkdirSync(sourceDirectory)
  const source = join(sourceDirectory, 'source.txt')
  writeFileSync(source, 'source')
  const input = { destination_path: externalFile, source_path: source }
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'export_file', input), { mode: 'write', paths: [externalFile] })
  grantPath(externalFile, 'read', { cwd: workspace })
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'export_file', input), { mode: 'write', paths: [externalFile] })
  grantPath(externalFile, 'write', { cwd: workspace })
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'export_file', input), { mode: 'read', paths: [source] })
  grantPath(sourceDirectory, 'read', { cwd: workspace })
  assert.equal(outOfWorkspaceFilePaths(workspace, 'export_file', input), null)
})

test('export source remains read-only and create_document ignores non-applicable source operands', context => {
  const { workspace, localFile, externalFile } = fixture(context)
  const input = { destination_path: `  ${localFile}  `, source_path: `  ${externalFile}  ` }
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'export_file', input), { mode: 'read', paths: [externalFile] })
  assert.equal(outOfWorkspaceFilePaths(workspace, 'create_document', input), null)
  assert.equal(outOfWorkspaceFilePaths(workspace, 'open_path', { path: '   ' }), null)
  assert.equal(outOfWorkspaceFilePaths(workspace, 'create_document', { destination_path: 42 }), null)
})

test('tilde and surrounding whitespace normalize external export and open operands', context => {
  const { root, workspace } = fixture(context)
  const homeRelative = `${basename(root)}/report.txt`
  const expected = join(homedir(), homeRelative)
  for (const tool of ['export_file', 'create_document']) {
    assert.deepEqual(outOfWorkspaceFilePaths(workspace, tool, { destination_path: `  ~/${homeRelative}  ` }), {
      mode: 'write', paths: [expected],
    })
  }
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'open_path', { path: `  ~/${homeRelative}  ` }), {
    mode: 'read', paths: [expected],
  })
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'export_file', { destination_path: 'local.txt', source_path: ` ~/${homeRelative} ` }), {
    mode: 'read', paths: [expected],
  })
})

test('symlinked workspace ancestors remain local while symlink escapes require grants', context => {
  const { root, workspace, external } = fixture(context)
  const alias = join(root, 'workspace-alias')
  symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(outOfWorkspaceFilePaths(alias, 'read_file', { file_path: 'local.txt' }), null)
  const escape = join(workspace, 'external-link')
  symlinkSync(external, escape, process.platform === 'win32' ? 'junction' : 'dir')
  const escapedFile = join(escape, 'outside.txt')
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'read_file', { file_path: escapedFile }), {
    mode: 'read', paths: [escapedFile],
  })
  grantPath(external, 'read', { cwd: workspace })
  assert.equal(outOfWorkspaceFilePaths(workspace, 'read_file', { file_path: escapedFile }), null)
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'write_file', { file_path: escapedFile }), {
    mode: 'write', paths: [escapedFile],
  })
})

test('registered workspace roots keep multi-root file operations inside the authorized workspace', context => {
  const { workspace, external, externalFile } = fixture(context)
  const result = withWorkspaceRoots([workspace, external], () =>
    outOfWorkspaceFilePaths(workspace, 'ast_edit', { paths: [workspace, externalFile] }),
  )
  assert.equal(result, null)
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'ast_edit', { paths: [externalFile] }), {
    mode: 'write', paths: [externalFile],
  })
})

test('approval snapshots label the same required directory and mode without granting access', context => {
  const { workspace, externalFile, localFile } = fixture(context)
  const pending = [
    { requestId: 'write', kind: 'approval', toolName: 'export_file', toolInput: { destination_path: externalFile } },
    { requestId: 'read', kind: 'approval', toolName: 'read_file', toolInput: { file_path: externalFile } },
    { requestId: 'local', kind: 'approval', toolName: 'write_file', toolInput: { file_path: localFile } },
    { requestId: 'ignored', kind: 'question', toolName: 'read_file', toolInput: { file_path: externalFile } },
  ]
  const snapshot = buildApprovalSnapshot(workspace, 27, pending)
  assert.equal(snapshot.lastSeq, 27)
  assert.deepEqual(snapshot.approvals.map(approval => [approval.requestId, approval.pathGrant]), [
    ['write', { dir: dirname(externalFile), mode: 'write' }],
    ['read', { dir: dirname(externalFile), mode: 'read' }],
    ['local', undefined],
  ])
  assert.deepEqual(outOfWorkspaceFilePaths(workspace, 'write_file', { file_path: externalFile }), {
    mode: 'write', paths: [externalFile],
  })
  assert.deepEqual(approvalPathGrant(workspace, 'request_path_access', { path: ` ${dirname(externalFile)} `, mode: 'write' }), {
    dir: dirname(externalFile), mode: 'write',
  })
})
