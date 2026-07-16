import { describe, it, expect } from 'vitest';
import { EventBus } from '../assets/scripts/core/EventBus';
import { PropSystem } from '../assets/scripts/core/systems/PropSystem';
import { BalanceConfig } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { PropType as PT } from '../assets/scripts/core/types';
import type { Card, PropType, HitQuality } from '../assets/scripts/core/types';

const SLOTS = 6;

/** 只读 BeltView 桩：直接给定槽位状态，让 PropSystem 单测脱离传送带内部机制。 */
class StubBelt {
  slots: (Card | null)[];
  constructor(slots: (Card | null)[] = new Array(SLOTS).fill(null)) {
    this.slots = slots;
  }
  get size(): number {
    return this.slots.filter((c) => c).length;
  }
  slotAt(i: number): Card | null {
    return this.slots[i] ?? null;
  }
  hasCardsInRange(slot: number, radius: number): boolean {
    const lo = Math.max(0, slot - radius);
    const hi = Math.min(this.slots.length - 1, slot + radius);
    for (let i = lo; i <= hi; i++) if (this.slots[i]) return true;
    return false;
  }
}

let _id = 1;
function mk(category: Card['category'], state: Card['state'], weight: number): Card {
  return { id: _id++, category, state, weight, isThreat: state === 'active-white' };
}

function setup(slots?: (Card | null)[], seed = 7) {
  const bus = new EventBus();
  const belt = new StubBelt(slots);
  const prop = new PropSystem(BalanceConfig, bus, new SeededRng(seed), belt, SLOTS);
  return { bus, belt, prop };
}

describe('PropSystem · 改需求（唯一倒扣，§4.2）', () => {
  it('命中活跃白卡：消耗1次、进CD、回充丢锅、连击+1', () => {
    const { bus, prop } = setup([mk('urgent', 'active-white', 10)]);
    const hits: { prop: PropType; quality: HitQuality }[] = [];
    bus.on('CardHit', ({ prop: p, quality }) => hits.push({ prop: p, quality }));
    prop.beginCharge(PT.ChangeDemand);
    prop.tick(0.05, 'mid'); // scan 0.05 → slot0, 非 Perfect
    prop.release(PT.ChangeDemand);
    expect(hits).toHaveLength(1);
    expect(hits[0].prop).toBe(PT.ChangeDemand);
    expect(prop.getState(PT.ChangeDemand).uses).toBe(5); // cap 6 → 5
    expect(prop.canUse(PT.ChangeDemand)).toBe(false); // CD 中
    expect(prop.getState(PT.ThrowPot).energy).toBeCloseTo(0.25, 5);
    expect(prop.currentCombo).toBe(1);
  });

  it('改需求打在返工卡＝无效目标，不消耗次数（§4.3）', () => {
    const { bus, prop } = setup([mk('urgent', 'rework', 10)]);
    let reason = '';
    bus.on('PropUnavailable', ({ reason: r }) => (reason = r));
    const usesBefore = prop.getState(PT.ChangeDemand).uses;
    prop.beginCharge(PT.ChangeDemand);
    prop.tick(0.05, 'mid');
    prop.release(PT.ChangeDemand);
    expect(reason).toBe('invalid-target');
    expect(prop.getState(PT.ChangeDemand).uses).toBe(usesBefore);
  });
});

describe('PropSystem · 加需求（插队键，随手可用）', () => {
  it('空挡也可用，永远有效；命中回充丢锅', () => {
    const { bus, prop } = setup(); // 空带
    const hits: PropType[] = [];
    bus.on('CardHit', ({ prop: p }) => hits.push(p));
    prop.beginCharge(PT.AddDemand);
    prop.tick(0.5, 'early'); // scan 0.5 → slot3
    prop.release(PT.AddDemand);
    expect(hits).toEqual([PT.AddDemand]);
    expect(prop.getState(PT.ThrowPot).energy).toBeCloseTo(0.25, 5);
  });
});

describe('PropSystem · Perfect 可变奖励（§4.3）', () => {
  it('在挡位中心窗口松手＝Perfect 命中', () => {
    const { bus, prop } = setup([mk('urgent', 'active-white', 10)]);
    const q: HitQuality[] = [];
    const rewards: string[] = [];
    bus.on('CardHit', ({ quality }) => q.push(quality));
    bus.on('PerfectRewardGranted', ({ reward }) => rewards.push(reward));
    prop.beginCharge(PT.ChangeDemand);
    prop.tick(0.5 / SLOTS, 'mid'); // slot0 中心 scan
    prop.release(PT.ChangeDemand);
    expect(q).toEqual(['perfect']);
    expect(rewards).toHaveLength(1);
    expect(['cd-refill-10', 'extra-use', 'energy-full']).toContain(rewards[0]);
  });
});

describe('PropSystem · 连击（§4.4，纯演出不计数值）', () => {
  it('窗口内连续有效命中 → 连击递增；超窗 → 重新计 1', () => {
    const { belt, prop } = setup([mk('urgent', 'active-white', 10)]);
    // 1: 加需求（首用无CD）
    prop.beginCharge(PT.AddDemand);
    prop.tick(0.3, 'early');
    prop.release(PT.AddDemand);
    expect(prop.currentCombo).toBe(1);
    // 2: 改需求（首用无CD），窗口内
    prop.beginCharge(PT.ChangeDemand);
    prop.tick(0.05, 'mid');
    prop.release(PT.ChangeDemand);
    expect(prop.currentCombo).toBe(2);
    // 改需求 CD(mid=5s) — 用加需求继续需清 CD；belt[0] 已被改需求变成返工卡，重置成白卡
    belt.slots[0] = mk('routine', 'active-white', 2);
    prop.tick(6.0, 'early'); // 清加需求 CD 且超连击窗口
    prop.beginCharge(PT.AddDemand);
    prop.tick(0.3, 'early');
    prop.release(PT.AddDemand);
    expect(prop.currentCombo).toBe(1);
  });
});

describe('PropSystem · 丢锅（范围清空，§4.2）', () => {
  it('4 次有效命中把丢锅能量攒满 → 可用', () => {
    const { prop } = setup();
    expect(prop.canUse(PT.ThrowPot)).toBe(false);
    for (let i = 0; i < 4; i++) {
      prop.tick(3.0, 'early'); // 清加需求 CD
      prop.beginCharge(PT.AddDemand);
      prop.tick(0.3, 'early');
      prop.release(PT.AddDemand);
    }
    expect(prop.getState(PT.ThrowPot).energy).toBeCloseTo(1, 5);
    expect(prop.canUse(PT.ThrowPot)).toBe(true);
  });

  it('命中范围内卡 → 发 CardHit 且能量清零', () => {
    const { bus, prop } = setup([mk('routine', 'active-white', 2), mk('key', 'active-white', 5), null, null, null, null]);
    // 先攒满丢锅
    for (let i = 0; i < 4; i++) {
      prop.tick(3.0, 'early');
      prop.beginCharge(PT.AddDemand);
      prop.tick(0.3, 'early');
      prop.release(PT.AddDemand);
    }
    const hits: PropType[] = [];
    bus.on('CardHit', ({ prop: p }) => hits.push(p));
    prop.beginCharge(PT.ThrowPot);
    prop.tick(0.18, 'mid'); // scan 0.18 → slot1，非 Perfect
    prop.release(PT.ThrowPot);
    expect(hits).toEqual([PT.ThrowPot]);
    expect(prop.getState(PT.ThrowPot).energy).toBe(0);
  });

  it('空范围＝Miss 不消耗、连击清零', () => {
    const { bus, prop } = setup(); // 空带
    for (let i = 0; i < 5; i++) {
      // 用占位白卡让加需求/连击成立（加需求不需要目标，但连击需要有效命中；加需求即有效）
      prop.tick(3.0, 'early');
      prop.beginCharge(PT.AddDemand);
      prop.tick(0.3, 'early');
      prop.release(PT.AddDemand);
    }
    expect(prop.canUse(PT.ThrowPot)).toBe(true);
    expect(prop.currentCombo).toBeGreaterThanOrEqual(1);
    let reason = '';
    bus.on('PropUnavailable', ({ reason: r }) => (reason = r));
    prop.beginCharge(PT.ThrowPot);
    prop.tick(0.18, 'mid');
    prop.release(PT.ThrowPot);
    expect(reason).toBe('empty');
    expect(prop.currentCombo).toBe(0);
  });
});

describe('PropSystem · 拍马屁（冻结）+ Boss保底（§5.4②）', () => {
  it('拍马屁能量满后点按 → 发 AIHit + KissUpFreeze', () => {
    const { bus, prop } = setup();
    expect(prop.canUse(PT.KissUp)).toBe(false);
    prop.tick(51, 'early'); // 0.02/s≈50s 攒满
    expect(prop.canUse(PT.KissUp)).toBe(true);
    let aiHit = 0;
    let freezeSec = 0;
    bus.on('AIHit', () => aiHit++);
    bus.on('KissUpFreeze', ({ durationSec }) => (freezeSec = durationSec));
    expect(prop.useKissUp()).toBe(true);
    expect(aiHit).toBe(1);
    expect(freezeSec).toBeGreaterThanOrEqual(1.5);
    expect(freezeSec).toBeLessThanOrEqual(2.0);
  });

  it('Boss保底：丢锅能量<0.5 时充至 0.5', () => {
    const { prop } = setup();
    expect(prop.getState(PT.ThrowPot).energy).toBe(0);
    prop.onBossSpawned();
    expect(prop.getState(PT.ThrowPot).energy).toBeCloseTo(0.5, 5);
  });

  it('Boss保底：丢锅能量已≥0.5 时不重复充', () => {
    const { prop } = setup();
    // 手动把丢锅能量堆到 0.5 以上
    for (let i = 0; i < 4; i++) {
      prop.tick(3.0, 'early');
      prop.beginCharge(PT.AddDemand);
      prop.tick(0.3, 'early');
      prop.release(PT.AddDemand);
    }
    const before = prop.getState(PT.ThrowPot).energy;
    prop.onBossSpawned();
    expect(prop.getState(PT.ThrowPot).energy).toBe(before);
  });
});
