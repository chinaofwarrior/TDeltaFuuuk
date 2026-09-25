import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {FusionEngine} from '../src/fusion/engine.js';
import {Agent} from '../src/agent.js';
import {DurableQueue} from '../src/core/durable_queue.js';
import {normalize} from '../src/core/observation.js';
import {ProviderManager} from '../src/providers/manager.js';
import {Hub} from '../src/hub.js';
const obs=(type,kind,id,x={})=>({type,subject:{kind,id},source:'TEAM_SELF_REPORT',confidence:1,...x});
test('independent authenticated player states with zero-value supplies',()=>{
 const f=new FusionEngine({viewerId:'T1'});
 f.ingest(obs('ENTITY_STATE','SELF','fake',{position:{x:10,y:20},supplies:{ammo:50}}),{agentId:'T1'});
 f.ingest(obs('ENTITY_STATE','SELF','fake',{position:{x:90,y:50},supplies:{ammo:0}}),{agentId:'T2'});
 const s=f.worldState();assert.equal(s.self.id,'T1');assert.equal(s.self.supplies.ammo,50);
 assert.equal(s.teammates.T2.position.x,90);assert.equal(s.teammates.T2.state.supplies.ammo,0);
});
test('uncertain bearings are reports, not fake exact points',()=>{
 const f=new FusionEngine();f.ingest(obs('ENTITY_STATE','SELF','me',{position:{x:0,y:0}}),{agentId:'T1'});
 f.ingest(obs('AUDIO_CONTACT','OBSERVED_ENEMY','E',{bearing:65,source:'AUDIO'}),{agentId:'T1'});
 assert.equal(f.worldState().enemies.length,0);assert.equal(f.worldState().reports.length,1);
});
test('sparse equipment, supplies, position stay attached',()=>{
 const f=new FusionEngine();
 f.ingest(obs('LOADOUT_STATE','SELF','me',{equipment:{primary:'K416'}}),{agentId:'T1'});
 f.ingest(obs('SUPPLY_STATE','SELF','me',{supplies:{ammo:0,medkits:2}}),{agentId:'T1'});
 f.ingest(obs('ENTITY_STATE','SELF','me',{position:{x:4,y:3}}),{agentId:'T1'});
 assert.equal(f.worldState().self.equipment.primary,'K416');assert.equal(f.worldState().self.supplies.ammo,0);
});
test('prediction uses incremental, not cumulative elapsed time',()=>{
 const f=new FusionEngine();
 f.ingest(obs('ENTITY_STATE','OBSERVED_ENEMY','E',{position:{x:0,y:0}}),{agentId:'T1'});
 const t=f.enemies.values().next().value;t.velocity.vx=10;
 const now=t.lastPredict;t.predict(now+1000);t.predict(now+2000);assert.equal(t.position.x,20);
});
test('critical events survive failed network request until acknowledgement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tdf-test-'));
 try{
  const config=join(dir,'agent.json');writeFileSync(config,JSON.stringify({agentId:'T2',sharedToken:'unused',hubUrl:'http://127.0.0.1:1'}));
  const a=new Agent(config);let n=0;a.hubClient={hubUrl:'loopback',sendObservations:async sent=>
    ++n===1?{ok:false,ack_ids:[]}:{ok:true,ack_ids:sent.map(o=>o.observation_id)}};
  a.push(obs('SUPPLY_STATE','SELF','me',{supplies:{medkits:0}}));
  await a.flush();assert.equal(a.pending.size,1);
  await a.flush();assert.equal(a.pending.size,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('real HTTP rejects spoofing; Agent->Hub connects own slot',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tdf-e2e-'));mkdirSync(join(dir,'empty'));
 writeFileSync(join(dir,'hub.json'),JSON.stringify({hubHttpPort:0,ingestPort:0,discoveryPort:0,viewerId:'T1'}));
 const h=new Hub(join(dir,'hub.json'));let a;
 try{
  await h.start();const url='http://127.0.0.1:'+h.ingestServer.address().port;
  const wrong=await fetch(url+'/ingest',{method:'POST',headers:{authorization:'Bearer wrong','content-type':'application/json'},body:'{}'});
  assert.equal(wrong.status,401);
  h.fusion.ingest(obs('ENTITY_STATE','SELF','host',{position:{x:10,y:10}}),{agentId:'T1'});
  const cfg=join(dir,'agent.json');writeFileSync(cfg,JSON.stringify({agentId:'T2',sharedToken:h.config.peers.T2.token,hubUrl:url,providersDir:join(dir,'empty'),agentHttpPort:0,agentUdpPort:0,flushIntervalMs:25}));
  a=new Agent(cfg);await a.start();
  a.push(obs('SUPPLY_STATE','SELF','spoof',{supplies:{ammo:64}}));
  a.push(obs('ENTITY_STATE','SELF','spoof',{position:{x:100,y:22}}));
  await sleep(350);
  const w=h.fusion.worldState();assert.equal(w.self.id,'T1');assert.equal(w.teammates.T2.position.x,100);
  assert.equal(w.teammates.T2.state.supplies.ammo,64);assert.equal(w.teammates.spoof,undefined);
  assert.equal(a.pending.size,0);
  const bad=await fetch(url+'/ingest',{method:'POST',headers:{authorization:'Bearer '+h.config.peers.T2.token,'content-type':'application/json'},body:JSON.stringify({agent_id:'T3',observations:[]})});
  assert.equal(bad.status,403);
 }finally{a?.stop();h.stop();rmSync(dir,{recursive:true,force:true});}
});

test('native manifest enforces exact approved DLL hash',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tdf-dll-'));
 try{
  writeFileSync(join(dir,'bad.dll'),'not-a-real-dll');
  const spec=join(dir,'bad.provider.json');
  writeFileSync(spec,JSON.stringify({dll:'bad.dll',sha256:'00',capabilities:['SELF_POSITION']}));
  const manager=new ProviderManager({providersDir:dir});
  const out=await manager.start(spec);assert.equal(out.ok,false);
  manager.stopAll();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('matching native DLL hash proceeds through validation and fails closed if standalone host is absent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tdf-hash-'));
 try{
  const dll=join(dir,'test.dll');const bytes='example bytes to pin';
  writeFileSync(dll,bytes);
  const m=join(dir,'good.provider.json');
  writeFileSync(m,JSON.stringify({dll:'test.dll',sha256:createHash('sha256').update(bytes).digest('hex'),capabilities:['SELF_POSITION']}));
  const provider=new ProviderManager({providersDir:dir});
  const outcome=await provider.start(m);
  // In source tests, native host executable does not exist in repo root.
  assert.equal(typeof outcome,'object');
  assert.equal(outcome.ok,false);
  provider.stopAll();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('critical event remains after recreation and disappears only after durable acknowledgement',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tdf-persist-'));
 try{
  const path=join(dir,'agent.json');writeFileSync(path,JSON.stringify({agentId:'T3',sharedToken:'test'}));
  const a=new Agent(path);
  const e=normalize(obs('SUPPLY_STATE','SELF','me',{supplies:{medkits:0}}));
  assert.equal(a.push(e),true);
  const b=new Agent(path);
  assert.equal(b.pending.size,1);assert.equal(b.spool.first(1)[0].observation_id,e.observation_id);
  b.spool.ack([e.observation_id]);
  assert.equal(new Agent(path).pending.size,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('expired evidence does not replay as live observation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tdf-expire-')),path=join(dir,'events.json');
 let now=10000;
 try{
  const q=new DurableQueue(path,{now:()=>now,ttlMs:200});
  q.add({observation_id:'one',observed_at:9950,type:'ENEMY_REPORT'});
  now+=300;assert.equal(q.prune(),1);assert.equal(q.expired,1);
  assert.equal(new DurableQueue(path,{now:()=>now,ttlMs:200}).size,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('out-of-order pose cannot overwrite newer pose or block different data type',()=>{
 const f=new FusionEngine({viewerId:'T1'}),t=Date.now()-200;
 f.ingest(obs('ENTITY_STATE','SELF','me',{observed_at:t+100,position:{x:90,y:10}}),{agentId:'T1'});
 f.ingest(obs('ENTITY_STATE','SELF','me',{observed_at:t,position:{x:1,y:2}}),{agentId:'T1'});
 f.ingest(obs('SUPPLY_STATE','SELF','me',{observed_at:t,supplies:{ammo:0}}),{agentId:'T1'});
 assert.equal(f.worldState().self.position.x,90);assert.equal(f.worldState().self.supplies.ammo,0);
});
test('one Hub and three real Agent connections keep all four members separate',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tdf-four-'));mkdirSync(join(dir,'empty'));
 const path=join(dir,'hub.json');
 writeFileSync(path,JSON.stringify({hubHttpPort:0,ingestPort:0,discoveryPort:0,viewerId:'T1'}));
 const hub=new Hub(path),agents=[];
 try{
  await hub.start();const url='http://127.0.0.1:'+hub.ingestServer.address().port;
  hub.fusion.ingest(obs('ENTITY_STATE','SELF','me',{position:{x:0,y:0}}),{agentId:'T1'});
  for(let i=2;i<=4;i++){
   const id='T'+i,config=join(dir,id+'.json');
   writeFileSync(config,JSON.stringify({agentId:id,sharedToken:hub.config.peers[id].token,
     hubUrl:url,providersDir:join(dir,'empty'),agentHttpPort:0,agentUdpPort:0,flushIntervalMs:30}));
   const a=new Agent(config);await a.start();
   a.push(obs('ENTITY_STATE','SELF','fake',{position:{x:10*i,y:i}}));
   a.push(obs('SUPPLY_STATE','SELF','fake',{supplies:{ammo:5*i}}));agents.push(a);
  }
  await sleep(500);const world=hub.fusion.worldState();
  assert.equal(world.self.id,'T1');
  for(let i=2;i<=4;i++){
   assert.equal(world.teammates['T'+i].position.x,10*i);
   assert.equal(world.teammates['T'+i].state.supplies.ammo,5*i);
   assert.equal(agents[i-2].pending.size,0);
  }
  assert.equal(hub.pairStatus().filter(s=>s.online).length,3);
 }finally{for(const a of agents)a.stop();hub.stop();rmSync(dir,{recursive:true,force:true});}
});
