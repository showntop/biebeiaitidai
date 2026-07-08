import { Game } from '../assets/scripts/core/Game';
import { DefaultLevel } from '../assets/scripts/core/config';
import { PropType as PT } from '../assets/scripts/core/types';

/** 传送带槽位数（= DefaultLevel.slots）。bot 的 intended/scanSlot 都用槽位索引。 */
export const SLOTS = DefaultLevel.slots;

export interface Bot {
  step(g: Game): void;
}

/** 什么都不做（探测完全被动基线）。 */
export class NoopBot implements Bot {
  step(_g: Game): void {}
}

/** 防守型 bot：拒 slot0 结算、危险区拍马屁、堆积丢锅、紧急加塞。目标"苟到底"。 */
export class DefensiveBot implements Bot {
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
    if (cards.filter((c) => c && c.state === 'active-white').length >= 4 && g.prop.canUse(PT.ThrowPot)) {
      g.beginCharge(PT.ThrowPot);
      this.intended = 1;
      return;
    }
    const urgentIdx = cards.findIndex((c) => c && c.state === 'active-white' && c.weight >= 10);
    if (urgentIdx > 0 && g.prop.canUse(PT.AddDemand)) {
      g.beginCharge(PT.AddDemand);
      this.intended = Math.min(urgentIdx, SLOTS - 1);
      return;
    }
    const hiIdx = cards.findIndex((c) => c && c.state === 'active-white' && c.weight >= 7);
    if (hiIdx >= 0 && g.prop.canUse(PT.ChangeDemand)) {
      g.beginCharge(PT.ChangeDemand);
      this.intended = Math.min(hiIdx, SLOTS - 1);
      return;
    }
  }
}

/** 进攻型 bot：专攻倒扣，把临门高权重白卡改需求翻成 -权重；不用拍马屁(冻结会卡倒扣结算)。目标"猎杀"。 */
export class OffensiveBot implements Bot {
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
      const c = cards[i];
      if (c && c.state === 'active-white' && c.weight > bestW) {
        bestW = c.weight;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && g.prop.canUse(PT.ChangeDemand)) {
      g.beginCharge(PT.ChangeDemand);
      this.intended = bestIdx;
      return;
    }
    for (let i = 0; i < Math.min(4, cards.length); i++) {
      const c = cards[i];
      if (c && c.state === 'active-white' && c.weight >= 7 && g.prop.canUse(PT.ChangeDemand)) {
        g.beginCharge(PT.ChangeDemand);
        this.intended = i;
        return;
      }
    }
    if (cards.filter((c) => c && c.state === 'active-white').length >= 3 && g.prop.canUse(PT.ThrowPot)) {
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
