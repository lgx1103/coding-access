// Assemble already-built bundles, upgrade instructions, and license notices.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.platform !== 'darwin') throw new Error('This archive helper uses macOS ditto.');
const platform = process.argv[2];
if (!['mac', 'win'].includes(platform)) throw new Error('Usage: node scripts/archive-tauri.mjs mac|win');
const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.release.conf.json'))).version;
const staging = join(root, '.local', `tauri-archive-${platform}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
if (platform === 'mac') {
  const app = join(root, 'src-tauri/target/release/bundle/macos/Coding Access.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
  execFileSync('ditto', [app, join(staging, 'Coding Access.app')]);
} else {
  const directory = join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis');
  const name = `Coding Access_${version}_x64-setup.exe`;
  if (!readdirSync(directory).includes(name)) throw new Error('Build the matching Windows installer first.');
  cpSync(join(directory, name), join(staging, `Coding-Access-${version}-win-x64-setup.exe`));
}
for (const [source, target] of [
  ['LICENSE', 'LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['src-tauri/THIRD_PARTY_RUST_NOTICES.txt', 'THIRD_PARTY_RUST_NOTICES.txt'],
  ['docs/client-native-beta.md', 'UPGRADE.md'],
]) cpSync(join(root, source), join(staging, target));
const filename = `Coding-Access-${version}-${platform}-${platform === 'mac' ? 'arm64' : 'x64'}.zip`;
const destination = join(root, 'release', filename);
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', staging, destination]);
const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
writeFileSync(join(root, '.local', `tauri-artifact-${platform}.json`), JSON.stringify({ filename, version, bytes: statSync(destination).size, sha256 }, null, 2));
console.log(JSON.stringify({ filename, bytes: statSync(destination).size, sha256 }));
