import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { DefaultLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { PropType as PT } from '../assets/scripts/core/types';

const SLOTS = DefaultLevel.slots;

/** 防守型 bot：拒 slot0 结算、危险区拍马屁、堆积丢锅、紧急加塞。目标是"苟到底"。 */
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

/** 进攻型 bot：专攻倒扣，把即将结算的高权重白卡改需求翻成 -权重；不用拍马屁(冻结会卡倒扣结算)。目标是"猎杀"。 */
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

interface BotStat {
  name: string;
  result: Record<string, number>;
  stars: { [k: string]: number };
  avgPeak: number;
  avgTime: number;
}

function runBot(name: string, Bot: new () => DefensiveBot | OffensiveBot, N: number): BotStat {
  const result: Record<string, number> = { 'win-hunt': 0, 'win-survive': 0, lose: 0 };
  const stars = [0, 0, 0, 0];
  let peakSum = 0;
  let timeSum = 0;
  const dt = 0.05;
  for (let s = 1; s <= N; s++) {
    const g = new Game(DefaultLevel, new SeededRng(s));
    const bot = new Bot();
    for (let t = 0; t < 90 && !g.over; t += dt) {
      bot.step(g);
      g.tick(dt);
    }
    result[g.result]++;
    stars[g.stars]++;
    peakSum += g.peakApproval;
    timeSum += g.elapsed;
  }
  return {
    name,
    result,
    stars: { '0': stars[0], '1': stars[1], '2': stars[2], '3': stars[3] },
    avgPeak: +(peakSum / N).toFixed(1),
    avgTime: +(timeSum / N).toFixed(1),
  };
}

describe('SIM: 防守 vs 进攻 bot 千局对照（平衡诊断）', () => {
  it('prints comparison', () => {
    const N = 1000;
    const out = [runBot('defensive', DefensiveBot, N), runBot('offensive', OffensiveBot, N)];
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
    expect(true).toBe(true);
  });
});
