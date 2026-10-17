// Test-only implementation of the documented job-launch.exe argv contract.
// It owns a real Win32 Job Object, not a fake process/cleanup result.
// See the repository's public win-orphan-descendants-repro Job Object probes.
// This file is not a replacement for the separately shipped runtime helper.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowsJobTestLauncher {
  private const uint KillOnJobClose = 0x2000;
  private const uint Synchronize = 0x00100000;
  private const uint UseStandardHandles = 0x100;
  private const uint CreateNoWindow = 0x08000000;
  private const uint Infinite = 0xffffffff;

  [StructLayout(LayoutKind.Sequential)] private struct BasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] private struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimit {
    public BasicLimit BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo {
    public uint cb;
    public string lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcess(string application, StringBuilder command,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
    IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);

  // The same Windows argv quoting rules used by CreateProcess/CRT and Node spawn.
  private static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(ch);
      slashes = 0;
    }
    result.Append('\\', slashes * 2);
    result.Append('"');
    return result.ToString();
  }

  private static void Check(bool success, string operation) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }

  private static int Main(string[] args) {
    IntPtr job = IntPtr.Zero, parent = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo();
    bool joined = false;
    uint exitCode = 1;
    try {
      string cwd = null;
      uint parentPid = 0;
      int index = 0;
      while (index < args.Length) {
        if (args[index] == "--cwd" && index + 1 < args.Length) { cwd = args[index + 1]; index += 2; }
        else if (args[index] == "--parent-pid" && index + 1 < args.Length) {
          if (!uint.TryParse(args[index + 1], out parentPid) || parentPid == 0) throw new ArgumentException("invalid parent pid");
          index += 2;
        } else break;
      }
      if (index >= args.Length || parentPid == 0) throw new ArgumentException("expected --cwd, --parent-pid and a command");
      var command = new StringBuilder();
      for (; index < args.Length; index++) {
        if (command.Length > 0) command.Append(' ');
        command.Append(Quote(args[index]));
      }
      if (command.Length >= 32767) throw new ArgumentException("command line too long");
      parent = OpenProcess(Synchronize, false, parentPid);
      Check(parent != IntPtr.Zero, "OpenProcess(parent)");
      job = CreateJobObject(IntPtr.Zero, null);
      Check(job != IntPtr.Zero, "CreateJobObject");
      var limit = new ExtendedLimit();
      limit.BasicLimitInformation.LimitFlags = KillOnJobClose;
      Check(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(ExtendedLimit))), "SetInformationJobObject");
      // Membership precedes spawn, so even MSYS descendants are born in the job.
      Check(AssignProcessToJobObject(job, GetCurrentProcess()), "AssignProcessToJobObject(self)");
      joined = true;
      var startup = new StartupInfo();
      startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
      startup.dwFlags = UseStandardHandles;
      startup.hStdInput = GetStdHandle(-10);
      startup.hStdOutput = GetStdHandle(-11);
      startup.hStdError = GetStdHandle(-12);
      foreach (IntPtr handle in new IntPtr[] { startup.hStdInput, startup.hStdOutput, startup.hStdError }) {
        Check(handle != IntPtr.Zero && handle != new IntPtr(-1), "inherited stdio handle");
        Check(SetHandleInformation(handle, 1, 1), "SetHandleInformation(stdio)");
      }
      Check(CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, CreateNoWindow,
        IntPtr.Zero, cwd, ref startup, out child), "CreateProcess");
      uint completed = WaitForMultipleObjects(2, new IntPtr[] { child.Process, parent }, false, Infinite);
      if (completed == 0) Check(GetExitCodeProcess(child.Process, out exitCode), "GetExitCodeProcess");
      else if (completed == 1) exitCode = 125; // The caller died: release its entire owned job.
      else throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForMultipleObjects");
    } catch (Exception error) {
      Console.Error.WriteLine("[job-test-launcher] " + error.Message);
      Console.Error.Flush();
      exitCode = 1;
    } finally {
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      if (parent != IntPtr.Zero) CloseHandle(parent);
    }
    if (joined) {
      // Includes this holder. Use the real child code; closing a self-owned job
      // before selecting the code would lose nonzero foreground exit statuses.
      TerminateJobObject(job, exitCode);
      Environment.Exit(unchecked((int)exitCode));
    }
    if (job != IntPtr.Zero) CloseHandle(job);
    return unchecked((int)exitCode);
  }
}
