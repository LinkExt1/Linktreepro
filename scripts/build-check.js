const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const roots = ['api', 'backend'];
const files = [];
for (const root of roots) {
  const dir = path.join(process.cwd(), root);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.js')) files.push(path.join(root, name));
  }
}
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
console.log(`Build check OK: ${files.length} JavaScript files validated.`);
