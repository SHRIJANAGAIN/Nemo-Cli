const fs = require('fs');
const path = require('path');
const root = 'packages/tui/src/repl';

function stripJsExtensions(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stripJsExtensions(full);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      let content = fs.readFileSync(full, 'utf8');
      content = content.replace(/from '([^']+)\.js'/g, "from '$1'");
      content = content.replace(/from "([^"]+)\.js"/g, 'from "$1"');
      fs.writeFileSync(full, content);
    }
  }
}

stripJsExtensions(root);
console.log('Done stripping .js extensions from repl');
