import type { EventBus } from '../EventBus';
import type { GameResult, HighlightId, HighlightMoment, HighlightTier } from '../types';

interface HighlightDefinition {
  label: string;
  tier: HighlightTier;
  quip: string;
}

export const HighlightDefinitions: Record<HighlightId, HighlightDefinition> = {
  'clean-hit': { label: '精准下班', tier: 1, quip: 'AI：这一下不在我的训练数据里。' },
  'combo-3': { label: '流程粉碎机', tier: 1, quip: 'AI：等等，你怎么连起来了？' },
  'combo-5': { label: '工位永动机', tier: 2, quip: 'AI：系统繁忙，请停止连击。' },
  'perfect-chain': { label: '三连 Perfect', tier: 3, quip: 'AI：连续三次？你是不是偷看答案了。' },
  'boss-clutch': { label: '门口截胡', tier: 3, quip: 'AI：老板都到门口了，你还敢拦？' },
  'danger-comeback': { label: '红区翻盘', tier: 2, quip: 'AI：刚才明明已经接管到 99%……' },
  'hunt-finish': { label: '反向优化', tier: 3, quip: 'AI：通知一下，我先去和老板谈谈。' },
  'revive-comeback': { label: '带薪返场', tier: 3, quip: 'AI：不是，你怎么又回来了？' },
  'hold-the-line': { label: '岗位守门员', tier: 1, quip: 'AI：本轮接管申请已被驳回。' },
  'last-stand': { label: '差点保住工位', tier: 1, quip: 'AI：就差一点，下次我不一定赢。' },
};

/**
 * 纯规则高光系统。
 *
 * 只监听 EventBus 并记录不可重复的高光，不修改游戏数值。高光定义成为局内演出、
 * 结算称号、埋点与分享战报的统一源真值。
 */
export class HighlightSystem {
  readonly earned: HighlightMoment[] = [];

  private readonly emitted = new Set<HighlightId>();
  private clock = 0;
  private perfectStreak = 0;
  private dangerAt = -Infinity;
  private bossAtDoor = false;
  private revived = false;
  private hadEffectiveHit = false;

  constructor(private readonly bus: EventBus) {
    bus.on('CardHit', ({ quality, card, slot }) => {
      this.hadEffectiveHit = true;
      this.trackPerfect(quality === 'perfect');
      if (card?.state === 'boss' && (this.bossAtDoor || slot <= 1)) this.award('boss-clutch');
    });
    bus.on('AIHit', ({ quality }) => {
      this.hadEffectiveHit = true;
      this.trackPerfect(quality === 'perfect');
    });
    bus.on('PropUnavailable', () => { this.perfectStreak = 0; });
    bus.on('ComboUpdated', ({ combo }) => {
      if (combo >= 5) this.award('combo-5');
      else if (combo >= 3) this.award('combo-3');
    });
    bus.on('BossIncoming', ({ tier }) => {
      if (tier === 1) this.bossAtDoor = true;
    });
    bus.on('ZoneChanged', ({ to }) => {
      if (to === 'danger') this.dangerAt = this.clock;
      if ((to === 'good' || to === 'hunt') && this.clock - this.dangerAt <= 12) {
        this.award('danger-comeback');
        this.dangerAt = -Infinity;
      }
    });
    bus.on('Revived', () => { this.revived = true; });
    bus.on('GameOver', ({ result }) => this.finish(result));
  }

  tick(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.clock += dt;
  }

  get best(): HighlightMoment | null {
    let best: HighlightMoment | null = null;
    for (const moment of this.earned) {
      // 同等级取后发生/后颁发的一项；同一帧复合事件也能把更完整的叙事放到结算封面。
      if (!best || moment.tier >= best.tier) {
        best = moment;
      }
    }
    return best;
  }

  private trackPerfect(perfect: boolean): void {
    if (!perfect) {
      this.perfectStreak = 0;
      return;
    }
    this.perfectStreak++;
    this.award('clean-hit');
    if (this.perfectStreak >= 3) this.award('perfect-chain');
  }

  private finish(result: GameResult): void {
    if (result === 'win-hunt') this.award('hunt-finish');
    if (result !== 'lose' && this.revived) this.award('revive-comeback');
    if (result === 'win-survive') this.award('hold-the-line');
    if (result === 'lose' && this.earned.length === 0) this.award('last-stand');
    // 极少数异常/脚本局也保证有一个可供结算使用的叙事锚点。
    if (this.earned.length === 0) this.award(this.hadEffectiveHit ? 'last-stand' : 'hold-the-line');
  }

  private award(id: HighlightId): void {
    if (this.emitted.has(id)) return;
    this.emitted.add(id);
    const def = HighlightDefinitions[id];
    const moment: HighlightMoment = {
      id,
      label: def.label,
      tier: def.tier,
      atSec: Number(this.clock.toFixed(2)),
    };
    this.earned.push(moment);
    this.bus.emit('Highlight', moment);
  }
}

export function highlightQuip(id: HighlightId): string {
  return HighlightDefinitions[id].quip;
}
