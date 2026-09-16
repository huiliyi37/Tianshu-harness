param(
  [Parameter(Mandatory=$true)][string]$Marker,
  [string]$BashPath = 'C:\Program Files\Git\bin\bash.exe'
)
# ASCII-only on purpose: PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK, so non-ASCII
# literals corrupt the parser. Keep every string in this file ASCII.
#
# Pre-warmed job holder. Protocol on stdin/stdout:
#   <- READY                       (Add-Type compiled, job created, KILL_ON_JOB_CLOSE set)
#   -> PID <win32_pid>             (the shell to adopt BEFORE it forks anything)
#   <- ASSIGNED ok=<bool> err=<n>
#   -> TERM                        (reap the whole job)
#   <- TERMINATED
#
# The point: whoever owns spawn keeps owning it (Node keeps stdio), while job membership
# is established by an explicit handshake instead of by winning a ~100-300ms race.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobApi2 {
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
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr proc, IntPtr job, [MarshalAs(UnmanagedType.Bool)] ref bool result);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetLastError();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@

$KILL_ON_JOB_CLOSE = 0x2000
$ExtendedLimitInfo = 9
$PROCESS_SET_QUOTA_AND_TERMINATE = 0x0100 -bor 0x0001

$job = [JobApi2]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { Write-Output "ERR create_job"; exit 1 }
$info = New-Object JobApi2+EXT_LIMIT
$info.BasicLimitInformation.LimitFlags = $KILL_ON_JOB_CLOSE
$size = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
[void][System.Runtime.InteropServices.Marshal]::StructureToPtr($info, $ptr, $false)
$set = [JobApi2]::SetInformationJobObject($job, $ExtendedLimitInfo, $ptr, [uint32]$size)
Write-Output ("job_created set_info=" + $set)
Write-Output "READY"
[Console]::Out.Flush()

# ---- adopt the shell -------------------------------------------------------
$line = [Console]::In.ReadLine()
if (-not $line -or $line -notmatch '^PID\s+(\d+)$') { Write-Output "ERR bad_pid_line"; exit 2 }
$target = [int]$Matches[1]
$h = [JobApi2]::OpenProcess($PROCESS_SET_QUOTA_AND_TERMINATE, $false, $target)
if ($h -eq [IntPtr]::Zero) { Write-Output ("ASSIGNED ok=False err=" + [JobApi2]::GetLastError()); exit 3 }
$ok = [JobApi2]::AssignProcessToJobObject($job, $h)
Write-Output ("ASSIGNED ok=" + $ok + " pid=" + $target + " err=" + [JobApi2]::GetLastError())
[Console]::Out.Flush()

# ---- reap on demand --------------------------------------------------------
$line2 = [Console]::In.ReadLine()
while ($line2 -like 'CHECK *') {
  $wp = [int]($line2 -replace '^CHECK\s+', '')
  $ph = [JobApi2]::OpenProcess(0x1000, $false, $wp)     # PROCESS_QUERY_LIMITED_INFORMATION
  if ($ph -eq [IntPtr]::Zero) {
    Write-Output ("INJOB pid=" + $wp + " open_failed err=" + [JobApi2]::GetLastError())
  } else {
    $ours = $false
    $any = $false
    [void][JobApi2]::IsProcessInJob($ph, $job, [ref]$ours)
    [void][JobApi2]::IsProcessInJob($ph, [IntPtr]::Zero, [ref]$any)
    Write-Output ("INJOB pid=" + $wp + " ours=" + $ours + " anyjob=" + $any)
    [void][JobApi2]::CloseHandle($ph)
  }
  [Console]::Out.Flush()
  $line2 = [Console]::In.ReadLine()
}
if ($line2 -ne 'TERM') { Write-Output "ERR expected_TERM"; exit 4 }
$tk = [JobApi2]::TerminateJobObject($job, 0)
Write-Output ("TERMINATED ok=" + $tk + " err=" + [JobApi2]::GetLastError())
[Console]::Out.Flush()
[void][JobApi2]::CloseHandle($job)
