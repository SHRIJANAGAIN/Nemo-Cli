const fs = require('fs');
const path = require('path');
const root = 'packages/tui/src/repl';

function fixIdentifiers(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fixIdentifiers(full);
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.includes('.d.ts')) {
      let content = fs.readFileSync(full, 'utf8');
      if (content.includes('SktAiLabs') || content.includes('sktAiLabs') || content.includes('SKT AI LABS')) {
        content = content.replace(/SktAiLabs/g, 'TrayambakLabs');
        content = content.replace(/sktAiLabs/g, 'trayambakLabs');
        content = content.replace(/SKT AI LABS(?=[A-Za-z_])/g, 'TrayambakLabs');
        fs.writeFileSync(full, content);
        console.log('Fixed:', full);
      }
    }
  }
}

fixIdentifiers(root);
console.log('Done fixing repl identifiers');
