@echo off
REM skt - global CMD shim (alias for trayambak).
REM
REM Resolution order:
REM   1. TRAYAMBAK_HOME env var
REM   2. Walk up parent directories looking for the project root
REM      (package.json + tsconfig.ink.json - ignores stray package.json files)
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
echo [skt] building in %TRAYAMBAK_HOME% ^(first run or stale dist^) ...
call npm --prefix "%TRAYAMBAK_HOME%" install --no-audit --no-fund >nul
if errorlevel 1 ( echo [skt] install failed. & endlocal & exit /b 1 )
call npm --prefix "%TRAYAMBAK_HOME%" run build >nul
if errorlevel 1 ( echo [skt] build failed. & endlocal & exit /b 1 )

:exec
set "TRAYAMBAK_BIN_NAME=skt"
node "%TRAYAMBAK_HOME%\dist\apps\cli\src\index.js" %*
endlocal
goto :eof

:notfound
echo [skt] Could not locate trayambak project root.
echo           Either:
echo             1. Run `node scripts/install-global.js` inside the trayambak project, or
echo             2. Set TRAYAMBAK_HOME to the project root, e.g.:
echo                setx TRAYAMBAK_HOME "C:\Users\engli\trayambak"
endlocal
exit /b 1
