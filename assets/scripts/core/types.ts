/**
 * 领域类型与事件契约 —— 对应《别让AI替代你-核心玩法策划》。
 *
 * 设计纪律：本文件及其同目录（core/）下的所有代码【零 Cocos 依赖】，
 * 仅用纯 TS 表达规则，使其可在 Node 下被单测、被千局模拟、与表现层物理隔离。
 */

/* ---------------- 卡片（策划文档§3.1） ---------------- */

/** 卡片类别（决定权重与类别色） */
export const CardCategory = {
  Routine: 'routine', // 常规 蓝 权重2
  Report: 'report', // 汇报 橙 权重4
  Key: 'key', // 关键 紫 权重5
  Proposal: 'proposal', // 提案 青 权重7
  Urgent: 'urgent', // 紧急 琥珀 权重10（全场最高威胁）
  Meeting: 'meeting', // 会议 浅灰 0（摸鱼卡）
  Document: 'document', // 文档 浅灰 0（摸鱼卡）
  Boss: 'boss', // Boss临检 特殊事件
} as const;
export type CardCategory = (typeof CardCategory)[keyof typeof CardCategory];

/**
 * 卡片状态通道（与类别色正交，决定"还要不要管"，策划文档§3.1 状态通道）。
 * 配色铁律：场上唯一的"卡片红"是返工卡，活跃白卡全部用饱和类别色，绝不撞红。
 */
export const CardState = {
  ActiveWhite: 'active-white', // 活跃白卡：活的威胁，原样抵达 → 认可度 +权重
  Rework: 'rework', // 返工卡（被「改需求」中和）：红底，抵达 → 认可度 -权重（唯一倒扣）
  Inserted: 'inserted', // 插队卡（被「加需求」插入）：灰底斜纹，纯拖延，认可度不变
  Idle: 'idle', // 摸鱼卡（会议/文档）：浅灰，权重0
  Boss: 'boss', // Boss临检卡
} as const;
export type CardState = (typeof CardState)[keyof typeof CardState];

export interface Card {
  id: number;
  category: CardCategory;
  state: CardState;
  /** 原始权重。活跃白卡抵达 +weight；返工卡抵达 -weight。 */
  weight: number;
  /** 是否仍为"活跃白卡威胁"（影响 Boss 结算、改需求目标判定）。 */
  isThreat: boolean;
}

/* ---------------- 道具（策划文档§4） ---------------- */

export const PropType = {
  AddDemand: 'add-demand', // 加需求：插入灰插队卡，纯拖延
  ChangeDemand: 'change-demand', // 改需求：活跃白卡→返工卡，唯一倒扣
  ThrowPot: 'throw-pot', // 丢锅：以命中点为中心炸连续3张
  KissUp: 'kiss-up', // 拍马屁：冻结传送带1.5~2s
} as const;
export type PropType = (typeof PropType)[keyof typeof PropType];

export const Acquisition = { CD: 'cd', Energy: 'energy' } as const;
export type Acquisition = (typeof Acquisition)[keyof typeof Acquisition];

/* ---------------- 认可度（策划文档§5） ---------------- */

/** 认可度分区（含猎杀线，§5.1）。 */
export const ApprovalZone = {
  Hunt: 'hunt', // 0~18 猎杀线：持续达2秒 → 猎杀式通关（数值见 assets/config/balance.json，随M4调优变化，此处不重复维护具体值）
  Good: 'good', // 猎杀线之上~49 状态良好
  Ok: 'ok', // 50~69 勉强接受：白卡生成速度加成见config
  Danger: 'danger', // 70~100 危险：白卡生成速度加成上升，Boss概率上升
} as const;
export type ApprovalZone = (typeof ApprovalZone)[keyof typeof ApprovalZone];

/** 单局阶段（策划文档§5.3 节奏递增） */
export const GamePhase = { Early: 'early', Mid: 'mid', Crisis: 'crisis' } as const;
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];

/** 胜负结果（开发计划§2 ApprovalSystem 三路判定 + 生存式） */
export const GameResult = {
  Ongoing: 'ongoing',
  WinHunt: 'win-hunt', // 猎杀式通关：认可度跌入猎杀线并维持2秒（§6.2①）
  WinSurvive: 'win-survive', // 生存式通关：倒计时归零且未触发其它判定（§6.2②）
  Lose: 'lose', // 认可度≥100（含Boss结算后），AI替代你（§6.1）
} as const;
export type GameResult = (typeof GameResult)[keyof typeof GameResult];

/** 命中质量（策划文档§4.3 Perfect判定） */
export const HitQuality = { Miss: 'miss', Normal: 'normal', Perfect: 'perfect' } as const;
export type HitQuality = (typeof HitQuality)[keyof typeof HitQuality];

/** Perfect 命中后的随机奖励类型（策划文档§4.3）。 */
export const PerfectRewardType = {
  CooldownRefill: 'cd-refill-10',
  ExtraUse: 'extra-use',
  EnergyFull: 'energy-full',
} as const;
export type PerfectRewardType = (typeof PerfectRewardType)[keyof typeof PerfectRewardType];

/** Boss分级预警挡位（§5.4①，进入最后4格分级增强） */
export type BossTellTier = 4 | 3 | 2 | 1;

/** 一局内可被结算、战报与分享共同复用的高光类型。 */
export type HighlightId =
  | 'clean-hit'
  | 'combo-3'
  | 'combo-5'
  | 'perfect-chain'
  | 'boss-clutch'
  | 'danger-comeback'
  | 'hunt-finish'
  | 'revive-comeback'
  | 'hold-the-line'
  | 'last-stand';

export type HighlightTier = 1 | 2 | 3;

export interface HighlightMoment {
  id: HighlightId;
  label: string;
  /** 1=轻高光，2=强高光，3=本局封面级高光。 */
  tier: HighlightTier;
  /** 发生于本局第几秒，供回放/埋点使用。 */
  atSec: number;
}

/* ---------------- 事件契约（开发计划§2，discriminated union） ---------------- */

export interface GameEvents {
  /** 一张卡抵达处理区被结算（§5.2）。delta 为本次认可度变化。 */
  CardResolved: { card: Card; delta: number };
  /** 传送带整体左移一格（离散挡位，§4.3） */
  CardShifted: { tickIndex: number; outgoing?: Card | null };
  /** 某挡位为空（空挡，命中即Miss） */
  SlotEmpty: { slot: number };
  /** 道具命中任务卡（加需求/改需求/丢锅），§4.3 */
  CardHit: { prop: PropType; slot: number; quality: HitQuality; card?: Card };
  /** Perfect 命中后实际抽中的奖励，供表现层明确告诉玩家“赚到了什么”。 */
  PerfectRewardGranted: { prop: PropType; reward: PerfectRewardType };
  /** 拍马屁命中AI本体（独立事件，不复用CardHit，开发计划§2） */
  AIHit: { quality: HitQuality };
  /** 无效目标/空挡Miss（不消耗次数，§4.3） */
  PropUnavailable: { prop: PropType; slot: number; reason: 'empty' | 'invalid-target' };
  /** 蓄力中取消（不消耗次数，§4.3-4） */
  PropCanceled: { prop: PropType };
  /** 认可度变化 */
  ApprovalChanged: { from: number; to: number; delta: number };
  /** 认可度跨越分区边界 */
  ZoneChanged: { from: ApprovalZone; to: ApprovalZone };
  /** 认可度跌入猎杀线，开始计时维持 */
  HuntChargeStart: { approval: number };
  /** 猎杀维持中断（回升出猎杀线） */
  HuntChargeBreak: { approval: number };
  /** Boss卡分级预警（进入最后4格递进，§5.4①） */
  BossIncoming: { tier: BossTellTier; slot: number };
  /** 连击更新（纯演出层，§4.4） */
  ComboUpdated: { combo: number };
  /** 单局阶段切换，用于提示中盘加速与最后冲刺。 */
  PhaseChanged: { from: GamePhase; to: GamePhase };
  /** 一张普通卡抵达处理区（Conveyor→Approval，由 Approval 计算认可度变化） */
  CardEnteredProcessing: { card: Card };
  /** Boss卡生成进入队列（→PropSystem 触发§5.4②资源保底） */
  BossSpawned: { card: Card };
  /** Boss资源保底已生效（PropSystem在onBossSpawned中把丢锅能量从<阈值拉到保证值时发出，供UI/M4验收监听） */
  BossGuaranteeTriggered: { filledTo: number };
  /** Boss卡抵达处理区，强制结算当前所有活跃白卡（→ApprovalSystem.bossSettle） */
  BossInspection: { threatCards: Card[] };
  /** 拍马屁命中AI本体，请求冻结传送带（→Game 暂停 belt/approval） */
  KissUpFreeze: { durationSec: number };
  /** AI表情请求（AIActorSystem→表现层，纯演出） */
  AIExpression: { expression: ExpressionId; durationSec: number; priority: number };
  /** 可截图、可结算、可分享的本局高光。 */
  Highlight: HighlightMoment;
  /** 局结束 */
  GameOver: { result: GameResult };
  /** §2.1 复活生效（认可度回滚+加时+清Boss临检）。供 UI 弹窗/演出层订阅。 */
  Revived: { approval: number; bonusSec: number };
}

/** AI 表情标识（对应策划文档§7 表情触发表，纯演出层用） */
export type ExpressionId =
  | 'slight-frown' // 命中/插入低权重卡 0.3s
  | 'surprised' // 改需求命中高权重白卡 0.5s
  | 'bewildered' // 丢锅批量清空 0.6s
  | 'combo-face' // 3连击加强表情
  | 'confident' // 认可度低位/良好
  | 'sweat' // 跨越50
  | 'panic' // 跨越70 危险
  | 'busy-pretend' // Boss分级预警 装忙
  | 'shy' // 拍马屁命中
  | 'idle-look' // 空闲张望
  | 'tense' // 持续危险区紧张
  | 'facepalm' // 连续 Perfect / 极限拦截后捂脸
  | 'crashed' // 高连击后短暂死机
  | 'called-in'; // 猎杀式通关 被叫去谈话

/** 传送带只读视图（PropSystem 仅需读取挡位以判定目标有效性，不持有 ConveyorSystem 引用） */
export interface BeltView {
  readonly size: number;
  slotAt(i: number): Card | null;
}
