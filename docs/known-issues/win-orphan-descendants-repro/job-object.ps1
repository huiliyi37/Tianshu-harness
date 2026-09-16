param(
  [ValidateSet('inside','assign')][string]$Mode = 'inside',
  [int]$ShellPid = 0,
  [Parameter(Mandatory=$true)][string]$Marker,
  [string]$BashPath = 'C:\Program Files\Git\bin\bash.exe'
)
# ---------------------------------------------------------------------------
# ASCII-ONLY ON PURPOSE. PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK, so
# non-ASCII literals corrupt the parser (a swallowed quote shifts the whole
# script). Keep every string in this file ASCII; Chinese docs live in README.md.
#
# Two modes = the positive and negative example for the job object:
#   inside : create job -> assign SELF into it -> spawn bash from there
#            (child inherits job membership) -> TerminateJobObject
#            EXPECT: ticks STOP (job membership rides the parent, so the broken
#            Win32 parent chain in MSYS does not matter)
#   assign : attach an ALREADY RUNNING bash to the job, then terminate
#            EXPECT: ticks KEEP GOING (bash already forked the background node,
#            which therefore never entered the job - the classic race)
# Verdict is decided only by the tick file length (before vs after the kill).
# ---------------------------------------------------------------------------

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobApi {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT_LIMIT {
    public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr h, int cls, IntPtr i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr h, uint code);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetLastError();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@

$KILL_ON_JOB_CLOSE = 0x2000
$ExtendedLimitInfo = 9
$PROCESS_SET_QUOTA_AND_TERMINATE = 0x0100 -bor 0x0001

$job = [JobApi]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { Write-Output "ERR create_job"; exit 1 }
$info = New-Object JobApi+EXT_LIMIT
$info.BasicLimitInformation.LimitFlags = $KILL_ON_JOB_CLOSE
$size = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
[void][System.Runtime.InteropServices.Marshal]::StructureToPtr($info, $ptr, $false)
$set = [JobApi]::SetInformationJobObject($job, $ExtendedLimitInfo, $ptr, [uint32]$size)
Write-Output ("mode=" + $Mode + " set_info=" + $set)
[Console]::Out.Flush()

function Ticks() { try { return (Get-Item -LiteralPath $Marker).Length } catch { return 0 } }

if ($Mode -eq 'inside') {
  $selfOk = [JobApi]::AssignProcessToJobObject($job, [JobApi]::GetCurrentProcess())
  Write-Output ("self_assign=" + $selfOk)

  # Write the inner command to a temp .sh and run that file: avoids
  # Start-Process mangling the quotes of a -c argument.
  $innerSh = Join-Path (Split-Path -Parent $Marker) 'inner.sh'
  $tick = 'nohup node -e "const fs=require(''fs'');setInterval(()=>fs.appendFileSync(process.argv[1],''x''),250)" "' + $Marker + '" >/dev/null 2>&1'
  Set-Content -LiteralPath $innerSh -Value ($tick + "`nwait`n") -Encoding ASCII
  $child = Start-Process -FilePath $BashPath -ArgumentList @($innerSh) -NoNewWindow -PassThru
  Write-Output ("spawned_bash_pid=" + $child.Id)
  [Console]::Out.Flush()

  Start-Sleep -Milliseconds 1500
  $before = Ticks
  Write-Output ("before_kill_ticks=" + $before)
  [Console]::Out.Flush()

  $tk = [JobApi]::TerminateJobObject($job, 0)
  Write-Output ("terminate_job=" + $tk + " err=" + [JobApi]::GetLastError())
  [Console]::Out.Flush()
  # NOTE: this process self-assigned into the job, so TerminateJobObject kills it
  # too. The verdict therefore has to be measured on the DRIVER side (Node), which
  # keeps ticking samples after this process is gone. Do not add an after_ticks
  # verdict here - it would never print.
}
else {
  if ($ShellPid -le 0) { Write-Output "ERR need -ShellPid for assign mode"; exit 2 }
  $h = [JobApi]::OpenProcess($PROCESS_SET_QUOTA_AND_TERMINATE, $false, $ShellPid)
  if ($h -eq [IntPtr]::Zero) { Write-Output ("ERR open_process err=" + [JobApi]::GetLastError()); exit 1 }
  $assigned = [JobApi]::AssignProcessToJobObject($job, $h)
  Write-Output ("assigned=" + $assigned + " pid=" + $ShellPid + " err=" + [JobApi]::GetLastError())
  Write-Output "READY (waiting for TERM on stdin)"
  [Console]::Out.Flush()

  [void][Console]::In.ReadLine()      # the driver decides when to terminate
  $before = Ticks
  Write-Output ("before_kill_ticks=" + $before)
  $tk = [JobApi]::TerminateJobObject($job, 0)
  Write-Output ("terminate_job=" + $tk)
  [Console]::Out.Flush()

  Start-Sleep -Milliseconds 1200
  $a1 = Ticks
  Start-Sleep -Milliseconds 1000
  $a2 = Ticks
  $verdict = if ($a2 -le $a1) { "STOPPED" } else { "STILL_WRITING (spawn-then-assign: the node was forked before the assign)" }
  Write-Output ("after_ticks=" + $a1 + "," + $a2 + " -> " + $verdict)
}
[void][JobApi]::CloseHandle($job)
