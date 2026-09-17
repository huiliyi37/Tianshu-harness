// Mechanism probe for plan 1 (job-object spawn), compiled directly with MSVC - no node-gyp
// needed, because the question is about Win32 semantics, not about Node bindings.
//
//   born-in-the-job == CreateProcess(CREATE_SUSPENDED) -> AssignProcessToJobObject -> ResumeThread
//
// QUESTION: if a **MSYS bash** is put into a job this way, do the background descendants it
// forks (nohup node) also end up in the job, and does one TerminateJobObject reap them all?
//
// usage: suspended-job.exe <marker> <runMs> [bashPath]
// verdict: whether the tick file keeps growing after TerminateJobObject + job member count.
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

int main(int argc, char** argv) {
  if (argc < 3) { printf("usage: suspended-job.exe <marker> <runMs> [bashPath]\n"); return 2; }
  const char* marker = argv[1];
  int runMs = atoi(argv[2]);
  const char* bash = (argc > 3) ? argv[3] : "C:\\Program Files\\Git\\bin\\bash.exe";

  // Same shape as the repro fixture: nohup + & and the shell waits for it.
  const char* js = "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),250)";
  char cmd[4096];
  _snprintf(cmd, sizeof cmd - 1,
            "\"%s\" -c \"nohup node -e \\\"%s\\\" \\\"%s\\\" >/dev/null 2>&1 & wait\"",
            bash, js, marker);
  cmd[sizeof cmd - 1] = 0;

  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) { printf("ERR CreateJobObject %lu\n", GetLastError()); return 1; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  ZeroMemory(&info, sizeof info);
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof info)) {
    printf("ERR SetInformationJobObject %lu\n", GetLastError()); return 1;
  }

  STARTUPINFOA si; PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof si); si.cb = sizeof si;
  ZeroMemory(&pi, sizeof pi);
  if (!CreateProcessA(NULL, cmd, NULL, NULL, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
    printf("ERR CreateProcess %lu\n", GetLastError()); return 1;
  }
  printf("created_suspended pid=%lu\n", pi.dwProcessId);

  BOOL assigned = AssignProcessToJobObject(job, pi.hProcess);
  printf("assign_suspended ok=%d err=%lu\n", assigned, GetLastError());
  if (!assigned) return 1;

  DWORD resumed = ResumeThread(pi.hThread);
  printf("resume ok=%d (prev suspend count=%lu)\n", resumed != (DWORD)-1, resumed);

  Sleep(runMs);
  ULONG_PTR members[64];
  DWORD n0 = jobMembers(job, members, 64);
  printf("job_members_before_kill=%lu [", n0);
  for (DWORD i = 0; i < n0; i++) printf("%lu%s", (unsigned long)members[i], i + 1 < n0 ? "," : "");
  printf("] | ticks=%ld\n", ticks(marker));

  long before = ticks(marker);
  Sleep(900);
  long after = ticks(marker);
  printf("pre_kill growth: %ld -> %ld %s\n", before, after, after > before ? "(alive)" : "(not writing?!)");

  BOOL tk = TerminateJobObject(job, 0);
  printf("terminate_job=%d err=%lu\n", tk, GetLastError());
  Sleep(1200);
  long a1 = ticks(marker);
  Sleep(1000);
  long a2 = ticks(marker);
  DWORD n1 = jobMembers(job, members, 64);
  printf("post_kill ticks=%ld,%ld members=%lu -> %s\n", a1, a2, n1,
         a2 <= a1 ? "STOPPED (job object reaped the MSYS tree)" : "STILL_WRITING (job did NOT cover them)");
  CloseHandle(job);
  return 0;
}
