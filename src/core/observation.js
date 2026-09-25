// Unified, source-aware Observation. Missing is not equivalent to zero.
import { genId } from '../util.js';
export const SOURCES = Object.freeze(['OFFICIAL_API','COMMUNITY_API','AUTHORIZED_SDK','TEAM_SELF_REPORT','MANUAL','VOICE','VISIBLE_UI','AUDIO','TEAM_REPORT','INFERRED','UNKNOWN']);
export const SUBJECT_KINDS = Object.freeze(['SELF','TEAMMATE','OBSERVED_ENEMY','PREDICTED_ENEMY']);
export const TYPES = Object.freeze(['ENTITY_STATE','LOADOUT_STATE','SUPPLY_STATE','CONTACT','ENEMY_REPORT','AUDIO_CONTACT','STATUS','PLAYER_REPORT','ACCOUNT']);
export const SUPPORT = Object.freeze({SELF_POSITION:'SELF_POSITION',SELF_HEADING:'SELF_HEADING',SELF_HEALTH:'SELF_HEALTH',SELF_EQUIPMENT:'SELF_EQUIPMENT',SELF_SUPPLIES:'SELF_SUPPLIES',TEAMMATE_POSITION:'TEAMMATE_POSITION',ENEMY_CONTACT:'ENEMY_CONTACT',AUDIO_EVENT:'AUDIO_EVENT',ACCOUNT_INFO:'ACCOUNT_INFO'});
const NUMERIC = new Set(['confidence','x','y','z','floor','heading','bearing','distance_estimate','count','hp','max_hp','armor_durability','armor_max','ammo','medkits','armor_repair','grenades','smoke','velocity','stance','armorDurability','armorMax']);
function normalizeNumbers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const output = {...value};
  for (const [key, item] of Object.entries(output)) {
    if (NUMERIC.has(key) && item !== null && item !== undefined) {
      if (typeof item === 'boolean' || String(item).trim() === '' || !Number.isFinite(Number(item))) throw new Error('invalid numeric field: '+key);
      output[key] = Number(item);
    } else if (item && typeof item === 'object' && !Array.isArray(item) && ['position','equipment','supplies'].includes(key)) {
      output[key] = normalizeNumbers(item);
    }
  }
  return output;
}
export function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('observation must be an object');
  const o = normalizeNumbers(raw);
  if (!TYPES.includes(o.type)) throw new Error('unknown observation type');
  if (o.source && !SOURCES.includes(o.source)) throw new Error('unrecognized provenance');
  o.source = o.source || 'UNKNOWN';
  o.subject = o.subject && typeof o.subject === 'object' ? {...o.subject} : {kind:'SELF'};
  o.subject.kind = o.subject.kind || 'SELF';
  if (!SUBJECT_KINDS.includes(o.subject.kind)) throw new Error('invalid subject kind');
  if (o.position && (!Number.isFinite(o.position.x) || !Number.isFinite(o.position.y))) throw new Error('invalid position');
  if (o.distance_estimate !== undefined && o.distance_estimate < 0) throw new Error('negative distance');
  if (o.confidence !== undefined && (o.confidence < 0 || o.confidence > 1)) throw new Error('confidence out of range');
  o.confidence = o.confidence ?? (o.source === 'UNKNOWN' || o.source === 'INFERRED' ? .35 : .8);
  o.observation_id = String(o.observation_id || genId('obs')).slice(0,128);
  o.observed_at = o.observed_at || o.timestamp_wall_ms || Date.now();
  if (!Number.isFinite(o.observed_at) || o.observed_at > Date.now()+30000) throw new Error('invalid observed_at');
  return o;
}
export function mergeSparse(base={}, incoming={}) {
  const out = {...base};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'object' && !Array.isArray(value) ? mergeSparse(out[key] || {}, value) : value;
  }
  return out;
}
