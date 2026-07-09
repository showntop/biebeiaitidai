import type { EventBus } from '../EventBus';
import type { BalanceConfigT } from '../config';
import { zoneFor } from '../config';
import type { ApprovalZone, Card, GameResult } from '../types';
import { GameResult as GR, ApprovalZone as AZ } from '../types';

/**
 * 认可度系统（核心规则层，对应策划文档§5、§6）。
 *
 * 职责：
 *  - 维护认可度 0~100（钳位），发 ApprovalChanged / ZoneChanged。
 *  - 结算增减来源（§5.2）：活跃白卡 +权重、返工卡 -权重（唯一倒扣）、其余 0。
 *  - Boss临检结算（§5.4）：只结算活跃白卡正权重，【只加不减】。
 *  - 双路径胜负（§6.2）：
 *      · 认可度 ≥100 → 判负（lose）。
 *      · 认可度跌入猎杀线并持续维持 holdSec → 猎杀式通关（win-hunt）。
 *      · 倒计时归零且未触发上述 → 由 LevelSystem 调 declareSurviveOnTimeout → 生存式通关（win-survive）。
 *  - 拍马屁冻结期间暂停一切结算与猎杀维持计时（§4.2）。
 *
 * 纯逻辑、零 Cocos 依赖：通过 EventBus 广播事件，表现层订阅即可。
 */
export class ApprovalSystem {
  private approval: number;
  private zone: ApprovalZone;
  private huntHoldAccum = 0; // 认可度持续≤猎杀线的累计秒数
  private result: GameResult = GR.Ongoing;
  private frozen = false; // 拍马屁冻结

  constructor(
    private cfg: BalanceConfigT,
    private events: EventBus,
    initApproval = cfg.approval.init,
  ) {
    this.approval = initApproval;
    this.zone = zoneFor(cfg, this.approval);
  }

  get value(): number {
    return this.approval;
  }
  get currentZone(): ApprovalZone {
    return this.zone;
  }
  get currentResult(): GameResult {
    return this.result;
  }

  /** 拍马屁冻结开关：冻结期间不结算、不计时猎杀维持（卡都静止）。 */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /** §5.2 一张卡抵达处理区被结算。返回本次认可度变化。 */
  resolveCard(card: Card): number {
    if (this.frozen) {
      // 冻结期间卡静止，不结算；仍广播 delta=0 供表现层同步。
      this.events.emit('CardResolved', { card, delta: 0 });
      return 0;
    }
    let delta = 0;
    if (card.state === 'active-white') delta = card.weight; // 活跃白卡 +权重
    else if (card.state === 'rework') delta = -card.weight; // 返工卡 -权重（唯一倒扣）
    // idle / inserted / boss 在此不产生认可度变化
    if (delta !== 0) this.apply(delta);
    this.events.emit('CardResolved', { card, delta });
    return delta;
  }

  /** §5.4 Boss临检强制结算：只结算活跃白卡正权重，只加不减。返回本次加和。 */
  bossSettle(threatCards: Card[]): number {
    if (this.frozen) return 0;
    const sum = threatCards
      .filter((c) => c.state === 'active-white')
      .reduce((s, c) => s + c.weight, 0);
    if (sum > 0) this.apply(sum);
    return sum;
  }

  /** 猎杀维持计时。每帧由 Game.tick 调用。 */
  tick(dt: number): void {
    if (this.frozen || this.result !== GR.Ongoing) return;
    if (this.zone === AZ.Hunt) {
      const started = this.huntHoldAccum === 0;
      this.huntHoldAccum += dt;
      if (started) this.events.emit('HuntChargeStart', { approval: this.approval });
      if (this.huntHoldAccum >= (this.cfg.zones.hunt.holdSec ?? Infinity)) {
        this.finish(GR.WinHunt);
      }
    } else if (this.huntHoldAccum > 0) {
      this.events.emit('HuntChargeBreak', { approval: this.approval });
      this.huntHoldAccum = 0;
    }
  }

  /** 倒计时归零且未触发其它判定 → 生存式通关（由 LevelSystem 调用）。 */
  declareSurviveOnTimeout(): void {
    if (this.result === GR.Ongoing) this.finish(GR.WinSurvive);
  }

  /** 复位到指定初始认可度（默认取配置）。 */
  reset(initApproval = this.cfg.approval.init): void {
    this.approval = initApproval;
    this.zone = zoneFor(this.cfg, this.approval);
    this.huntHoldAccum = 0;
    this.result = GR.Ongoing;
    this.frozen = false;
  }

  /**
   * §2.1 复活：把认可度强制回滚到指定值（默认为危险区下限69），
   * 并把局结果从 lose 重置为 ongoing，给玩家一次翻盘机会。
   */
  revive(targetApproval: number): void {
    this.approval = targetApproval;
    this.zone = zoneFor(this.cfg, this.approval);
    this.huntHoldAccum = 0;
    this.result = GR.Ongoing;
    this.frozen = false;
    const max = this.cfg.approval.max;
    this.events.emit('ApprovalChanged', { from: max, to: targetApproval, delta: targetApproval - max });
  }

  private apply(delta: number): void {
    const from = this.approval;
    const { min, max } = this.cfg.approval;
    const to = clamp(from + delta, min, max);
    this.approval = to;
    const prevZone = this.zone;
    const newZone = zoneFor(this.cfg, to);
    this.zone = newZone;
    this.events.emit('ApprovalChanged', { from, to, delta });
    if (prevZone !== newZone) this.events.emit('ZoneChanged', { from: prevZone, to: newZone });
    if (this.approval >= max) this.finish(GR.Lose);
  }

  private finish(result: GameResult): void {
    if (this.result !== GR.Ongoing) return; // 防止重复结算
    this.result = result;
    this.events.emit('GameOver', { result });
  }
}

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
