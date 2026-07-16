/**
 * 浏览器验收入口参数。保持在 core 中，方便纯 TS 单测并避免 QA 逻辑污染存档。
 *
 * 示例：?qa=perfect&seed=424242&level=3
 * - level 对外使用 1-based；内部统一转换为 0-based。
 * - 无效场景返回 null，正式环境不会启用任何 QA 行为。
 */
export const QaScenarios = [
  'entry',
  'playing',
  'drag',
  'perfect',
  'crisis',
  'result-lose',
  'result-survive',
  'result-hunt',
] as const;

export type QaScenario = (typeof QaScenarios)[number];

export interface QaLaunchConfig {
  scenario: QaScenario;
  seed: number;
  levelIndex: number;
}

const DEFAULT_SEED = 424242;

function queryValue(search: string, key: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const splitAt = pair.indexOf('=');
    const rawKey = splitAt >= 0 ? pair.slice(0, splitAt) : pair;
    if (decodeURIComponent(rawKey.replace(/\+/g, ' ')) !== key) continue;
    const rawValue = splitAt >= 0 ? pair.slice(splitAt + 1) : '';
    return decodeURIComponent(rawValue.replace(/\+/g, ' '));
  }
  return null;
}

export function parseQaLaunchConfig(search: string | undefined, levelCount = 20): QaLaunchConfig | null {
  if (!search) return null;
  const scenarioValue = queryValue(search, 'qa');
  if (!scenarioValue || !(QaScenarios as readonly string[]).includes(scenarioValue)) return null;

  const seedParam = queryValue(search, 'seed');
  const seedValue = seedParam === null || seedParam.trim() === '' ? Number.NaN : Number(seedParam);
  const seed = Number.isFinite(seedValue) && seedValue >= 0
    ? Math.trunc(seedValue) >>> 0
    : DEFAULT_SEED;

  const levelParam = queryValue(search, 'level');
  const levelValue = levelParam === null || levelParam.trim() === '' ? Number.NaN : Number(levelParam);
  const requestedLevel = Number.isFinite(levelValue) ? Math.trunc(levelValue) : 1;
  const maxLevel = Math.max(1, Math.trunc(levelCount));
  const levelIndex = Math.max(1, Math.min(maxLevel, requestedLevel)) - 1;

  return { scenario: scenarioValue as QaScenario, seed, levelIndex };
}
