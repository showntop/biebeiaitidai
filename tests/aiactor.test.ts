import { describe, it, expect } from 'vitest';
import { EventBus } from '../assets/scripts/core/EventBus';
import { AIActorSystem } from '../assets/scripts/core/systems/AIActorSystem';
import { BalanceConfig } from '../assets/scripts/core/config';
import type { Card } from '../assets/scripts/core/types';

function mk(weight: number): Card {
  return { id: 1, category: 'urgent', state: 'active-white', weight, isThreat: true };
}

describe('AIActorSystem · 表情触发（§7）', () => {
  it('改需求命中高权重白卡 → surprised', () => {
    const bus = new EventBus();
    const ai = new AIActorSystem(bus, BalanceConfig);
    bus.emit('CardHit', { prop: 'change-demand', slot: 0, quality: 'normal', card: mk(10) });
    expect(ai.expression).toBe('surprised');
  });

  it('改需求命中低权重白卡 → slight-frown', () => {
    const bus = new EventBus();
    const ai = new AIActorSystem(bus, BalanceConfig);
    bus.emit('CardHit', { prop: 'change-demand', slot: 0, quality: 'normal', card: mk(2) });
    expect(ai.expression).toBe('slight-frown');
  });

  it('丢锅命中 → bewildered', () => {
    const bus = new EventBus();
    const ai = new AIActorSystem(bus, BalanceConfig);
    bus.emit('CardHit', { prop: 'throw-pot', slot: 0, quality: 'normal', card: mk(5) });
    expect(ai.expression).toBe('bewildered');
  });

  it('认可度进入危险区 → panic（高优先级压过低权重皱眉）', () => {
    const bus = new EventBus();
    const ai = new AIActorSystem(bus, BalanceConfig);
    bus.emit('CardHit', { prop: 'add-demand', slot: 0, quality: 'normal' }); // slight-frown pri2
    bus.emit('ZoneChanged', { from: 'ok', to: 'danger' }); // panic pri8
    expect(ai.expression).toBe('panic');
  });

  it('3连击 → combo-face', () => {
    const bus = new EventBus();
    const ai = new AIActorSystem(bus, BalanceConfig);
    bus.emit('ComboUpdated', { combo: 3 });
    expect(ai.expression).toBe('combo-face');
  });

  it('表情到期后回落到 null', () => {
    const bus = new EventBus();
    const ai = new AIActorSystem(bus, BalanceConfig);
    bus.emit('CardHit', { prop: 'change-demand', slot: 0, quality: 'normal', card: mk(10) });
    expect(ai.expression).toBe('surprised');
    ai.tick(0.6); // surprised 时长 0.5s，到期
    expect(ai.expression).toBeNull();
  });
});
