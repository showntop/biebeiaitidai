import type { BalanceConfigT, CardDef, LevelDef, PropDef } from './config';
import type { CardCategory, PropType } from './types';

export interface ProjectConfigBundle {
  cards: Record<CardCategory, CardDef>;
  props: Record<PropType, PropDef> & { perfectRewards: Array<{ p: number; type: string }> };
  balance: BalanceConfigT;
  levels: readonly LevelDef[];
}

/**
 * 内容配置在启动时一次性校验。错误直接带字段路径，避免策划表改坏后进入一局才暴露。
 * 这里刻意不用额外运行时依赖，保证微信小游戏包体与启动路径稳定。
 */
export function validateProjectConfig(bundle: ProjectConfigBundle): string[] {
  const errors: string[] = [];
  const finite = (value: unknown, path: string, min = Number.NEGATIVE_INFINITY) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) errors.push(`${path} must be a finite number >= ${min}`);
  };

  const cardEntries = Object.entries(bundle.cards) as Array<[CardCategory, CardDef]>;
  if (cardEntries.length < 8) errors.push('cards must define all task categories');
  for (const [key, card] of cardEntries) {
    finite(card?.weight, `cards.${key}.weight`, 0);
    if (!card?.label) errors.push(`cards.${key}.label is required`);
  }

  const propKeys: PropType[] = ['add-demand', 'change-demand', 'throw-pot', 'kiss-up'];
  for (const key of propKeys) {
    const prop = bundle.props[key];
    if (!prop) {
      errors.push(`props.${key} is required`);
      continue;
    }
    finite(prop.totalCap, `props.${key}.totalCap`, 0);
    if (!prop.label || !prop.effect) errors.push(`props.${key} label/effect are required`);
  }
  const rewardProbability = bundle.props.perfectRewards?.reduce((sum, reward) => sum + (reward?.p ?? 0), 0) ?? 0;
  if (Math.abs(rewardProbability - 1) > 0.001) errors.push('props.perfectRewards probabilities must sum to 1');

  finite(bundle.balance?.approval?.min, 'balance.approval.min');
  finite(bundle.balance?.approval?.max, 'balance.approval.max');
  if (bundle.balance?.approval?.min >= bundle.balance?.approval?.max) errors.push('balance.approval min must be below max');

  if (bundle.levels.length !== 20) errors.push(`levels must contain 20 entries, got ${bundle.levels.length}`);
  const ids = new Set<string>();
  bundle.levels.forEach((level, index) => {
    const path = `levels[${index}]`;
    if (!level?.id) errors.push(`${path}.id is required`);
    else if (ids.has(level.id)) errors.push(`${path}.id must be unique`);
    else ids.add(level.id);
    finite(level?.durationSec, `${path}.durationSec`, 1);
    finite(level?.slots, `${path}.slots`, 1);
    finite(level?.approvalInit, `${path}.approvalInit`, bundle.balance.approval.min);
    if (level?.approvalInit > bundle.balance.approval.max) errors.push(`${path}.approvalInit exceeds approval max`);
    for (const phase of ['early', 'mid', 'crisis'] as const) {
      const distribution = level?.whiteDistribution?.[phase];
      if (!distribution) {
        errors.push(`${path}.whiteDistribution.${phase} is required`);
        continue;
      }
      const total = Object.values(distribution).reduce((sum, value) => sum + value, 0);
      // 小于 1 的尾段按 ConveyorSystem 约定回落到 routine；大于 1 会截断后半类别，属于配置错误。
      if (total < 0.90 || total > 1.001) errors.push(`${path}.whiteDistribution.${phase} must sum to 0.90..1`);
    }
    if (!level?.objective?.label) errors.push(`${path}.objective.label is required`);
  });
  return errors;
}

export function assertProjectConfig(bundle: ProjectConfigBundle): void {
  const errors = validateProjectConfig(bundle);
  if (errors.length > 0) throw new Error(`[ConfigValidation]\n${errors.join('\n')}`);
}
