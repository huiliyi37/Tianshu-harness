@echo off
REM ASCII only. Builds the plan-1 mechanism probe with MSVC.
REM Uses vswhere so the VS installation path is not hard-coded.
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" ( echo [x] vswhere not found & exit /b 1 )
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH ( echo [x] VS with C++ tools not found & exit /b 1 )
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /O2 /W3 /Fe:suspended-job.exe suspended-job.c
