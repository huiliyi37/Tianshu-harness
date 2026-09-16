// job-launch.exe - a minimal Job Object holder for Windows.
//
// WHY THIS EXISTS
//   On Windows + Git Bash, a background descendant (nohup node ... &) escapes `taskkill /T`:
//   the Win32 parent chain is broken at nohup. Measured (issue #144): the descendant ends up in
//   NO job at all, and assigning the shell to a job *after* it has started does not help either -
//   children forked by an already-running MSYS shell do not inherit membership.
//
//   So the process must be "born in the job": someone that already belongs to the job has to
//   create it. This helper does exactly that, and nothing else:
//
//     1. CreateJobObject + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
//     2. assign ITSELF into the job
//     3. CreateProcess the real command, inheriting its own std handles
//        (so the parent Node process keeps reading the pipes directly - zero stdio relay)
//     4. wait for the child, exit with its code
//     5. optionally watch the parent: if the parent dies, reap the whole job
//
//   Terminating this helper is therefore the whole fix: the last job handle closes, Windows
//   terminates every process still in the job (the shell, the nohup'd node, the whole fork chain).
//
// usage: job-launch.exe [--cwd <dir>] [--parent-pid <pid>] [--] <exe> [args...]
//
// NOTE: ASCII-only source on purpose (MSVC + a Chinese code page would emit C4819 warnings).
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static HANDLE g_job = NULL;
static HANDLE g_parent = NULL;

// Quote one argument for CreateProcess's command line (MSVCRT rules). Returns bytes written.
static int quoteArg(const char* in, char* out, int cap) {
  int n = 0;
  int need = (in[0] == 0);
  for (const char* p = in; *p; p++) {
    if (*p == ' ' || *p == '\t' || *p == '"') { need = 1; break; }
  }
  if (!need) {
    for (const char* p = in; *p && n < cap - 1; p++) out[n++] = *p;
    out[n] = 0;
    return n;
  }
  if (n < cap - 1) out[n++] = '"';
  int backslashes = 0;
  for (const char* p = in; *p; p++) {
    if (*p == '\\') { backslashes++; continue; }
    if (*p == '"') {
      for (int i = 0; i < backslashes * 2 + 1 && n < cap - 1; i++) out[n++] = '\\';
      if (n < cap - 1) out[n++] = '"';
      backslashes = 0;
      continue;
    }
    for (int i = 0; i < backslashes && n < cap - 1; i++) out[n++] = '\\';
    backslashes = 0;
    if (n < cap - 1) out[n++] = *p;
  }
  for (int i = 0; i < backslashes * 2 && n < cap - 1; i++) out[n++] = '\\';
  if (n < cap - 1) out[n++] = '"';
  out[n] = 0;
  return n;
}

// Watchdog: if the parent process goes away (crash / hard kill), reap the job so we never leave
// an orphaned command tree behind.
static DWORD WINAPI parentWatch(LPVOID unused) {
  (void)unused;
  if (g_parent) {
    WaitForSingleObject(g_parent, INFINITE);
    if (g_job) TerminateJobObject(g_job, 0);
    ExitProcess(0);
  }
  return 0;
}

int main(int argc, char** argv) {
  const char* cwd = NULL;
  DWORD parentPid = 0;
  int i = 1;
  while (i < argc) {
    if (strcmp(argv[i], "--") == 0) { i++; break; }
    if (strcmp(argv[i], "--cwd") == 0 && i + 1 < argc) { cwd = argv[++i]; i++; continue; }
    if (strcmp(argv[i], "--parent-pid") == 0 && i + 1 < argc) { parentPid = (DWORD)strtoul(argv[++i], NULL, 10); i++; continue; }
    break;
  }
  if (i >= argc) {
    fprintf(stderr, "usage: job-launch.exe [--cwd <dir>] [--parent-pid <pid>] [--] <exe> [args...]\n");
    return 2;
  }

  g_job = CreateJobObjectW(NULL, NULL);
  if (!g_job) { fprintf(stderr, "job-launch: CreateJobObject failed %lu\n", GetLastError()); return 1; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  ZeroMemory(&info, sizeof info);
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &info, sizeof info)) {
    fprintf(stderr, "job-launch: SetInformationJobObject failed %lu\n", GetLastError());
    return 1;
  }

  // Step 2: we join the job FIRST, so everything we create inherits membership.
  if (!AssignProcessToJobObject(g_job, GetCurrentProcess())) {
    fprintf(stderr, "job-launch: self-assign failed %lu\n", GetLastError());
    return 1;
  }

  // Build the child command line from argv (proper MSVCRT quoting).
  static char cmd[32768];
  int n = 0;
  for (int a = i; a < argc; a++) {
    if (a > i && n < (int)sizeof cmd - 1) cmd[n++] = ' ';
    n += quoteArg(argv[a], cmd + n, (int)sizeof cmd - n);
  }
  cmd[sizeof cmd - 1] = 0;

  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si);
  si.cb = sizeof si;
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  ZeroMemory(&pi, sizeof pi);

  if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, 0, NULL, cwd, &si, &pi)) {
    fprintf(stderr, "job-launch: CreateProcess failed %lu (cmd=%s)\n", GetLastError(), cmd);
    return 127;
  }

  if (parentPid != 0) {
    g_parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    if (g_parent) {
      HANDLE th = CreateThread(NULL, 0, parentWatch, NULL, 0, NULL);
      if (th) CloseHandle(th);
    }
  }

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  // Closing the job handle (process exit) triggers KILL_ON_JOB_CLOSE for anything left behind.
  return (int)code;
}
