@echo off
node -e "try { const d = require('better-sqlite3'); console.log('BETTER_SQLITE3_OK'); } catch(e) { console.log('BETTER_SQLITE3_FAIL:', e.message); }"
