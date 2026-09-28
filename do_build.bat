cd /d C:\Users\engli\trayambak
npx tsc -p tsconfig.json --noEmitOnError 2>&1
echo BUILD_EXITCODE=%ERRORLEVEL%
