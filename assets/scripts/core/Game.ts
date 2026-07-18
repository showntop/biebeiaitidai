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
import type { ApprovalZone, GamePhase, GameResult, HitQuality, PropType } from './types';
import { PropType as PT } from './types';

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
  /** §2.1 是否使用过复活（每关限1次，RunReport 采集）。 */
  revived = false;
  /** §2.1 复活后额外时长（秒）。 */
  private bonusDuration = 0;

  private shiftAcc = 0;
  private genAcc = 0;
  private freezeRemaining = 0;
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
      this.approval.resolveCard(card);
      if (this.result === 'lose') this.lastFailReason = 'unhandled-task';
    });
    this.bus.on('BossInspection', ({ threatCards }) => {
      this.bossInspectionsFired++;
      this.approval.bossSettle(threatCards);
      if (this.result === 'lose') this.lastFailReason = 'boss-inspection';
    });
    this.bus.on('BossSpawned', () => this.prop.onBossSpawned());
    this.bus.on('KissUpFreeze', ({ durationSec }) => this.applyFreeze(durationSec));
    // §4.2 道具生效：CardHit → Conveyor 变更
    this.bus.on('CardHit', ({ prop, slot, quality }) => {
      this.applyPropEffect(prop, slot);
      this.effectiveHits++;
      this.propHits[prop] = (this.propHits[prop] ?? 0) + 1;
      if (quality === 'perfect') this.perfectHits++;
    });
    this.bus.on('AIHit', () => {
      this.propHits[PT.KissUp] = (this.propHits[PT.KissUp] ?? 0) + 1;
    });
    this.bus.on('PropUnavailable', () => {
      this.missedThrows++;
    });
    this.bus.on('ApprovalChanged', ({ to }) => {
      if (to > this.peakApproval) this.peakApproval = to;
    });
    this.bus.on('ComboUpdated', ({ combo }) => {
      if (combo > this.maxCombo) this.maxCombo = combo;
    });
    this.bus.on('GameOver', ({ result }) => {
      this.result = result;
      this.finish();
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
      if (this.shouldSpawnBoss(phase, zone) && !this.conveyor.hasBoss()) {
        this.conveyor.generate(phase, { forceBoss: true });
      } else {
        this.conveyor.generate(phase);
      }
      if (this.over) return;
    }

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
    this.bonusDuration += 8;
    this.approval.revive(this.cfg.zones.danger.lo); // 危险区下限 69
    this.conveyor.clearBoss();
    this.bus.emit('Revived', { approval: this.approval.value, bonusSec: 8 });
    return true;
  }

  /* ---------- 表现层快照 ---------- */
  getSnapshot() {
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
    };
  }

  /* ---------- 内部 ---------- */

  private applyPropEffect(prop: PropType, slot: number): void {
    if (prop === PT.AddDemand) this.conveyor.insertGrayAt(slot);
    else if (prop === PT.ChangeDemand) this.conveyor.reworkAt(slot);
    else if (prop === PT.ThrowPot) this.conveyor.clearRange(slot, PropsConfig[PT.ThrowPot].clearRadius ?? 1);
  }

  private applyFreeze(dur: number): void {
    this.freezeRemaining = Math.max(this.freezeRemaining, dur);
    this.conveyor.setFrozen(true);
    this.approval.setFrozen(true);
  }

  /** §5.4 Boss 生成概率：随认可度区间与阶段上升，仅 danger/ok 区、且超过 minSpawnSec。 */
  private shouldSpawnBoss(phase: GamePhase, zone: ApprovalZone): boolean {
    if (!this.level.def.boss.enabled) return false;
    if (this.elapsed < this.level.def.boss.minSpawnSec) return false;
    const sp = BalanceConfig.boss.spawnProb;
    const zoneP = zone === 'danger' ? sp.zone.danger : zone === 'ok' ? sp.zone.ok : 0;
    const phaseM = sp.phaseMul[phase];
    return this.rng.next() < zoneP * phaseM;
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
