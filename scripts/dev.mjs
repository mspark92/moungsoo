// Loopback-only Node adapter for editing the Worker app without paid services.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { handleRequest } from '../worker/runtime.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const storeRoot=process.env.REFERENCE_LOCAL_DATA_DIR?resolve(process.env.REFERENCE_LOCAL_DATA_DIR):resolve(root,'.local-data');
const port=Number(process.env.PORT||3000);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('PORT must be an integer between 0 and 65535.');
let listeningPort=port;
const token=process.env.ADMIN_TOKEN?.trim()||'';
if(token&&token.length<24)throw Error('Use at least 24 characters for ADMIN_TOKEN. Its value is never printed.');
const hash=value=>createHash('sha256').update(value).digest('hex');
function objectPath(key){const path=resolve(storeRoot,key);if(!path.startsWith(storeRoot+sep)||key.includes('\0'))throw Error('Invalid local storage key.');return path;}
async function load(key){try{return await readFile(objectPath(key),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
let storageQueue=Promise.resolve();
function exclusive(operation){const next=storageQueue.then(operation);storageQueue=next.catch(()=>{});return next;}
const bucket={
 async get(key){const value=await load(key);return value===null?null:{etag:hash(value),json:async()=>JSON.parse(value)};},
 put(key,value,options={}){return exclusive(async()=>{const prior=await load(key);if(options.onlyIf?.etagMatches&&(prior===null||hash(prior)!==options.onlyIf.etagMatches))return null;if(options.onlyIf?.etagDoesNotMatch==='*'&&prior!==null)return null;const path=objectPath(key),temp=path+'.'+randomUUID()+'.tmp';await mkdir(dirname(path),{recursive:true});await writeFile(temp,value,{mode:0o600});await rename(temp,path);return{etag:hash(value)};});},
 delete(key){return exclusive(async()=>{try{await unlink(objectPath(key));}catch(error){if(error.code!=='ENOENT')throw error;}});},
};
// Local HTTP has no trusted Sites gateway. Never trust supplied identity headers.
const env={BUCKET:bucket,ADMIN_TOKEN:token,...(process.env.LAW_API_OC?{LAW_API_OC:process.env.LAW_API_OC}:{}),...(process.env.LAW_UPDATE_SIGNING_KEY?{LAW_UPDATE_SIGNING_KEY:process.env.LAW_UPDATE_SIGNING_KEY}:{}),...(process.env.HOLIDAY_API_KEY?{HOLIDAY_API_KEY:process.env.HOLIDAY_API_KEY}:{})};
const server=createServer(async(incoming,outgoing)=>{
 try{
  if(incoming.headers.host!==`127.0.0.1:${listeningPort}`&&incoming.headers.host!==`localhost:${listeningPort}`){outgoing.writeHead(400);outgoing.end('Use the printed loopback URL.');return;}
  const headers=new Headers();for(const [name,value]of Object.entries(incoming.headers)){if(/^oai-|^x-forwarded-|^cf-/i.test(name)||value===undefined)continue;headers.set(name,Array.isArray(value)?value.join(','):value);}
  const chunks=[];let size=0;for await(const chunk of incoming){size+=chunk.length;if(size>2*1024*1024){outgoing.writeHead(413);outgoing.end('Request body exceeds 2 MB.');return;}chunks.push(chunk);}
  const body=Buffer.concat(chunks),method=incoming.method||'GET';
  const request=new Request(`http://${incoming.headers.host}${incoming.url||'/'}`,{method,headers,...(body.length&&!['GET','HEAD'].includes(method)?{body}: {})});
  // Read source assets on each request so edits appear after a browser refresh.
  const seed=JSON.parse(await readFile(resolve(root,'data/seed.json'),'utf8')),assets={};
  for(const file of ['index.html','app.js','styles.css','favicon.svg'])assets['/'+file]=await readFile(resolve(root,'public',file),'utf8');
  const response=await handleRequest(request,env,{waitUntil:promise=>promise.catch(()=>{})},seed,assets);
  outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
 }catch{outgoing.writeHead(500,{'content-type':'text/plain; charset=utf-8'});outgoing.end('Local server error. Check your input and local data files. No credentials are logged.');}
});
server.listen(port,'127.0.0.1',()=>{listeningPort=server.address().port;console.log(`Local: http://127.0.0.1:${listeningPort}\nAdmin token: ${token?'configured':'not configured (public browsing works)'}\nLocal data: .local-data/ (ignored by Git; never upload this folder)`)});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port in use. Choose another PORT.':'Could not start the local server.');process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
