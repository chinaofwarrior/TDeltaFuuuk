// LAN discovery intentionally never includes an authentication secret.
import dgram from 'node:dgram';
import {logger} from '../util.js';
export const PORTS={HUB_HTTP:17888,HUB_INGEST:17889,DISCOVERY:17892,AGENT_UDP:17890,AGENT_HTTP:17891};
export const DISCOVER_MAGIC='TDF-DISCOVER-v2';
export class DiscoveryServer {
  constructor({ingestPort=PORTS.HUB_INGEST,name='TDeltaFuuuk',port=PORTS.DISCOVERY}={}){
    this.ingestPort=ingestPort;this.name=name;this.port=port;this.sock=null;
  }
  start(){
    return new Promise((resolve,reject)=>{
      const s=dgram.createSocket('udp4');this.sock=s;
      s.once('error',reject);
      s.on('message',(msg,peer)=>{
        if(msg.toString()!==DISCOVER_MAGIC)return;
        const answer=JSON.stringify({magic:DISCOVER_MAGIC,name:this.name,ingest_port:this.ingestPort});
        s.send(answer,peer.port,peer.address);
      });
      s.bind(this.port,'0.0.0.0',()=>{s.setBroadcast(true);resolve();});
    });
  }
  stop(){if(this.sock){this.sock.close();this.sock=null;}}
}
export class DiscoveryClient {
  constructor({port=PORTS.DISCOVERY,timeoutMs=1300}={}){this.port=port;this.timeoutMs=timeoutMs;}
  findHub(){
    return new Promise(resolve=>{
      const s=dgram.createSocket('udp4');let done=false;
      const finish=value=>{if(done)return;done=true;clearTimeout(timer);s.close();resolve(value);};
      const timer=setTimeout(()=>finish(null),this.timeoutMs);
      s.on('error',()=>finish(null));
      s.on('message',(msg,peer)=>{
        try{const m=JSON.parse(msg);
          if(m.magic===DISCOVER_MAGIC && Number.isInteger(m.ingest_port)){
            finish({hub_ip:peer.address,ingest_port:m.ingest_port,name:m.name});
          }
        }catch{}
      });
      s.bind(0,()=>{try{s.setBroadcast(true);s.send(DISCOVER_MAGIC,this.port,'255.255.255.255');}catch{finish(null);}});
    });
  }
}
export class UdpIngestServer {
  constructor({port=PORTS.AGENT_UDP,onData}={}){this.port=port;this.onData=onData||(()=>{});this.sock=null;}
  start(){return new Promise((resolve,reject)=>{
    const s=dgram.createSocket('udp4');this.sock=s;s.once('error',reject);
    s.on('message',b=>{if(b.length>16384)return;try{this.onData(JSON.parse(b.toString()));}catch{}});
    s.bind(this.port,'127.0.0.1',resolve);
  });}
  stop(){this.sock?.close();this.sock=null;}
}
export class HubClient {
  constructor({hubUrl='',token='',agentId='',onState=()=>{}}={}){
    this.hubUrl=hubUrl.replace(/\/$/,'');this.token=token;this.agentId=agentId;
    this.onState=onState;this.connected=false;this.clockSync=null;
  }
  async sendObservations(observations){
    if(!this.hubUrl || !this.token)return {ok:false,ack_ids:[]};
    try{
      const r=await fetch(this.hubUrl+'/ingest',{method:'POST',
        headers:{'content-type':'application/json','authorization':'Bearer '+this.token},
        body:JSON.stringify({agent_id:this.agentId,observations}),
        signal:AbortSignal.timeout(2500)});
      const body=await r.json().catch(()=>({}));
      this.setConnected(r.ok);
      return {ok:r.ok,ack_ids:Array.isArray(body.ack_ids)?body.ack_ids:[],rejected_ids:Array.isArray(body.rejected_ids)?body.rejected_ids:[]};
    }catch(e){this.setConnected(false);return {ok:false,ack_ids:[]};}
  }
  async syncClock(){
    if(!this.hubUrl || !this.clockSync)return;
    const t1=Date.now();try{
      const r=await fetch(this.hubUrl+'/time',{headers:{authorization:'Bearer '+this.token},signal:AbortSignal.timeout(1000)});
      if(!r.ok)return;
      const remote=await r.json();
      this.clockSync.record(t1,remote.now_ms,Date.now());
    }catch{}
  }
  setConnected(v){if(this.connected!==v){this.connected=v;this.onState(v?'connected':'disconnected');logger.info('net','Hub '+(v?'已连接':'已断开'));}}
}
