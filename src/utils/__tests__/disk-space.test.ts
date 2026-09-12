import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { freeDiskBytes, diskWarnThresholdMb, lowDiskWarning, DEFAULT_DISK_WARN_MB } from '../disk-space.js'

describe('disk-space（磁盘水位探测）', () => {
  afterEach(() => { delete process.env.RIVET_DISK_WARN_MB })

  it('freeDiskBytes：存在的路径返回正数，bogus 路径 undefined', () => {
    assert.ok((freeDiskBytes(tmpdir()) ?? 0) > 0)
    assert.equal(freeDiskBytes('/nonexistent-path-xyz-不可能存在'), undefined)
  })

  it('lowDiskWarning：阈值 0 关闭；阈值高到不可能满足时给出警告行', () => {
    assert.equal(lowDiskWarning(tmpdir(), 0), undefined, '阈值 0 = 关闭警告')
    const note = lowDiskWarning(tmpdir(), 1024 * 1024 * 1024) // 1PB——任何机器都触发
    assert.ok(note, '超阈值应给出警告')
    assert.match(note!, /磁盘可用空间仅剩 \d+MB/)
  })

  it('diskWarnThresholdMb：默认 512，RIVET_DISK_WARN_MB 覆盖，非法值回落默认', () => {
    assert.equal(diskWarnThresholdMb(), DEFAULT_DISK_WARN_MB)
    process.env.RIVET_DISK_WARN_MB = '128'
    assert.equal(diskWarnThresholdMb(), 128)
    process.env.RIVET_DISK_WARN_MB = 'not-a-number'
    assert.equal(diskWarnThresholdMb(), DEFAULT_DISK_WARN_MB)
  })
})
