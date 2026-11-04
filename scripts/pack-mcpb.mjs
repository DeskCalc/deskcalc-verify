// Build dist/deskcalc-verify.mcpb (Claude Desktop extension, double-click install).
// dist/server.js is already a self-contained bundle (esbuild), so the package only holds
// manifest.json, server/index.js and the icon. Version comes from package.json.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = join(root, 'dist', 'mcpb');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(join(root, 'dist', 'server.js'), join(stage, 'server', 'index.js'));
copyFileSync(join(root, 'mcpb', 'icon.png'), join(stage, 'icon.png'));
copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

const out = join(root, 'dist', 'deskcalc-verify.mcpb');
execSync(`npx -y @anthropic-ai/mcpb validate "${join(stage, 'manifest.json')}"`, { stdio: 'inherit' });
execSync(`npx -y @anthropic-ai/mcpb pack "${stage}" "${out}"`, { stdio: 'inherit' });
console.log('ok', out);
