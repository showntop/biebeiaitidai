import { EventBus } from './EventBus';
import { ConveyorSystem } from './systems/ConveyorSystem';
import { PropSystem } from './systems/PropSystem';
import { ApprovalSystem } from './systems/ApprovalSystem';
import { AIActorSystem } from './systems/AIActorSystem';
import { LevelSystem } from './systems/LevelSystem';
import type { RunStats } from './systems/LevelSystem';
import { BalanceConfig, PropsConfig, DefaultLevel } from './config';
import { phaseFor } from './config';
import { defaultRng } from './rng';
import type { Rng } from './rng';
import type { LevelDef } from './config';
import type { ApprovalZone, GamePhase, GameResult, PropType } from './types';
import { PropType as PT } from './types';

/**
 * 游戏总装（核心规则层入口，对应开发计划§2 架构 + §3 Game 编排）。
 *
 * 职责：
 *  - 创建各系统并完成事件接线（系统间通过 EventBus 解耦，跨系统协调集中在此）。
 *  - tick(dt) 驱动主循环：道具扫描、AI表情、（冻结期外）认可度计时、挡位左移、白卡生成、Boss生成。
 *  - 输入 API：beginCharge/release/cancel/useKissUp（Cocos 输入层调用）。
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
  readonly level: LevelSystem;

  elapsed = 0;
  peakApproval: number;
  bossInspectionsFired = 0;
  result: GameResult = 'ongoing';
  stars = 0;

  private shiftAcc = 0;
  private genAcc = 0;
  private freezeRemaining = 0;
  private rng: Rng;

  constructor(level: LevelDef = DefaultLevel, rng: Rng = defaultRng) {
    this.rng = rng;
    this.conveyor = new ConveyorSystem(BalanceConfig, level, this.bus, rng);
    this.approval = new ApprovalSystem(BalanceConfig, this.bus, level.approvalInit);
    this.prop = new PropSystem(BalanceConfig, this.bus, rng, this.conveyor, level.slots);
    this.ai = new AIActorSystem(this.bus, BalanceConfig);
    this.level = new LevelSystem(BalanceConfig, level);
    this.peakApproval = level.approvalInit;

    // —— 事件接线 ——
    this.bus.on('CardEnteredProcessing', ({ card }) => this.approval.resolveCard(card));
    this.bus.on('BossInspection', ({ threatCards }) => {
      this.bossInspectionsFired++;
      this.approval.bossSettle(threatCards);
    });
    this.bus.on('BossSpawned', () => this.prop.onBossSpawned());
    this.bus.on('KissUpFreeze', ({ durationSec }) => this.applyFreeze(durationSec));
    // §4.2 道具生效：CardHit → Conveyor 变更
    this.bus.on('CardHit', ({ prop, slot }) => this.applyPropEffect(prop, slot));
    this.bus.on('ApprovalChanged', ({ to }) => {
      if (to > this.peakApproval) this.peakApproval = to;
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

    if (this.freezeRemaining > 0) {
      this.freezeRemaining -= dt;
      if (this.freezeRemaining <= 0) {
        this.freezeRemaining = 0;
        this.conveyor.setFrozen(false);
        this.approval.setFrozen(false);
      }
      return; // §4.2 冻结期间 belt/approval/生成暂停
    }

    this.elapsed += dt;
    this.approval.tick(dt);

    const phase = this.phase;
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

    if (this.elapsed >= this.level.def.durationSec && !this.over) {
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
  cancel(prop: PropType): void {
    this.prop.cancel(prop);
  }
  useKissUp(): boolean {
    return this.prop.useKissUp();
  }

  /* ---------- 表现层快照 ---------- */
  getSnapshot() {
    return {
      elapsed: this.elapsed,
      duration: this.level.def.durationSec,
      approval: this.approval.value,
      zone: this.approval.currentZone,
      phase: this.phase,
      result: this.result,
      stars: this.stars,
      peakApproval: this.peakApproval,
      combo: this.prop.currentCombo,
      frozen: this.isFrozen,
      beltSize: this.conveyor.size,
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
    const zoneP = zone === 'danger' ? 0.1 : zone === 'ok' ? 0.04 : 0;
    const phaseM = phase === 'crisis' ? 1.5 : phase === 'mid' ? 1.0 : 0.5;
    return this.rng.next() < zoneP * phaseM;
  }

  private finish(): void {
    const stats: RunStats = {
      peakApproval: this.peakApproval,
      timeUsedSec: this.elapsed,
      bossInspectionsFired: this.bossInspectionsFired,
    };
    this.stars = this.level.starRating(this.result, stats);
  }
}
