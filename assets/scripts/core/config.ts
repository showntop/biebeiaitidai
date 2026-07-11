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
import level1Json from '../../config/levels/level-1.json';
import level2Json from '../../config/levels/level-2.json';
import level3Json from '../../config/levels/level-3.json';
import level4Json from '../../config/levels/level-4.json';
import level5Json from '../../config/levels/level-5.json';
import level6Json from '../../config/levels/level-6.json';
import level7Json from '../../config/levels/level-7.json';
import level8Json from '../../config/levels/level-8.json';
import level9Json from '../../config/levels/level-9.json';
import level10Json from '../../config/levels/level-10.json';
import level11Json from '../../config/levels/level-11.json';
import level12Json from '../../config/levels/level-12.json';
import level13Json from '../../config/levels/level-13.json';
import level14Json from '../../config/levels/level-14.json';
import level15Json from '../../config/levels/level-15.json';
import level16Json from '../../config/levels/level-16.json';
import level17Json from '../../config/levels/level-17.json';
import level18Json from '../../config/levels/level-18.json';
import level19Json from '../../config/levels/level-19.json';
import level20Json from '../../config/levels/level-20.json';
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
  boss: {
    tellSlots: number;
    guaranteeEnergyThreshold: number;
    guaranteeFillTo: number;
    /** §5.4 Boss 生成概率：分区基础概率 × 阶段倍率（hunt/good 区不生成）。 */
    spawnProb: {
      zone: { danger: number; ok: number };
      phaseMul: { early: number; mid: number; crisis: number };
    };
  };
  /** §6.2 星级评价阈值。 */
  stars: { huntFastWinSec: number };
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
  /** §1.3 主题叙事标题（如"第1轮反击"）。 */
  title?: string;
  durationSec: number;
  slots: number;
  approvalInit: number;
  whiteDistribution: { early: WhiteDist; mid: WhiteDist; crisis: WhiteDist };
  idleCardRatio: number;
  boss: { enabled: boolean; minSpawnSec: number };
  /** §1.2 本关解锁的道具类型（首次出现的道具）。 */
  unlockedProps?: PropType[];
  /** §6.2 三星挑战提示文案（关卡可覆写）。 */
  challengeHint?: string;
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

/**
 * M2 验证批次关卡序列（§1.1 锯齿难度曲线 3难+1甜点+1检查点）。
 * 索引 0 即第1关。完成 N 关解锁 N+1 关。
 */
export const LevelSequence: LevelDef[] = [
  level1Json as unknown as LevelDef,
  level2Json as unknown as LevelDef,
  level3Json as unknown as LevelDef,
  level4Json as unknown as LevelDef,
  level5Json as unknown as LevelDef,
  level6Json as unknown as LevelDef,
  level7Json as unknown as LevelDef,
  level8Json as unknown as LevelDef,
  level9Json as unknown as LevelDef,
  level10Json as unknown as LevelDef,
  level11Json as unknown as LevelDef,
  level12Json as unknown as LevelDef,
  level13Json as unknown as LevelDef,
  level14Json as unknown as LevelDef,
  level15Json as unknown as LevelDef,
  level16Json as unknown as LevelDef,
  level17Json as unknown as LevelDef,
  level18Json as unknown as LevelDef,
  level19Json as unknown as LevelDef,
  level20Json as unknown as LevelDef,
];

/** §1.2 当前已解锁的道具（累积，关卡序列驱动）。 */
export function unlockedPropsUpTo(levelIndex: number): PropType[] {
  const acc = new Set<PropType>();
  for (let i = 0; i <= levelIndex && i < LevelSequence.length; i++) {
    const def = LevelSequence[i];
    if (def.unlockedProps) for (const p of def.unlockedProps) acc.add(p);
  }
  return Array.from(acc);
}

/** 按关卡序号取 LevelDef（越界返回最后一关，便于"无限模式"兜底）。 */
export function getLevel(index: number): LevelDef {
  if (index < 0) return LevelSequence[0];
  if (index >= LevelSequence.length) return LevelSequence[LevelSequence.length - 1];
  return LevelSequence[index];
}

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
