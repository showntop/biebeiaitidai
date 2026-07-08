import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../assets/scripts/core/EventBus';
import { ConveyorSystem } from '../assets/scripts/core/systems/ConveyorSystem';
import { BalanceConfig, DefaultLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import type { Card } from '../assets/scripts/core/types';

describe('ConveyorSystem · 生成与位移', () => {
  let bus: EventBus;
  let conv: ConveyorSystem;
  beforeEach(() => {
    bus = new EventBus();
    conv = new ConveyorSystem(BalanceConfig, DefaultLevel, bus, new SeededRng(42));
  });

  it('generate 在入口（最右）追加卡', () => {
    expect(conv.size).toBe(0);
    conv.generate('early');
    expect(conv.size).toBe(1);
  });

  it('step 结算最左卡并整体左移', () => {
    // 生成 2 张，再 step：head 被结算，size 减 1
    conv.generate('early');
    conv.generate('early');
    const before = conv.size;
    const processed: Card[] = [];
    bus.on('CardEnteredProcessing', ({ card }) => processed.push(card));
    conv.step();
    expect(processed).toHaveLength(1);
    expect(conv.size).toBe(before - 1);
  });

  it('空队列 step 不抛错、不发 CardEnteredProcessing', () => {
    let fired = false;
    bus.on('CardEnteredProcessing', () => (fired = true));
    expect(() => conv.step()).not.toThrow();
    expect(fired).toBe(false);
  });

  it('生成分布可复现（同种子同序列）', () => {
    const a = new ConveyorSystem(BalanceConfig, DefaultLevel, bus, new SeededRng(7));
    const b = new ConveyorSystem(BalanceConfig, DefaultLevel, new EventBus(), new SeededRng(7));
    const catsA: string[] = [];
    const catsB: string[] = [];
    for (let i = 0; i < 20; i++) {
      a.generate('mid');
      b.generate('mid');
      catsA.push(a.slotAt(a.size - 1)!.category);
      catsB.push(b.slotAt(b.size - 1)!.category);
    }
    expect(catsA).toEqual(catsB);
  });
});

describe('ConveyorSystem · 道具作用（§4.2）', () => {
  let bus: EventBus;
  let conv: ConveyorSystem;
  beforeEach(() => {
    bus = new EventBus();
    conv = new ConveyorSystem(BalanceConfig, DefaultLevel, bus, new SeededRng(1));
  });

  it('改需求：活跃白卡 → 返工卡；非活跃白卡目标失败', () => {
    conv.generate('early'); // 一张活跃白卡在 index0
    const target = conv.slotAt(0)!;
    expect(target.state).toBe('active-white');
    expect(conv.reworkAt(0)).toBe(true);
    expect(conv.slotAt(0)!.state).toBe('rework');
    // 再改一次（已是返工卡）应失败
    expect(conv.reworkAt(0)).toBe(false);
  });

  it('丢锅：范围内清空，返回炸掉张数', () => {
    for (let i = 0; i < 4; i++) conv.generate('early');
    const before = conv.size;
    const removed = conv.clearRange(1, 1); // 炸 index0..2
    expect(removed).toBe(3);
    expect(conv.size).toBe(before - 3);
  });

  it('加需求：在 slot 插入灰插队卡，其后右移', () => {
    conv.generate('early');
    conv.generate('early');
    const before = conv.size;
    conv.insertGrayAt(0);
    expect(conv.size).toBe(before + 1);
    expect(conv.slotAt(0)!.state).toBe('inserted');
  });
});

describe('ConveyorSystem · Boss临检（§5.4）', () => {
  let bus: EventBus;
  let conv: ConveyorSystem;
  beforeEach(() => {
    bus = new EventBus();
    conv = new ConveyorSystem(BalanceConfig, DefaultLevel, bus, new SeededRng(1));
  });

  it('生成 Boss 时发 BossSpawned，且场上标记存在', () => {
    let spawned = 0;
    bus.on('BossSpawned', () => spawned++);
    conv.generate('crisis', { forceBoss: true });
    expect(spawned).toBe(1);
    expect(conv.hasBoss()).toBe(true);
  });

  it('Boss 进入最后4格分级发 BossIncoming(tier 递减)', () => {
    const tiers: number[] = [];
    bus.on('BossIncoming', ({ tier }) => tiers.push(tier));
    // 把 Boss 放到最右，前面塞几张白卡占位
    conv.generate('crisis', { forceBoss: true }); // boss 在 index0（队列只有它）
    // 让 boss 逐步靠近处理区：此时它在 index0，立即进入 tell
    // 重新构造：先放 3 张白卡再放 boss，使 boss 在 index3
    conv.reset();
    conv.generate('early');
    conv.generate('early');
    conv.generate('early');
    conv.generate('crisis', { forceBoss: true }); // [W1,W2,W3,B] boss idx3
    // 3 次 step 消耗 3 张白卡，Boss 从 idx3 → idx0，期间发 tier3/2/1
    conv.step(); // boss→idx2 tier3
    conv.step(); // boss→idx1 tier2
    conv.step(); // boss→idx0 tier1（head 仍是最后一张白卡）
    expect(tiers).toContain(3);
    expect(tiers).toContain(2);
    // 第 4 次 step：head=Boss → 触发临检
    const inspections: number[] = [];
    bus.on('BossInspection', ({ threatCards }) => inspections.push(threatCards.length));
    conv.step();
    expect(inspections).toHaveLength(1);
    expect(conv.hasBoss()).toBe(false);
  });

  it('Boss 一次性结算其身后全部活跃白卡（防二次结算），返工卡保留', () => {
    let settleCount = -1;
    bus.on('BossInspection', ({ threatCards }) => (settleCount = threatCards.length));
    // Boss 排在最前，身后 1 张返工卡 + 2 张活跃白卡
    conv.generate('crisis', { forceBoss: true }); // [B]
    conv.generate('early'); // [B, W1]
    conv.generate('early'); // [B, W1, W2]
    // 把 W2 改成返工卡以验证返工卡不计入、不被移除
    conv.reworkAt(2); // [B, W1, R]
    conv.step(); // head=Boss → 临检
    expect(settleCount).toBe(1); // 仅 W1 计入
    // 结算后活跃白卡被移除，返工卡保留
    expect(conv.threatCards).toHaveLength(0);
    expect(conv.size).toBe(1); // 只剩返工卡
    expect(conv.slotAt(0)!.state).toBe('rework');
  });
});
