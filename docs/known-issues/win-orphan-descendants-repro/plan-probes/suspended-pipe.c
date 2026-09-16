// Fidelity probe: do stdio PIPES survive "born in a job" (CREATE_SUSPENDED -> assign -> resume)?
//
// The real spawn path (src/tools/bash.ts) uses stdio: ['ignore','pipe','pipe'] and, on Windows,
// detached:false. The plan-1 probe (suspended-job.c) inherited the console instead of pipes, so it
// did NOT cover this. If pipes cannot survive the suspended-create, the "minimal native surface"
// design collapses and plan 2 (helper owns spawn) is the only option left.
//
// usage: suspended-pipe.exe <marker> <runMs> [bashPath]
// checks: (1) stdout/stderr bytes arrive while running; (2) after TerminateJobObject an EOF
//         (broken pipe) is observed on both readers; (3) the tick file stops; (4) job members == 0.
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  DWORD NumberOfAssignedProcesses;
  DWORD NumberOfProcessIdsInList;
  ULONG_PTR ProcessIdList[64];
} JOB_PID_LIST;

static HANDLE g_outR = NULL, g_errR = NULL;
static volatile LONG g_outBytes = 0, g_errBytes = 0;
static volatile LONG g_outEof = 0, g_errEof = 0;

static long ticks(const char* path) {
  FILE* f = fopen(path, "rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fclose(f);
  return n;
}

static DWORD jobMembers(HANDLE job, ULONG_PTR* out, DWORD max) {
  JOB_PID_LIST list;
  ZeroMemory(&list, sizeof list);
  DWORD ret = 0;
  if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, &list, sizeof list, &ret)) return 0;
  DWORD n = list.NumberOfProcessIdsInList;
  if (n > max) n = max;
  for (DWORD i = 0; i < n; i++) out[i] = list.ProcessIdList[i];
  return n;
}

// Pump a pipe until EOF, counting bytes. Each pipe gets its own thread, mirroring how the real
// consumer (libuv stream -> Node socket) keeps reading while the command runs.
typedef struct { HANDLE h; volatile LONG* bytes; volatile LONG* eof; char tag[8]; } PumpArgs;

static DWORD WINAPI pump(LPVOID param) {
  PumpArgs* a = (PumpArgs*)param;
  char buf[512];
  DWORD got = 0;
  for (;;) {
    BOOL ok = ReadFile(a->h, buf, sizeof buf, &got, NULL);
    if (!ok) break;              // ERROR_BROKEN_PIPE after terminate, or a real error
    if (got == 0) break;
    InterlockedExchangeAdd(a->bytes, (LONG)got);
  }
  InterlockedExchange(a->eof, 1);
  return 0;
}

int main(int argc, char** argv) {
  if (argc < 3) { printf("usage: suspended-pipe.exe <marker> <runMs> [bashPath]\n"); return 2; }
  const char* marker = argv[1];
  int runMs = atoi(argv[2]);
  const char* bash = (argc > 3) ? argv[3] : "C:\\Program Files\\Git\\bin\\bash.exe";

  // The command mirrors the real shape: some stdout/stderr, then a detached-ish background
  // descendant that keeps running (and, like the real one, sends its output to /dev/null so it
  // does not hold our pipes open).
  const char* js = "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),250)";
  char cmd[4096];
  _snprintf(cmd, sizeof cmd - 1,
            "\"%s\" -c \"echo HELLO_STDOUT; echo HELLO_STDERR 1>&2; "
            "nohup node -e \\\"%s\\\" \\\"%s\\\" >/dev/null 2>&1 & wait\"",
            bash, js, marker);
  cmd[sizeof cmd - 1] = 0;

  SECURITY_ATTRIBUTES sa;
  sa.nLength = sizeof sa; sa.lpSecurityDescriptor = NULL; sa.bInheritHandle = TRUE;
  HANDLE outR = NULL, outW = NULL, errR = NULL, errW = NULL;
  if (!CreatePipe(&outR, &outW, &sa, 0)) { printf("ERR CreatePipe(out) %lu\n", GetLastError()); return 1; }
  if (!CreatePipe(&errR, &errW, &sa, 0)) { printf("ERR CreatePipe(err) %lu\n", GetLastError()); return 1; }
  HANDLE nulR = CreateFileA("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);

  STARTUPINFOA si; PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si); si.cb = sizeof si;
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = nulR;
  si.hStdOutput = outW;
  si.hStdError = errW;
  ZeroMemory(&pi, sizeof pi);

  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  ZeroMemory(&info, sizeof info);
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof info);

  if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
    printf("ERR CreateProcess %lu\n", GetLastError()); return 1;
  }
  printf("created_suspended pid=%lu (with pipes wired as std handles)\n", pi.dwProcessId);
  printf("assign_suspended ok=%d\n", AssignProcessToJobObject(job, pi.hProcess));
  printf("resume ok=%d\n", ResumeThread(pi.hThread) != (DWORD)-1);

  // CRITICAL: drop our own copies of the child's ends. If the parent keeps a writable handle
  // open, the readers never observe EOF when the child dies -- libuv does exactly this right
  // after spawn, and forgetting it is the classic reason "kill looks like it worked but the
  // stream never closes".
  CloseHandle(outW); outW = NULL;
  CloseHandle(errW); errW = NULL;
  if (nulR) { CloseHandle(nulR); nulR = NULL; }

  PumpArgs paOut = { outR, &g_outBytes, &g_outEof, "out" };
  PumpArgs paErr = { errR, &g_errBytes, &g_errEof, "err" };
  HANDLE thOut = CreateThread(NULL, 0, pump, &paOut, 0, NULL);
  HANDLE thErr = CreateThread(NULL, 0, pump, &paErr, 0, NULL);

  Sleep(runMs);
  ULONG_PTR members[64];
  DWORD n0 = jobMembers(job, members, 64);
  printf("while_running: stdout=%ld bytes stderr=%ld bytes | job_members=%lu | ticks=%ld\n",
         (long)g_outBytes, (long)g_errBytes, n0, ticks(marker));

  long before = ticks(marker);
  Sleep(900);
  long after = ticks(marker);

  printf("terminate_job ok=%d\n", TerminateJobObject(job, 0));
  // Give the readers a bounded window to observe EOF.
  for (int i = 0; i < 50 && !(g_outEof && g_errEof); i++) Sleep(100);
  printf("after_kill: stdout_eof=%ld stderr_eof=%ld | pipe closure=%s\n",
         (long)g_outEof, (long)g_errEof,
         (g_outEof && g_errEof) ? "OBSERVED (broken pipe)" : "NOT observed");

  Sleep(1000);
  long a1 = ticks(marker), a2;
  Sleep(1000);
  a2 = ticks(marker);
  printf("post_kill ticks=%ld,%ld members=%lu | pre_kill growth %ld->%ld\n",
         a1, a2, jobMembers(job, members, 64), before, after);
  printf("verdict: pipes_survived=%s tree_reaped=%s\n",
         (g_outBytes > 0 && g_errBytes > 0 && g_outEof && g_errEof) ? "YES" : "NO",
         (a2 <= a1) ? "YES" : "NO");
  CloseHandle(job);
  return 0;
}
