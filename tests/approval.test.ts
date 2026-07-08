import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../assets/scripts/core/EventBus';
import { ApprovalSystem } from '../assets/scripts/core/systems/ApprovalSystem';
import { BalanceConfig, zoneFor } from '../assets/scripts/core/config';
import type { Card, CardCategory, CardState, GameResult } from '../assets/scripts/core/types';

let _id = 1;
function mkCard(category: CardCategory, state: CardState, weight: number): Card {
  return { id: _id++, category, state, weight, isThreat: state === 'active-white' };
}

describe('ApprovalSystem · 认可度基础', () => {
  let bus: EventBus;
  let sys: ApprovalSystem;
  beforeEach(() => {
    bus = new EventBus();
    sys = new ApprovalSystem(BalanceConfig, bus);
  });

  it('初始认可度 = 配置值 40，分区 good', () => {
    expect(sys.value).toBe(40);
    expect(sys.currentZone).toBe('good');
    expect(zoneFor(BalanceConfig, 40)).toBe('good');
  });

  it('活跃白卡结算 +权重（§5.2）', () => {
    sys.resolveCard(mkCard('routine', 'active-white', 2));
    expect(sys.value).toBe(42);
  });

  it('返工卡结算 -权重，为唯一倒扣来源（§5.2）', () => {
    sys.resolveCard(mkCard('urgent', 'rework', 10));
    expect(sys.value).toBe(30);
  });

  it('倒扣钳位至下限 0，不越界（§5.1）', () => {
    for (let i = 0; i < 6; i++) sys.resolveCard(mkCard('urgent', 'rework', 10));
    expect(sys.value).toBe(0);
    expect(zoneFor(BalanceConfig, 0)).toBe('hunt');
  });

  it('摸鱼卡/插队卡结算不改变认可度', () => {
    sys.resolveCard(mkCard('meeting', 'idle', 0));
    sys.resolveCard(mkCard('routine', 'inserted', 2));
    expect(sys.value).toBe(40);
  });

  it('分区跨越时发 ZoneChanged（good→danger）', () => {
    const changes: string[] = [];
    bus.on('ZoneChanged', ({ to }) => changes.push(to));
    for (let i = 0; i < 4; i++) sys.resolveCard(mkCard('urgent', 'active-white', 10)); // 40→80
    expect(sys.currentZone).toBe('danger');
    expect(changes).toContain('danger');
  });
});

describe('ApprovalSystem · Boss临检结算（§5.4）', () => {
  let bus: EventBus;
  let sys: ApprovalSystem;
  beforeEach(() => {
    bus = new EventBus();
    sys = new ApprovalSystem(BalanceConfig, bus);
  });

  it('Boss结算只加不减，仅计活跃白卡正权重（返工卡被忽略）', () => {
    const sum = sys.bossSettle([
      mkCard('routine', 'active-white', 2),
      mkCard('urgent', 'active-white', 10),
      mkCard('urgent', 'rework', 10), // 返工卡不参与 Boss 结算
    ]);
    expect(sum).toBe(12);
    expect(sys.value).toBe(52);
  });

  it('空威胁列表 Boss 结算为 0，认可度不变', () => {
    expect(sys.bossSettle([])).toBe(0);
    expect(sys.value).toBe(40);
  });
});

describe('ApprovalSystem · 双路径胜负（§6.2）', () => {
  let bus: EventBus;
  let sys: ApprovalSystem;
  beforeEach(() => {
    bus = new EventBus();
    sys = new ApprovalSystem(BalanceConfig, bus);
  });

  it('认可度达 100 → 判负 lose（§6.1）', () => {
    const results: GameResult[] = [];
    bus.on('GameOver', ({ result }) => results.push(result));
    for (let i = 0; i < 6; i++) sys.resolveCard(mkCard('urgent', 'active-white', 10)); // 40→100
    expect(sys.value).toBe(100);
    expect(sys.currentResult).toBe('lose');
    expect(results).toEqual(['lose']);
  });

  it('认可度跌入猎杀线并持续维持 2 秒 → 猎杀式通关 win-hunt（§6.2①）', () => {
    const results: GameResult[] = [];
    const charges: number[] = [];
    bus.on('GameOver', ({ result }) => results.push(result));
    bus.on('HuntChargeStart', ({ approval }) => charges.push(approval));
    // 40 → 倒扣到 12（猎杀线 ≤25 内）
    sys.resolveCard(mkCard('urgent', 'rework', 10)); // 30
    sys.resolveCard(mkCard('urgent', 'rework', 10)); // 20 → hunt(≤25)
    sys.resolveCard(mkCard('urgent', 'rework', 8)); // 12 → hunt
    expect(sys.currentZone).toBe('hunt');
    sys.tick(1.0); // 累计 1s，未满 2s 不触发
    expect(sys.currentResult).toBe('ongoing');
    sys.tick(1.0); // 累计 2s，触发
    expect(sys.currentResult).toBe('win-hunt');
    expect(results).toEqual(['win-hunt']);
    expect(charges).toEqual([12]);
  });

  it('猎杀维持期间回升出猎杀线 → 中断重新计时（§6.2① hold 语义）', () => {
    sys.resolveCard(mkCard('urgent', 'rework', 10)); // 30
    sys.resolveCard(mkCard('urgent', 'rework', 5)); // 25 → hunt(≤25)
    sys.tick(1.0); // 累计 1s
    sys.resolveCard(mkCard('routine', 'active-white', 3)); // +3 → 28，回升出猎杀线
    expect(sys.currentZone).toBe('good');
    sys.tick(1.0); // 中断后重新计时，此时累计仅 1s，不触发
    expect(sys.currentResult).toBe('ongoing');
    // 再次跌回猎杀线并维持满 2s
    sys.resolveCard(mkCard('urgent', 'rework', 10)); // 18 → hunt
    sys.tick(2.0);
    expect(sys.currentResult).toBe('win-hunt');
  });

  it('倒计时归零未触发其它判定 → 生存式通关 win-survive（§6.2②）', () => {
    const results: GameResult[] = [];
    bus.on('GameOver', ({ result }) => results.push(result));
    sys.declareSurviveOnTimeout();
    expect(sys.currentResult).toBe('win-survive');
    expect(results).toEqual(['win-survive']);
  });

  it('已结算（lose/win-hunt）后不再被覆盖（防重复结算）', () => {
    bus.on('GameOver', () => {});
    for (let i = 0; i < 6; i++) sys.resolveCard(mkCard('urgent', 'active-white', 10)); // lose
    expect(sys.currentResult).toBe('lose');
    sys.declareSurviveOnTimeout(); // 不应改成 win-survive
    expect(sys.currentResult).toBe('lose');
  });
});

describe('ApprovalSystem · 拍马屁冻结（§4.2）', () => {
  it('冻结期间不结算、不计猎杀维持', () => {
    const bus = new EventBus();
    const sys = new ApprovalSystem(BalanceConfig, bus);
    // 先打到猎杀线
    sys.resolveCard(mkCard('urgent', 'rework', 10));
    sys.resolveCard(mkCard('urgent', 'rework', 10));
    sys.resolveCard(mkCard('urgent', 'rework', 10)); // 10 → hunt
    sys.setFrozen(true);
    sys.resolveCard(mkCard('routine', 'active-white', 2)); // 冻结忽略
    expect(sys.value).toBe(10);
    sys.tick(5.0); // 冻结期间不计维持
    expect(sys.currentResult).toBe('ongoing');
    sys.setFrozen(false);
    sys.tick(2.0); // 解冻后维持满 2s 触发
    expect(sys.currentResult).toBe('win-hunt');
  });
});
