// A fresh, reviewable snapshot; never pushes, rewrites Git history or alters client sources.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('.local', { recursive: true }); mkdirSync('release/public-beta', { recursive: true });
const stage = mkdtempSync(resolve('.local/public-source-'));
const directories = ['src', 'tests', 'assets', 'deploy', '.github', 'docs/public', 'src-tauri/src', 'src-tauri/tests', 'src-tauri/capabilities', 'src-tauri/examples'];
const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.env.example', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.release.conf.json', 'src-tauri/THIRD_PARTY_RUST_NOTICES.txt'];
const scripts = ['setup.ts', 'demo.ts', 'build.mjs', 'backup.ts', 'restore.ts', 'agent-smoke.ts', 'load-smoke.ts', 'terminal-smoke.ts', 'package-server.mjs', 'package-tauri-win-macos.mjs', 'archive-tauri.mjs', 'rust-notices.mjs', 'export-public-source.mjs', 'update-signature-smoke.mjs', 'update-job-smoke.mjs', 'verify-release-artifacts.mjs', 'product-ui-smoke.ts', 'tool-search-runtime-smoke.ts', 'fixtures'];
// Missing allowlisted files are errors, so a source archive cannot silently lose a build dependency.
for (const name of [...directories, ...files, ...scripts.map(n => 'scripts/' + n)]) {
  mkdirSync(join(stage, name, '..'), { recursive: true }); cpSync(name, join(stage, name), { recursive: true, dereference: false });
}
cpSync('README.md', join(stage, 'README.md'));
// Keep the root README as the canonical landing page; this template is needed for re-export.
writeFileSync(join(stage, 'docs/public/README.md'), readFileSync('docs/public/README.md', 'utf8').replaceAll('](docs/public/', '](').replaceAll('](CONTRIBUTING.md)', '](../../CONTRIBUTING.md)').replaceAll('](SECURITY.md)', '](../../SECURITY.md)').replaceAll('](CHANGELOG.md)', '](../../CHANGELOG.md)').replaceAll('](LICENSE)', '](../../LICENSE)').replaceAll('](THIRD_PARTY_NOTICES.md)', '](../../THIRD_PARTY_NOTICES.md)').replaceAll('](src-tauri/', '](../../src-tauri/'));
for (const name of ['deployment', 'docker-deployment']) writeFileSync(join(stage, `docs/${name}.md`), '# 部署说明\n\n请参阅[公开版部署说明](public/deployment.md)。\n');
const changed = []; const findings = []; let scanned = 0;
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name); const name = relative(stage, path);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlink is not allowed in public snapshot: ${name}`);
    if (entry.isDirectory()) { visit(path); continue; }
    if (/\.(sqlite(?:-.*)?|key|p12|pfx|log)$/.test(name) || entry.name === '.env') throw new Error(`Private file is not allowed: ${name}`);
    const bytes = readFileSync(path); if (bytes.includes(0)) continue;
    let text = bytes.toString('utf8'); if (Buffer.from(text).compare(bytes) !== 0) continue;
    const generic = text.replaceAll('127.0.0.1', '127.0.0.1').replaceAll('/Users/example', '/Users/example');
    if (text !== generic) { writeFileSync(path, generic); changed.push(name); } text = generic; scanned++;
    // No test-directory exemption: a real credential can accidentally enter a fixture too.
    for (const [kind, regex] of Object.entries({ private_key: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, token: /(?:aca_[A-Za-z0-9_-]{35,}|sk-[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,})/ })) if (regex.test(text)) findings.push({ path: name, kind });
  }
}
visit(stage);
writeFileSync(join(stage, 'PUBLIC-SNAPSHOT.md'), `# Public source snapshot\n\nServer baseline ${version}. Git history, local state, credentials, internal screenshots and generated binaries are excluded. Client sources retain their independent version. No remote publication was performed.\n`);
const report = { stage, serverVersion: version, scannedTextFiles: scanned, changed, findings };
writeFileSync('.local/public-source-report.json', JSON.stringify(report, null, 2));
if (findings.length) throw new Error('Potential sensitive content; review paths in .local/public-source-report.json.');
const target = resolve(`release/public-beta/Coding-Access-${version}-public-source.tar.gz`);
const metadataFlags = process.platform === 'darwin' ? ['--no-xattrs', '--no-acls', '--no-fflags', '--no-mac-metadata'] : [];
execFileSync('tar', [...metadataFlags, '-czf', target, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
writeFileSync(target + '.sha256', `${createHash('sha256').update(readFileSync(target)).digest('hex')}  ${target.split('/').at(-1)}\n`);
console.log(JSON.stringify({ stage, target, scannedTextFiles: scanned, rewrittenFiles: changed.length, findings: findings.length }));
