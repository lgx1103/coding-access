import { createServer } from 'node:http';
import { createReadStream, readFileSync, cpSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const version=JSON.parse(readFileSync('src-tauri/tauri.release.conf.json')).version;
const files=[['mac-arm64-update.tar.gz','src-tauri/target/release/bundle/macos/Coding Access.app.tar.gz'],['win-x64-setup.exe',`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Coding Access_${version}_x64-setup.exe`]];
const publicKey=JSON.parse(readFileSync('src-tauri/tauri.release.conf.json')).plugins.updater.pubkey;
writeFileSync('.local/release-update.pub',publicKey);
let current;
const server=createServer((req,res)=>{ if(req.url==='/file') {res.setHeader('Content-Length',statSync(current).size);createReadStream(current).pipe(res);}else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:'9.9.9',url:`http://127.0.0.1:${server.address().port}/file`,signature:readFileSync(current+'.sig','utf8').trim()}));} });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const reports=[];
try {for(const [name,file] of files) {current=resolve(file);const target=`release/Coding-Access-${version}-${name}`;cpSync(file,target);cpSync(file+'.sig',target+'.sig');
 const result=await new Promise((resolveResult,reject)=>{const p=spawn('src-tauri/target/debug/examples/update_fixture',[`http://127.0.0.1:${server.address().port}/manifest`,'.local/release-update.pub']);let out='';p.stdout.on('data',c=>out+=c);p.on('error',reject);p.on('exit',code=>code===0?resolveResult(JSON.parse(out.trim())):reject(new Error('Signature verifier failed')));});
 if(!result.verified)throw new Error('Invalid release signature');reports.push({file:target,...result});}
 writeFileSync('output/verification/release-signatures.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports));
} finally {server.close();}
