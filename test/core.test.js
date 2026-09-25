import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {FusionEngine} from '../src/fusion/engine.js';
import {Agent} from '../src/agent.js';
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
