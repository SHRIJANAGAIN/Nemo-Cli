const fs = require('fs');
const path = require('path');

const destDir = 'dist/packages/tui/src/ink-app-esm';
const srcDir = path.join(destDir, 'packages', 'tui', 'src', 'ink-app');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (fs.existsSync(srcDir)) {
  copyDirRecursive(srcDir, destDir);
  // Flattened deps: files pulled in from ../ui keep their own same-dir imports
  // (theme.js -> ./skt-themes.js), which would dangle once the nested
  // packages/ tree below is deleted. Pull them in transitively.
  const uiDir = path.join(destDir, 'packages', 'tui', 'src', 'ui');
  const pulled = new Set();
  const queue = ['theme.js'];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (pulled.has(rel)) continue;
    pulled.add(rel);
    const src = path.join(uiDir, rel);
    if (!fs.existsSync(src)) continue; // verifier flags real misses below
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (fs.existsSync(src + '.map')) fs.copyFileSync(src + '.map', dest + '.map');
    const content = fs.readFileSync(src, 'utf8');
    for (const m of content.matchAll(/from\s*(["'])\.\/([^"']+\.js)\1/g)) {
      queue.push(m[2]);
    }
  }
  for (const dir of ['packages', 'apps', 'skt', 'ink-app']) {
    const dirPath = path.join(destDir, dir);
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }
}

fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify({ type: 'module' }));

function fixImports(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      fixImports(fullPath);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      content = content.replace(/from\s*(["'])(\.[^"']+)(["'])/g, (match, q1, p1, q2) => {
        if (p1.endsWith('.js')) {
          if (p1 === '../ui/theme.js') {
            return `from ${q1}./theme.js${q2}`;
          }
          return match;
        }
        if (p1 === '../ui/theme') {
          return `from ${q1}./theme.js${q2}`;
        }
        return `from ${q1}${p1}.js${q2}`;
      });
      fs.writeFileSync(fullPath, content);
    }
  }
}

fixImports(destDir);

// Fail the build if a flattened ESM import points at a file that isn't there
// (this is how a missing sibling copy like skt-themes.js surfaces — as a
// runtime ERR_MODULE_NOT_FOUND otherwise).
function verifyImports(dir) {
  const missing = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) {
        const content = fs.readFileSync(full, 'utf8');
        const specs = [];
        for (const m of content.matchAll(/from\s*(["'])(\.[^"']+)\1/g)) specs.push(m[2]);
        for (const m of content.matchAll(/import\s*(["'])(\.[^"']+)\1/g)) specs.push(m[2]);
        for (const spec of specs) {
          if (!spec.endsWith('.js')) continue;
          if (!fs.existsSync(path.resolve(path.dirname(full), spec))) {
            missing.push(`${full} -> ${spec}`);
          }
        }
      }
    }
  };
  walk(dir);
  if (missing.length > 0) {
    throw new Error(`Flattened output has unresolved imports:\n  ${missing.join('\n  ')}`);
  }
}
verifyImports(destDir);

console.log('Fixed ESM imports and flattened output');
