@echo off
cd /d C:\Users\engli\trayambak
npm rebuild better-sqlite3 2>&1
node -e "try{const d=require('better-sqlite3');console.log('BETTER_SQLITE3_OK')}catch(e){console.log('BETTER_SQLITE3_FAIL:',e.message)}"
