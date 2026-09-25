import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Hub} from '../src/hub.js';
import {Agent} from '../src/agent.js';
test('three Agent stress: 20Hz streams plus critical events survive short outage', {timeout:45000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tdf-stress-'));mkdirSync(join(dir,'empty'));
 const cfg=join(dir,'hub.json');writeFileSync(cfg,JSON.stringify({hubHttpPort:0,ingestPort:0,discoveryPort:0,viewerId:'T1'}));
 const hub=new Hub(cfg);const agents=[];
 try{
  await hub.start();const url='http://127.0.0.1:'+hub.ingestServer.address().port;
  for(let i=2;i<=4;i++){
   const id='T'+i,file=join(dir,id+'.json');
   writeFileSync(file,JSON.stringify({agentId:id,sharedToken:hub.config.peers[id].token,
      hubUrl:url,providersDir:join(dir,'empty'),agentHttpPort:0,agentUdpPort:0,flushIntervalMs:50}));
   const a=new Agent(file);await a.start();agents.push(a);
  }
  const start=Date.now();let n=0;
  while(Date.now()-start<6000){
   for(let i=0;i<3;i++){
    const a=agents[i];
    a.push({type:'ENTITY_STATE',subject:{kind:'SELF'},source:'TEAM_SELF_REPORT',
      position:{x:n+i*100,y:i},observed_at:Date.now()});
    if(n%20===0)a.push({type:'SUPPLY_STATE',subject:{kind:'SELF'},source:'TEAM_SELF_REPORT',
      supplies:{ammo:Math.max(0,100-n%101),medkits:2}});
   }
   if(n===40)for(const a of agents)a.hubClient.hubUrl='http://127.0.0.1:1';
   if(n===80)for(const a of agents)a.hubClient.hubUrl=url;
   n++;await sleep(50);
  }
  await sleep(1000);
  for(const a of agents){
   assert.equal(a.pending.size,0,'critical events must be acknowledged after recovery');
   assert.equal(a.dropped,0);
  }
  const peers=hub.pairStatus();assert.equal(peers.filter(x=>x.online).length,3);
  const world=hub.fusion.worldState();
  for(let i=2;i<=4;i++)assert.ok(world.teammates['T'+i]?.position);
  assert.ok(n>=80);
 }finally{for(const a of agents)a.stop();hub.stop();rmSync(dir,{recursive:true,force:true});}
});
