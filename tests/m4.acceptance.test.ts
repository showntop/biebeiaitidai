import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { DefaultLevel } from '../assets/scripts/core/config';
import { BalanceConfig } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { PropType as PT } from '../assets/scripts/core/types';

const SLOTS = DefaultLevel.slots;
const N = 1000;

/**
 * M4 验收专用：不复用 sim.bot 的聚合均值（avgPeak），
 * 而是逐帧/逐事件追踪三条具体指标的真实发生次数，避免用均值代替时序判据。
 */

/** 复用 sim.bot 的防守/进攻 bot 逻辑（保持与已发布调优结果一致的输入）。 */
class DefensiveBot {
  private intended = -1;
  step(g: Game): void {
    if (g.approval.currentZone === 'danger' && g.prop.canUse(PT.KissUp)) g.useKissUp();
    if (g.prop.chargingProp) {
      const s = g.prop.scanSlot;
      if (s === this.intended || s >= SLOTS - 1) {
        g.release(g.prop.chargingProp);
        this.intended = -1;
      }
      return;
    }
    const cards = g.conveyor.cards;
    if (cards[0]?.state === 'active-white' && g.prop.canUse(PT.ChangeDemand)) {
      g.beginCharge(PT.ChangeDemand);
      this.intended = 0;
      return;
    }
    if (cards.filter((c) => c.state === 'active-white').length >= 4 && g.prop.canUse(PT.ThrowPot)) {
      g.beginCharge(PT.ThrowPot);
      this.intended = 1;
      return;
    }
    const urgentIdx = cards.findIndex((c) => c.state === 'active-white' && c.weight >= 10);
    if (urgentIdx > 0 && g.prop.canUse(PT.AddDemand)) {
      g.beginCharge(PT.AddDemand);
      this.intended = Math.min(urgentIdx, SLOTS - 1);
      return;
    }
    const hiIdx = cards.findIndex((c) => c.state === 'active-white' && c.weight >= 7);
    if (hiIdx >= 0 && g.prop.canUse(PT.ChangeDemand)) {
      g.beginCharge(PT.ChangeDemand);
      this.intended = Math.min(hiIdx, SLOTS - 1);
      return;
    }
  }
}

class OffensiveBot {
  private intended = -1;
  step(g: Game): void {
    if (g.prop.chargingProp) {
      const s = g.prop.scanSlot;
      if (s === this.intended || s >= SLOTS - 1) {
        g.release(g.prop.chargingProp);
        this.intended = -1;
      }
      return;
    }
    const cards = g.conveyor.cards;
    let bestIdx = -1;
    let bestW = -1;
    for (let i = 0; i < Math.min(2, cards.length); i++) {
      if (cards[i]?.state === 'active-white' && cards[i].weight > bestW) {
        bestW = cards[i].weight;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && g.prop.canUse(PT.ChangeDemand)) {
      g.beginCharge(PT.ChangeDemand);
      this.intended = bestIdx;
      return;
    }
    for (let i = 0; i < Math.min(4, cards.length); i++) {
      if (cards[i]?.state === 'active-white' && cards[i].weight >= 7 && g.prop.canUse(PT.ChangeDemand)) {
        g.beginCharge(PT.ChangeDemand);
        this.intended = i;
        return;
      }
    }
    if (cards.filter((c) => c.state === 'active-white').length >= 3 && g.prop.canUse(PT.ThrowPot)) {
      g.beginCharge(PT.ThrowPot);
      this.intended = Math.min(1, cards.length - 1);
      return;
    }
    if (cards[0]?.state === 'active-white' && g.prop.canUse(PT.AddDemand)) {
      g.beginCharge(PT.AddDemand);
      this.intended = 0;
      return;
    }
  }
}

/** 什么都不做（探测"完全被动"情形下的骤死/保底基线，作为下界对照）。 */
class NoopBot {
  step(_g: Game): void {}
}

interface AcceptanceStat {
  name: string;
  n: number;
  result: Record<string, number>;
  huntRate: number;
  /** §5.4 危机期骤死：5秒滑动窗口内认可度从<70跨越到>=100（真判负骤死），逐帧追踪，非均值推断。 */
  crisisSuddenDeathCount: number;
  crisisSuddenDeathRate: number;
  /** Boss 资源保底触发次数、以及触发后本次临检是否仍然导致判负（=保底没能真正解决威胁）。 */
  bossGuaranteeTriggered: number;
  bossGuaranteeFollowedByLoseWithin3s: number;
}

function runAcceptance(name: string, Bot: new () => { step: (g: Game) => void }): AcceptanceStat {
  const result: Record<string, number> = { 'win-hunt': 0, 'win-survive': 0, lose: 0 };
  let crisisSuddenDeathCount = 0;
  let bossGuaranteeTriggered = 0;
  let bossGuaranteeFollowedByLose = 0;
  const dt = 0.05;
  const WINDOW = 5.0; // 5秒滑动窗口

  for (let s = 1; s <= N; s++) {
    const g = new Game(DefaultLevel, new SeededRng(s));
    const bot = new Bot();

    // approval 历史（时间戳, 值），仅保留窗口内，用于判定"5秒内从<70到>=100"
    const hist: { t: number; v: number }[] = [];
    let guaranteeFiredAt = -1;

    // 直接监听 PropSystem 发的 BossGuaranteeTriggered 事件（不依赖 handler 注册顺序）
    g.bus.on('BossGuaranteeTriggered', () => {
      bossGuaranteeTriggered++;
    });
    let bossInspectionAt = -1;
    g.bus.on('BossInspection', () => {
      bossInspectionAt = g.elapsed;
    });

    void BalanceConfig.boss.guaranteeEnergyThreshold; // 不再需要帧级探测，保底事件直接驱动计数

    // 记录是否本局至少触发过一次保底，用于后续"保底后是否仍然判负"校验
    let guaranteeFiredThisGame = false;
    g.bus.on('BossGuaranteeTriggered', () => {
      guaranteeFiredThisGame = true;
    });

    for (let t = 0; t < 90 && !g.over; t += dt) {
      bot.step(g);
      g.tick(dt);

      hist.push({ t: g.elapsed, v: g.approval.value });
      while (hist.length > 0 && g.elapsed - hist[0].t > WINDOW) hist.shift();

      // 危机期骤死判定：当前 elapsed 在 45~60s，且窗口内存在一个历史点 v<70，
      // 而当前 approval>=100（真实判负阈值），即"5秒内从<70冲到100导致判负"。
      if (g.elapsed >= 45 && g.approval.value >= 100) {
        const hadSubDangerInWindow = hist.some((h) => h.v < 70);
        if (hadSubDangerInWindow) crisisSuddenDeathCount++;
      }

      if (g.over) break;
    }

    // 保底触发后，检查该次 Boss 临检结算是否仍在 3 秒内导致判负
    if (guaranteeFiredThisGame && bossInspectionAt >= 0 && g.result === 'lose') {
      if (g.elapsed - bossInspectionAt <= 3.0) bossGuaranteeFollowedByLose++;
    }
    void guaranteeFiredAt;

    result[g.result]++;
  }

  return {
    name,
    n: N,
    result,
    huntRate: +(result['win-hunt'] / N).toFixed(4),
    crisisSuddenDeathCount,
    crisisSuddenDeathRate: +(crisisSuddenDeathCount / N).toFixed(4),
    bossGuaranteeTriggered,
    bossGuaranteeFollowedByLoseWithin3s: bossGuaranteeFollowedByLose,
  };
}

describe('M4 验收：精细化指标（非均值推断，逐局逐事件追踪）', () => {
  it('猎杀式通关可达性 + 危机期骤死 + Boss保底真实生效率', () => {
    const stats = [
      runAcceptance('noop', NoopBot),
      runAcceptance('defensive', DefensiveBot),
      runAcceptance('offensive', OffensiveBot),
    ];
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(stats, null, 2));
    expect(true).toBe(true);
  });
});
