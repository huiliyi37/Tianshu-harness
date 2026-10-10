import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const mutations = [
  ['paused preview bypass', "r?.status === 'active'", 'true'],
  ['revision rollback', 'next.revision < previous.revision', 'false'],
  ['revocation removed', '!previous.revokedVersions.every(v => next.revokedVersions.includes(v))', 'false'],
  ['percentage reduction', 'options.percentage < c.platforms[p].percentage', 'false'],
  ['legacy stable bypass', 'if (control.stable.version !== version)', 'if (false)', 'guard-stable-publication.mjs'],
  ['promotion without real upgrade', 'realUpgrade && e.realSignedUpgrade !== true', 'false'],
]
for (const [name, before, after, filename = 'update-control.mjs'] of mutations) {
  const folder=mkdtempSync(join(tmpdir(),'tianshu-control-defects-'))
  try {
    for (const file of ['update-control.mjs','catalog.mjs','update-control.test.mjs','publish-update-control.mjs','report-routing.mjs','guard-stable-publication.mjs']) copyFileSync(new URL(file,import.meta.url),join(folder,file))
    const shellName=join(folder,'upload-update-to-oss.sh')
    copyFileSync(new URL('../upload-update-to-oss.sh',import.meta.url),shellName)
    const testPath=join(folder,'update-control.test.mjs')
    writeFileSync(testPath,readFileSync(testPath,'utf8').replace("../upload-update-to-oss.sh","./upload-update-to-oss.sh"))
    const file=join(folder,filename), source=readFileSync(file,'utf8')
    if (!source.includes(before)) throw new Error(`Missing mutation: ${name}`)
    writeFileSync(file,source.replace(before,after))
    const result=spawnSync(process.execPath,['--test','--test-reporter=tap',join(folder,'update-control.test.mjs')],{encoding:'utf8',windowsHide:true})
    if (result.status===0 || !result.stdout.includes('not ok')) throw new Error(`Restored defect was not caught: ${name}\n${result.stdout}\n${result.stderr}`)
    console.log(`RED confirmed: ${name}`)
  } finally { rmSync(folder,{recursive:true,force:true}) }
}
