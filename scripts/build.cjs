const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src/rezka-fi.js'), 'utf8')
    .replace(/__PLUGIN_VERSION__/g, version);
for (const name of ['rezka-fi.js', 'rezka-fi-auth.js']) {
    fs.writeFileSync(path.join(root, 'docs', name), source);
}
console.log('Built docs/rezka-fi.js and compatibility URL docs/rezka-fi-auth.js');
