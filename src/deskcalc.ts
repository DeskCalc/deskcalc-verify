// Find and start DeskCalc. Everything stays local: no network, no telemetry.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DeskCalcInfo {
  found: boolean;
  kind?: 'custom' | 'store' | 'desktop';
  path?: string;
}

function regValue(key: string, name: string): string | undefined {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`, 'i').exec(out);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function exists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }   // lstat: Store aliases are reparse points
}

/** Order: DESKCALC_PATH, Store alias (DeskCalc 11.3+), website install (registry). */
export function findDeskCalc(): DeskCalcInfo {
  // An optional .mcpb setting left empty may arrive as "" or as the unresolved "${user_config...}".
  const raw = process.env.DESKCALC_PATH?.trim();
  const custom = raw && !raw.includes('${') ? raw : undefined;
  if (custom) return exists(custom) ? { found: true, kind: 'custom', path: custom } : { found: false };

  const local = process.env.LOCALAPPDATA;
  if (local) {
    const alias = join(local, 'Microsoft', 'WindowsApps', 'deskcalc.exe');
    if (exists(alias)) return { found: true, kind: 'store', path: alias };
  }

  const dirs = [
    regValue('HKCU\\Software\\DeskCalc', 'InstallDir'),
    regValue('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeskCalc', 'InstallLocation'),
    regValue('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeskCalc', 'InstallLocation'),
  ];
  for (const d of dirs) {
    if (!d) continue;
    const exe = join(d.replace(/^"|"$/g, ''), 'DeskCalc.exe');
    if (existsSync(exe)) return { found: true, kind: 'desktop', path: exe };
  }
  return { found: false };
}

/**
 * Exchange folder. Outside AppData on purpose: packaged (MSIX) apps may have
 * AppData writes redirected to a private folder this server could not see.
 */
export function exchangeDir(): string {
  const dir = process.env.DESKCALC_VERIFY_DIR
    ?? (existsSync(join(homedir(), 'Documents')) ? join(homedir(), 'Documents', 'DeskCalc Verify') : join(homedir(), 'DeskCalc Verify'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Start `deskcalc.exe /verify <job>`; returns immediately. DESKCALC_EXTRA_ARGS e.g. "/probe" for testing. */
export function launchVerify(exe: string, jobPath: string): void {
  const extra = (process.env.DESKCALC_EXTRA_ARGS ?? '').split(' ').filter(Boolean);
  const args = ['/verify', jobPath, ...extra];
  // A .js/.mjs path is a stand-in for tests (fake DeskCalc).
  const [cmd, argv] = /\.m?js$/i.test(exe) ? [process.execPath, [exe, ...args]] : [exe, args];
  const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => { /* reported via missing acknowledgement */ });
  child.unref();
}
