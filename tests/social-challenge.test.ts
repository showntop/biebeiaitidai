import { describe, expect, it } from 'vitest';
import {
  buildSharePayload,
  createDailyChallenge,
  createFriendChallenge,
  decodeChallenge,
  encodeChallenge,
  parseChallengeQuery,
} from '../assets/scripts/core/SocialChallenge';
import type { RunReport } from '../assets/scripts/core/RunReport';

function report(result: RunReport['result'] = 'win-survive'): RunReport {
  return {
    result,
    stars: result === 'lose' ? 0 : 3,
    levelIndex: 4,
    levelId: 'level-5',
    levelTitle: '第5轮反击',
    peakApproval: 82,
    finalApproval: 43,
    timeUsedSec: 58.4,
    durationSec: 60,
    bossInspectionsFired: 0,
    maxCombo: 5,
    effectiveHits: 8,
    perfectHits: 3,
    missedThrows: 1,
    revived: false,
    highlights: ['clean-hit', 'combo-5'],
    highlightTitle: '工位永动机',
  };
}

describe('SocialChallenge', () => {
  it('同一天的每日挑战完全确定，不同日期变化', () => {
    expect(createDailyChallenge('2026-07-18')).toEqual(createDailyChallenge('2026-07-18'));
    expect(createDailyChallenge('2026-07-19')).not.toEqual(createDailyChallenge('2026-07-18'));
    expect(() => createDailyChallenge('18/07/2026')).toThrow();
  });

  it('好友挑战短码可校验、可稳定往返、篡改后拒绝', () => {
    const challenge = createFriendChallenge(7, 0xfedcba98);
    const code = encodeChallenge(challenge);
    const decoded = decodeChallenge(code);
    expect(decoded).toEqual(challenge);
    expect(encodeChallenge(decoded!)).toBe(code);
    expect(parseChallengeQuery(`?foo=1&challenge=${encodeURIComponent(code)}`)).toEqual(challenge);
    expect(decodeChallenge(`${code.slice(0, -1)}x`)).toBeNull();
  });

  it('战报仅输出正向指标，并把同 seed 挑战带入 query', () => {
    const payload = buildSharePayload(report(), '反替代打工人', 9, 12345);
    expect(payload.title).toContain('工位守住了');
    expect(payload.card.metrics.map((m) => m.label)).toEqual(['坚守时间', '最高连击', 'Perfect']);
    expect(payload.card.metrics.every((m) => !m.label.includes('失败') && !m.label.includes('失误'))).toBe(true);
    expect(parseChallengeQuery(`?${payload.query}`)).toMatchObject({ levelIndex: 4, seed: 12345, mode: 'friend' });
  });

  it('反杀、红区翻盘和失败生成不同战报类型', () => {
    expect(buildSharePayload(report('win-hunt'), 'AI克星', 20, 1).card.variant).toBe('hunt');
    const comeback = report();
    comeback.highlights = ['danger-comeback'];
    expect(buildSharePayload(comeback, '岗位保卫者', 2, 2).card.variant).toBe('comeback');
    expect(buildSharePayload(report('lose'), '岗位保卫者', 1, 3).card.variant).toBe('last-stand');
  });
});
