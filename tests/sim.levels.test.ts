import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { LevelSequence, unlockedPropsUpTo } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { DefensiveBot } from './bots';

/**
 * 逐关难度曲线诊断：对每一关跑防守 bot，输出胜/猎杀/负/峰值/Boss临检次数。
 * 验证：① 难度随关数上升但可过；② Boss 关(L10)在关卡流里正常触发临检；
 *       ③ 锁定道具在各关被正确禁用（bot 不会用未解锁道具）。
 */
describe('SIM: 逐关难度曲线（防守 bot）', () => {
  it('prints per-level stats', () => {
    const N = 300;
    const out = LevelSequence.map((level, idx) => {
      const result: Record<string, number> = { 'win-hunt': 0, 'win-survive': 0, lose: 0 };
      let peakSum = 0;
      let bossFired = 0;
      const dt = 0.05;
      for (let s = 1; s <= N; s++) {
        const g = new Game(level, new SeededRng(s + idx * 9973), unlockedPropsUpTo(idx));
        g.bus.on('BossInspection', () => bossFired++);
        const bot = new DefensiveBot();
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
        title: level.title,
        winRate: +(((result['win-survive'] + result['win-hunt']) / N) * 100).toFixed(0),
        hunt: result['win-hunt'],
        lose: result.lose,
        avgPeak: +(peakSum / N).toFixed(1),
        bossFired,
      };
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
    expect(out).toHaveLength(LevelSequence.length);
  });
});
