const fs = require('fs');
const path = require('path');
const root = 'packages';

function fixIdentifiers(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.includes('node_modules') && !entry.name.includes('dist')) {
      fixIdentifiers(full);
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.includes('.d.ts')) {
      let content = fs.readFileSync(full, 'utf8');
      if (content.includes('SKT AI LABS')) {
        // Only replace when followed by a letter/underscore (part of identifier), not space/newline
        content = content.replace(/SKT AI LABS(?=[A-Za-z_])/g, 'TrayambakLabs');
        fs.writeFileSync(full, content);
        console.log('Fixed:', full);
      }
    }
  }
}

fixIdentifiers(root);
console.log('Done fixing identifiers');
