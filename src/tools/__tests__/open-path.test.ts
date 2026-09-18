import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOpenPathCommand,
  buildRevealCommand,
  decideOpenAction,
  isDirectoryPath,
  OPEN_PATH_TOOL,
  windowsFileHasHandler,
} from '../open-path.js'

describe('open_path', () => {
  it('builds Windows opener via PowerShell Start-Process -FilePath (no cmd.exe metachar reinterpretation)', () => {
    const target = 'C:\\Users\\Honglin   zhang\\Desktop\\天枢-logo.svg'
    const command = buildOpenPathCommand(target, 'win32')

    assert.equal(command.cmd, 'powershell.exe')
    // 路径作为单引号字面串嵌入 -FilePath，不再走 cmd 二次解析。
    // 注意: Start-Process 没有 -LiteralPath 参数 (那是 Item cmdlet 的)。
    assert.deepEqual(command.args, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${target}'`,
    ])
    // cmd.exe 不应再被使用。
    assert.notEqual(command.cmd, 'cmd.exe')
  })

  it('neutralizes cmd metacharacters and single quotes in Windows paths', () => {
    // 含 & | % ^ 的合法路径必须能开（不误杀），且元字符不被解释（不注入）。
    const target = "C:\\R&D\\report|v2\\100%^win\\o'brien.txt"
    const command = buildOpenPathCommand(target, 'win32')

    assert.equal(command.cmd, 'powershell.exe')
    const literalArg = command.args[command.args.length - 1]
    // 单引号字面串：内嵌单引号被双写转义，& | % ^ 原样保留为字面量。
    assert.equal(literalArg, "Start-Process -FilePath 'C:\\R&D\\report|v2\\100%^win\\o''brien.txt'")
  })

  it('builds macOS opener with path as a separate argument', () => {
    const target = '/Users/banxia/Desktop/天枢 logo.svg'
    const command = buildOpenPathCommand(target, 'darwin')

    assert.equal(command.cmd, 'open')
    assert.deepEqual(command.args, [target])
  })

  it('builds Linux opener with path as a separate argument', () => {
    const target = '/home/user/桌面/天枢 logo.svg'
    const command = buildOpenPathCommand(target, 'linux')

    assert.equal(command.cmd, 'xdg-open')
    assert.deepEqual(command.args, [target])
  })

  it('builds Windows reveal command via explorer /select (PowerShell, no cmd metachar reinterpretation)', () => {
    const target = 'C:\\Users\\Honglin   zhang\\Desktop\\天枢-logo.svg'
    const command = buildRevealCommand(target, 'win32')

    assert.equal(command.cmd, 'powershell.exe')
    assert.deepEqual(command.args, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `explorer /select,'${target}'`,
    ])
  })

  it('neutralizes single quotes in Windows reveal paths', () => {
    const target = "C:\\R&D\\o'brien.txt"
    const command = buildRevealCommand(target, 'win32')

    const literalArg = command.args[command.args.length - 1]
    assert.equal(literalArg, "explorer /select,'C:\\R&D\\o''brien.txt'")
  })

  it('normalizes forward slashes to backslashes in Windows reveal paths', () => {
    // 前端 toAbsolute 在 cwd 含 '/' 时会拼出 'C:/Users/.../file.ts'。
    // explorer 对正斜杠路径静默失败——必须归一为反斜杠。
    const fwdSlash = 'C:/Users/test/project/src/index.ts'
    const backslash = 'C:\\Users\\test\\project\\src\\index.ts'
    const command = buildRevealCommand(fwdSlash, 'win32')

    const literalArg = command.args[command.args.length - 1]
    assert.equal(literalArg, `explorer /select,'${backslash}'`)
  })

  it('normalizes forward slashes to backslashes in Windows open paths', () => {
    const fwdSlash = 'C:/Users/test/R&D/report.md'
    const backslash = 'C:\\Users\\test\\R&D\\report.md'
    const command = buildOpenPathCommand(fwdSlash, 'win32')

    const literalArg = command.args[command.args.length - 1]
    assert.equal(literalArg, `Start-Process -FilePath '${backslash}'`)
  })

  it('builds macOS reveal command with open -R', () => {
    const target = '/Users/banxia/Desktop/天枢 logo.svg'
    const command = buildRevealCommand(target, 'darwin')

    assert.equal(command.cmd, 'open')
    assert.deepEqual(command.args, ['-R', target])
  })

  it('builds Linux reveal command by opening the parent directory', () => {
    const target = '/home/user/桌面/天枢 logo.svg'
    const command = buildRevealCommand(target, 'linux')

    assert.equal(command.cmd, 'xdg-open')
    assert.deepEqual(command.args, ['/home/user/桌面'])
  })

  it('returns error instead of spawning when path does not exist', async () => {
    const result = await OPEN_PATH_TOOL.execute({
      cwd: process.cwd(),
      toolUseId: 'tu-open',
      input: { path: '/definitely/not/existing/tianshu-logo.svg' },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /路径不存在/)
  })
})

/**
 * 回归锚（issue #193）：Windows 上打开「无关联处理程序」的文件会弹「选取应用」
 * 对话框，且对话框 detached 存活、调用方回收不了。这里锁死判定：这类必须退化为
 * 「定位」（explorer /select,），不得走「打开」。
 */
describe('open_path —— Windows 无关联扩展名退化为定位', () => {
  const win = 'win32' as NodeJS.Platform

  it('decideOpenAction：Windows 文件且确认无处理程序 → reveal', () => {
    assert.equal(decideOpenAction({ platform: win, isDirectory: false, hasHandler: false }), 'reveal')
  })

  it('decideOpenAction：有处理程序 → open', () => {
    assert.equal(decideOpenAction({ platform: win, isDirectory: false, hasHandler: true }), 'open')
  })

  it('decideOpenAction：判断不了时 fail-open，维持 open（不误降级）', () => {
    assert.equal(decideOpenAction({ platform: win, isDirectory: false, hasHandler: undefined }), 'open')
  })

  it('decideOpenAction：目录始终 open——explorer 打开目录总有处理程序', () => {
    assert.equal(decideOpenAction({ platform: win, isDirectory: true, hasHandler: false }), 'open')
  })

  it('decideOpenAction：非 Windows 不受影响', () => {
    assert.equal(decideOpenAction({ platform: 'darwin', isDirectory: false, hasHandler: false }), 'open')
    assert.equal(decideOpenAction({ platform: 'linux', isDirectory: false, hasHandler: false }), 'open')
  })

  it('退化为定位时用的是 explorer /select, ——不是 explorer.exe <file>', () => {
    const action = decideOpenAction({ platform: win, isDirectory: false, hasHandler: false })
    const command = action === 'reveal'
      ? buildRevealCommand('C:\\tmp\\probe.zzq', win)
      : buildOpenPathCommand('C:\\tmp\\probe.zzq', win)
    assert.match(command.args.join(' '), /explorer \/select,/)
    assert.doesNotMatch(command.args.join(' '), /Start-Process -FilePath/)
  })

  it('windowsFileHasHandler：非 Windows / 无扩展名 → undefined（判断不了）', () => {
    assert.equal(windowsFileHasHandler('/tmp/a.zzq', 'darwin'), undefined)
    assert.equal(windowsFileHasHandler('C:\\tmp\\noext', 'win32'), undefined)
  })

  it('windowsFileHasHandler：用户级 UserChoice 有 ProgId → true', () => {
    const q = (key: string) => (key.includes('UserChoice') ? 'ProgId    REG_SZ    Applications\\notepad.exe' : '')
    assert.equal(windowsFileHasHandler('C:\\tmp\\a.zzq', 'win32', q), true)
  })

  it('windowsFileHasHandler：机器级关联且 shell\\open\\command 在 → true', () => {
    const q = (key: string) => {
      if (key.includes('UserChoice')) throw new Error('no user choice')
      if (key.endsWith('.zzq')) return '    (默认)    REG_SZ    zzq.Document'
      if (key.includes('shell\\open\\command')) return '    (默认)    REG_SZ    "C:\\app.exe" "%1"'
      throw new Error('unexpected')
    }
    assert.equal(windowsFileHasHandler('C:\\tmp\\a.zzq', 'win32', q), true)
  })

  it('windowsFileHasHandler：HKCR 有扩展名但无 shell\\open\\command → false', () => {
    const q = (key: string) => {
      if (key.includes('UserChoice')) throw new Error('no user choice')
      if (key.endsWith('.zzq')) return '    (默认)    REG_SZ    zzq.Document'
      throw new Error('no open command')
    }
    assert.equal(windowsFileHasHandler('C:\\tmp\\a.zzq', 'win32', q), false)
  })

  it('windowsFileHasHandler：HKCR 里根本没有该扩展名 → false（强信号）', () => {
    const q = (key: string) => {
      if (key.includes('UserChoice')) throw new Error('no user choice')
      throw new Error('extension not found')
    }
    assert.equal(windowsFileHasHandler('C:\\tmp\\a.zzqprobe', 'win32', q), false)
  })

  it(
    'windowsFileHasHandler：真机探测——随机扩展名必须被判为无处理程序',
    { skip: process.platform !== 'win32' ? 'Windows only' : false },
    () => {
      assert.equal(
        windowsFileHasHandler('C:\\probe\\rivet-no-handler-probe.zzqprobe'),
        false,
      )
    },
  )

  it('isDirectoryPath：不存在的路径按「不是目录」处理，不抛', () => {
    assert.equal(isDirectoryPath('/definitely/not/existing/whatever'), false)
  })
})
