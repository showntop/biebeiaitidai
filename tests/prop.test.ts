import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../assets/scripts/core/EventBus';
import { ConveyorSystem } from '../assets/scripts/core/systems/ConveyorSystem';
import { PropSystem } from '../assets/scripts/core/systems/PropSystem';
import { BalanceConfig, DefaultLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { PropType as PT } from '../assets/scripts/core/types';
import type { HitQuality, PropType } from '../assets/scripts/core/types';

function setup(seed = 7) {
  const bus = new EventBus();
  const rng = new SeededRng(seed);
  const conv = new ConveyorSystem(BalanceConfig, DefaultLevel, bus, rng);
  const prop = new PropSystem(BalanceConfig, bus, rng, conv, DefaultLevel.slots);
  return { bus, rng, conv, prop };
}

/** 生成直到 slot0 是活跃白卡（确定性，idleCardRatio 下通常 1 次）。 */
function ensureActiveWhiteAt0(conv: ConveyorSystem): void {
  conv.reset();
  let guard = 0;
  while ((conv.slotAt(0)?.state !== 'active-white') && guard++ < 20) {
    conv.reset();
    conv.generate('early');
  }
}

describe('PropSystem · 改需求（唯一倒扣，§4.2）', () => {
  it('命中活跃白卡：消耗1次、进入CD、回充丢锅能量、连击+1', () => {
    const { bus, conv, prop } = setup();
    ensureActiveWhiteAt0(conv);
    const hits: { prop: PropType; quality: HitQuality }[] = [];
    bus.on('CardHit', ({ prop: p, quality }) => hits.push({ prop: p, quality }));

    expect(prop.beginCharge(PT.ChangeDemand)).toBe(true);
    prop.tick(0.05, 'mid'); // 扫描推进到 slot0 区
    expect(prop.release(PT.ChangeDemand)).toBe(true);

    expect(hits).toHaveLength(1);
    expect(hits[0].prop).toBe(PT.ChangeDemand);
    expect(prop.getState(PT.ChangeDemand).uses).toBe(6); // 7→6
    expect(prop.canUse(PT.ChangeDemand)).toBe(false); // 在 CD
    expect(prop.getState(PT.ThrowPot).energy).toBeCloseTo(0.25, 5); // 回充丢锅
    expect(prop.currentCombo).toBe(1);
  });

  it('改需求打在返工卡/空挡＝无效目标，不消耗次数（§4.3）', () => {
    const { bus, conv, prop } = setup();
    conv.generate('early');
    conv.reworkAt(0); // slot0 变返工卡
    let unavailable = '';
    bus.on('PropUnavailable', ({ reason }) => (unavailable = reason));
    const usesBefore = prop.getState(PT.ChangeDemand).uses;

    prop.beginCharge(PT.ChangeDemand);
    prop.tick(0.05, 'mid');
    prop.release(PT.ChangeDemand);

    expect(unavailable).toBe('invalid-target');
    expect(prop.getState(PT.ChangeDemand).uses).toBe(usesBefore); // 未消耗
  });
});

describe('PropSystem · 加需求（插队键，随手可用）', () => {
  it('空挡也可插入，永远有效；命中回充丢锅', () => {
    const { bus, prop } = setup();
    const hits: PropType[] = [];
    bus.on('CardHit', ({ prop: p }) => hits.push(p));
    prop.beginCharge(PT.AddDemand);
    prop.tick(0.5, 'early'); // slot=floor(0.5*6)=3
    prop.release(PT.AddDemand);
    expect(hits).toEqual([PT.AddDemand]);
    expect(prop.getState(PT.ThrowPot).energy).toBeCloseTo(0.25, 5);
  });
});

describe('PropSystem · Perfect 可变奖励（§4.3）', () => {
  it('在挡位中心窗口松手＝Perfect 命中', () => {
    const { bus, conv, prop } = setup();
    ensureActiveWhiteAt0(conv);
    const qualities: HitQuality[] = [];
    bus.on('CardHit', ({ quality }) => qualities.push(quality));

    prop.beginCharge(PT.ChangeDemand);
    // slot0 中心 = 0.5/6 ≈ 0.0833；scanSec=1 → tick 该秒数
    prop.tick((0.5 / 6) + 0.001, 'mid');
    prop.release(PT.ChangeDemand);

    expect(qualities).toEqual(['perfect']);
  });
});

describe('PropSystem · 连击（§4.4，纯演出不计数值）', () => {
  it('窗口内连续有效命中 → 连击递增；超窗 → 重新计 1', () => {
    // 注：加需求 CD(3s)＝连击窗口(3s)，单道具无法自连击；连击靠交替道具
    const { conv, prop } = setup();
    ensureActiveWhiteAt0(conv);
    // 第 1 击：加需求（首用无 CD）
    prop.beginCharge(PT.AddDemand);
    prop.tick(0.3, 'early');
    prop.release(PT.AddDemand);
    expect(prop.currentCombo).toBe(1);
    // 第 2 击：改需求（首用无 CD），窗口内 → 连击 2
    prop.beginCharge(PT.ChangeDemand);
    prop.tick(0.05, 'mid'); // slot0，slot0 仍为活跃白卡（测试中 belt 未接 CardHit 变更）
    prop.release(PT.ChangeDemand);
    expect(prop.currentCombo).toBe(2);
    // 超窗（>3s）后用加需求（CD 已被 tick 清掉）再击 → 重置为 1
    prop.tick(6.0, 'early'); // 清 add-demand CD 且超过连击窗口
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
      prop.tick(3.0, 'early'); // 清 add-demand CD
      prop.beginCharge(PT.AddDemand);
      prop.tick(0.3, 'early'); // 偏移扫描，避开 Perfect 窗口
      prop.release(PT.AddDemand);
    }
    expect(prop.getState(PT.ThrowPot).energy).toBeCloseTo(1, 5);
    expect(prop.canUse(PT.ThrowPot)).toBe(true);
  });

  it('丢锅命中后能量清零', () => {
    const { bus, conv, prop } = setup();
    for (let i = 0; i < 4; i++) {
      prop.tick(3.0, 'early');
      prop.beginCharge(PT.AddDemand);
      prop.tick(0.3, 'early');
      prop.release(PT.AddDemand);
    }
    // 队列放 3 张卡，丢锅 slot1 炸 0..2（scan 0.18 → slot1，非 Perfect）
    conv.reset();
    conv.generate('early');
    conv.generate('early');
    conv.generate('early');
    const hits: PropType[] = [];
    bus.on('CardHit', ({ prop: p }) => hits.push(p));
    prop.beginCharge(PT.ThrowPot);
    prop.tick(0.18, 'mid');
    prop.release(PT.ThrowPot);
    expect(hits).toEqual([PT.ThrowPot]);
    expect(prop.getState(PT.ThrowPot).energy).toBe(0); // 用后清零
  });

  it('空范围＝Miss 不消耗、连击清零', () => {
    const { bus, conv, prop } = setup();
    // 5 次 add-demand：4 次攒满丢锅 + 1 次制造连击（add-demand 上限 5，刚好用尽）
    for (let i = 0; i < 5; i++) {
      prop.tick(3.0, 'early');
      prop.beginCharge(PT.AddDemand);
      prop.tick(0.3, 'early');
      prop.release(PT.AddDemand);
    }
    expect(prop.canUse(PT.ThrowPot)).toBe(true);
    expect(prop.currentCombo).toBeGreaterThanOrEqual(1);
    conv.reset(); // 清空队列
    let reason = '';
    bus.on('PropUnavailable', ({ reason: r }) => (reason = r));
    prop.beginCharge(PT.ThrowPot);
    prop.tick(0.18, 'mid');
    prop.release(PT.ThrowPot);
    expect(reason).toBe('empty');
    expect(prop.currentCombo).toBe(0); // Miss 清零
  });
});

describe('PropSystem · 拍马屁（冻结，§4.2）+ Boss保底（§5.4②）', () => {
  it('拍马屁能量满后点按 → 发 AIHit + KissUpFreeze', () => {
    const { bus, prop } = setup();
    expect(prop.canUse(PT.KissUp)).toBe(false);
    prop.tick(51, 'early'); // 0.02/s ≈ 50s 攒满
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

  it('Boss保底：丢锅能量<0.5 时，把丢锅充至 0.5（只看丢锅，不看拍马屁，§5.4②修复后逻辑）', () => {
    const { prop } = setup();
    expect(prop.getState(PT.ThrowPot).energy).toBe(0);
    prop.onBossSpawned();
    expect(prop.getState(PT.ThrowPot).energy).toBeCloseTo(0.5, 5);
  });

  it('Boss保底：丢锅能量已≥0.5 时不重复充（玩家有牌可用了）', () => {
    const { prop } = setup();
    // 模拟有效命中攒了丢锅能量到 0.5 以上
    for (let i = 0; i < 4; i++) {
      prop['rt'][PT.ThrowPot].energy = Math.min(1, prop['rt'][PT.ThrowPot].energy + 0.25);
    }
    const before = prop.getState(PT.ThrowPot).energy;
    prop.onBossSpawned();
    expect(prop.getState(PT.ThrowPot).energy).toBe(before); // 未额外充能
  });
});
