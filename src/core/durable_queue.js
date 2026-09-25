// Key events survive process restarts; stale events never become "live" data.
import {readFileSync,existsSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
export class DurableQueue{
 constructor(file,{max=2048,ttlMs=55000,now=()=>Date.now()}={}){
  this.file=file;this.max=max;this.ttlMs=ttlMs;this.now=now;this.items=new Map();
  this.expired=0;this.failedWrites=0;
  if(existsSync(file)){
   let value;
   try{const raw=readFileSync(file);if(raw.length>8*1024*1024)throw Error('oversized');
     value=JSON.parse(raw.toString('utf8'));}catch{throw Error('事件存储损坏，保留原文件: '+file);}
   if(value?.version!==1||!Array.isArray(value.events)||value.events.length>max)throw Error('未知事件存储版本: '+file);
   for(const e of value.events){
    if(typeof e?.observation_id!=='string'||!Number.isFinite(e.observed_at))throw Error('非法存储事件: '+file);
    this.items.set(e.observation_id,e);
   }
  }
  this.prune();
 }
 persist(){
  mkdirSync(dirname(this.file),{recursive:true});
  const tmp=this.file+'.tmp',buf=Buffer.from(JSON.stringify({version:1,events:[...this.items.values()]}));
  if(buf.length>8*1024*1024)throw Error('事件存储超限');
  let fd=null;
  try{fd=openSync(tmp,'w',0o600);writeSync(fd,buf);fsyncSync(fd);closeSync(fd);fd=null;renameSync(tmp,this.file);}
  catch(e){this.failedWrites++;if(fd!==null)try{closeSync(fd)}catch{};try{unlinkSync(tmp)}catch{};throw e;}
 }
 add(event){
  if(this.items.has(event.observation_id))return true;
  if(this.items.size>=this.max)return false;
  this.items.set(event.observation_id,event);
  try{this.persist();return true;}catch(e){this.items.delete(event.observation_id);throw e;}
 }
 ack(ids){
  if(!ids?.length)return;
  const before=new Map(this.items);let changed=false;
  for(const id of ids)if(this.items.delete(id))changed=true;
  if(changed)try{this.persist()}catch(e){this.items=before;throw e;}
 }
 prune(){
  const ids=[...this.items.values()].filter(e=>e.observed_at<this.now()-this.ttlMs).map(e=>e.observation_id);
  if(ids.length){this.ack(ids);this.expired+=ids.length;}
  return ids.length;
 }
 first(n){return [...this.items.values()].slice(0,n)}
 get size(){return this.items.size}
}
