// 融合 + 航迹引擎（对应《开发方案》Batch 2，第四/五/十一/十二/十三节）。
// 职责：去重、时间对齐、实体关联、证据融合、航迹生命周期、置信度/不确定度衰减。
// 输出统一 WorldState。

import { normalize, SUBJECT_KINDS } from '../core/observation.js';
import { wallMs, monotonicMs } from '../core/clock.js';
import { logger } from '../util.js';

// ---- 航迹（Track） ----
class Track {
  constructor(id, kind, obs, nowMs) {
    this.id = id;
    this.kind = kind;
    this.position = obs.position ? { ...obs.position } : null;
    this.velocity = { vx: 0, vy: 0, vz: 0 };
    this.heading = obs.heading ?? null;
    this.sigma = 6.0; // 不确定度半径（米）
    this.confidence = obs.confidence ?? 0.5;
    this.sources = new Set([obs.source]);
    this.observers = new Set(obs.observer_id ? [obs.observer_id] : []);
    this.createdAt = nowMs;
    this.lastSeen = nowMs;
    this.lastUpdate = nowMs;
    this.evidence = [];
    this.state = {}; // 稀疏状态（hp/equipment/supplies）
  }

  // 预测到当前时刻：位置按速度外推，不确定度增长（《方案》§12 σ(t)=σ0+k·Δt）
  predict(nowMs) {
    const dt = (nowMs - this.lastUpdate) / 1000;
    if (this.position) {
      this.position.x += this.velocity.vx * dt;
      this.position.y += this.velocity.vy * dt;
      this.position.z += this.velocity.vz * dt;
    }
    this.sigma += 0.8 * dt; // 不确定度随时间增长
  }

  // Alpha-Beta 滤波更新（《方案》§13 第一版先做稳）
  update(obs, nowMs) {
    const dt = Math.max((nowMs - this.lastUpdate) / 1000, 0.001);
    const alpha = 0.6;
    const beta = 0.2;

    if (obs.position && this.position) {
      const px = obs.position.x - this.position.x;
      const py = obs.position.y - this.position.y;
      const pz = (obs.position.z ?? this.position.z ?? 0) - (this.position.z ?? 0);
      const estVx = dt > 0 ? px / dt : 0;
      const estVy = dt > 0 ? py / dt : 0;
      this.position.x += alpha * px;
      this.position.y += alpha * py;
      this.position.z = (this.position.z ?? 0) + alpha * pz;
      this.velocity.vx += beta * (estVx - this.velocity.vx);
      this.velocity.vy += beta * (estVy - this.velocity.vy);
      this.sigma = Math.max(1.5, this.sigma * 0.6); // 有新观测 → 不确定度收缩
    }

    if (obs.heading !== undefined && obs.heading !== null) this.heading = obs.heading;

    // 证据融合：独立来源按 (1-∏(1-c)) 组合，同源取最大值
    if (obs.confidence !== undefined && obs.confidence !== null) {
      if (!this.sources.has(obs.source)) {
        this.confidence = 1 - (1 - this.confidence) * (1 - obs.confidence);
        this.sources.add(obs.source);
      } else {
        this.confidence = Math.max(this.confidence, obs.confidence);
      }
    }
    if (obs.observer_id) this.observers.add(obs.observer_id);

    this.state = mergeState(this.state, obs);
    this.evidence.push({ source: obs.source, at: nowMs });
    if (this.evidence.length > 32) this.evidence.shift();
    this.lastSeen = nowMs;
    this.lastUpdate = nowMs;
  }

  get sourceDiversity() {
    return this.sources.size;
  }

  stale(nowMs, ttlMs) {
    return nowMs - this.lastSeen > ttlMs;
  }
}

function mergeState(base, obs) {
  const out = { ...base };
  if (obs.hp !== undefined) out.hp = obs.hp;
  if (obs.max_hp !== undefined) out.max_hp = obs.max_hp;
  if (obs.equipment) out.equipment = { ...(out.equipment || {}), ...obs.equipment };
  if (obs.supplies) out.supplies = { ...(out.supplies || {}), ...obs.supplies };
  if (obs.bearing !== undefined) out.bearing = obs.bearing;
  if (obs.distance_estimate !== undefined) out.distance_estimate = obs.distance_estimate;
  return out;
}

// ---- 融合引擎 ----
export class FusionEngine {
  constructor({ selfId = 'T1', gateFactor = 2.5, enemyTtlMs = 15000 } = {}) {
    this.selfId = selfId;
    this.gateFactor = gateFactor;
    this.enemyTtlMs = enemyTtlMs;
    this.tracks = new Map(); // id -> Track
    this.seenObsIds = new Set();
    this.selfState = { id: selfId, kind: 'SELF' };
    this.lastDecay = monotonicMs();
  }

  // 入口：处理一条原始 Observation
  ingest(raw) {
    let obs;
    try {
      obs = normalize(raw);
    } catch (e) {
      logger.warn('fusion', `丢弃非法 observation: ${e.message}`);
      return;
    }
    // 去重
    if (obs.observation_id && this.seenObsIds.has(obs.observation_id)) return;
    if (obs.observation_id) {
      this.seenObsIds.add(obs.observation_id);
      if (this.seenObsIds.size > 10000) this.seenObsIds.clear();
    }

    const nowMs = wallMs();
    this._decay(nowMs);

    const kind = obs.subject && obs.subject.kind;
    if (kind === 'SELF') {
      this._updateSelf(obs, nowMs);
    } else if (kind === 'TEAMMATE') {
      this._updateTrack(obs.subject.id, 'TEAMMATE', obs, nowMs);
    } else if (kind === 'OBSERVED_ENEMY' || kind === 'PREDICTED_ENEMY') {
      this._updateEnemy(obs, kind, nowMs);
    }
    // 其它类型（ACCOUNT 等）由上层单独处理，不影响世界状态
  }

  _updateSelf(obs, nowMs) {
    this.selfState = mergeState(this.selfState, obs);
    if (obs.position) this.selfState.position = { ...obs.position };
    if (obs.heading !== undefined && obs.heading !== null) this.selfState.heading = obs.heading;
    this.selfState.source = obs.source;
  }

  _updateTrack(id, kind, obs, nowMs) {
    let t = this.tracks.get(id);
    if (!t) {
      t = new Track(id, kind, obs, nowMs);
      this.tracks.set(id, t);
    } else {
      t.update(obs, nowMs);
    }
  }

  _updateEnemy(obs, kind, nowMs) {
    const pos = resolveEnemyPosition(obs, this._observerPosition(obs));
    if (!pos) return; // 无法定位的敌情（如仅 sector），暂不建航迹

    // 关联到已有敌航迹
    const existing = this._associateEnemy(pos, nowMs);
    if (existing) {
      existing.update({ ...obs, position: pos }, nowMs);
      return;
    }
    const id = obs.subject && obs.subject.id ? obs.subject.id : `E-${Math.floor(nowMs)}-${Math.floor(Math.random() * 1000)}`;
    const t = new Track(id, kind, { ...obs, position: pos }, nowMs);
    this.tracks.set(id, t);
  }

  _observerPosition(obs) {
    const oid = obs.observer_id;
    if (oid && oid !== this.selfId) {
      const t = this.tracks.get(oid);
      if (t && t.position) return { position: t.position, heading: t.heading };
    }
    const sp = this.selfState.position;
    return { position: sp, heading: this.selfState.heading };
  }

  // 关联评分：Score = w_d·d + w_t·Δt（《方案》§13 的简化版，Mahalanobis 门控）
  _associateEnemy(pos, nowMs) {
    let best = null;
    let bestScore = Infinity;
    for (const t of this.tracks.values()) {
      if (t.kind !== 'OBSERVED_ENEMY' && t.kind !== 'PREDICTED_ENEMY') continue;
      if (!t.position) continue;
      const d = Math.hypot(t.position.x - pos.x, t.position.y - pos.y);
      const dtSec = (nowMs - t.lastSeen) / 1000;
      // 门控：距离须在不确定度允许范围内
      if (d > this.gateFactor * Math.max(t.sigma, 3)) continue;
      const score = d + 0.5 * dtSec * 5;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  // 周期性衰减（置信度下降、不确定度增长、超时航迹清除）
  _decay(nowMs) {
    for (const t of this.tracks.values()) {
      t.predict(nowMs);
      if (t.kind === 'OBSERVED_ENEMY' || t.kind === 'PREDICTED_ENEMY') {
        if (t.stale(nowMs, this.enemyTtlMs)) {
          this.tracks.delete(t.id);
        }
      }
    }
  }

  decayNow() {
    this._decay(wallMs());
  }

  // 组装世界状态
  worldState() {
    const nowMs = wallMs();
    const teammates = {};
    const enemies = [];
    for (const t of this.tracks.values()) {
      const rec = {
        id: t.id,
        kind: t.kind,
        position: t.position,
        heading: t.heading,
        velocity: t.velocity,
        sigma: Math.round(t.sigma * 10) / 10,
        confidence: Math.round(t.confidence * 100) / 100,
        source: [...t.sources],
        source_diversity: t.sourceDiversity,
        observers: [...t.observers],
        last_seen: t.lastSeen,
        age_ms: nowMs - t.lastSeen,
        state: t.state,
      };
      if (t.kind === 'TEAMMATE') teammates[t.id] = rec;
      else enemies.push(rec);
    }
    return {
      self: { ...this.selfState },
      teammates,
      enemies,
      updated_at: nowMs,
    };
  }
}

// 把敌情 Observation 解析为世界坐标位置
function resolveEnemyPosition(obs, observer) {
  // 1) 直接带位置（ENTITY_STATE）
  if (obs.position && obs.position.x !== undefined && obs.position.y !== undefined) {
    return { x: obs.position.x, y: obs.position.y, z: obs.position.z ?? 0, floor: obs.position.floor };
  }
  // 2) 方位 + 距离（CONTACT / AUDIO_CONTACT），相对观察者朝向
  const bearing = obs.bearing;
  const dist = obs.distance_estimate;
  if (bearing !== undefined && observer && observer.position) {
    const heading = observer.heading ?? 0;
    const worldBearing = ((heading + bearing) * Math.PI) / 180;
    const d = dist ?? 20;
    return {
      x: observer.position.x + Math.cos(worldBearing) * d,
      y: observer.position.y + Math.sin(worldBearing) * d,
      z: observer.position.z ?? 0,
    };
  }
  return null;
}
