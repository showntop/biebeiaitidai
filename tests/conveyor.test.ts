import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../assets/scripts/core/EventBus';
import { ConveyorSystem } from '../assets/scripts/core/systems/ConveyorSystem';
import { BalanceConfig, DefaultLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import type { Card } from '../assets/scripts/core/types';
import type { LevelDef } from '../assets/scripts/core/config';

const SLOTS = DefaultLevel.slots; // 6

describe('ConveyorSystem · 固定槽位模型', () => {
  let bus: EventBus;
  let conv: ConveyorSystem;
  beforeEach(() => {
    bus = new EventBus();
    conv = new ConveyorSystem(BalanceConfig, DefaultLevel, bus, new SeededRng(42));
  });

  it('generate 在入口 slot(N-1) 放卡', () => {
    expect(conv.size).toBe(0);
    conv.generate('early');
    expect(conv.size).toBe(1);
    expect(conv.slotAt(SLOTS - 1)?.state).toBe('active-white');
  });

  it('入口被占时本次生成丢弃（需 step 腾位才能再放）', () => {
    conv.generate('early'); // slot5
    conv.generate('early'); // slot5 仍被占 → 丢弃
    expect(conv.size).toBe(1);
    conv.step(); // 左移，slot5 腾空
    conv.generate('early'); // 放入 slot5
    expect(conv.size).toBe(2);
  });

  it('【回归】卡牌需 N 步才结算：穿越期间(~N×slotPeriod)不结算，给玩家反应时间', () => {
    conv.generate('early'); // slot5
    const card = conv.slotAt(SLOTS - 1);
    expect(card?.state).toBe('active-white');
    let resolved = 0;
    bus.on('CardEnteredProcessing', () => resolved++);
    // 走 N-1 步：slot5→slot0，尚未结算
    for (let i = 0; i < SLOTS - 1; i++) conv.step();
    expect(resolved).toBe(0); // 关键：穿越期间不结算（旧 bug 会立即结算）
    expect(conv.slotAt(0)).toBe(card);
    // 第 N 步：抵达处理区被结算
    conv.step();
    expect(resolved).toBe(1);
  });

  it('step 结算 slot0 并左移（空槽不报错）', () => {
    expect(() => conv.step()).not.toThrow();
    conv.generate('early');
    for (let i = 0; i < SLOTS - 1; i++) conv.step();
    let processed: Card[] = [];
    bus.on('CardEnteredProcessing', ({ card }) => processed.push(card));
    conv.step();
    expect(processed).toHaveLength(1);
  });
});

describe('ConveyorSystem · 道具作用（§4.2，按槽位）', () => {
  let bus: EventBus;
  let conv: ConveyorSystem;
  beforeEach(() => {
    bus = new EventBus();
    conv = new ConveyorSystem(BalanceConfig, DefaultLevel, bus, new SeededRng(1));
  });

  it('改需求：slot 处活跃白卡 → 返工卡；非活跃目标失败', () => {
    conv.generate('early');
    for (let i = 0; i < SLOTS - 1; i++) conv.step(); // 卡到 slot0
    expect(conv.slotAt(0)!.state).toBe('active-white');
    expect(conv.reworkAt(0)).toBe(true);
    expect(conv.slotAt(0)!.state).toBe('rework');
    expect(conv.reworkAt(0)).toBe(false); // 已是返工卡
  });

  it('丢锅：以 slot 为中心炸范围内卡，留空档（不压缩）', () => {
    // 在 slot0、slot1、slot2 各放一张：连续 generate+step 积累
    for (let k = 0; k < SLOTS; k++) {
      conv.generate('early');
      conv.step();
    }
    const before = conv.size;
    const removed = conv.clearRange(1, 1); // 炸 slot0..2
    expect(removed).toBe(3);
    expect(conv.size).toBe(before - 3);
    expect(conv.slotAt(0)).toBeNull(); // 留空档
  });

  it('加需求：slot 处插入灰插队卡，其后右移', () => {
    conv.generate('early');
    for (let i = 0; i < SLOTS - 1; i++) conv.step(); // 卡到 slot0
    conv.insertGrayAt(0);
    expect(conv.slotAt(0)!.state).toBe('inserted');
  });

  it('hasCardsInRange：范围内有卡返回 true', () => {
    conv.generate('early'); // slot5
    expect(conv.hasCardsInRange(0, 1)).toBe(false); // slot0..2 空
    expect(conv.hasCardsInRange(SLOTS - 1, 1)).toBe(true); // slot4..5 含卡
  });
});

describe('ConveyorSystem · Boss临检（§5.4）', () => {
  let bus: EventBus;
  let conv: ConveyorSystem;
  beforeEach(() => {
    bus = new EventBus();
    conv = new ConveyorSystem(BalanceConfig, DefaultLevel, bus, new SeededRng(1));
  });

  it('生成 Boss 发 BossSpawned，标记存在', () => {
    let spawned = 0;
    bus.on('BossSpawned', () => spawned++);
    conv.generate('crisis', { forceBoss: true });
    expect(spawned).toBe(1);
    expect(conv.hasBoss()).toBe(true);
  });

  it('Boss 走到 slot0 触发临检（发 BossInspection），并移除自身', () => {
    const tiers: number[] = [];
    bus.on('BossIncoming', ({ tier }) => tiers.push(tier));
    let inspections = 0;
    bus.on('BossInspection', () => inspections++);
    conv.generate('crisis', { forceBoss: true }); // Boss slot5
    // 走到 slot0 并结算（最多 SLOTS 步）
    for (let i = 0; i < SLOTS + 1 && conv.hasBoss(); i++) conv.step();
    expect(inspections).toBe(1);
    expect(conv.hasBoss()).toBe(false);
    expect(tiers.length).toBeGreaterThan(0); // 期间发过分级预警
  });

  it('clearBoss 移除场上 Boss 卡（§2.1 复活辅助）', () => {
    conv.generate('crisis', { forceBoss: true });
    expect(conv.hasBoss()).toBe(true);
    expect(conv.clearBoss()).toBe(1);
    expect(conv.hasBoss()).toBe(false);
  });
});

describe('ConveyorSystem · 中后期任务变体', () => {
  const modifierLevel = (overrides?: Partial<LevelDef>): LevelDef => ({
    ...DefaultLevel,
    idleCardRatio: 0,
    whiteDistribution: {
      early: { routine: 0, report: 0, key: 1, proposal: 0, urgent: 0 },
      mid: { routine: 0, report: 0, key: 1, proposal: 0, urgent: 0 },
      crisis: { routine: 0, report: 0, key: 1, proposal: 0, urgent: 0 },
    },
    taskModifiers: {
      eliteRatio: { early: 1, mid: 1, crisis: 1 },
      linkRatio: { early: 0, mid: 0, crisis: 0 },
      eliteMinWeight: 5,
      eliteGuardReduction: 2,
      linkBonus: 1,
      maxElite: 2,
    },
    ...overrides,
  });

  it('精英任务第一次改需求只破盾，第二次才转返工', () => {
    const bus = new EventBus();
    const conv = new ConveyorSystem(BalanceConfig, modifierLevel(), bus, new SeededRng(3));
    let broken = 0;
    bus.on('EliteGuardBroken', () => broken++);
    conv.generate('mid');
    const slot = DefaultLevel.slots - 1;
    const card = conv.slotAt(slot)!;
    expect(card).toMatchObject({ elite: true, guard: 1, state: 'active-white', weight: 7 });
    expect(conv.changeDemandAt(slot)).toMatchObject({ changed: true, reworked: false, guardBroken: true, riskPrevented: 2 });
    expect(card).toMatchObject({ guard: 0, state: 'active-white', weight: 5, isThreat: true });
    expect(conv.changeDemandAt(slot)).toMatchObject({ changed: true, reworked: true, guardBroken: false, riskPrevented: 10 });
    expect(card).toMatchObject({ state: 'rework', isThreat: false });
    expect(broken).toBe(1);
  });

  it('抱团形成后双方 +1 风险，移除任意伙伴会让剩余任务恢复', () => {
    const base = modifierLevel();
    const level = modifierLevel({
      taskModifiers: {
        ...base.taskModifiers!,
        eliteRatio: { early: 0, mid: 0, crisis: 0 },
        linkRatio: { early: 1, mid: 1, crisis: 1 },
      },
    });
    const bus = new EventBus();
    const conv = new ConveyorSystem(BalanceConfig, level, bus, new SeededRng(4));
    let formed = 0;
    let broken = 0;
    bus.on('TaskLinkFormed', () => formed++);
    bus.on('TaskLinkBroken', () => broken++);
    conv.generate('mid');
    conv.step();
    conv.generate('mid');
    const left = conv.slotAt(DefaultLevel.slots - 2)!;
    const right = conv.slotAt(DefaultLevel.slots - 1)!;
    expect(left.weight).toBe(6);
    expect(right.weight).toBe(6);
    expect(left.linkId).toBe(right.linkId);
    conv.clearRange(DefaultLevel.slots - 1, 0);
    expect(left).toMatchObject({ weight: 5, linkBonus: 0 });
    expect(left.linkId).toBeUndefined();
    expect(formed).toBe(1);
    expect(broken).toBe(1);
  });

  it('Boss 专属加盾机制作用于现有任务，并发准确摘要', () => {
    const level = modifierLevel({
      taskModifiers: undefined,
      boss: { enabled: true, minSpawnSec: 0, arrivalEffect: 'fortify-all' },
    });
    const bus = new EventBus();
    const conv = new ConveyorSystem(BalanceConfig, level, bus, new SeededRng(6));
    conv.generate('mid');
    conv.step();
    conv.generate('mid');
    conv.step();
    let affected = 0;
    let cardIds: number[] = [];
    bus.on('BossArrivalEffect', (event) => {
      affected = event.affected;
      cardIds = event.cardIds;
    });
    conv.generate('mid', { forceBoss: true });
    expect(affected).toBe(2);
    expect(cardIds).toHaveLength(2);
    expect(new Set(cardIds).size).toBe(2);
    expect(conv.threatCards.map((card) => card.id).sort()).toEqual([...cardIds].sort());
    expect(conv.threatCards.every((card) => card.guard === 1 && card.elite)).toBe(true);
  });
});
