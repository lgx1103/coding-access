// Cross-build helpers stay on the developer machine; no Node sidecar is shipped.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('On Windows use npm run package:tauri:win.');
const root = resolve(import.meta.dirname, '..');
const local = join(root, '.local/tauri-toolchain');
const llvm = [join(local, 'bottles/llvm/22.1.8/bin'), '/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin'].find(p => existsSync(join(p, 'llvm-ar')));
const nsis = [join(local, 'bottles/makensis/3.12/bin'), '/opt/homebrew/bin', '/usr/local/bin'].find(p => existsSync(join(p, 'makensis')));
if (!llvm || !nsis) throw new Error('Install LLVM and NSIS before cross-building.');
const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
const linker = join(sysroot, 'lib/rustlib', host, 'bin/rust-lld');
if (!existsSync(linker)) throw new Error('The Rust linker is unavailable.');
const wrappers = join(root, '.local/tauri-cross-linker');
mkdirSync(wrappers, { recursive: true });
// Rust 1.96 selects static VCRuntime with the system UCRT. cargo-xwin 0.23.1
// injects older flags which disable that UCRT; only remove that conflicting pair.
writeFileSync(join(wrappers, 'lld-link'), `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
let args=process.argv.slice(2);
if(args.includes('/NODEFAULTLIB:libucrt.lib')) args=args.filter(x=>!['-nodefaultlib:ucrt','-defaultlib:libucrt'].includes(x));
if(args[0]!=='-flavor') args.unshift('-flavor','link');
const result=spawnSync(${JSON.stringify(linker)},args,{stdio:'inherit'});
if(result.error) console.error(result.error.message);
process.exit(result.status??1);
`, { mode: 0o755 });
const env = { ...process.env, PATH: [wrappers, join(local, 'bin'), llvm, nsis, process.env.PATH].join(':'), XWIN_CACHE_DIR: join(root, '.local/tauri-xwin-cache') };
const nsisResources = resolve(nsis, '../share/nsis');
if (existsSync(nsisResources)) {
  env.NSISDIR = nsisResources;
  // Tauri clears NSISDIR while preparing its bundler environment. Restore it
  // inside the local wrapper when using an unpacked, verified Homebrew bottle.
  writeFileSync(join(wrappers, 'makensis'), `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
const result=spawnSync(${JSON.stringify(join(nsis, 'makensis'))},process.argv.slice(2),{stdio:'inherit',env:{...process.env,NSISDIR:${JSON.stringify(nsisResources)}}});
if(result.error) console.error(result.error.message);
process.exit(result.status??1);
`, { mode: 0o755 });
}
for (const [tool, args] of [['cargo-xwin', ['--version']], ['clang-cl', ['--version']], ['llvm-ar', ['--version']], ['makensis', ['-VERSION']]]) {
  execFileSync(tool, args, { env, stdio: 'ignore' });
}
const child = spawn(join(root, 'node_modules/.bin/tauri'), ['build', '--config', 'src-tauri/tauri.release.conf.json', '--features', 'distribution', '--target', 'x86_64-pc-windows-msvc', '--runner', 'cargo-xwin', '--bundles', 'nsis'], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
