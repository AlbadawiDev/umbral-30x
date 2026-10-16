import { mkdir, rm, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=process.cwd(), dist=resolve(root,'dist');
await rm(dist,{recursive:true,force:true});
await mkdir(dist,{recursive:true});
for(const name of ['index.html','styles.css']) await copyFile(resolve(root,name),resolve(dist,name));
for(const name of ['src','fixtures']) await cp(resolve(root,name),resolve(dist,name),{recursive:true});
await mkdir(resolve(dist,'docs'),{recursive:true});
for(const name of ['README.md','docs/DEMO.md','docs/SECURITY.md','docs/VALIDATION.md']) {
  try { await copyFile(resolve(root,name),resolve(dist,'docs',name.split('/').at(-1))); }
  catch(e) { if(e.code!=='ENOENT') throw e; }
}
try { await cp(resolve(root,'video'),resolve(dist,'video'),{recursive:true}); } catch(e) { if(e.code!=='ENOENT')throw e; }
await writeFile(resolve(dist,'_headers'),'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n');
const html=await readFile(resolve(dist,'index.html'),'utf8');
if(!html.includes('app.js'))throw new Error('Missing app module in index.html');
console.log(JSON.stringify({build:'ready',directory:dist}));
