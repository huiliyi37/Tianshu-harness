@echo off
REM ASCII only. Builds the job-object launcher (Windows helper for issue #144).
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /O2 /W3 /Fe:job-launch.exe job-launch.c
