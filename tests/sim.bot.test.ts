import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { DefaultLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { DefensiveBot, OffensiveBot } from './bots';
import type { Bot } from './bots';

interface BotStat {
  name: string;
  result: Record<string, number>;
  stars: { [k: string]: number };
  avgPeak: number;
  avgTime: number;
}

/** 把一局跑到结束，返回该 bot 的聚合统计。 */
function runBot(name: string, BotCtor: new () => Bot, N: number): BotStat {
  const result: Record<string, number> = { 'win-hunt': 0, 'win-survive': 0, lose: 0 };
  const stars = [0, 0, 0, 0];
  let peakSum = 0;
  let timeSum = 0;
  const dt = 0.05;
  for (let s = 1; s <= N; s++) {
    const g = new Game(DefaultLevel, new SeededRng(s));
    const bot = new BotCtor();
    for (let t = 0; t < 90 && !g.over; t += dt) {
      bot.step(g);
      g.tick(dt);
    }
    result[g.result]++;
    stars[g.stars]++;
    peakSum += g.peakApproval;
    timeSum += g.elapsed;
  }
  return {
    name,
    result,
    stars: { '0': stars[0], '1': stars[1], '2': stars[2], '3': stars[3] },
    avgPeak: +(peakSum / N).toFixed(1),
    avgTime: +(timeSum / N).toFixed(1),
  };
}

describe('SIM: 防守 vs 进攻 bot 千局对照（平衡诊断）', () => {
  it('prints comparison', () => {
    const N = 1000;
    const out = [runBot('defensive', DefensiveBot, N), runBot('offensive', OffensiveBot, N)];
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
    expect(true).toBe(true);
  });
});
