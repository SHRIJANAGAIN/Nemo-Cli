@echo off
REM nemo - global CMD shim (alias for nemo).
REM
REM Resolution order:
REM   1. NEMO_HOME env var
REM   2. Walk up parent directories looking for the project root
REM      (package.json + tsconfig.ink.json - ignores stray package.json files)
REM
REM First run: install + build. Subsequent: just exec.

setlocal

set "TRY=%NEMO_HOME%"
if not "%TRY%"=="" goto :resolved

set "TRY=%~dp0"
:findroot
if exist "%TRY%package.json" if exist "%TRY%tsconfig.ink.json" goto :found
if "%TRY:~-1%"=="\" set "TRY=%TRY:~0,-1%"
for %%I in ("%TRY%") do set "TRY=%%~dpI"
if "%TRY%\"=="\" goto :notfound
goto :findroot

:found
if "%TRY:~-1%"=="\" set "TRY=%TRY:~0,-1%"

:resolved
set "NEMO_HOME=%TRY%"

set "DIST_OK="
if exist "%NEMO_HOME%\dist\apps\cli\src\index.js" (
  node "%NEMO_HOME%\scripts\check-dist.mjs" >nul 2>&1
  if not errorlevel 1 set "DIST_OK=1"
)
if "%DIST_OK%"=="1" goto :exec
echo [nemo] building in %NEMO_HOME% ^(first run or stale dist^) ...
call npm --prefix "%NEMO_HOME%" install --no-audit --no-fund >nul
if errorlevel 1 ( echo [nemo] install failed. & endlocal & exit /b 1 )
call npm --prefix "%NEMO_HOME%" run build >nul
if errorlevel 1 ( echo [nemo] build failed. & endlocal & exit /b 1 )

:exec
set "NEMO_BIN_NAME=nemo-code"
REM Propagate the CLI's exit code (see nemo.cmd): `endlocal` resets
REM ERRORLEVEL, so refusals used to reach scripts as success.
node "%NEMO_HOME%\dist\apps\cli\src\index.js" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%

:notfound
echo [nemo] Could not locate nemo project root.
echo           Either:
echo             1. Run `node scripts/install-global.js` inside the nemo project, or
echo             2. Set NEMO_HOME to the project root, e.g.:
echo                setx NEMO_HOME "C:\Users\engli\nemo"
endlocal
exit /b 1
