import { EventBus } from './EventBus';
import { ConveyorSystem } from './systems/ConveyorSystem';
import { PropSystem } from './systems/PropSystem';
import { ApprovalSystem } from './systems/ApprovalSystem';
import { AIActorSystem } from './systems/AIActorSystem';
import { LevelSystem } from './systems/LevelSystem';
import { HighlightSystem } from './systems/HighlightSystem';
import type { RunStats } from './systems/LevelSystem';
import { BalanceConfig, PropsConfig, DefaultLevel } from './config';
import { phaseFor } from './config';
import { defaultRng } from './rng';
import type { Rng } from './rng';
import type { LevelDef } from './config';
import type { LevelObjectiveKind } from './config';
import type { ApprovalZone, CardCategory, GamePhase, GameResult, HitQuality, PropType } from './types';
import { PropType as PT } from './types';

export interface ObjectiveSnapshot {
  kind: LevelObjectiveKind;
  label: string;
  current: number;
  target: number;
  mode: 'count' | 'guard' | 'hunt';
  complete: boolean;
  prop?: PropType;
}

export interface FailureCoach {
  reason: 'unhandled-task' | 'boss-inspection' | 'unknown';
  title: string;
  advice: string;
  impact: number;
  affected: number;
}

export interface ThreatForecast {
  steps: number;
  delta: number;
  projectedApproval: number;
  bossInSteps: boolean;
  label: string;
}

export interface TargetRecommendation {
  slot: number;
  benefit: number;
  affected: number;
  label: string;
}

/**
 * 游戏总装（核心规则层入口，对应开发计划§2 架构 + §3 Game 编排）。
 *
 * 职责：
 *  - 创建各系统并完成事件接线（系统间通过 EventBus 解耦，跨系统协调集中在此）。
 *  - tick(dt) 驱动主循环：道具扫描、AI表情、（冻结期外）认可度计时、挡位左移、白卡生成、Boss生成。
 *  - 输入 API：beginCharge/release/releaseAtSlot/cancel/useKissUp（Cocos 输入层调用）。
 *  - 拍马屁冻结编排：暂停 belt+approval，到期恢复。
 *  - CardHit → Conveyor 变更（插入/污染/清空）。
 *  - 统计峰值/用时/Boss临检次数 → 结算星级。
 *
 * 确定性：注入 Rng 即可复现整局（M0 回归比对的基础）。
 */
export class Game {
  readonly bus = new EventBus();
  readonly conveyor: ConveyorSystem;
  readonly approval: ApprovalSystem;
  readonly prop: PropSystem;
  readonly ai: AIActorSystem;
  readonly highlights: HighlightSystem;
  readonly level: LevelSystem;
  private readonly cfg = BalanceConfig;

  elapsed = 0;
  peakApproval: number;
  bossInspectionsFired = 0;
  result: GameResult = 'ongoing';
  stars = 0;
  maxCombo = 0;
  effectiveHits = 0;
  perfectHits = 0;
  missedThrows = 0;
  readonly propHits: Partial<Record<PropType, number>> = {};
  /** 失败的直接来源，供结算归因与数据分析；通关时保持 null。 */
  lastFailReason: 'unhandled-task' | 'boss-inspection' | null = null;
  private lastFailImpact = 0;
  private lastFailAffected = 0;
  private lastFailCardCategory: CardCategory | null = null;
  /** §2.1 是否使用过复活（每关限1次，RunReport 采集）。 */
  revived = false;
  /** §2.1 复活后额外时长（秒）。 */
  private bonusDuration = 0;

  private shiftAcc = 0;
  private genAcc = 0;
  private freezeRemaining = 0;
  private bossScheduleIndex = 0;
  private bossWarningMask = 0;
  /** 危险区内只提醒一次，必须先脱离危险区才能重新武装。 */
  private lastChanceEpisodeWarned = false;
  private lastChanceImminent = false;
  private objectiveCompletedEmitted = false;
  private rng: Rng;

  constructor(level: LevelDef = DefaultLevel, rng: Rng = defaultRng, allowedProps?: PropType[]) {
    this.rng = rng;
    this.conveyor = new ConveyorSystem(BalanceConfig, level, this.bus, rng);
    this.approval = new ApprovalSystem(BalanceConfig, this.bus, level.approvalInit);
    this.prop = new PropSystem(BalanceConfig, this.bus, rng, this.conveyor, level.slots, allowedProps);
    this.ai = new AIActorSystem(this.bus, BalanceConfig);
    this.highlights = new HighlightSystem(this.bus);
    this.level = new LevelSystem(BalanceConfig, level);
    this.peakApproval = level.approvalInit;

    // —— 事件接线 ——
    this.bus.on('CardEnteredProcessing', ({ card }) => {
      const impact = this.approval.resolveCard(card);
      if (this.result === 'lose') {
        this.lastFailReason = 'unhandled-task';
        this.lastFailImpact = Math.max(0, impact);
        this.lastFailAffected = 1;
        this.lastFailCardCategory = card.category;
      }
    });
    this.bus.on('BossInspection', ({ threatCards, totalThreats, patternLabel }) => {
      this.bossInspectionsFired++;
      const riskAdded = this.approval.bossSettle(threatCards);
      this.bus.emit('BossInspectionResolved', {
        checked: threatCards.length,
        remaining: Math.max(0, (totalThreats ?? threatCards.length) - threatCards.length),
        riskAdded,
        patternLabel: patternLabel ?? this.level.def.boss.patternLabel ?? '临检扫描',
      });
      if (this.result === 'lose') {
        this.lastFailReason = 'boss-inspection';
        this.lastFailImpact = riskAdded;
        this.lastFailAffected = threatCards.length;
        this.lastFailCardCategory = null;
      }
    });
    this.bus.on('BossSpawned', () => this.prop.onBossSpawned());
    this.bus.on('KissUpFreeze', ({ durationSec }) => this.applyFreeze(durationSec));
    // §4.2 道具生效：CardHit → Conveyor 变更
    this.bus.on('CardHit', ({ prop, slot, quality }) => {
      const effect = this.applyPropEffect(prop, slot);
      this.effectiveHits++;
      this.propHits[prop] = (this.propHits[prop] ?? 0) + 1;
      if (quality === 'perfect') this.perfectHits++;
      this.bus.emit('PropEffectResolved', { prop, slot, ...effect });
      this.maybeEmitObjectiveCompleted();
    });
    this.bus.on('AIHit', () => {
      this.propHits[PT.KissUp] = (this.propHits[PT.KissUp] ?? 0) + 1;
      this.maybeEmitObjectiveCompleted();
    });
    this.bus.on('PropUnavailable', () => {
      this.missedThrows++;
    });
    this.bus.on('ApprovalChanged', ({ to }) => {
      if (to > this.peakApproval) this.peakApproval = to;
    });
    this.bus.on('ComboUpdated', ({ combo }) => {
      if (combo > this.maxCombo) this.maxCombo = combo;
      this.maybeEmitObjectiveCompleted();
    });
    this.bus.on('GameOver', ({ result }) => {
      this.result = result;
      this.finish();
      this.maybeEmitObjectiveCompleted();
    });
  }

  get over(): boolean {
    return this.result !== 'ongoing';
  }
  get isFrozen(): boolean {
    return this.freezeRemaining > 0;
  }
  get phase(): GamePhase {
    return phaseFor(BalanceConfig, this.elapsed);
  }

  tick(dt: number): void {
    if (this.over) return;
    this.prop.tick(dt, this.phase);
    this.ai.tick(dt);
    this.highlights.tick(dt);

    if (this.freezeRemaining > 0) {
      this.freezeRemaining -= dt;
      if (this.freezeRemaining <= 0) {
        this.freezeRemaining = 0;
        this.conveyor.setFrozen(false);
        this.approval.setFrozen(false);
      }
      return; // §4.2 冻结期间 belt/approval/生成暂停
    }

    const phaseBefore = this.phase;
    this.elapsed += dt;
    this.approval.tick(dt);
    this.updateScheduledBossWarning();

    const phase = this.phase;
    if (phase !== phaseBefore) this.bus.emit('PhaseChanged', { from: phaseBefore, to: phase });
    const zone = this.approval.currentZone;
    const bonus = BalanceConfig.zones[zone].genBonus;
    const slotPeriod = BalanceConfig.phases[phase].slotPeriodSec;
    const genInterval = BalanceConfig.phases[phase].genIntervalSec / (1 + bonus);

    this.shiftAcc += dt;
    let guard = 0;
    while (this.shiftAcc >= slotPeriod && guard++ < 100) {
      this.shiftAcc -= slotPeriod;
      this.conveyor.step();
      if (this.over) return;
    }
    this.genAcc += dt;
    guard = 0;
    while (this.genAcc >= genInterval && guard++ < 100) {
      this.genAcc -= genInterval;
      const bossSpawn = this.bossSpawnReason(phase, zone);
      if (bossSpawn && !this.conveyor.hasBoss()) {
        this.conveyor.generate(phase, { forceBoss: true });
        // 入口可能正被普通卡占用；只有实际生成成功才消费本次固定节拍。
        if (bossSpawn === 'scheduled' && this.conveyor.hasBoss()) {
          this.bossScheduleIndex++;
          this.bossWarningMask = 0;
        }
      } else {
        const nextBossAt = this.level.def.boss.scheduleSec?.[this.bossScheduleIndex];
        const bossImminent = nextBossAt !== undefined && nextBossAt - this.elapsed <= 6;
        this.conveyor.generate(phase, { allowModifiers: zone !== 'danger' && !bossImminent });
      }
      if (this.over) return;
    }

    this.updateLastChanceWarning(slotPeriod);

    if (this.elapsed >= this.level.def.durationSec + this.bonusDuration && !this.over) {
      this.approval.declareSurviveOnTimeout();
    }
  }

  /* ---------- 输入 API（Cocos 输入层调用） ---------- */
  beginCharge(prop: PropType): boolean {
    return this.prop.beginCharge(prop);
  }
  release(prop: PropType): boolean {
    return this.prop.release(prop);
  }

  releaseAtSlot(prop: PropType, slot: number, quality?: HitQuality): boolean {
    return this.prop.releaseAtSlot(prop, slot, quality);
  }
  cancel(prop: PropType): void {
    this.prop.cancel(prop);
  }
  suspendCharge(): void {
    this.prop.suspendCharge();
  }
  useKissUp(): boolean {
    return this.prop.useKissUp();
  }

  /**
   * §2.1 复活：仅在 lose 状态下可用，每关限1次。
   * - 认可度回滚到危险区下限（69）
   * - 倒计时额外 +8 秒
   * - 清除场上 Boss 卡（防二次死亡）
   * - 标记 revived=true，结算时进入 RunReport
   * @returns 是否成功复活
   */
  revive(): boolean {
    if (this.result !== 'lose') return false;
    if (this.revived) return false; // 每关限1次
    this.revived = true;
    this.result = 'ongoing';
    this.lastFailReason = null;
    this.lastFailImpact = 0;
    this.lastFailAffected = 0;
    this.lastFailCardCategory = null;
    this.bonusDuration += 8;
    this.approval.revive(this.cfg.zones.danger.lo); // 危险区下限 69
    this.conveyor.clearBoss();
    this.lastChanceEpisodeWarned = false;
    this.lastChanceImminent = false;
    this.bus.emit('Revived', { approval: this.approval.value, bonusSec: 8 });
    return true;
  }

  /* ---------- 表现层快照 ---------- */
  getSnapshot() {
    const bossSchedule = this.level.def.boss.scheduleSec;
    const nextBossAt = bossSchedule?.[this.bossScheduleIndex];
    return {
      elapsed: this.elapsed,
      duration: this.level.def.durationSec + this.bonusDuration,
      approval: this.approval.value,
      zone: this.approval.currentZone,
      phase: this.phase,
      result: this.result,
      stars: this.stars,
      peakApproval: this.peakApproval,
      combo: this.prop.currentCombo,
      frozen: this.isFrozen,
      beltSize: this.conveyor.size,
      revived: this.revived,
      bonusDuration: this.bonusDuration,
      huntProgress: this.approval.huntProgress,
      huntThreshold: this.cfg.zones.hunt.hi,
      huntHoldSec: this.cfg.zones.hunt.holdSec ?? 0,
      bossActive: this.conveyor.hasBoss(),
      nextBossInSec: nextBossAt === undefined ? null : Math.max(0, nextBossAt - this.elapsed),
      lastChanceImminent: this.lastChanceImminent,
    };
  }

  getObjectiveSnapshot(): ObjectiveSnapshot | null {
    const objective = this.level.def.objective;
    if (!objective) return null;
    const target = Math.max(1, objective.target ?? 1);
    let current = 0;
    let mode: ObjectiveSnapshot['mode'] = 'count';
    switch (objective.kind) {
      case 'effective-hits': current = this.effectiveHits; break;
      case 'perfect': current = this.perfectHits; break;
      case 'combo': current = this.maxCombo; break;
      case 'use-prop': current = objective.prop ? (this.propHits[objective.prop] ?? 0) : 0; break;
      case 'hunt':
        mode = 'hunt';
        current = this.approval.huntProgress * (this.cfg.zones.hunt.holdSec ?? 2);
        break;
      case 'boss-safe':
        mode = 'guard';
        current = this.bossInspectionsFired;
        break;
      case 'no-miss':
        mode = 'guard';
        current = this.missedThrows;
        break;
    }
    const objectiveTarget = mode === 'hunt' ? (this.cfg.zones.hunt.holdSec ?? 2) : mode === 'guard' ? 0 : target;
    const complete = mode === 'guard'
      ? this.over && current === 0
      : objective.kind === 'hunt'
        ? this.result === 'win-hunt'
        : current >= objectiveTarget;
    return { kind: objective.kind, label: objective.label, current, target: objectiveTarget, mode, complete, prop: objective.prop };
  }

  getFailureCoach(): FailureCoach {
    if (this.lastFailReason === 'boss-inspection') {
      return {
        reason: 'boss-inspection',
        title: `临检一次结算 ${this.lastFailAffected} 张任务 · 风险 +${Math.round(this.lastFailImpact)}`,
        advice: '看到 6 秒预警就保留甩锅；先清高权重白卡，再用拍马屁争取出手时间。',
        impact: this.lastFailImpact,
        affected: this.lastFailAffected,
      };
    }
    if (this.lastFailReason === 'unhandled-task') {
      const task = this.cardCategoryLabel(this.lastFailCardCategory);
      return {
        reason: 'unhandled-task',
        title: `${task}任务漏进处理区 · 风险 +${Math.round(this.lastFailImpact)}`,
        advice: `下一局优先用“改需求”处理${task}任务；队列堆满三张时再用甩锅清场。`,
        impact: this.lastFailImpact,
        affected: 1,
      };
    }
    return {
      reason: 'unknown',
      title: '风险到达 100，岗位被 AI 接管',
      advice: '优先处理橙色、紫色和红色高权重任务，危险区至少保留一次甩锅。',
      impact: 0,
      affected: 0,
    };
  }

  /** 预估未来若干次传送带移动后的净风险；遇到 Boss 时复用真实抽查规则。 */
  getThreatForecast(steps = 3): ThreatForecast {
    const horizon = Math.max(1, Math.min(this.level.def.slots, Math.floor(steps)));
    const cards = this.conveyor.cards;
    const bossSlot = cards.findIndex((card, slot) => slot < horizon && card?.state === 'boss');
    let delta = 0;
    if (bossSlot >= 0) {
      for (let i = 0; i < bossSlot; i++) delta += this.cardForecastDelta(cards[i]);
      const threats = cards
        .slice(bossSlot + 1)
        .filter((card): card is NonNullable<typeof card> => card?.state === 'active-white')
        .sort((a, b) => b.weight - a.weight);
      const limit = this.level.def.boss.inspectionLimit;
      const inspected = limit === undefined ? threats : threats.slice(0, Math.max(0, limit));
      delta += inspected.reduce((sum, card) => sum + card.weight, 0);
    } else {
      for (let i = 0; i < horizon; i++) delta += this.cardForecastDelta(cards[i]);
    }
    const rounded = Math.round(delta);
    return {
      steps: horizon,
      delta,
      projectedApproval: Math.max(0, Math.min(100, this.approval.value + delta)),
      bossInSteps: bossSlot >= 0,
      label: bossSlot >= 0
        ? `临检预计 ${rounded >= 0 ? '+' : ''}${rounded}`
        : `${horizon}步 ${rounded >= 0 ? '+' : ''}${rounded}`,
    };
  }

  /** 给拖拽层提供同一套“最佳目标”判定，UI 不自行猜测权重或范围规则。 */
  getTargetRecommendation(prop: PropType): TargetRecommendation | null {
    if (prop === PT.KissUp) return null;
    const cards = this.conveyor.cards;
    if (prop === PT.ChangeDemand || prop === PT.AddDemand) {
      let bestSlot = -1;
      let bestBenefit = -1;
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        if (card?.state !== 'active-white') continue;
        const benefit = prop === PT.ChangeDemand
          ? (card.guard ?? 0) > 0
            ? Math.min(card.weight, this.level.def.taskModifiers?.eliteGuardReduction ?? 2)
            : card.weight * 2
          : card.weight;
        if (benefit > bestBenefit) {
          bestBenefit = benefit;
          bestSlot = i;
        }
      }
      if (bestSlot < 0) return prop === PT.AddDemand
        ? { slot: Math.max(0, cards.length - 1), benefit: 1, affected: 1, label: '补一个缓冲位' }
        : null;
      return prop === PT.ChangeDemand
        ? {
          slot: bestSlot,
          benefit: bestBenefit,
          affected: 1,
          label: (cards[bestSlot]?.guard ?? 0) > 0 ? `破盾 · 风险 -${bestBenefit}` : `风险摆幅 -${bestBenefit}`,
        }
        : { slot: bestSlot, benefit: bestBenefit, affected: 1, label: `延缓 +${bestBenefit} 高危任务` };
    }

    const radius = PropsConfig[PT.ThrowPot].clearRadius ?? 1;
    let best: TargetRecommendation | null = null;
    for (let slot = 0; slot < cards.length; slot++) {
      let benefit = 0;
      let affected = 0;
      let hasBoss = false;
      for (let i = Math.max(0, slot - radius); i <= Math.min(cards.length - 1, slot + radius); i++) {
        const card = cards[i];
        if (!card) continue;
        affected++;
        if (card.state === 'active-white') benefit += card.weight;
        if (card.state === 'boss') hasBoss = true;
      }
      const score = benefit + (hasBoss ? 100 : 0);
      const bestScore = best ? best.benefit + (best.label.includes('拦截临检') ? 100 : 0) : -1;
      if (affected > 0 && score > bestScore) {
        best = {
          slot,
          benefit,
          affected,
          label: hasBoss ? `拦截临检 · 连清 ${affected} 张` : `连清 ${affected} 张 · 挡住 ${benefit} 风险`,
        };
      }
    }
    return best;
  }

  /* ---------- 内部 ---------- */

  private applyPropEffect(prop: PropType, slot: number): { affected: number; riskPrevented: number; bufferedSlots: number } {
    if (prop === PT.AddDemand) {
      this.conveyor.insertGrayAt(slot);
      return { affected: 1, riskPrevented: 0, bufferedSlots: 1 };
    }
    if (prop === PT.ChangeDemand) {
      const result = this.conveyor.changeDemandAt(slot);
      return { affected: result.changed ? 1 : 0, riskPrevented: result.riskPrevented, bufferedSlots: 0 };
    }
    if (prop === PT.ThrowPot) {
      const radius = PropsConfig[PT.ThrowPot].clearRadius ?? 1;
      let riskPrevented = 0;
      for (let i = Math.max(0, slot - radius); i <= Math.min(this.level.def.slots - 1, slot + radius); i++) {
        const card = this.conveyor.slotAt(i);
        if (card?.state === 'active-white') riskPrevented += card.weight;
      }
      const affected = this.conveyor.clearRange(slot, radius);
      return { affected, riskPrevented, bufferedSlots: 0 };
    }
    return { affected: 0, riskPrevented: 0, bufferedSlots: 0 };
  }

  private cardCategoryLabel(category: CardCategory | null): string {
    if (category === 'urgent') return '紧急';
    if (category === 'proposal') return '提案';
    if (category === 'key') return '关键';
    if (category === 'report') return '汇报';
    return '常规';
  }

  private cardForecastDelta(card: ReturnType<ConveyorSystem['slotAt']>): number {
    if (!card) return 0;
    if (card.state === 'active-white') return card.weight;
    if (card.state === 'rework') return -card.weight;
    return 0;
  }

  private updateScheduledBossWarning(): void {
    const nextAt = this.level.def.boss.scheduleSec?.[this.bossScheduleIndex];
    if (nextAt === undefined || this.conveyor.hasBoss()) return;
    const remaining = nextAt - this.elapsed;
    if (remaining <= 6 && (this.bossWarningMask & 1) === 0) {
      this.bossWarningMask |= 1;
      this.bus.emit('BossBeatWarning', { seconds: 6 });
    }
    if (remaining <= 3 && (this.bossWarningMask & 2) === 0) {
      this.bossWarningMask |= 2;
      this.bus.emit('BossBeatWarning', { seconds: 3 });
    }
  }

  /**
   * 只读未来一格并发出演出事件，不改变认可度、传送带速度或失败规则。
   * 玩家离开危险区后才会再次获得提示，避免高压阶段连续刷屏。
   */
  private updateLastChanceWarning(slotPeriod: number): void {
    if (this.approval.currentZone !== 'danger') {
      this.lastChanceEpisodeWarned = false;
      this.lastChanceImminent = false;
      return;
    }
    const forecast = this.getThreatForecast(1);
    const imminent = forecast.delta > 0 && forecast.projectedApproval >= this.cfg.approval.max;
    this.lastChanceImminent = imminent;
    if (!imminent || this.lastChanceEpisodeWarned) return;

    const cards = this.conveyor.cards;
    const lead = cards[0];
    const boss = lead?.state === 'boss';
    let cardIds: number[] = lead ? [lead.id] : [];
    if (boss) {
      const threats = cards
        .slice(1)
        .filter((card): card is NonNullable<typeof card> => card?.state === 'active-white')
        .sort((a, b) => b.weight - a.weight);
      const limit = this.level.def.boss.inspectionLimit;
      const inspected = limit === undefined ? threats : threats.slice(0, Math.max(0, limit));
      cardIds = [lead!.id, ...inspected.map((card) => card.id)];
    }
    this.lastChanceEpisodeWarned = true;
    this.bus.emit('LastChanceWarning', {
      projectedApproval: forecast.projectedApproval,
      impact: forecast.delta,
      seconds: Math.max(0.1, Math.round((slotPeriod - this.shiftAcc) * 10) / 10),
      boss,
      cardIds,
    });
  }

  private maybeEmitObjectiveCompleted(): void {
    if (this.objectiveCompletedEmitted) return;
    const objective = this.getObjectiveSnapshot();
    if (!objective?.complete) return;
    this.objectiveCompletedEmitted = true;
    this.bus.emit('ObjectiveCompleted', { label: objective.label });
  }

  private applyFreeze(dur: number): void {
    this.freezeRemaining = Math.max(this.freezeRemaining, dur);
    this.conveyor.setFrozen(true);
    this.approval.setFrozen(true);
  }

  /**
   * Boss 优先服从关卡编排节拍，保证“临检关”真的出现且可练习；
   * 没配置节拍的旧关卡继续走认可度/阶段概率，保持向后兼容。
   */
  private bossSpawnReason(phase: GamePhase, zone: ApprovalZone): 'scheduled' | 'random' | null {
    if (!this.level.def.boss.enabled) return null;
    const schedule = this.level.def.boss.scheduleSec;
    if (schedule?.length) {
      const dueAt = schedule[this.bossScheduleIndex];
      return dueAt !== undefined && this.elapsed >= dueAt ? 'scheduled' : null;
    }
    if (this.elapsed < this.level.def.boss.minSpawnSec) return null;
    const sp = BalanceConfig.boss.spawnProb;
    const zoneP = zone === 'danger' ? sp.zone.danger : zone === 'ok' ? sp.zone.ok : 0;
    const phaseM = sp.phaseMul[phase];
    return this.rng.next() < zoneP * phaseM ? 'random' : null;
  }

  private finish(): void {
    const stats: RunStats = {
      peakApproval: this.peakApproval,
      timeUsedSec: this.elapsed,
      bossInspectionsFired: this.bossInspectionsFired,
      maxCombo: this.maxCombo,
      effectiveHits: this.effectiveHits,
      perfectHits: this.perfectHits,
      missedThrows: this.missedThrows,
      propHits: this.propHits,
    };
    this.stars = this.level.starRating(this.result, stats);
  }

  /** 生成 §3.3 战报（Game 结束后调用，给 PlayerProfile 累加 / UI 渲染用）。 */
  buildReport(levelIndex: number): import('./RunReport').RunReport {
    const def = this.level.def;
    return {
      result: this.result,
      stars: this.stars,
      levelIndex,
      levelId: def.id,
      levelTitle: def.title ?? def.id,
      peakApproval: this.peakApproval,
      finalApproval: this.approval.value,
      timeUsedSec: this.elapsed,
      durationSec: def.durationSec + this.bonusDuration,
      bossInspectionsFired: this.bossInspectionsFired,
      maxCombo: this.maxCombo,
      effectiveHits: this.effectiveHits,
      perfectHits: this.perfectHits,
      missedThrows: this.missedThrows,
      revived: this.revived,
      objectiveLabel: def.objective?.label,
      objectiveMet: this.level.objectiveMet(this.result, {
        peakApproval: this.peakApproval,
        timeUsedSec: this.elapsed,
        bossInspectionsFired: this.bossInspectionsFired,
        maxCombo: this.maxCombo,
        effectiveHits: this.effectiveHits,
        perfectHits: this.perfectHits,
        missedThrows: this.missedThrows,
        propHits: this.propHits,
      }),
      highlights: this.highlights.earned.map((moment) => moment.id),
      highlightTitle: this.highlights.best?.label,
    };
  }
}
