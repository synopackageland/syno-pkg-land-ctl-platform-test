// Test-only Get-Acl snapshot; the CLI never starts PowerShell for ACL checks.
import {execFile} from 'node:child_process';
import {win32} from 'node:path';
export const maskSids=text=>text.replace(/S-1-5-21-(?:\d+-)*\d+/g,'S-1-5-21-*').replace(/S-1-15-2-(?:\d+-)*\d+/g,'S-1-15-2-*');
export function snapshotPaths(stateRoot){
 const parents=[];let path=win32.dirname(stateRoot);
 for(let count=0;count<32;count++){parents.unshift(path);const parent=win32.dirname(path);if(parent===path)break;path=parent;}
 return [...parents.map((path,index)=>({label:'ancestor-'+index,path})),{label:'state',path:stateRoot},{label:'native',path:win32.join(stateRoot,'native')}];
}
const script=`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$items = ConvertFrom-Json $env:CTL_SMOKE_ACL_PATHS
$result = @($items | ForEach-Object {
  $item = $_
  try {
    if (Test-Path -LiteralPath $item.path) {
      @{label=$item.label; sddl=(Get-Acl -LiteralPath $item.path -ErrorAction Stop).Sddl}
    } else { @{label=$item.label; status='missing'} }
  } catch { @{label=$item.label; status='inspection-failed'} }
})
ConvertTo-Json -InputObject $result -Compress -Depth 4`;
export async function windowsSddlSnapshot(stateRoot,emit,{platform=process.platform,execute=execFile,env=process.env}={}){
 if(platform!=='win32')return;
 const paths=snapshotPaths(stateRoot);
 const result=await new Promise(resolve=>{
  execute('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
   {env:{...env,CTL_SMOKE_ACL_PATHS:JSON.stringify(paths)},windowsHide:true,timeout:20000,maxBuffer:1024*1024,encoding:'utf8'},
   (error,stdout)=>resolve(error?null:stdout));
 });
 try{
  if(result===null)throw Error();const rows=JSON.parse(result.replace(/^\uFEFF/,''));
  if(!Array.isArray(rows)||rows.length!==paths.length)throw Error();
  for(const [index,row] of rows.entries()){
   if(row.label!==paths[index].label)throw Error();
   if(typeof row.sddl==='string'&&row.sddl.length<=65536&&!/[\r\n\0]/.test(row.sddl))emit(`[SDDL] ${row.label}: ${maskSids(row.sddl)}`);
   else emit(`[SDDL] ${row.label}: ${row.status==='missing'?'missing':'inspection-failed'}`);
  }
 }catch{emit('[SDDL] snapshot unavailable (bounded PowerShell diagnostic); continuing smoke');}
}
