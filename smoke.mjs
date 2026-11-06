// Real-platform acceptance against a disposable local ingress. No native keyring mocks.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,realpathSync,existsSync,rmSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,delimiter} from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
import {once} from 'node:events';
import {lookup} from 'node:dns/promises';
import {assertNativeStatus,cleanupTemporaryRoot} from './smoke-support.mjs';
import {windowsSddlSnapshot} from './windows-sddl.mjs';

const source=process.argv[2];
assert.ok(source,'Usage: node smoke.mjs <exact-version|local.tgz> [--vault|--headless]');
const local=source.endsWith('.tgz');
assert.ok(local?existsSync(resolve(source)):/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(source),'Provide an exact npm version or an existing local .tgz.');
assert.ok(process.argv.slice(3).every(arg=>['--vault','--headless'].includes(arg)),'Unknown option.');
assert.ok(process.env.CTL_SMOKE_CONTROL,'Launch using a PTY driver.');
const spec=local?resolve(source):`@synopackageland/cli@${source}`;
assert.ok(process.stdin.isTTY&&process.stdout.isTTY,'Run in a terminal; the smoke exercises real hidden prompts.');
const headless=process.argv.includes('--headless'),vault=headless||process.argv.includes('--vault'),backend=vault?'encrypted-file':'keychain';
const root=mkdtempSync(join(tmpdir(),"ctl platform 'smoke-")),install=join(root,'install');
const cliTrace=join(root,'ctl-phases.jsonl');appendFileSync(cliTrace,'',{mode:0o600});
let controlState={label:'install',root,cliTrace,passphrase:'smoke independent passphrase'},step=0;
function trace(event,detail={}){
 controlState={...controlState,...detail,event,message:detail.message,childPid:event==='subprocess-start'||event==='subprocess-done'?(detail.childPid??controlState.childPid):undefined};
 appendFileSync(process.env.CTL_SMOKE_CONTROL,JSON.stringify(controlState)+'\n');
}
const sddlSnapshot=async phase=>{if(process.platform!=='win32')return;trace('phase',{phase});await windowsSddlSnapshot(join(root,'state'),message=>trace('diagnostic',{message}));};
try {
await sddlSnapshot('Windows pre-install SDDL snapshot');
trace('phase',{phase:'install CLI'});
const npmCandidates=[process.env.npm_execpath,join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];
if(process.platform!=='win32')for(const dir of (process.env.PATH??'').split(delimiter)){try{npmCandidates.push(realpathSync(join(dir,'npm')));}catch{}}
const npm=npmCandidates.find(p=>p&&existsSync(p));assert.ok(npm,'Install Node with npm (Node >=22.12).');
function child(args,{interactive=false,input='',env=process.env}={}){
 const phase=args[0]===npm?'npm install':`CLI ${args[2]??'subprocess'}`;
 return new Promise((done,reject)=>{
 const p=spawn(process.execPath,args,{env,stdio:interactive?'inherit':['pipe','pipe','pipe'],windowsHide:!interactive});trace('subprocess-start',{phase,childPid:p.pid});let out='',err='';
 if(!interactive){p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(input);}
 p.once('error',reject);p.once('close',code=>{trace('subprocess-done',{phase,exitCode:code});done({code,out,err});});
});}
console.log(`Installing CLI ${local?'tarball':source} from npm (no lifecycle scripts).`);
const installed=await child([npm,'install','--prefix',install,'--ignore-scripts','--omit=dev','--omit=peer','--no-audit','--no-fund','--registry',process.env.SMOKE_NPM_REGISTRY??'https://registry.npmjs.org',spec]);
assert.equal(installed.code,0,installed.out+installed.err);
const pkg=join(install,'node_modules/@synopackageland/cli'),bin=join(pkg,'dist/bin.js');
const required=['nas/store.js','ctl/native-store.js','ctl/native-metadata.js','ctl/native-schemas.js','ctl/descriptor.js'];
assert.ok(required.every(relative=>existsSync(join(pkg,'dist',relative))),
 'Installed CLI lacks native credential support; select a version or local tarball containing dist/ctl/native-store.js.');
trace('phase',{phase:'load native credential modules'});
const load=relative=>import(pathToFileURL(join(pkg,'dist',relative)).href);
const {CtlStore}=await load('nas/store.js');
const {NativeKeychain,nativeScope}=await load('ctl/native-store.js');
const {digest,nativeBindings}=await load('ctl/native-metadata.js');
const {nativeFeatures}=await load('ctl/native-schemas.js');
const {validateDescriptor}=await load('ctl/descriptor.js');
const passphrase='smoke independent passphrase',nonce=randomBytes(8).toString('hex');
const fresh={type:'greader-client-login',credentialPage:'i/?c=user&a=profile',instructions:'Open Profile, set the API password, and use the native account name.',exchangePath:'/api/greader.php/accounts/ClientLogin',identityPath:'/api/greader.php/reader/api/0/user-info',actionTokenPath:'/api/greader.php/reader/api/0/token'};
const header={type:'header',header:'Authorization',prefix:'Token ',credentialPage:'dashboard',instructions:'Open My Profile > API Auth Token. Copy the regenerated token.',verify:{method:'GET',path:'/api/profile/',response:{statuses:[200],decode:'json',maxBytes:65536,contentTypes:['application/json'],project:{fields:{name:'/name'}}}}};
const {address:loopback}=await lookup('localhost',{family:4});
assert.ok(loopback.startsWith('127.'),'Fixture must bind to IPv4 loopback');
let descriptor,generation=1,scheme='header',permission=false,events=[],violations=[];
const nativeToken=()=>`smoke-${nonce}-${scheme}-token-${generation}`;
const password=()=>`smoke-${nonce}-password-${generation}`;
const server=http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
 const body=Buffer.concat(chunks).toString(),url=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
 if(url.pathname==='/webapi/entry.cgi'){
  const form=new URLSearchParams(body);
  res.end(JSON.stringify(form.get('api')==='SYNO.API.Auth'?{success:true,data:{sid:'smoke-dsm-session',synotoken:'smoke-dsm-token'}}:{success:true,data:{total:1,packages:[{id:'CredentialSmoke',version:'1'}]}}));return;
 }
 if(url.pathname==='/webman/3rdparty/CredentialSmoke/cgi/api.cgi'){res.end(JSON.stringify({success:true,data:descriptor}));return;}
 events.push({path:url.pathname,auth:req.headers.authorization,body});
 for(const key of ['cookie','origin','referer','synotoken','x-syno-token','remote-user','x-forwarded-user'])if(req.headers[key])violations.push(key);
 if(url.pathname.endsWith('ClientLogin')){
  const form=new URLSearchParams(body);assert.equal(req.headers.authorization,undefined);
  if(form.get('Email')!=='reader'||form.get('Passwd')!==password()){res.statusCode=401;res.end('{}');return;}
  res.setHeader('content-type','text/plain');res.end(`Auth=${nativeToken()}\n`);return;
 }
 if(req.headers.authorization!==(scheme==='header'?'Token ':'GoogleLogin auth=')+nativeToken()){res.statusCode=401;res.end('{"private":"do not echo auth errors"}');return;}
 if(permission){res.statusCode=403;res.end('{}');return;}
 res.end(JSON.stringify(url.pathname.endsWith('/profile/')?{name:'Smoke User'}:url.pathname.endsWith('user-info')?{userId:'reader'}:{items:[{id:1}]}));
 });});server.listen(0,loopback);await once(server,'listening');
const origin=`http://${loopback}:${server.address().port}`,profile='platform-smoke-'+nonce;
const env={...process.env,SYNOPKGLAND_CTL_DIR:join(root,'state'),SYNOPKGLAND_CTL_DIAGNOSTICS_FILE:cliTrace,DSM_USERNAME:'smoke',DSM_PASSWORD:'synthetic-dsm-password'};delete env.DSM_URL;delete env.DSM_OTP;
trace('phase',{phase:'construct native credential stores'});
const store=new CtlStore(env.SYNOPKGLAND_CTL_DIR),keychain=new NativeKeychain(),keys=[];
const cli=(args,options={})=>child([bin,'ctl',...args,'--host',profile],{env,...options});
const json=async(args,expected=0,input='')=>{const r=await cli([...args,'--json'],{input});assert.equal(r.code,expected,r.out+r.err);return JSON.parse(r.out);};
const business=()=>events.filter(e=>e.path.endsWith('/api/items')).length;
async function inspectWindowsAcl(){
 if(process.platform!=='win32'||!vault)return;
 trace('phase',{phase:'Windows native ACL readback'});
 const {windowsAclSnapshot}=await load('ctl/windows-acl.js');
 const pending=[join(env.SYNOPKGLAND_CTL_DIR,'native')];let checked=0;
 while(pending.length){
  const path=pending.pop(),snapshot=windowsAclSnapshot(path);
  assert.equal(snapshot.owner,snapshot.currentUser,'Private ACL owner must be the current user');
  assert.equal(snapshot.protected,true,'Private ACL must disable inheritance');assert.equal(snapshot.reparsePoint,false);
  let allowed=false;
  for(const rule of snapshot.rules)if(rule.type==='Allow'&&rule.rights){assert.equal(rule.sid,snapshot.currentUser,'Private ACL permits another principal');allowed=true;}
  assert.ok(allowed,'Private ACL must allow the current user');checked++;
  if(snapshot.directory)for(const entry of readdirSync(path,{withFileTypes:true})){assert.ok(!entry.isSymbolicLink(),'Private ACL fixture contains a link');pending.push(join(path,entry.name));}
 }
 console.log(`PASS user-only vault ACLs (native readback, ${checked} objects)`);
}
const currentRecord=key=>{trace('phase',{phase:'read native credential record'});return backend==='keychain'?keychain.get(key):Promise.resolve(readFileSync(join(env.SYNOPKGLAND_CTL_DIR,'native',key+'.vault'),'utf8'));};
const status=async(state)=>{const before=events.length,r=await json(['list','--refresh']);if(r?.data?.apps?.[0]?.auth?.state!==state)await sddlSnapshot('Windows status-mismatch SDDL snapshot');assertNativeStatus(state,r,readFileSync(process.env.CTL_SMOKE_CONTROL,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),message=>{console.error(message);trace('diagnostic',{message});});assert.equal(events.length,before,'list must not probe native APIs');};
async function human(label,args,expected,secret){
 trace('step-start',{label,secret,step:++step,phase:'interactive CLI'});
 console.log(`\nSTEP ${label}`);
 const r=await cli(args,{interactive:true});assert.equal(r.code,expected,`STEP ${label} exit`);
 trace('step-done',{exitCode:r.code});
}
try{
 for(scheme of ['header','greader-client-login']){
  generation=1;permission=false;events=[];const auth=scheme==='header'?header:fresh;
  const nativeHttp={basePath:'/smoke/',auth,limits:{maxResponseBytes:1048576,maxTransferBytes:1048576}};
  const operations={'items.list':{summary:'List smoke items',cli:['items','list'],effect:'read',permission:'authenticated',ai:'read',kind:'rpc',paramsSchema:{type:'object',additionalProperties:false,properties:{},required:[]},resultSchema:{type:'array',items:{type:'object'}},flow:{type:'invoke',method:'items.list'},http:{method:'GET',path:'/api/items',response:{statuses:[200],decode:'json',maxBytes:1048576,contentTypes:['application/json'],project:{pointer:'/items'}}}}};
  const registry={format:'synopkgland.api',version:3,nativeHttp,operations};
  const entryPolicyDigest=digest({entry:'app-privilege',fixture:true}),registrySha256=digest(registry),authSha256=digest({basePath:nativeHttp.basePath,auth,entryPolicyDigest}),bindings=nativeBindings(registry);
  const packageInfo={id:'CredentialSmoke',version:'1',displayName:'Credential Smoke'};
  const inventory={format:'synopkgland.http-inventory',version:1,package:packageInfo,entry:'app-privilege',entryPolicyDigest,basePath:nativeHttp.basePath,registrySha256,authSha256,bindings,upstreamAuthPaths:['/api']};
  const payload={package:packageInfo,aliases:['smoke'],provenance:{developedBy:'third-party',generator:'platform-smoke'},entry:'app-privilege',transport:{path:'/webman/3rdparty/CredentialSmoke/cgi/api.cgi',auth:'dsm-session'},execution:{type:'native-http',...nativeHttp},features:[...nativeFeatures()],entryPolicyDigest,registrySha256,authSha256,inventorySha256:digest(inventory),bindings,commands:operations};
  descriptor={format:'synopkgland.api',version:3,payload,sha256:digest({format:'synopkgland.api',version:3,payload})};validateDescriptor(descriptor,'CredentialSmoke','1');
  const host={name:profile,origin,username:'smoke',tunnel:true,approved:{CredentialSmoke:{version:'1',hash:descriptor.sha256}}};store.save(host);
  const key=nativeScope(host,'CredentialSmoke',{authSha256});keys.push(key);
  await status('missing');
  if(headless&&scheme==='header'){
   const r=await cli(['auth','--app','CredentialSmoke','--secret-stdin','--json'],{input:nativeToken()+'\n'});
   assert.equal(r.code,2,r.out+r.err);assert.equal(JSON.parse(r.out).error.code,'CTL_NATIVE_STORE_UNAVAILABLE');assert.match(r.out+r.err,/--store encrypted-file/);await status('missing');
   console.log('PASS no Secret Service: clear explicit encrypted-file guidance, no silent fallback');
  }
  await human('enroll '+scheme,['auth','--app','CredentialSmoke',...(vault?['--store','encrypted-file']:[])],0,scheme==='header'?nativeToken():password());
  await status(vault?'locked':'stored');
  await human('call '+scheme,['smoke','items','list'],0);
  const original=await currentRecord(key),initialBusiness=business();generation=2;
  if(!vault){const r=await json(['smoke','items','list'],2);assert.equal(r.error.code,'CTL_NATIVE_AUTH_INVALID');assert.match(r.error.hint,/ctl auth/);assert.equal(business(),initialBusiness+1);}
  else await human('401 decline '+scheme,['smoke','items','list'],2);
  await status('invalid');
  // Verification failure preserves both the old credential and its invalid marker.
  if(!vault){const raw=scheme==='header'?'wrong-smoke-token':JSON.stringify({username:'reader',apiPassword:'wrong-smoke-password'});const r=await json(['auth','--app','CredentialSmoke','--secret-stdin'],2,raw+'\n');assert.equal(r.error.code,'CTL_NATIVE_AUTH_INVALID');}
  else await human('failed update '+scheme,['auth','--app','CredentialSmoke'],2,scheme==='header'?'wrong-smoke-token':'wrong-smoke-password');
  assert.equal(await currentRecord(key),original);await status('invalid');
  const beforeRenew=business();
  await human('401 renew '+scheme,['smoke','items','list'],2,scheme==='header'?nativeToken():password());
  assert.equal(business(),beforeRenew,'renewal must NEVER replay business request');
  assert.notEqual(await currentRecord(key),original);await status(vault?'locked':'stored');
  await human('explicit rerun '+scheme,['smoke','items','list'],0);assert.equal(business(),beforeRenew+1);
  // Ordinary auth with an existing record updates without --reset or backend selection.
  const beforeUpdate=await currentRecord(key);
  await human('ordinary update '+scheme,['auth','--app','CredentialSmoke'],0,scheme==='header'?nativeToken():password());
  if(vault){await inspectWindowsAcl();trace('phase',{phase:'decrypt native credential record'});store.native.setUnlock(async()=>passphrase);const record=await store.native.get(key);assert.equal(record.token,nativeToken());assert.ok(!JSON.stringify(record).includes(password()));const afterUpdate=await currentRecord(key);assert.notEqual(afterUpdate,beforeUpdate);assert.notEqual(JSON.parse(afterUpdate).nonce,JSON.parse(beforeUpdate).nonce);assert.ok(!afterUpdate.includes(nativeToken()));}
  else {const record=JSON.parse(await currentRecord(key));assert.equal(record.token,nativeToken());assert.ok(!JSON.stringify(record).includes(password()));}
  permission=true;
  if(vault)await human('403 permission '+scheme,['smoke','items','list'],4);
  else {const r=await json(['smoke','items','list'],4);assert.equal(r.error.code,'CTL_NATIVE_ACCESS_DENIED');}
  permission=false;await status(vault?'locked':'stored');
  const beforeReset=events.length;await json(['auth','--app','CredentialSmoke','--reset']);assert.equal(events.length,beforeReset);await status('missing');
  if(backend==='keychain')assert.equal(await keychain.get(key),null);
  else assert.ok(!readdirSync(join(env.SYNOPKGLAND_CTL_DIR,'native')).some(f=>f.endsWith('.vault')));
  assert.deepEqual(violations,[]);console.log(`PASS ${process.platform} ${backend} ${scheme}: enroll/call/401/failed-update/renew/no-replay/update/403/reset/list`);
 }
 console.log('ALL PLATFORM SMOKE CHECKS PASSED');
}finally{
 trace('phase',{phase:'cleanup native credentials'});
 for(const key of keys)try{await store.native.delete(key);}catch{if(backend==='keychain')await keychain.delete(key).catch(()=>{});}
 server.closeAllConnections();await new Promise(done=>server.close(done));
}

} finally { cleanupTemporaryRoot(root); }
