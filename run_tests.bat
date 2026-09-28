@echo off
cd /d C:\Users\engli\trayambak
npx vitest run 2>&1 | findstr /N "."
