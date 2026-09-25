import {SUPPORT} from '../core/observation.js';
export const ABI_VERSION=1;
export const encodeMsg=o=>JSON.stringify(o)+'\n';
export function decodeLine(s){if(typeof s!=='string'||s.length>262144)return null;try{return JSON.parse(s.trim());}catch{return null;}}
export function parseHello(m){
 if(!m||m.type!=='hello')return {error:'missing hello'};
 if(Number(m.abi)!==ABI_VERSION)return {error:'ABI mismatch'};
 if(!Array.isArray(m.capabilities)||m.capabilities.some(c=>!Object.values(SUPPORT).includes(c)))return {error:'invalid capabilities'};
 if(!Number.isFinite(m.max_rate_hz)||m.max_rate_hz<=0||m.max_rate_hz>1000)return {error:'invalid rate'};
 return {abi:ABI_VERSION,provider:String(m.provider||'unknown').slice(0,80),capabilities:m.capabilities,max_rate_hz:m.max_rate_hz};
}
export function observationCapability(o){
 if(!o||typeof o!=='object')return null;
 if(o.type==='ACCOUNT')return 'ACCOUNT_INFO';
 if(o.type==='AUDIO_CONTACT')return 'AUDIO_EVENT';
 if(o.type==='ENEMY_REPORT'||o.type==='CONTACT'||['OBSERVED_ENEMY','PREDICTED_ENEMY'].includes(o.subject?.kind))return 'ENEMY_CONTACT';
 if(o.type==='LOADOUT_STATE')return 'SELF_EQUIPMENT';
 if(o.type==='SUPPLY_STATE')return 'SELF_SUPPLIES';
 if(o.type==='STATUS')return o.ammo!==undefined||o.medkits!==undefined?'SELF_SUPPLIES':'SELF_HEALTH';
 if(o.type==='ENTITY_STATE')return o.position?'SELF_POSITION':o.hp!==undefined?'SELF_HEALTH':'SELF_HEADING';
 return null;
}
