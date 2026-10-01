@echo off
REM trayambak - global CMD shim.
REM
REM Resolution order:
REM   1. TRAYAMBAK_HOME env var
REM   2. Walk up parent directories looking for the project root
REM      (package.json + tsconfig.ink.json — ignores stray package.json files)
REM
REM First run: install + build. Subsequent: just exec.

setlocal

set "TRY=%TRAYAMBAK_HOME%"
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
set "TRAYAMBAK_HOME=%TRY%"

set "DIST_OK="
if exist "%TRAYAMBAK_HOME%\dist\apps\cli\src\index.js" (
  node "%TRAYAMBAK_HOME%\scripts\check-dist.mjs" >nul 2>&1
  if not errorlevel 1 set "DIST_OK=1"
)
if "%DIST_OK%"=="1" goto :exec
echo [trayambak] building in %TRAYAMBAK_HOME% ^(first run or stale dist^) ...
call npm --prefix "%TRAYAMBAK_HOME%" install --no-audit --no-fund >nul
if errorlevel 1 ( echo [trayambak] install failed. & endlocal & exit /b 1 )
call npm --prefix "%TRAYAMBAK_HOME%" run build >nul
if errorlevel 1 ( echo [trayambak] build failed. & endlocal & exit /b 1 )

:exec
REM Propagate the CLI's exit code: without this, `endlocal` resets ERRORLEVEL
REM to 0, so a refusal (e.g. the retired --dump-system-prompt, exit 2) looked
REM like success to every script and CI step driving the shim.
node "%TRAYAMBAK_HOME%\dist\apps\cli\src\index.js" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%

:notfound
echo [trayambak] Could not locate trayambak project root.
echo           Either:
echo             1. Run `node scripts/install-global.js` inside the trayambak project, or
echo             2. Set TRAYAMBAK_HOME to the project root, e.g.:
echo                setx TRAYAMBAK_HOME "C:\Users\engli\trayambak"
endlocal
exit /b 1
