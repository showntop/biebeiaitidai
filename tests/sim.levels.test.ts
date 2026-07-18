import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { LevelSequence, allowedPropsForLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { DefensiveBot, OffensiveBot } from './bots';
import type { Bot } from './bots';

interface LevelStat {
  level: number;
  id: string;
  title: string;
  winRate: number;
  huntRate: number;
  lose: number;
  avgPeak: number;
  bossFired: number;
}

function runSim(botFactory: () => Bot, label: string, N = 300): LevelStat[] {
  const dt = 0.05;
  return LevelSequence.map((level, idx) => {
    const result: Record<string, number> = { 'win-hunt': 0, 'win-survive': 0, lose: 0 };
    let peakSum = 0;
    let bossFired = 0;
    for (let s = 1; s <= N; s++) {
      const g = new Game(level, new SeededRng(s + idx * 9973), allowedPropsForLevel(idx));
      g.bus.on('BossInspection', () => bossFired++);
      const bot = botFactory();
      for (let t = 0; t < 120 && !g.over; t += dt) {
        bot.step(g);
        g.tick(dt);
      }
      result[g.result]++;
      peakSum += g.peakApproval;
    }
    return {
      level: idx + 1,
      id: level.id,
      title: level.title ?? level.id,
      winRate: +(((result['win-survive'] + result['win-hunt']) / N) * 100).toFixed(0),
      huntRate: +((result['win-hunt'] / N) * 100).toFixed(1),
      lose: result.lose,
      avgPeak: +(peakSum / N).toFixed(1),
      bossFired,
    };
  });
}

describe('SIM: 逐关难度曲线（防守 bot）', () => {
  it('prints per-level stats', () => {
    const out = runSim(() => new DefensiveBot(), 'defensive');
    // eslint-disable-next-line no-console
    console.log('[defensive]', JSON.stringify(out));
    expect(out).toHaveLength(LevelSequence.length);
  });
});

describe('SIM: 逐关猎杀可达性（进攻 bot）', () => {
  it('prints per-level hunt stats', () => {
    const out = runSim(() => new OffensiveBot(), 'offensive');
    // eslint-disable-next-line no-console
    console.log('[offensive]', JSON.stringify(out));
    // 进攻 bot 每关猎杀率应 > 0（非近乎0）
    for (const s of out) {
      expect(s.huntRate, `L${s.level} 猎杀率应>0`).toBeGreaterThan(0);
    }
    expect(out).toHaveLength(LevelSequence.length);
  });
});
