/**
 * 数据驱动配置加载（开发计划§1：Excel/CSV→JSON，策划改表不动代码）。
 *
 * 所有数值（卡权重、道具CD/上限、认可度分区、阶段节奏、Boss规则、连击）
 * 全部来自 assets/config/*.json，core 代码不硬编码任何平衡常量。
 * 改数值 = 改 JSON，不需要程序发版、不需要 Cocos 编辑器。
 */
import cardsJson from '../../config/cards.json';
import propsJson from '../../config/props.json';
import balanceJson from '../../config/balance.json';
import levelJson from '../../config/level-default.json';
import type { CardCategory, PropType, GamePhase, ApprovalZone } from './types';

export interface CardDef {
  weight: number;
  color: string;
  threat: boolean;
  label: string;
}

export interface PhaseCd {
  early: number;
  mid: number;
  crisis: number;
}

export interface PerfectReward {
  p: number;
  type: 'cd-refill-10' | 'extra-use' | 'energy-full';
}

export interface PropDef {
  label: string;
  acquisition: 'cd' | 'energy';
  cd?: PhaseCd;
  totalCap: number;
  energyPerEffectiveHit?: number;
  energyFillRateRatio?: number;
  energyPerSec?: number;
  clearRadius?: number;
  freezeSec?: { min: number; max: number };
  effect: string;
}

export interface ZoneDef {
  lo: number;
  hi: number;
  genBonus: number;
  /** 仅猎杀区有：持续维持该秒数触发猎杀式通关。 */
  holdSec?: number;
}

export interface PhaseDef {
  fromSec: number;
  toSec: number;
  genIntervalSec: number;
  slotPeriodSec: number;
}

export interface BalanceConfigT {
  approval: { init: number; min: number; max: number };
  zones: { hunt: ZoneDef; good: ZoneDef; ok: ZoneDef; danger: ZoneDef };
  phases: { early: PhaseDef; mid: PhaseDef; crisis: PhaseDef };
  boss: { tellSlots: number; guaranteeEnergyThreshold: number; guaranteeFillTo: number };
  combo: { windowSec: number; tierExpressions: number };
  control: { scanSec: number; perfectWindowRatio: number };
}

export interface WhiteDist {
  routine: number;
  report: number;
  key: number;
  proposal: number;
  urgent: number;
}

export interface LevelDef {
  id: string;
  durationSec: number;
  slots: number;
  approvalInit: number;
  whiteDistribution: { early: WhiteDist; mid: WhiteDist; crisis: WhiteDist };
  idleCardRatio: number;
  boss: { enabled: boolean; minSpawnSec: number };
}

/** 卡片定义表（按类别查权重/颜色/是否威胁）。 */
export const CardsConfig = cardsJson as unknown as Record<CardCategory, CardDef>;

/** 道具定义表 + Perfect 可变奖励池。 */
export const PropsConfig = propsJson as unknown as Record<PropType, PropDef> & {
  perfectRewards: PerfectReward[];
};

/** 全局平衡参数（认可度分区/阶段节奏/Boss规则/连击）。 */
export const BalanceConfig = balanceJson as unknown as BalanceConfigT;

/** 默认 60 秒标准关（策划文档§8 单局节奏模拟）。 */
export const DefaultLevel = levelJson as unknown as LevelDef;

export function getCardDef(cat: CardCategory): CardDef {
  return CardsConfig[cat];
}

export function getPropDef(prop: PropType): PropDef {
  return PropsConfig[prop];
}

/** 根据认可度数值查分区（config 驱动，分区边界来自 balance.json）。 */
export function zoneFor(cfg: BalanceConfigT, value: number): ApprovalZone {
  const z = cfg.zones;
  if (value <= z.hunt.hi) return 'hunt';
  if (value <= z.good.hi) return 'good';
  if (value <= z.ok.hi) return 'ok';
  return 'danger';
}

/** 根据单局已用时长查阶段（config 驱动）。 */
export function phaseFor(cfg: BalanceConfigT, elapsedSec: number): GamePhase {
  const p = cfg.phases;
  if (elapsedSec < p.mid.fromSec) return 'early';
  if (elapsedSec < p.crisis.fromSec) return 'mid';
  return 'crisis';
}
