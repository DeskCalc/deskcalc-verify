// Put the bundled server into the Claude plugin (plugin/server/index.js) and keep the
// plugin version in step with package.json. The plugin directory does not accept a
// launcher such as npx; it runs a file shipped inside the plugin with node.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
mkdirSync(join(root, 'plugin', 'server'), { recursive: true });
copyFileSync(join(root, 'dist', 'server.js'), join(root, 'plugin', 'server', 'index.js'));

const mf = join(root, 'plugin', '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(readFileSync(mf, 'utf8'));
manifest.version = pkg.version;
writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
console.log('ok plugin', pkg.version);
