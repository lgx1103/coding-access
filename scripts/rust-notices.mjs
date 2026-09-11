import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
const metadata = JSON.parse(execFileSync('cargo',['metadata','--manifest-path','src-tauri/Cargo.toml','--format-version','1'],{encoding:'utf8',maxBuffer:20*1024*1024}));
const supplemental = JSON.parse(readFileSync('docs/public/licenses/sources.json', 'utf8'));
const texts = new Map(); const sections = []; const missing=[];
for (const p of metadata.packages.filter(p=>p.source).sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version))) {
  const root=dirname(p.manifest_path);
  const files=readdirSync(root).filter(n=>/^(licen[cs]e|copying|unlicense)([._-].*)?$/i.test(n));
  if (p.license_file && existsSync(join(root,p.license_file))) files.push(p.license_file);
  const ids=[];
  for(const file of [...new Set(files)]) { try { const text=readFileSync(join(root,file),'utf8');const hash=createHash('sha256').update(text).digest('hex').slice(0,16);texts.set(hash,text);ids.push(hash); } catch {} }
  if (!ids.length) for (const entry of supplemental.find(x => x.name === p.name && x.version === p.version)?.sources ?? []) { const text=readFileSync(join('docs/public/licenses',entry.file),'utf8'); const hash=createHash('sha256').update(text).digest('hex').slice(0,16); texts.set(hash,text); ids.push(hash); }
  if(!ids.length) missing.push({name:p.name,version:p.version,license:p.license});
  sections.push(`${p.name} ${p.version}\nLicense: ${p.license ?? 'See package license'}\nSource: ${p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`}\nLicense texts: ${ids.join(', ') || 'SPDX identifier above'}\n`);
}
writeFileSync('src-tauri/THIRD_PARTY_RUST_NOTICES.txt', `Coding Access native dependency notices\nIncludes dependencies across supported build targets.\n\n${sections.join('\n')}\n${[...texts].map(([id,text])=>`\n===== ${id} =====\n${text}`).join('\n')}`);
console.log(JSON.stringify({packages:sections.length,licenseTexts:texts.size,spdxOnly:missing}));
