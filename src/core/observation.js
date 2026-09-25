// Observation 数据模型 —— 全系统的统一数据单元。
// 对应《开发方案》第四节 + 《原理》第七/八节：所有字段带 provenance，位置/装备/补给稀疏更新。

import { genId } from '../util.js';
import { wallMs } from './clock.js';

// ---- 枚举定义（与设计文档一致） ----

export const SOURCES = Object.freeze([
  'OFFICIAL_API',
  'AUTHORIZED_SDK',
  'TEAM_SELF_REPORT',
  'MANUAL',
  'VOICE',
  'VISIBLE_UI',
  'AUDIO',
  'TEAM_REPORT',
  'INFERRED',
  'UNKNOWN',
]);

export const SUBJECT_KINDS = Object.freeze([
  'SELF',
  'TEAMMATE',
  'OBSERVED_ENEMY',
  'PREDICTED_ENEMY',
]);

export const TYPES = Object.freeze([
  'ENTITY_STATE',   // 位置/朝向/姿态
  'LOADOUT_STATE',  // 装备
  'SUPPLY_STATE',   // 补给
  'CONTACT',        // 敌人接触（方位+距离）
  'ENEMY_REPORT',   // 手动报点（扇区/数量）
  'AUDIO_CONTACT',  // 声学事件（脚步/枪声）
  'STATUS',         // 血/甲/弹/药 状态
  'PLAYER_REPORT',  // 队友自报/声明
  'ACCOUNT',        // 账号/历史慢元数据
]);

const NUMERIC_KEYS = ['confidence', 'x', 'y', 'z', 'floor', 'heading', 'bearing', 'distance_estimate', 'count', 'hp', 'max_hp', 'armor_durability', 'armor_max', 'ammo', 'medkits', 'armor_repair', 'grenades', 'smoke', 'velocity', 'stance'];

function coerceNumbers(obj) {
  for (const k of NUMERIC_KEYS) {
    if (obj[k] !== undefined && obj[k] !== null) {
      const n = Number(obj[k]);
      if (!Number.isNaN(n)) obj[k] = n;
    }
  }
  for (const sub of ['position', 'equipment', 'supplies']) {
    if (obj[sub] && typeof obj[sub] === 'object') coerceNumbers(obj[sub]);
  }
  return obj;
}

function clampConfidence(c) {
  if (c === undefined || c === null) return null;
  const n = Number(c);
  if (Number.isNaN(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * 把任意上游数据标准化为统一的 Observation。
 * 缺失的 provenance 会补齐，但 source 不会伪造（默认 UNKNOWN）。
 */
export function normalize(raw) {
  const o = coerceNumbers(typeof raw === 'object' && raw ? { ...raw } : {});
  if (!o.type || !TYPES.includes(o.type)) {
    throw new Error(`未知 Observation 类型: ${o.type}`);
  }
  if (o.source && !SOURCES.includes(o.source)) {
    throw new Error(`未知 source: ${o.source}`);
  }
  const subject = o.subject && typeof o.subject === 'object' ? o.subject : {};
  if (!subject.kind) subject.kind = 'SELF';
  if (!SUBJECT_KINDS.includes(subject.kind)) {
    throw new Error(`未知 subject.kind: ${subject.kind}`);
  }
  o.subject = subject;
  o.observation_id = o.observation_id || genId('obs');
  o.source = o.source || 'UNKNOWN';
  o.observed_at = o.observed_at || o.timestamp_wall_ms || wallMs();
  o.confidence = clampConfidence(o.confidence ?? 1.0);
  return o;
}

/**
 * 稀疏合并：把一次新的 observation 合并进现有状态对象，不清空旧值。
 * 位置帧不带装备、装备帧不带位置时，旧值保留。
 */
export function mergeSparse(base, inc) {
  const out = { ...base };
  for (const k of Object.keys(inc)) {
    if (inc[k] === undefined || inc[k] === null) continue;
    if (typeof inc[k] === 'object' && !Array.isArray(inc[k])) {
      out[k] = mergeSparse(out[k] || {}, inc[k]);
    } else {
      out[k] = inc[k];
    }
  }
  return out;
}

export const SUPPORT = Object.freeze({
  SELF_POSITION: 'SELF_POSITION',
  SELF_HEADING: 'SELF_HEADING',
  SELF_HEALTH: 'SELF_HEALTH',
  SELF_EQUIPMENT: 'SELF_EQUIPMENT',
  SELF_SUPPLIES: 'SELF_SUPPLIES',
  TEAMMATE_POSITION: 'TEAMMATE_POSITION',
  ENEMY_CONTACT: 'ENEMY_CONTACT',
  AUDIO_EVENT: 'AUDIO_EVENT',
  ACCOUNT_INFO: 'ACCOUNT_INFO',
});
