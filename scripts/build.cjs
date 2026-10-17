const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/rezka-fi.js'), 'utf8');
for (const name of ['rezka-fi.js', 'rezka-fi-auth.js']) {
    fs.writeFileSync(path.join(root, 'docs', name), source);
}
console.log('Built docs/rezka-fi.js and compatibility URL docs/rezka-fi-auth.js');
