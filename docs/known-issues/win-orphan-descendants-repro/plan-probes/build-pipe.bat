@echo off
REM ASCII only. Compiles the plan-1 mechanism probe with MSVC from VS 2022 Build Tools.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /O2 /W3 /Fe:suspended-pipe.exe suspended-pipe.c
