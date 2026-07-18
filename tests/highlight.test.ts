import { describe, expect, it } from 'vitest';
import { EventBus } from '../assets/scripts/core/EventBus';
import { HighlightSystem, highlightQuip } from '../assets/scripts/core/systems/HighlightSystem';
import type { Card, HighlightId } from '../assets/scripts/core/types';

const activeCard: Card = {
  id: 1,
  category: 'key',
  state: 'active-white',
  weight: 5,
  isThreat: true,
};

describe('HighlightSystem', () => {
  it('连续 Perfect、三连击只各颁发一次并选最高级高光', () => {
    const bus = new EventBus();
    const highlights = new HighlightSystem(bus);
    const emitted: HighlightId[] = [];
    bus.on('Highlight', ({ id }) => emitted.push(id));

    for (let i = 0; i < 4; i++) {
      highlights.tick(0.5);
      bus.emit('CardHit', { prop: 'change-demand', slot: 2, quality: 'perfect', card: activeCard });
    }
    bus.emit('ComboUpdated', { combo: 3 });
    bus.emit('ComboUpdated', { combo: 5 });
    bus.emit('ComboUpdated', { combo: 5 });

    expect(emitted).toEqual(['clean-hit', 'perfect-chain', 'combo-3', 'combo-5']);
    expect(highlights.best?.id).toBe('perfect-chain');
    expect(highlights.earned[0].atSec).toBe(0.5);
  });

  it('识别 Boss 门口拦截和危险区十二秒内翻盘', () => {
    const bus = new EventBus();
    const highlights = new HighlightSystem(bus);
    bus.emit('BossIncoming', { tier: 1, slot: 0 });
    bus.emit('CardHit', {
      prop: 'throw-pot',
      slot: 3,
      quality: 'normal',
      card: { ...activeCard, id: 9, category: 'boss', state: 'boss' },
    });
    bus.emit('ZoneChanged', { from: 'ok', to: 'danger' });
    highlights.tick(4);
    bus.emit('ZoneChanged', { from: 'danger', to: 'ok' });
    highlights.tick(3);
    bus.emit('ZoneChanged', { from: 'ok', to: 'good' });

    expect(highlights.earned.map((h) => h.id)).toEqual(['boss-clutch', 'danger-comeback']);
  });

  it('结算保证至少一个叙事锚点，并识别复活反杀', () => {
    const lossBus = new EventBus();
    const loss = new HighlightSystem(lossBus);
    lossBus.emit('GameOver', { result: 'lose' });
    expect(loss.best?.id).toBe('last-stand');

    const winBus = new EventBus();
    const win = new HighlightSystem(winBus);
    winBus.emit('Revived', { approval: 69, bonusSec: 8 });
    winBus.emit('GameOver', { result: 'win-hunt' });
    expect(win.earned.map((h) => h.id)).toEqual(['hunt-finish', 'revive-comeback']);
    expect(win.best?.id).toBe('revive-comeback');
    expect(highlightQuip('revive-comeback')).toContain('又回来了');
  });
});
