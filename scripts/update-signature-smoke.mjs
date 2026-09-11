import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const root = mkdtempSync(resolve('.local/update-signature-'));
execFileSync('node_modules/.bin/tauri', ['signer', 'generate', '--ci', '-p', '', '-w', join(root, 'test.key')], { stdio: 'ignore' }); chmodSync(join(root,'test.key'),0o600);
writeFileSync(join(root, 'artifact'), 'signed fixture data');
execFileSync('node_modules/.bin/tauri', ['signer','sign','-f',join(root,'test.key'),'-p','',join(root,'artifact')], { stdio:'ignore' });
let signature = readFileSync(join(root,'artifact.sig'),'utf8').trim();
let tamper = false; let base;
const server = createServer((req,res) => {
  if (req.url === '/update') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({version:'99.0.0',notes:'fixture',url:base+'/artifact',signature})); }
  else { res.end(tamper ? 'corrupted fixture data' : readFileSync(join(root,'artifact'))); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); base = `http://127.0.0.1:${server.address().port}`;
async function verify(install = false) { return await new Promise((resolve,reject)=>{ const p=spawn('src-tauri/target/debug/examples/update_fixture',[base+'/update',join(root,'test.key.pub'),...(install ? [root] : [])],{env:{...process.env,NO_PROXY:'127.0.0.1',no_proxy:'127.0.0.1'}});let stdout='',stderr='';p.stdout.on('data',c=>stdout+=c);p.stderr.on('data',c=>stderr+=c);p.on('exit',code=>code?reject(new Error(stderr)):resolve(JSON.parse(stdout.trim()))); }); }
try { const good = await verify(); assert.equal(good.verified,true); tamper=true; const bad = await verify(); assert.equal(bad.verified,false); tamper=false;
  for (const directory of ['old','new']) { mkdirSync(join(root,directory,'Fixture.app/Contents/MacOS'),{recursive:true}); writeFileSync(join(root,directory,'Fixture.app/Contents/MacOS/fixture'),directory); }
  writeFileSync(join(root,'.aca-update-fixture'),'synthetic');writeFileSync(join(root,'preferences.json'),'preserved');
  execFileSync('tar',['-czf',join(root,'artifact'),'-C',join(root,'new'),'Fixture.app'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
  execFileSync('node_modules/.bin/tauri',['signer','sign','-f',join(root,'test.key'),'-p','',join(root,'artifact')],{stdio:'ignore'});
  signature=readFileSync(join(root,'artifact.sig'),'utf8').trim();
  const installed=await verify(true); assert.equal(installed.installed,true, JSON.stringify(installed));assert.equal(readFileSync(join(root,'old/Fixture.app/Contents/MacOS/fixture'),'utf8'),'new');assert.equal(readFileSync(join(root,'preferences.json'),'utf8'),'preserved');
  writeFileSync(join(root,'artifact'),'signed but invalid archive');
  execFileSync('node_modules/.bin/tauri',['signer','sign','-f',join(root,'test.key'),'-p','',join(root,'artifact')],{stdio:'ignore'});signature=readFileSync(join(root,'artifact.sig'),'utf8').trim();
  const malformed=await verify(true);assert.equal(malformed.verified,true);assert.equal(malformed.installed,false);assert.equal(readFileSync(join(root,'old/Fixture.app/Contents/MacOS/fixture'),'utf8'),'new');
  execFileSync('tar',['-czf',join(root,'artifact'),'-C',join(root,'new'),'Fixture.app'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
  execFileSync('node_modules/.bin/tauri',['signer','sign','-f',join(root,'test.key'),'-p','',join(root,'artifact')],{stdio:'ignore'});signature=readFileSync(join(root,'artifact.sig'),'utf8').trim();
  let permissionDenied;chmodSync(join(root,'old'),0o500);
  try{permissionDenied=await verify(true);assert.equal(permissionDenied.installed,false);assert.equal(readFileSync(join(root,'old/Fixture.app/Contents/MacOS/fixture'),'utf8'),'new');}finally{chmodSync(join(root,'old'),0o700);}
  mkdirSync('output/verification',{recursive:true});writeFileSync('output/verification/update-signature.json',JSON.stringify({good,bad,installed,malformed,permissionDenied,isolatedBundleReplacement:true,realInstalledAppsTouched:false},null,2));
} finally { server.close(); }
