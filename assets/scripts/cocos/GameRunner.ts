import { _decorator, Component, Node, Label, Color, UITransform, UIOpacity, tween, Tween, Vec3, Rect, input, Input, EventKeyboard, EventTouch, EventMouse, Sprite, SpriteFrame, resources, Texture2D, view, Graphics, sys, Mask, instantiate, game as ccGame, Game as CocosGame } from 'cc';
import { Game } from '../core/Game';
import { getLevel, BalanceConfig, getCardDef } from '../core/config';
import { SeededRng } from '../core/rng';
import { InMemoryStorage, Session } from '../core/Session';
import type { Storage } from '../core/Session';
import { parseQaLaunchConfig } from '../core/QaLaunchConfig';
import type { QaLaunchConfig } from '../core/QaLaunchConfig';
import type { RunTelemetry } from '../core/Telemetry';
import { onboardingBriefing, onboardingNudge, onboardingRetryHint } from '../core/Onboarding';
import { AchievementHints, AchievementLabels, CosmeticLabels, RankLabels, bestStarsFor, rankProgress, rankProgressFromScore, totalStars } from '../core/profile';
import { highlightQuip } from '../core/systems/HighlightSystem';
import { buildSharePayload, createDailyChallenge, encodeChallenge, localDateKey, parseChallengeQuery } from '../core/SocialChallenge';
import type { ChallengeSpec } from '../core/SocialChallenge';
import type { AchievementId, PlayerProfile } from '../core/profile';
import type { RunReport } from '../core/RunReport';
import { CardState as CS, HitQuality as HQ, PropType as PT } from '../core/types';
import type { Card, HitQuality, PerfectRewardType, PropType } from '../core/types';
import {
  boundedThrowPeakY,
  findLockedCardSlot,
  guidedThrowLeadPoint,
  isManualThrowGesture,
  projectedThrowTargetX,
  throwPresentationStrength,
} from '../core/ThrowGesture';
import { FxLayer } from './FxLayer';
import { ApprovalGaugeView } from './ui/ApprovalGaugeView';
import { PropButtonView } from './ui/PropButtonView';
import { ResultDialogView, type ResultDialogButton } from './ui/ResultDialogView';
import { TaskCardView } from './ui/TaskCardView';
import { CharacterRigView } from './ui/CharacterRigView';
import { PressureAtmosphereView } from './ui/PressureAtmosphereView';
import { PauseMenuView } from './ui/PauseMenuView';
import { UiPainter, type CardShellState, type KeycapState } from './ui/UiPainter';
import { UiTokens, alphaColor } from './ui/UiTokens';
import { createTelemetryBridge } from './TelemetryBridge';
import { SensoryFeedback } from './SensoryFeedback';
import { ShareBridge } from './ShareBridge';
import { RewardedAdBridge } from './RewardedAdBridge';
import { RuntimeMonitor } from './RuntimeMonitor';
import { CareerChapters, nextStarMilestone } from '../core/CareerRoute';
import { AimPredictionView } from './ui/AimPredictionView';

const { ccclass, property } = _decorator;

interface CardVisual {
  node: Node;
  slotIndex: number;
  signature: string;
  moving: boolean;
  pendingCard: Card | null;
}

interface PaperTuning {
  arcHeight: number;
  duration: number;
  spin: number;
  startScale: Vec3;
  midScale: Vec3;
  endScale: Vec3;
  /** 越高越跟手；重道具刻意保留一点惯性。 */
  followHz: number;
  /** 起手弹起尺度，让四种道具在第一触感上可区分。 */
  liftScale: number;
  /** 横向拖动时的速度形变量。 */
  dragStretchFactor: number;
}

type PaperOutcome = 'hit' | 'miss' | 'invalid';
type PropInteractionState = 'idle' | 'arming' | 'dragging' | 'launching';

/**
 * Cocos 表现层薄壳 —— 持有 core.Session + core.Game，只做：驱动 tick、转发输入、按 Session 状态渲染。
 *
 * 关卡流（继续进度 / 选关 / 结算 / 解锁 / 段位 / 战报 / 下一关 / 重试）的可测逻辑全在 core/Session，
 * 这里只把按钮事件翻译成 Session/Game 调用、把 Session 状态反映到节点。
 *
 * 【需在编辑器验证的节点接线】新增节点（相对旧版）：
 *   - LevelLabel (Label)  顶部：当前关标题 + 反替代进度
 *   - ReportLabel (Label) 居中：局结束显示战报（结果/星级/峰值/连击 + 战报梗文案）；默认隐藏
 *   - NextBtn (Node)      结算时显示，点按进入下一关（hasNext=false 时隐藏）
 *   - RetryBtn (Node)     结算时显示，点按重试本关
 *   - ReviveBtn (Node)    结算 lose 且未复活时显示，点按复活（每关限1次；键盘 V 同效，不接线也能用 V）
 * 旧节点沿用：Belt(6格)/Approval/Zone/Timer/ScanIndicator/Props(4按钮)/Result。
 */
@ccclass('GameRunner')
export class GameRunner extends Component {
  @property(Node) beltNode: Node | null = null;
  @property(Label) approvalLabel: Label | null = null;
  @property(Label) zoneLabel: Label | null = null;
  @property(Label) timerLabel: Label | null = null;
  @property(Node) propButtons: Node | null = null;
  @property(Node) scanIndicator: Node | null = null;
  @property(Label) levelLabel: Label | null = null; // 新增：关卡标题/段位/天数
  @property(Label) reportLabel: Label | null = null; // 新增：战报
  @property(Node) nextBtn: Node | null = null; // 新增：下一关
  @property(Node) retryBtn: Node | null = null; // 新增：重试
  @property(Node) reviveBtn: Node | null = null; // 新增：复活（仅 lose 且未用过复活时显示；键盘 V 同效，无需接线）

  // 美术资源：运行时从 resources/art/ 自动加载，编辑器里无需手动接线
  private artSprites: Map<string, SpriteFrame> = new Map();
  private bgFillNode: Node | null = null;
  private bgNode: Node | null = null;
  private monitorSurfaceNode: Node | null = null;
  private conveyorTrackNode: Node | null = null;
  private deskDecorNode: Node | null = null;
  private deskItemNodes: Node[] = [];
  private charNode: Node | null = null;
  private characterRigView: CharacterRigView | null = null;
  private pressureAtmosphereNode: Node | null = null;
  private pressureAtmosphereView: PressureAtmosphereView | null = null;
  private pauseButtonNode: Node | null = null;
  private pauseMenuNode: Node | null = null;
  private readonly pauseMenuView = new PauseMenuView();
  private paused = false;
  private pauseWasAutomatic = false;
  /** 动态创建的游戏标题和倒计时（不依赖场景绑定节点） */
  private gameTitleNode: Node | null = null;
  private gameTimerNode: Node | null = null;
  /** 显示器外的顶部/底部 HUD。保持显示器背景与内屏节点不被重绘。 */
  private subtitleNode: Node | null = null;
  private lowerHudNode: Node | null = null;
  /** 方案 3 的实体控制台底座与计时器铭牌。 */
  private timerPlateNode: Node | null = null;
  private monitorLabelNode: Node | null = null;
  private monitorProcessLabelNode: Node | null = null;
  private monitorEntryLabelNode: Node | null = null;
  private resultScrimNode: Node | null = null;
  /** 蓄力时吸附到目标卡槽的光圈，和虚线弹道一起构成完整预判。 */
  private aimTargetNode: Node | null = null;

  private session!: Session;
  private game!: Game;
  private telemetry!: RunTelemetry;
  private readonly shareBridge = new ShareBridge();
  private readonly rewardedAds = new RewardedAdBridge();
  private runtimeMonitor: RuntimeMonitor | null = null;
  private reviveAdPending = false;
  private incomingChallenge: ChallengeSpec | null = null;
  private currentSeed = 0;
  private readonly dt = 0.05; // 逻辑固定步进
  private accumulator = 0;
  private slotNodes: Node[] = [];
  /** 每个卡槽的 Graphics 背景节点（代码画圆角矩形底）。创建/定位见 ensureSlotBackgrounds / layoutBeltSlots。 */
  private slotBackgrounds: Node[] = [];
  private readonly cardBackgroundSignatures = new Map<string, string>();
  private readonly emptySlotRendered = new Set<string>();
  /**
   * 卡片视觉按 card.id 持有，不再按槽位复用。
   * 这是保证"移动中内容不换卡"和出口物理裁切的核心。
   */
  private cardVisuals = new Map<number, CardVisual>();
  private propButtonNodes: Node[] = [];
  private propButtonBackgrounds: Node[] = [];
  private propIconSprites: (Sprite | null)[] = [];
  private propActionLabels: Label[] = [];
  private propButtonViews: PropButtonView[] = [];
  private approvalGaugeView: ApprovalGaugeView | null = null;
  private aimingProp: PropType | null = null;
  private propInteractionState: PropInteractionState = 'idle';
  private aimingSlot = 0;
  private aimStart = new Vec3();
  private aimPoint = new Vec3();
  /** 目标选择轴与纸团手指位置解耦：纸团跟手，横向位移只推动这根虚拟选择轴。 */
  private aimSelectionX = 0;
  /** 触摸事件只更新目标点；真正的视觉跟随在 update 中每帧最多执行一次。 */
  private aimDesiredPoint = new Vec3();
  private aimSlotTargets: Vec3[] = [];
  private aimRenderedSlot = -1;
  private aimVelocityX = 0;
  private aimVisualTime = 0;
  private aimTargetKick = 0;
  private aimLockSec = 0;
  private aimPerfectReady = false;
  private aimTargetValid = true;
  private aimRecommendationSlot = -1;
  /** 轻点默认使用推荐目标；越过手势死区后才切换为左右手动选位。 */
  private aimManualTargeting = false;
  /** 改需求/甩锅锁定卡片身份，传送带移动时不会误命中新来的邻卡。 */
  private aimLockedCardId: number | null = null;
  /** 范围道具允许锁住中心附近卡片，并保持它相对爆心的槽位偏移。 */
  private aimLockedCardOffset = 0;
  private aimGestureStart = new Vec3();
  private aimGestureLast = new Vec3();
  private aimGestureLastMs = 0;
  private aimReleaseVelocityY = 0;
  private aimReleaseVelocityX = 0;
  /** 只有先离开道具键、再拖回键上，才进入可见的“收回”状态。 */
  private aimHasLeftSource = false;
  private aimReturnCancel = false;
  private activeAimTouchId: number | null = null;
  private readonly sensory = new SensoryFeedback();
  private paperAimNode: Node | null = null;
  private paperAimShadowNode: Node | null = null;
  private aimEffectPreviewNode: Node | null = null;
  private aimDirectionNode: Node | null = null;
  /** 准星旁直接写明将命中谁以及预计收益，避免玩家自行猜线和终点。 */
  private aimPredictionView: AimPredictionView | null = null;
  private scanPos = 0;
  private reported = false; // 本局是否已结算展示（防止重复 finishLevel）
  /** 首次失败仍可复活时延迟 level_end，确保复活后的最终结果只结算一次。 */
  private pendingTelemetryReport: { report: RunReport; failReason: 'unhandled-task' | 'boss-inspection' | 'unknown' } | null = null;
  private uiState: 'select' | 'playing' | 'result' = 'select';
  private levelSelectRoot: Node | null = null;
  private careerPanelNode: Node | null = null;
  private tutorialRoot: Node | null = null;
  private tutorialStep = 0;
  private tutorialDone = false;
  private onboardingNudgeShown = false;
  private perfectTipShown = false;
  private highRiskTipShown = false;
  private bossTipShown = false;
  private eliteTipShown = false;
  private linkTipShown = false;
  private fx: FxLayer | null = null;
  private eventUnsubs: Array<() => void> = [];
  private lastEventText = '';
  private eventTextUntilSec = 0;
  private eventTextPriority = 0;
  private compactHeader = false;
  /** URL 驱动的无存档 QA 场景；正式启动时始终为 null。 */
  private qaConfig: QaLaunchConfig | null = null;
  private qaApplied = false;
  private lastTimerText = '';
  private lastTimerPaintSignature = '';

  private static readonly PROP_LABELS = UiTokens.prop.labels;
  private static readonly PROP_ACTION_LABELS = UiTokens.prop.actionLabels;
  private static readonly PROP_TYPES: PropType[] = [PT.AddDemand, PT.ChangeDemand, PT.ThrowPot, PT.KissUp];

  /** 道具按钮主色由 UiTokens.prop.colors 统一维护，避免按钮视觉到处散落。 */
  private static readonly PROP_COLORS: ReadonlyArray<Readonly<Color>> = UiTokens.prop.colors;
  /** 道具 key → artSprites 索引名（与 props/ 目录文件名约定一致）。 */
  private static readonly PROP_ART_KEYS = UiTokens.asset.propArtKeys;
  /** 纸团飞行手感参数：表现层先集中调，手感稳定后再沉到 JSON。 */
  private static readonly PAPER_TUNING: Readonly<Record<PropType, PaperTuning>> = {
    [PT.AddDemand]: {
      arcHeight: 125,
      duration: 0.27,
      spin: 110,
      startScale: new Vec3(1, 1, 1),
      midScale: new Vec3(0.92, 1.08, 1),
      endScale: new Vec3(0.72, 0.72, 1),
      followHz: 38,
      liftScale: 1.04,
      dragStretchFactor: 0.88,
    },
    [PT.ChangeDemand]: {
      arcHeight: 175,
      duration: 0.32,
      spin: 480,
      startScale: new Vec3(1.03, 0.97, 1),
      midScale: new Vec3(0.84, 1.16, 1),
      endScale: new Vec3(0.66, 0.66, 1),
      followHz: 30,
      liftScale: 1.07,
      dragStretchFactor: 1.02,
    },
    [PT.ThrowPot]: {
      arcHeight: 72,
      duration: 0.34,
      spin: 210,
      startScale: new Vec3(1.08, 1.08, 1),
      midScale: new Vec3(1.08, 0.92, 1),
      endScale: new Vec3(0.82, 0.82, 1),
      followHz: 22,
      liftScale: 1.11,
      dragStretchFactor: 1.18,
    },
    [PT.KissUp]: {
      arcHeight: 96,
      duration: 0.34,
      spin: -420,
      startScale: new Vec3(0.96, 0.96, 1),
      midScale: new Vec3(0.86, 1.12, 1),
      endScale: new Vec3(0.42, 0.42, 1),
      followHz: 33,
      liftScale: 1.02,
      dragStretchFactor: 0.94,
    },
  };
  /** 任务队列使用专用图标卡，不再回退成英文类别文字。 */
  private static readonly CARD_ART_KEYS: Readonly<Record<string, string>> = UiTokens.asset.cardArtKeys;
  /** 卡片角标切片：底板统一，类别色只来自这层资产。 */
  private static readonly CARD_ACCENT_ART_KEYS: Readonly<Record<string, string>> = UiTokens.asset.cardAccentArtKeys;
  /** 空槽也显示即将到来的任务预览，避免队列退化成一排 "---"。 */
  private static readonly QUEUE_PREVIEW_ART_KEYS = UiTokens.asset.queuePreviewArtKeys;
  private static readonly QUEUE_PREVIEW_COLORS: ReadonlyArray<Readonly<Color>> = UiTokens.card.previewColors;

  /** 卡牌 Graphics 背景样式常量。卡牌 = 代码画圆角矩形底 + 纯图标 Sprite（见美术指南「卡牌/按钮=代码画底+纯图标」）。 */
  private static readonly CARD_BORDER_COLORS: Readonly<Record<string, Readonly<Color>>> = UiTokens.card.borderColors;
  private static readonly CARD_FILL_COLOR = UiTokens.card.fill;
  private static readonly CARD_BORDER_WIDTH = UiTokens.card.borderWidth;
  private static readonly CARD_CORNER_RADIUS = UiTokens.card.radius;
  /** Rework 返工卡底色（红底覆盖） */
  private static readonly COLOR_REWORK = UiTokens.card.rework;
  /** Inserted 杂活卡底色（灰底斜纹覆盖） */
  private static readonly COLOR_INSERTED = UiTokens.card.inserted;
  /** Idle 摸鱼卡底色（压暗原色） */
  private static readonly CARD_IDLE_DIM = UiTokens.card.idleDim;
  /** ActiveWhite 边框亮度（正常色），非活跃状态压暗系数 */
  private static readonly CARD_STROKE_DIM = UiTokens.card.strokeDim;

  /** 环境色（视觉规范§1.5，非功能区氛围底色）。 */
  private static readonly ENV_PANEL = UiTokens.environment.panel;
  private static readonly ENV_WALL = UiTokens.environment.wall;
  private static readonly ENV_DARK = UiTokens.environment.dark;

  /** “精密桌面玩具”主题令牌：环境克制，功能色爆发。 */
  private static readonly UI_IVORY = new Color(244, 235, 221, 255);
  private static readonly UI_PAPER = new Color(255, 250, 241, 255);
  private static readonly UI_INK = new Color(76, 67, 58, 255);
  private static readonly UI_MUTED = new Color(126, 114, 99, 255);
  private static readonly UI_WALNUT = new Color(168, 124, 88, 255);
  private static readonly UI_DANGER = new Color(220, 60, 60, 255);
  private static readonly START_BG = UiTokens.environment.startBg;
  private static readonly START_CARD = UiTokens.environment.startCard;
  private static readonly START_SOFT = UiTokens.environment.startSoft;
  private static readonly START_BLUE = UiTokens.color.blue;
  private static readonly START_BLUE_DARK = UiTokens.environment.startBlueDark;
  private static readonly START_TEXT = UiTokens.environment.startText;
  private static readonly START_MUTED = UiTokens.environment.startMuted;
  private static readonly TUTORIAL_DONE_KEY = 'biebeiaitidai.tutorial.done.v2';
  private static readonly PERFECT_TIP_KEY = 'biebeiaitidai.perfect.tip.v1';
  private static readonly HIGH_RISK_TIP_KEY = 'biebeiaitidai.high-risk.tip.v1';
  private static readonly BOSS_TIP_KEY = 'biebeiaitidai.boss.tip.v1';
  private static readonly ELITE_TIP_KEY = 'biebeiaitidai.elite.tip.v1';
  private static readonly LINK_TIP_KEY = 'biebeiaitidai.link.tip.v1';

  private startCardMetrics(): { width: number; height: number; cy: number; narrow: boolean } {
    const vis = view.getVisibleSize();
    const narrow = vis.height / Math.max(1, vis.width) >= 1.5;
    const width = Math.min(vis.width * (narrow ? 0.895 : 0.82), narrow ? 1000 : 860);
    const height = narrow
      ? Math.min(vis.height * 0.455, width * 1.12)
      : Math.min(vis.height * 0.47, width * 0.90);
    const cy = narrow ? vis.height * 0.02 : vis.height * 0.095;
    return { width, height, cy, narrow };
  }

  onLoad(): void {
    this.hideDebugOverlays();
    this.hideScenePlaceholderLabels();
    const locationSearch = (globalThis as { location?: { search?: string } }).location?.search;
    this.qaConfig = parseQaLaunchConfig(locationSearch);
    this.incomingChallenge = this.qaConfig ? null : parseChallengeQuery(locationSearch);
    this.telemetry = createTelemetryBridge(this.qaConfig !== null).telemetry;
    this.runtimeMonitor = new RuntimeMonitor(this.telemetry);
    this.runtimeMonitor.start();
    this.tutorialDone = this.qaConfig !== null || sys.localStorage?.getItem(GameRunner.TUTORIAL_DONE_KEY) === '1';
    this.perfectTipShown = this.qaConfig !== null || sys.localStorage?.getItem(GameRunner.PERFECT_TIP_KEY) === '1';
    this.highRiskTipShown = this.qaConfig !== null || sys.localStorage?.getItem(GameRunner.HIGH_RISK_TIP_KEY) === '1';
    this.bossTipShown = this.qaConfig !== null || sys.localStorage?.getItem(GameRunner.BOSS_TIP_KEY) === '1';
    this.eliteTipShown = this.qaConfig !== null || sys.localStorage?.getItem(GameRunner.ELITE_TIP_KEY) === '1';
    this.linkTipShown = this.qaConfig !== null || sys.localStorage?.getItem(GameRunner.LINK_TIP_KEY) === '1';
    this.session = new Session(this.qaConfig ? new InMemoryStorage() : new CocosStorage());
    if (this.qaConfig) this.session.profile.highestUnlockedLevel = this.qaConfig.levelIndex;
    this.session.continueProgress(); // 继续"最高解锁关"进度

    if (this.beltNode) this.beltNode.children.forEach((c: Node) => this.slotNodes.push(c));
    // eslint-disable-next-line no-console
    console.log(`[GameRunner] beltNode wired=${!!this.beltNode} slotNodes=${this.slotNodes.length}`);
    this.slotNodes.forEach((n: Node, i: number) => {
      if (!n.getComponent(Label)) {
        // eslint-disable-next-line no-console
        console.warn(`[GameRunner] Slot${i} 没有 Label 组件 → 卡牌渲染不出来。每个 Slot 子节点要挂 Label。`);
      }
    });
    this.bindPropButtons();
    this.bindFlowButtons();
    this.showLevelSelect(); // 先进入开始页，不直接开打

    // 桌面预览键盘兜底（绕过按钮命中区问题，先验证游戏逻辑）
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    // 纸团拖出按钮区域后，按钮节点会收到 TOUCH_CANCEL；后续拖动/松手必须由全局触摸接管。
    input.on(Input.EventType.TOUCH_MOVE, this.onGlobalTouchMove, this);
    input.on(Input.EventType.TOUCH_END, this.onGlobalTouchEnd, this);
    input.on(Input.EventType.TOUCH_CANCEL, this.onGlobalTouchCancel, this);
    input.on(Input.EventType.MOUSE_MOVE, this.onGlobalMouseMove, this);
    input.on(Input.EventType.MOUSE_UP, this.onGlobalMouseUp, this);
    ccGame.on(CocosGame.EVENT_HIDE, this.onAppHide, this);
    ccGame.on(CocosGame.EVENT_SHOW, this.onAppShow, this);

    // 美术资源自动加载：扫描 resources/art/ 下所有 PNG，按文件名建索引
    // 加载完成后自动建 Bg/Char 节点并接线，编辑器里无需任何手动操作
    this.loadArtAssets();
  }

  /** 扫描 resources/art/ 加载所有图片，按文件名建索引。 */
  private loadArtAssets(): void {
    // eslint-disable-next-line no-console
    console.log('[GameRunner] loadArtAssets: 开始扫描 resources/art/ ...');
    // getDirWithPath 拿到 art/ 下所有 Texture2D 的 {path, uuid} 列表
    const infos = (resources as any).getDirWithPath?.('art', Texture2D) ?? [];
    // eslint-disable-next-line no-console
    console.log(`[GameRunner] getDirWithPath 找到 ${infos.length} 张 Texture2D，原始路径：`, infos.map((i: any) => i.path));
    if (infos.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[GameRunner] 没找到任何 Texture2D → 请检查 resources/art/ 下是否有 PNG 文件且 .meta 已生成（编辑器需重新打开/导入）');
      this.applyQaScenarioOnce();
      return;
    }
    let remaining = infos.length;
    for (const info of infos) {
      resources.load(info.path, Texture2D, (err: Error | null, tex: Texture2D) => {
        remaining--;
        if (err || !tex) {
          // eslint-disable-next-line no-console
          console.warn(`[GameRunner] 加载失败: ${info.path}`, err?.message);
          this.runtimeMonitor?.assetLoadFailure(info.path);
        } else {
          const sf = new SpriteFrame();
          sf.texture = tex;
          const name = this.artNameFromPath(info.path);
          this.artSprites.set(name, sf);
          // eslint-disable-next-line no-console
          console.log(`[GameRunner]  loaded: ${name}  (from ${info.path})`);
        }
        if (remaining === 0) {
          // eslint-disable-next-line no-console
          console.log(`[GameRunner] 美术资源已加载 ${this.artSprites.size} 张：`, Array.from(this.artSprites.keys()));
          this.applyBgCharSprites();
          this.applyQaScenarioOnce();
        }
      });
    }
  }

  /** 从 resources 路径解析出美术资源名（key）。
   *  path 可能的形态（不同 Cocos 版本/导入状态有差异）：
   *    art/bg/bg-office/texture   → bg-office
   *    art/cards/card-routine     → card-routine
   *    art/props/prop-add-demand  → prop-add-demand
   *  规则：去掉末尾的子资产名（texture/spriteFrame），再取最后一段作为文件名；下划线归一为连字符。 */
  private artNameFromPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    // 丢弃末尾的子资产标记
    const last = parts[parts.length - 1] ?? '';
    if (last === 'texture' || last === 'spriteFrame') parts.pop();
    const name = parts[parts.length - 1] ?? '';
    return name.replace(/_/g, '-');
  }

  onDestroy(): void {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    input.off(Input.EventType.TOUCH_MOVE, this.onGlobalTouchMove, this);
    input.off(Input.EventType.TOUCH_END, this.onGlobalTouchEnd, this);
    input.off(Input.EventType.TOUCH_CANCEL, this.onGlobalTouchCancel, this);
    input.off(Input.EventType.MOUSE_MOVE, this.onGlobalMouseMove, this);
    input.off(Input.EventType.MOUSE_UP, this.onGlobalMouseUp, this);
    ccGame.off(CocosGame.EVENT_HIDE, this.onAppHide, this);
    ccGame.off(CocosGame.EVENT_SHOW, this.onAppShow, this);
    this.fx?.dispose();
    this.resetCardVisuals();
    this.clearPaperAim(true);
    this.clearEventFeed();
    this.hideTutorial();
    this.pauseMenuView.destroy();
    this.sensory.dispose();
    this.runtimeMonitor?.dispose();
    this.runtimeMonitor = null;
  }

  /** 键盘操控：1/2/3 蓄力(松手释放)、4 拍马屁、R 重试、N 下一关、B/Escape 返回选关。 */
  private onKeyDown(e: EventKeyboard): void {
    // 开始页：Enter/Space/1 开始第一关
    if (this.uiState === 'select') {
      if (e.keyCode === 13 || e.keyCode === 32 || e.keyCode === 49) this.onLevelSelected(0);
      return;
    }
    if (this.paused) {
      if (e.keyCode === 27 || e.keyCode === 80 || e.keyCode === 32) this.setPaused(false);
      return;
    }
    // 结算页：R 重试 / N 下一关 / V 复活(仅lose) / B 返回选关
    if (this.game.over) {
      if (e.keyCode === 82) this.onRetry(); // R
      else if (e.keyCode === 78) this.onNext(); // N
      else if (e.keyCode === 86) this.onRevive(); // V 复活
      else if (e.keyCode === 66 || e.keyCode === 27) this.onBackToSelect(); // B / Escape
      return;
    }
    // 游玩中：P / B / Escape 打开暂停；返回主页改为面板内二次动作，防止误触丢局。
    if (e.keyCode === 80 || e.keyCode === 66 || e.keyCode === 27) { this.setPaused(true); return; }
    // 仅在未蓄力时开始（防键盘自动连按重置扫描）
    if (this.game.prop.chargingProp === null) {
      switch (e.keyCode) {
        case 49: this.game.beginCharge(PT.AddDemand); return; // '1'
        case 50: this.game.beginCharge(PT.ChangeDemand); return; // '2'
        case 51: this.game.beginCharge(PT.ThrowPot); return; // '3'
      }
    }
    if (e.keyCode === 52) this.game.useKissUp(); // '4'
  }

  private onKeyUp(e: EventKeyboard): void {
    if (this.uiState !== 'playing' || this.paused) return;
    switch (e.keyCode) {
      case 49: this.game.release(PT.AddDemand); break; // '1'
      case 50: this.game.release(PT.ChangeDemand); break; // '2'
      case 51: this.game.release(PT.ThrowPot); break; // '3'
    }
  }

  /* ---------- 关卡流 ---------- */

  /** 用 Session 当前关开新一局。 */
  private startGame(): void {
    this.clearPauseState();
    this.resetCardVisuals();
    this.clearPaperAim(true);
    const idx = this.session.currentIndex;
    const levelDef = getLevel(idx);
    const seed = this.qaConfig?.seed
      ?? this.session.activeChallenge?.seed
      ?? levelDef.fixedSeed
      ?? ((Date.now() % 100000) ^ ((idx + 1) * 2654435761)); // QA 固定；正式游玩每次尝试不同
    const normalizedSeed = seed >>> 0;
    this.currentSeed = normalizedSeed;
    this.game = new Game(getLevel(idx), new SeededRng(normalizedSeed), this.session.allowedPropsFor(idx));
    this.telemetry.startLevel(idx, normalizedSeed);
    this.accumulator = 0;
    this.scanPos = 0;
    this.lastTimerText = '';
    this.lastTimerPaintSignature = '';
    this.reported = false;
    this.uiState = 'playing';
    this.eventTextPriority = 0;
    this.eventTextUntilSec = 0;
    // 重试/下一关进入时直接同步新局初值，避免结算前的 100 或猎杀低值残留一帧再缓动回来。
    this.approvalGaugeView?.snap(this.game.approval.value, this.game.approval.currentZone, '', 0);
    this.onboardingNudgeShown = false;
    const onboarding = onboardingBriefing({
      levelIndex: idx,
      elapsedSec: 0,
      bestStars: bestStarsFor(this.session.profile, idx),
      effectiveHits: 0,
      perfectHits: 0,
      huntProgress: 0,
      huntThreshold: BalanceConfig.zones.hunt.hi,
      huntHoldSec: BalanceConfig.zones.hunt.holdSec ?? 2,
    });
    if (onboarding) {
      this.setEventText(onboarding, 5.6, 5);
    } else if (this.tutorialDone) {
      const objective = levelDef.objective?.label ?? levelDef.challengeHint ?? '先处理高风险卡片';
      const bossPattern = levelDef.boss.patternLabel ? ` · ${levelDef.boss.patternLabel}` : '';
      this.setEventText(`本关目标 · ${objective}${bossPattern}`, 4.8, 2);
    }
    this.hideReport();
    this.hideLevelSelect();
    this.setGameUIVisible(true);
    // 先完成视觉节点布局，再把动效接到实际可见的认可度读数上。
    this.applyBgCharSprites();
    // 道具 HUD（CD/能量/次数/就绪）由 render() 每帧刷新（renderPropHUD），无需此处单独调用
    // 动效层：每局重新订阅新 EventBus
    this.fx?.dispose();
    this.fx = new FxLayer(
      this.game.bus,
      this.node,
      this.slotNodes,
      this.lowerHudNode?.getChildByName('ApprovalValue')?.getComponent(Label) ?? this.approvalLabel,
      (slot) => this.visualNodeAtSlot(slot),
      (cardId) => this.cardVisuals.get(cardId)?.node ?? null,
      () => this.charNode,
    );
    this.bindEventFeed();
    this.bindGameTelemetry();
    this.bindSensoryFeedback();
    this.beginTutorialIfNeeded();
  }

  /**
   * 一次性建立截图验收场景。所有状态使用内存存档与固定 RNG，不会污染玩家进度。
   * 该入口只会在 URL 带合法 qa 参数时执行。
   */
  private applyQaScenarioOnce(): void {
    const qa = this.qaConfig;
    if (!qa || this.qaApplied) return;
    this.qaApplied = true;

    if (qa.scenario === 'entry' || qa.scenario === 'career-route' || qa.scenario === 'career-achievements') {
      if (qa.scenario !== 'entry') {
        this.session.profile.highestUnlockedLevel = Math.max(7, qa.levelIndex);
        for (let i = 0; i < this.session.profile.highestUnlockedLevel; i++) {
          this.session.profile.bestStars[i] = (i % 3) + 1;
        }
        if (qa.scenario === 'career-achievements') {
          this.session.profile.achievements = ['first-hunt', 'perfect-chain', 'combo-5'];
          this.session.profile.cosmetics = ['desk-classic', 'paper-blue', 'ai-crash-face'];
        }
        this.updateLevelSelectContent();
        this.showCareerPanel(qa.scenario === 'career-route' ? 'route' : 'achievements');
      }
      this.publishQaReady();
      return;
    }

    this.session.profile.highestUnlockedLevel = Math.max(
      this.session.profile.highestUnlockedLevel,
      qa.levelIndex,
    );
    if (qa.scenario === 'result-daily') this.session.startChallenge(createDailyChallenge('2026-07-18'));
    else this.session.startLevel(qa.levelIndex);
    if (qa.scenario === 'result-rankup') {
      // 18 分 → 猎杀三星后 22.5 分，稳定触发首个段位晋升演出。
      this.session.profile.huntWinCount = 6;
      this.session.profile.bestStars.fill(0);
      this.session.profile.star3Levels = [];
      this.session.profile.highestUnlockedLevel = 0;
      this.session.currentIndex = 0;
    }
    this.startGame();

    // P0 是静态布局基线，不把一次性事件 tween 混进截图；动态反馈由后续手感专项验收。
    if (qa.scenario === 'crisis' || qa.scenario === 'pause' || qa.scenario === 'boss-warning' || qa.scenario === 'boss-critical' || qa.scenario.startsWith('result-')) {
      this.fx?.dispose();
      this.fx = null;
    }

    if (qa.scenario === 'crisis') {
      this.fillQaBelt(true);
      this.game.elapsed = Math.max(0, this.game.level.def.durationSec - 8);
      const delta = Math.max(0, 78 - this.game.approval.value);
      if (delta > 0) this.game.approval.resolveCard(this.qaCard(CS.ActiveWhite, delta));
    } else if (qa.scenario === 'boss-warning' || qa.scenario === 'boss-critical') {
      this.fillQaBelt(false);
      const firstBossAt = this.game.level.def.boss.scheduleSec?.[0] ?? 24;
      this.game.elapsed = Math.max(0, firstBossAt - (qa.scenario === 'boss-critical' ? 3.1 : 6.1));
      this.game.tick(0.15);
    } else {
      this.fillQaBelt(false);
    }

    if (qa.scenario === 'elite-link' || qa.scenario === 'shield-break') {
      const cards = this.game.conveyor.cards;
      cards.fill(null);
      cards[1] = { id: -21, category: 'boss', state: CS.Boss, weight: 0, baseWeight: 0, isThreat: false };
      cards[2] = { id: -22, category: 'proposal', state: CS.ActiveWhite, weight: 8, baseWeight: 7, isThreat: true, elite: true, guard: 1, linkId: 9, linkBonus: 1 };
      cards[3] = { id: -23, category: 'key', state: CS.ActiveWhite, weight: 6, baseWeight: 5, isThreat: true, linkId: 9, linkBonus: 1 };
      cards[4] = { id: -24, category: 'urgent', state: CS.ActiveWhite, weight: 12, baseWeight: 12, isThreat: true, elite: true, guard: 1 };
    }
    if (qa.scenario === 'rework-hit') {
      const cards = this.game.conveyor.cards;
      cards.fill(null);
      cards[1] = { id: -41, category: 'report', state: CS.ActiveWhite, weight: 3, baseWeight: 3, isThreat: true };
      cards[2] = { id: -42, category: 'urgent', state: CS.ActiveWhite, weight: 10, baseWeight: 10, isThreat: true };
      cards[4] = { id: -43, category: 'key', state: CS.ActiveWhite, weight: 5, baseWeight: 5, isThreat: true };
    }
    if (qa.scenario === 'last-chance') {
      const cards = this.game.conveyor.cards;
      cards.fill(null);
      const raiseBy = Math.max(0, 92 - this.game.approval.value);
      if (raiseBy > 0) this.game.approval.resolveCard(this.qaCard(CS.ActiveWhite, raiseBy));
      cards[0] = { id: -31, category: 'urgent', state: CS.ActiveWhite, weight: 10, baseWeight: 10, isThreat: true };
      cards[2] = { id: -32, category: 'proposal', state: CS.ActiveWhite, weight: 7, baseWeight: 7, isThreat: true };
      cards[4] = { id: -33, category: 'key', state: CS.ActiveWhite, weight: 5, baseWeight: 5, isThreat: true };
    }
    if (qa.scenario === 'onboarding-perfect' || qa.scenario === 'onboarding-hunt') {
      this.game.elapsed = qa.scenario === 'onboarding-perfect' ? 12.1 : 14.1;
    }

    this.render();

    if (qa.scenario === 'shield-break') {
      this.game.beginCharge(PT.ChangeDemand);
      this.game.releaseAtSlot(PT.ChangeDemand, 2, HQ.Perfect);
      this.render();
    } else if (qa.scenario === 'rework-hit') {
      this.game.beginCharge(PT.ChangeDemand);
      this.game.releaseAtSlot(PT.ChangeDemand, 2, HQ.Normal);
      this.render();
    } else if (qa.scenario === 'last-chance') {
      this.game.tick(0.01);
      this.render();
    } else if (qa.scenario === 'pause') {
      this.setPaused(true);
    } else if (qa.scenario === 'perfect-chain') {
      this.game.bus.emit('PerfectChainUpdated', { chain: 4 });
    } else if (qa.scenario === 'combo-reward') {
      this.game.bus.emit('ComboUpdated', { combo: 5 });
      this.game.bus.emit('ComboRewardGranted', { combo: 5, tier: 2, label: '火力全开', cooldownReducedSec: 0.9 });
    } else if (qa.scenario === 'drag' || qa.scenario === 'blast' || qa.scenario === 'perfect') {
      if (qa.scenario === 'blast') {
        for (let i = 0; i < 4; i++) {
          this.game.beginCharge(PT.AddDemand);
          this.game.releaseAtSlot(PT.AddDemand, Math.min(2, this.game.level.def.slots - 1), HQ.Normal);
          this.game.prop.tick(10, this.game.phase);
        }
      }
      const targetSlot = this.game.conveyor.cards.findIndex((card, index) => index >= 2 && card !== null);
      const slot = targetSlot >= 0 ? targetSlot : Math.max(0, Math.floor(this.slotNodes.length / 2));
      this.onPropDown(qa.scenario === 'blast' ? PT.ThrowPot : PT.AddDemand);
      const target = this.aimSlotTargets[slot] ?? this.targetPointForSlot(slot);
      this.aimDesiredPoint.set(target.x, this.aimPoint.y, 0);
      this.propInteractionState = 'dragging';
      this.updateAimFrame(1 / 60, true);
      if (qa.scenario === 'perfect') {
        this.updateAimFrame(UiTokens.aim.perfectLockSec + 0.04, true);
      }
    } else if (qa.scenario.startsWith('result-')) {
      this.game.effectiveHits = 7;
      this.game.perfectHits = qa.scenario === 'result-lose' ? 1 : 3;
      this.game.maxCombo = qa.scenario === 'result-hunt' ? 5 : 3;
      this.game.missedThrows = qa.scenario === 'result-lose' ? 2 : 0;
      if (qa.scenario === 'result-lose') {
        this.game.bus.emit('CardEnteredProcessing', { card: this.qaCard(CS.ActiveWhite, 100) });
      } else if (qa.scenario === 'result-survive' || qa.scenario === 'result-daily') {
        this.game.elapsed = this.game.level.def.durationSec;
        this.game.approval.declareSurviveOnTimeout();
      } else {
        const reduceBy = Math.max(1, this.game.approval.value - 8);
        this.game.approval.resolveCard(this.qaCard(CS.Rework, reduceBy));
        this.game.approval.tick((BalanceConfig.zones.hunt.holdSec ?? 2) + 0.1);
      }
      this.finishAndShowReport();
    }

    this.publishQaReady();
  }

  /** 稳定填充队列；Boss 版本固定把临检卡放在中间可见槽。 */
  private fillQaBelt(includeBoss: boolean): void {
    this.game.conveyor.reset();
    const phase = this.game.phase;
    if (includeBoss) {
      this.game.conveyor.generate(phase);
      this.game.conveyor.step();
      this.game.conveyor.generate(phase, { forceBoss: true });
      this.game.conveyor.step();
      this.game.conveyor.generate(phase);
      this.game.conveyor.step();
      this.game.conveyor.generate(phase);
      this.game.conveyor.step();
      this.game.conveyor.generate(phase);
      return;
    }
    for (let i = 0; i < this.game.level.def.slots; i++) {
      this.game.conveyor.generate(phase);
      if (i < this.game.level.def.slots - 1) this.game.conveyor.step();
    }
  }

  private qaCard(state: Card['state'], weight: number): Card {
    return {
      id: -1,
      category: 'urgent',
      state,
      weight,
      isThreat: state === CS.ActiveWhite,
    };
  }

  /** Playwright 只等待这份只读快照，不接触 GameRunner 私有实现。 */
  private publishQaReady(): void {
    const qa = this.qaConfig;
    if (!qa) return;
    const cards = this.game
      ? this.game.conveyor.cards.map((card) => card ? `${card.category}:${card.state}:${card.weight}` : null)
      : [];
    (globalThis as unknown as { __BRAATN_QA__: unknown }).__BRAATN_QA__ = {
      ready: true,
      scenario: qa.scenario,
      seed: qa.seed,
      levelIndex: qa.levelIndex,
      uiState: this.uiState,
      paused: this.paused,
      result: this.game?.result ?? 'not-started',
      cards,
      perfectReady: this.aimPerfectReady,
    };
  }

  /** 命中/认可度/Boss 等即时反馈全部由 FxLayer 飘字承担；
   *  HUD 提示行只保留教学引导文案，命中后清空，避免变成第二个控制台。 */
  private bindEventFeed(): void {
    this.clearEventFeed();
    this.eventUnsubs.push(
      this.game.bus.on('CardHit', ({ prop, quality }) => {
        const perfect = quality === 'perfect';
        this.completeTutorial();
        this.setEventText(perfect ? `完美命中：${this.propDisplayName(prop)}压住了任务` : UiTokens.tutorial.hitHint, 2.6, perfect ? 5 : 3);
      }),
      this.game.bus.on('PropEffectResolved', ({ prop, affected, riskPrevented, bufferedSlots }) => {
        const benefit = prop === PT.AddDemand
          ? `缓冲 +${bufferedSlots} 格`
          : prop === PT.ChangeDemand
            ? `风险摆幅 -${riskPrevented}`
            : `清场 ${affected} 张${riskPrevented > 0 ? ` · 挡住 ${riskPrevented} 风险` : ''}`;
        this.setEventText(`${this.propDisplayName(prop)} · ${benefit}`, 2.6, 6);
      }),
      this.game.bus.on('PerfectRewardGranted', ({ reward }) => {
        this.setEventText(`Perfect 奖励：${this.perfectRewardLabel(reward)}`, 2.8, 6);
      }),
      this.game.bus.on('PerfectChainUpdated', ({ chain }) => {
        if (chain >= 2) this.setEventText(`连续 Perfect ×${chain} · 精准升级`, 2.4, 7 + Math.min(chain, 3));
      }),
      this.game.bus.on('ComboRewardGranted', ({ combo, label, cooldownReducedSec }) => {
        this.setEventText(`${combo} 连 ${label} · 当前纸团冷却 -${cooldownReducedSec.toFixed(1)}s`, 2.8, 8);
      }),
      this.game.bus.on('PropUnavailable', ({ reason }) => {
        this.setEventText(reason === 'empty' ? '空位没砸中，换个任务卡试试' : '这个目标不吃这招，换道具试试', 2.0, 4);
      }),
      this.game.bus.on('ApprovalChanged', ({ delta }) => {
        if (delta > 0) this.setEventText(`危险上升 ${Math.round(delta)}，赶紧拦截任务`, 2.2, 1);
        else if (delta < 0) this.setEventText(`漂亮！认可度回落 ${Math.abs(Math.round(delta))}`, 2.2, 2);
      }),
      this.game.bus.on('ZoneChanged', ({ to }) => {
        const copy: Record<string, string> = {
          hunt: '猎杀线！稳住两秒就能反杀',
          good: '状态良好，可以继续控节奏',
          ok: '进入一般区，任务会更烦',
          danger: '危险！AI 正在接管你的工作',
        };
        this.setEventText(copy[to] ?? '状态变化', 3.0, 6);
      }),
      this.game.bus.on('KissUpFreeze', ({ durationSec }) => {
        this.setEventText(`拍马屁生效 · 队列冻结 ${durationSec.toFixed(1)}s`, 2.4, 6);
      }),
      this.game.bus.on('BossBeatWarning', ({ seconds }) => {
        const pattern = this.game.level.def.boss.inspectionLimit
          ? `重点抽查 ${this.game.level.def.boss.inspectionLimit} 张`
          : '全量扫描';
        this.setEventText(`${seconds} 秒后${pattern} · 留好甩锅`, 2.2, seconds === 3 ? 9 : 7);
      }),
      this.game.bus.on('LastChanceWarning', ({ boss, impact, seconds }) => {
        this.setEventText(
          boss
            ? `最后机会：${seconds.toFixed(1)} 秒后临检将推高 ${Math.round(impact)} · 立刻甩锅`
            : `最后机会：${seconds.toFixed(1)} 秒后将被接管 · 立刻改需求或甩锅`,
          3.0,
          12,
        );
      }),
      this.game.bus.on('BossSpawned', ({ inspectionLimit }) => {
        if (!this.bossTipShown) {
          this.bossTipShown = true;
          sys.localStorage?.setItem(GameRunner.BOSS_TIP_KEY, '1');
          this.setEventText('首次临检：Boss 会抽查高风险任务 · 留好甩锅，拍马屁能争取时间', 4.8, 10);
        } else {
          this.setEventText(inspectionLimit === undefined
            ? '全量扫描已入场 · 立刻拦截 Boss'
            : `重点抽查 ${inspectionLimit} 张已入场 · 优先甩锅`, 2.8, 9);
        }
      }),
      this.game.bus.on('BossInspectionResolved', ({ checked, remaining, riskAdded }) => {
        this.setEventText(`临检查 ${checked} 张 · 风险 +${Math.round(riskAdded)}${remaining > 0 ? ` · 余 ${remaining} 张` : ''}`, 2.8, 9);
      }),
      this.game.bus.on('ObjectiveCompleted', ({ label }) => {
        this.setEventText(`目标完成 ✓ ${label}`, 3.0, 10);
      }),
      this.game.bus.on('PhaseChanged', ({ to }) => {
        const phaseText = to === 'mid'
          ? '中盘加速：任务生成变快了'
          : '最后冲刺：守住岗位别让队列爆掉';
        this.setEventText(phaseText, 3.0, 6);
      }),
      this.game.bus.on('EliteTaskSpawned', () => {
        if (this.eliteTipShown) return;
        this.eliteTipShown = true;
        sys.localStorage?.setItem(GameRunner.ELITE_TIP_KEY, '1');
        this.setEventText('首次精英任务 · 改需求先破盾，再命中一次才会返工', 4.5, 8);
      }),
      this.game.bus.on('EliteGuardBroken', ({ reduction }) => {
        this.setEventText(`护盾击破 · 风险 -${reduction} · 再用改需求可转返工`, 3.0, 8);
      }),
      this.game.bus.on('TaskLinkFormed', ({ bonus }) => {
        if (this.linkTipShown) return;
        this.linkTipShown = true;
        sys.localStorage?.setItem(GameRunner.LINK_TIP_KEY, '1');
        this.setEventText(`首次任务抱团 · 双方风险 +${bonus} · 清掉任意一张即可拆链`, 4.5, 8);
      }),
      this.game.bus.on('TaskLinkBroken', ({ bonusRemoved }) => {
        if (bonusRemoved > 0) this.setEventText(`抱团已拆 · 剩余任务风险 -${bonusRemoved}`, 2.6, 7);
      }),
      this.game.bus.on('BossArrivalEffect', ({ label }) => {
        this.setEventText(`Boss 现场施压 · ${label}`, 3.6, 10);
      }),
      this.game.bus.on('Highlight', ({ id, tier }) => {
        this.setEventText(highlightQuip(id), tier >= 3 ? 3.8 : 2.8, 7 + tier);
      }),
    );
  }

  /** 规则事件统一映射为产品事件；平台 SDK 与落盘策略由 TelemetryBridge 隔离。 */
  private bindGameTelemetry(): void {
    this.eventUnsubs.push(
      this.game.bus.on('CardHit', ({ prop, quality }) => this.telemetry.validHit(prop, quality)),
      this.game.bus.on('PropUnavailable', ({ prop, reason }) => this.telemetry.invalidTarget(prop, reason)),
      this.game.bus.on('PropCanceled', ({ prop }) => this.telemetry.gestureCanceled(prop)),
      this.game.bus.on('ZoneChanged', ({ from, to }) => this.telemetry.approvalZoneChanged(from, to)),
      this.game.bus.on('BossIncoming', ({ tier, slot }) => this.telemetry.bossWarning(tier, slot)),
      this.game.bus.on('Revived', () => this.telemetry.reviveUsed()),
      this.game.bus.on('Highlight', ({ id, tier }) => this.telemetry.highlight(id, tier)),
    );
  }

  /** 音效和震动只订阅规则事件，不参与判定；任何设备能力失败都不会阻断一局。 */
  private bindSensoryFeedback(): void {
    this.eventUnsubs.push(
      this.game.bus.on('CardHit', ({ prop, quality }) => {
        if (quality === HQ.Perfect) this.sensory.play('perfect');
        else this.sensory.play(prop === PT.ThrowPot ? 'heavy-hit' : 'hit');
        this.sensory.haptic(prop === PT.ThrowPot || quality === HQ.Perfect ? 'heavy' : 'medium', 72);
      }),
      this.game.bus.on('AIHit', ({ quality }) => {
        this.sensory.play(quality === HQ.Perfect ? 'perfect' : 'hit');
        this.sensory.haptic(quality === HQ.Perfect ? 'heavy' : 'medium', 72);
      }),
      this.game.bus.on('PropUnavailable', () => {
        this.sensory.play('miss');
        this.sensory.haptic('light', 110);
      }),
      this.game.bus.on('ZoneChanged', ({ to }) => {
        if (to === 'danger') {
          this.sensory.play('danger');
          this.sensory.haptic('medium', 220);
        }
      }),
      this.game.bus.on('BossIncoming', ({ tier }) => {
        if (tier === 4 || tier === 1) this.sensory.play('boss');
        if (tier === 1) this.sensory.haptic('heavy', 260);
      }),
      this.game.bus.on('BossBeatWarning', ({ seconds }) => {
        this.sensory.play(seconds === 3 ? 'boss' : 'target-tick');
        this.sensory.haptic(seconds === 3 ? 'medium' : 'light', 180);
      }),
      this.game.bus.on('EliteGuardBroken', () => {
        this.sensory.play('shield-break');
        this.sensory.haptic('medium', 90);
      }),
      this.game.bus.on('TaskLinkBroken', ({ bonusRemoved }) => {
        if (bonusRemoved <= 0) return;
        this.sensory.play('link-break');
        this.sensory.haptic('light', 100);
      }),
      this.game.bus.on('BossArrivalEffect', () => {
        this.sensory.play('boss-impact');
        this.sensory.haptic('heavy', 220);
      }),
      this.game.bus.on('LastChanceWarning', () => {
        this.sensory.play('last-chance');
        this.sensory.haptic('heavy', 260);
      }),
      this.game.bus.on('ComboRewardGranted', ({ tier }) => {
        this.sensory.play(tier >= 2 ? 'perfect' : 'target-tick');
        this.sensory.haptic(tier >= 2 ? 'medium' : 'light', 120);
      }),
      this.game.bus.on('Revived', () => {
        this.sensory.play('revive');
        this.sensory.haptic('heavy', 180);
      }),
      this.game.bus.on('GameOver', ({ result }) => {
        this.sensory.play(result === 'lose' ? 'lose' : 'win');
        this.sensory.haptic('heavy', 220);
      }),
    );
  }

  private clearEventFeed(): void {
    this.eventUnsubs.forEach((off) => off());
    this.eventUnsubs = [];
  }

  private setEventText(text: string, ttlSec = UiTokens.feedback.eventHintTtlSec, priority = 0): void {
    const elapsed = this.game?.getSnapshot().elapsed ?? 0;
    const active = elapsed <= this.eventTextUntilSec;
    const normalized = text.replace(/^事件\s*[·:：]\s*/, '');
    if (active && priority < this.eventTextPriority && normalized !== this.lastEventText) return;
    this.lastEventText = normalized;
    this.eventTextUntilSec = elapsed + Math.max(0.1, ttlSec);
    this.eventTextPriority = priority;
  }

  private perfectRewardLabel(reward: PerfectRewardType): string {
    if (reward === 'extra-use') return '次数 +1';
    if (reward === 'energy-full') return '立即充满';
    return '冷却回退 10%';
  }

  private shouldShowTutorial(): boolean {
    return this.uiState === 'playing' && this.session.currentIndex === 0 && !this.tutorialDone;
  }

  private beginTutorialIfNeeded(): void {
    this.tutorialStep = 0;
    if (!this.shouldShowTutorial()) {
      this.hideTutorial();
      return;
    }
    this.telemetry.tutorialShown(this.tutorialStep);
    this.showTutorial(UiTokens.tutorial.holdHint);
  }

  private advanceTutorial(step: number, text: string): void {
    if (!this.shouldShowTutorial() || step <= this.tutorialStep) return;
    this.tutorialStep = step;
    // 进入投掷滑轨后，操作区本身就是教学。隐藏旧黑色气泡，避免遮住任务卡与吸附目标。
    if (this.aimingProp !== null) {
      this.hideTutorial();
      return;
    }
    this.showTutorial(text);
  }

  private completeTutorial(): void {
    if (!this.shouldShowTutorial()) return;
    this.telemetry.tutorialCompleted(this.tutorialStep);
    this.tutorialDone = true;
    sys.localStorage?.setItem(GameRunner.TUTORIAL_DONE_KEY, '1');
    this.eventTextUntilSec = 0;
    this.eventTextPriority = 0;
    this.hideTutorial();
  }

  private hideTutorial(): void {
    if (this.tutorialRoot?.isValid) this.tutorialRoot.active = false;
  }

  private showTutorial(text: string): void {
    if (!this.tutorialRoot?.isValid) {
      const root = new Node('TutorialHint');
      root.layer = 1 << 25;
      root.parent = this.node;
      root.addComponent(UITransform);
      root.addComponent(Graphics);
      const labelNode = new Node('TutorialText');
      labelNode.layer = 1 << 25;
      labelNode.parent = root;
      labelNode.addComponent(UITransform);
      const label = labelNode.addComponent(Label);
      label.horizontalAlign = 1;
      label.verticalAlign = 1;
      label.isBold = true;
      label.overflow = Label.Overflow.SHRINK;
      this.tutorialRoot = root;
    }
    const vis = view.getVisibleSize();
    const w = Math.min(vis.width * 0.64, 390);
    const h = 42;
    const root = this.tutorialRoot;
    root.getComponent(UITransform)!.setContentSize(w, h);
    const placement = this.tutorialPlacement(w, h);
    root.setPosition(placement.x, placement.y, 0);
    const g = root.getComponent(Graphics)!;
    g.clear();
    g.fillColor = new Color(54, 48, 42, 34);
    g.roundRect(-w / 2 + 3, -h / 2 - 4, w - 6, h, 15);
    g.fill();
    g.fillColor = new Color(255, 252, 246, 250);
    g.strokeColor = new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, 205);
    g.lineWidth = 2;
    g.roundRect(-w / 2, -h / 2, w, h, 14);
    g.fill(); g.stroke();
    g.fillColor = new Color(255, 252, 246, 250);
    g.strokeColor = new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, 205);
    g.lineWidth = 2;
    const px = Math.max(-w / 2 + 22, Math.min(w / 2 - 22, placement.pointerX));
    if (placement.pointerDown) {
      g.moveTo(px - 9, -h / 2 + 2);
      g.lineTo(px + 9, -h / 2 + 2);
      g.lineTo(px, -h / 2 - 12);
    } else {
      g.moveTo(px - 9, h / 2 - 2);
      g.lineTo(px + 9, h / 2 - 2);
      g.lineTo(px, h / 2 + 12);
    }
    g.close();
    g.fill();
    g.stroke();
    const label = root.getChildByName('TutorialText')?.getComponent(Label);
    if (label) {
      label.string = text;
      label.fontSize = 18;
      label.lineHeight = 24;
      label.color = UiTokens.color.inkDeep;
      label.node.getComponent(UITransform)!.setContentSize(w - 24, h - 6);
    }
    root.active = this.shouldShowTutorial();
    root.setSiblingIndex(this.node.children.length - 1);
  }

  private layoutTutorialHint(): void {
    if (!this.tutorialRoot?.isValid) return;
    const ut = this.tutorialRoot.getComponent(UITransform);
    const placement = this.tutorialPlacement(ut?.width ?? 260, ut?.height ?? 40);
    this.tutorialRoot.setPosition(placement.x, placement.y, 0);
  }

  private tutorialPlacement(w: number, h: number): { x: number; y: number; pointerX: number; pointerDown: boolean } {
    const vis = view.getVisibleSize();
    const margin = 26;
    const clampX = (x: number) => Math.max(-vis.width / 2 + w / 2 + margin, Math.min(vis.width / 2 - w / 2 - margin, x));
    if (this.tutorialStep >= 2) {
      const target = this.targetPointForSlot(this.aimingSlot);
      const y = Math.max(-vis.height / 2 + 210, target.y - h / 2 - 70);
      const x = clampX(target.x);
      return { x, y, pointerX: target.x - x, pointerDown: false };
    }
    if (this.tutorialStep >= 1 && this.aimingProp !== null) {
      const x = clampX(this.aimPoint.x || 0);
      return { x, y: this.aimPoint.y + h / 2 + 54, pointerX: this.aimPoint.x - x, pointerDown: true };
    }
    const source = this.propSourcePoint(PT.AddDemand);
    const x = clampX(source.x);
    return {
      x,
      y: source.y + h / 2 + Math.max(56, vis.height * 0.07),
      pointerX: source.x - x,
      pointerDown: true,
    };
  }

  private onNext(): void {
    this.finalizePendingTelemetry();
    this.telemetry.navigation('next_level');
    if (this.session.startNext()) this.startGame();
  }
  private onRetry(): void {
    this.finalizePendingTelemetry();
    this.telemetry.navigation('retry');
    this.startGame();
  }
  private onBackToSelect(): void {
    this.clearPauseState();
    this.finalizePendingTelemetry();
    this.telemetry.navigation('return_home');
    if (this.session.activeChallenge) {
      this.session.leaveChallenge();
      this.incomingChallenge = null;
    }
    this.showLevelSelect();
  }

  private onAppHide(): void {
    if (this.uiState === 'playing' && !this.game?.over) this.setPaused(true, true);
  }

  private onAppShow(): void {
    // 切回前台不自动开跑，必须由玩家明确点“继续游戏”。
    if (this.paused && this.pauseWasAutomatic && this.pauseMenuNode?.isValid) {
      this.pauseMenuNode.setSiblingIndex(this.node.children.length - 1);
    }
  }

  private setPaused(paused: boolean, automatic = false): void {
    if (paused) {
      if (this.paused || this.uiState !== 'playing' || !this.game || this.game.over) return;
      this.paused = true;
      this.pauseWasAutomatic = automatic;
      this.accumulator = 0;
      this.game.suspendCharge();
      this.clearPaperAim(true);
      this.propInteractionState = 'idle';
      this.hideTutorial();
      if (this.pauseButtonNode) this.pauseButtonNode.active = false;
      this.updateAmbientPresentation(0);
      const vis = view.getVisibleSize();
      this.pauseMenuNode = this.pauseMenuView.show({
        parent: this.node,
        layer: 1 << 25,
        viewWidth: vis.width,
        viewHeight: vis.height,
        automatic,
        soundEnabled: () => this.sensory.settings.soundEnabled,
        hapticsEnabled: () => this.sensory.settings.hapticsEnabled,
        reducedMotion: () => this.sensory.settings.reducedMotion,
        toggleSound: () => {
          const next = !this.sensory.settings.soundEnabled;
          this.sensory.setSoundEnabled(next);
          if (next) { this.sensory.unlock(); this.sensory.play('pickup'); }
        },
        toggleHaptics: () => {
          const next = !this.sensory.settings.hapticsEnabled;
          this.sensory.setHapticsEnabled(next);
          if (next) this.sensory.haptic('medium', 0);
        },
        toggleReducedMotion: () => {
          this.sensory.setReducedMotion(!this.sensory.settings.reducedMotion);
        },
        resume: () => this.setPaused(false),
        retry: () => { this.clearPauseState(); this.onRetry(); },
        returnHome: () => { this.clearPauseState(); this.onBackToSelect(); },
      });
      return;
    }
    if (!this.paused) return;
    this.clearPauseState();
    if (this.pauseButtonNode) this.pauseButtonNode.active = this.uiState === 'playing' && !this.game.over;
    if (this.shouldShowTutorial()) {
      const copy = this.tutorialStep <= 0 ? UiTokens.tutorial.holdHint
        : this.tutorialStep === 1 ? UiTokens.tutorial.dragHint
          : UiTokens.tutorial.releaseHint;
      this.showTutorial(copy);
    }
    this.updateAmbientPresentation(0);
  }

  private clearPauseState(): void {
    this.paused = false;
    this.pauseWasAutomatic = false;
    this.pauseMenuView.hide();
    this.pauseMenuNode = null;
    this.accumulator = 0;
  }
  /** §2.1 复活：仅 lose 且本关未用过复活时有效。成功后回到 playing 继续本关（core 已回滚认可度到69/+8s/清Boss）。 */
  private async onRevive(): Promise<void> {
    if (!this.game.over || this.game.result !== 'lose') return;
    if (this.reviveAdPending) return;
    this.reviveAdPending = true;
    const adOutcome = await this.rewardedAds.show('revive');
    this.reviveAdPending = false;
    this.telemetry.rewardedAdResult('revive', adOutcome);
    if (adOutcome !== 'bypassed' && adOutcome !== 'completed') return;
    if (!this.game.revive()) return; // 每关限1次，core 内部再兜一次
    // 首次失败只是复活决策点，不作为最终 level_end；继续沿用原 run 聚合整局数据。
    this.pendingTelemetryReport = null;
    this.reported = false;
    this.uiState = 'playing';
    this.hideReport();
  }

  /* ---------- 开始页 ---------- */

  /** 显示开始页：隐藏游戏 UI，创建/显示开局覆盖层。 */
  private showLevelSelect(): void {
    this.hideDebugOverlays();
    this.clearPauseState();
    this.uiState = 'select';
    this.setGameUIVisible(false);
    this.hideReport();
    this.hideTutorial();
    if (!this.levelSelectRoot) {
      this.levelSelectRoot = this.createLevelSelectUI();
    }
    this.levelSelectRoot.active = true;
    this.levelSelectRoot.setSiblingIndex(this.node.children.length - 1);
    this.updateLevelSelectContent();
  }

  private hideLevelSelect(): void {
    if (this.levelSelectRoot) this.levelSelectRoot.active = false;
  }

  private hideDebugOverlays(): void {
    const doc = (globalThis as { document?: Document }).document;
    if (!doc) return;
    const selectors = ['#vConsole', '.vc-switch', '.vc-mask', '.vc-panel', '.vConsole'];
    for (const selector of selectors) {
      doc.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        el.style.display = 'none';
        el.style.pointerEvents = 'none';
      });
    }
  }

  /** 清理 Cocos 场景模板里遗留的默认 Label="label"，避免显示器/按钮区域冒出白色占位字。 */
  private hideScenePlaceholderLabels(): void {
    this.node.getComponentsInChildren(Label).forEach((label) => {
      if (label.string.trim().toLowerCase() === 'label') label.enabled = false;
    });
  }

  /** 动态创建开始页覆盖层 —— 简洁纸感小游戏入口。 */
  private createLevelSelectUI(): Node {
    const root = new Node('LevelSelectUI');
    root.layer = 33554432; // UI_2D
    root.addComponent(UITransform).setContentSize(view.getVisibleSize().width, view.getVisibleSize().height);
    const bg = root.addComponent(Graphics);
    this.paintFullScreenStartBg(bg);
    this.node.addChild(root);

    const vis = view.getVisibleSize();
    const metrics = this.startCardMetrics();
    const cardW = metrics.width;
    const cardH = metrics.height;
    const cardCY = metrics.cy;

    this.paintStartAlertBar(root, cardW, cardH, cardCY);
    this.makeFeedbackToggles(root, cardW, cardH, cardCY);

    const titleNode = new Node('StartTitle');
    titleNode.layer = 33554432;
    titleNode.parent = root;
    titleNode.setPosition(0, cardCY + cardH * 0.197, 0);
    titleNode.addComponent(UITransform).setContentSize(cardW * 0.86, cardH * 0.17);
    const titleLabel = titleNode.addComponent(Label);
    titleLabel.string = '别让AI替代你';
    titleLabel.fontFamily = 'PingFang SC';
    titleLabel.fontSize = Math.min(112, Math.max(78, cardW * 0.105));
    titleLabel.lineHeight = titleLabel.fontSize + 8;
    titleLabel.horizontalAlign = 1;
    titleLabel.verticalAlign = 1;
    titleLabel.color = GameRunner.START_TEXT;
    titleLabel.isBold = true;
    titleLabel.overflow = Label.Overflow.NONE;

    const crisis = this.mkLabel(root, 'CrisisText', 0, cardCY + cardH * 0.072,
      '守住认可度：轻点快投，拖甩精准换目标。', Math.min(34, Math.max(27, cardW * 0.036)), cardW * 0.78, cardH * 0.085);
    this.styleStartLabel(crisis, GameRunner.START_MUTED, false);

    this.makeStartDoodles(root, vis, cardW, cardH, cardCY);

    this.makeStartButton(root, 0, cardCY - cardH * 0.328, cardW * 0.875, cardH * 0.124,
      this.primaryStartText(), () => this.onPrimaryStart());
    const utilityY = cardCY - cardH * 0.58;
    const utilityW = Math.min(cardW * 0.275, 132);
    const utilityH = Math.min(62, cardH * 0.105);
    this.makeStartSecondaryButton(root, 'CareerRouteButton', -cardW * 0.30, utilityY, utilityW, utilityH,
      '关卡路线', () => this.showCareerPanel('route'));
    this.makeStartSecondaryButton(root, 'DailyChallengeButton', 0, utilityY, utilityW, utilityH,
      '今日挑战', () => this.onDailyChallenge());
    this.makeStartSecondaryButton(root, 'AchievementButton', cardW * 0.30, utilityY, utilityW, utilityH,
      '成就 0/6', () => this.showCareerPanel('achievements'));

    const rankIcon = new Node('RankIcon');
    rankIcon.layer = 33554432;
    rankIcon.parent = root;
    rankIcon.addComponent(UITransform).setContentSize(34, 34);
    rankIcon.setPosition(-cardW * 0.222, cardCY - cardH * 0.455, 0);
    const rankG = rankIcon.addComponent(Graphics);
    rankG.strokeColor = GameRunner.START_BLUE;
    rankG.lineWidth = 3;
    rankG.moveTo(-5, 12);
    rankG.bezierCurveTo(18, 5, 14, -18, -2, -14);
    rankG.bezierCurveTo(-16, -9, -12, 8, 0, 5);
    rankG.stroke();

    const rank = this.mkLabel(root, 'RankInfo', 34, cardCY - cardH * 0.455, '', Math.min(31, Math.max(24, cardW * 0.033)), cardW * 0.66, cardH * 0.07);
    this.styleStartLabel(rank, GameRunner.START_MUTED, false);

    const reward = this.mkLabel(root, 'GrowthPreview', 0, cardCY - cardH * 0.515, '', Math.min(25, Math.max(19, cardW * 0.027)), cardW * 0.72, cardH * 0.055);
    this.styleStartLabel(reward, GameRunner.START_BLUE_DARK, true);

    return root;
  }

  /** 刷新开始页内容（进度行）。 */
  private updateLevelSelectContent(): void {
    if (!this.levelSelectRoot) return;
    const bg = this.levelSelectRoot.getComponent(Graphics);
    if (bg) this.paintFullScreenStartBg(bg);
    const rankInfo = this.levelSelectRoot.getChildByName('RankInfo');
    if (rankInfo) {
      const label = rankInfo.getComponent(Label);
      if (label) {
        const progress = rankProgress(this.session.profile);
        const growth = progress.next
          ? `距${RankLabels[progress.next]} ${Math.ceil(progress.remaining)}分`
          : '最高段位';
        label.string = `${this.session.rankLabel} · 总星${totalStars(this.session.profile)}/${this.session.levelCount * 3} · ${growth}`;
        label.color = GameRunner.UI_MUTED;
        label.isBold = false;
      }
    }
    const startLabel = this.levelSelectRoot.getChildByName('StartButton')?.getChildByName('StartButtonLabel')?.getComponent(Label);
    if (startLabel) startLabel.string = this.primaryStartText();
    const achievementLabel = this.levelSelectRoot.getChildByName('AchievementButton')?.getChildByName('AchievementButtonLabel')?.getComponent(Label);
    if (achievementLabel) achievementLabel.string = `成就 ${this.session.profile.achievements.length}/${Object.keys(AchievementLabels).length}`;
    const daily = createDailyChallenge(localDateKey());
    const dailyRecord = this.session.profile.dailyRecords.find((record) => record.key === daily.keyHash.toString(36));
    const dailyLabel = this.levelSelectRoot.getChildByName('DailyChallengeButton')?.getChildByName('DailyChallengeButtonLabel')?.getComponent(Label);
    if (dailyLabel) dailyLabel.string = dailyRecord ? `今日最佳 ${dailyRecord.score}` : '今日挑战 · 有奖';
    const growthPreview = this.levelSelectRoot.getChildByName('GrowthPreview')?.getComponent(Label);
    if (growthPreview) {
      const stars = totalStars(this.session.profile);
      const milestone = nextStarMilestone(stars);
      growthPreview.string = milestone ? `再拿 ${milestone.stars - stars}★ 解锁「${milestone.label}」` : '星级收藏已全部解锁';
    }
  }

  private primaryStartText(): string {
    if (this.incomingChallenge) return this.incomingChallenge.mode === 'daily' ? '开始今日挑战' : '接受好友挑战';
    return `继续第${this.session.profile.highestUnlockedLevel + 1}关`;
  }

  private onPrimaryStart(): void {
    const challenge = this.incomingChallenge;
    if (challenge) {
      if (!this.session.startChallenge(challenge)) return;
      this.telemetry.challengeStarted(challenge.mode, encodeChallenge(challenge));
      this.startGame();
      return;
    }
    this.onLevelSelected(this.session.profile.highestUnlockedLevel);
  }

  private onDailyChallenge(): void {
    const challenge = createDailyChallenge(localDateKey());
    if (!this.session.startChallenge(challenge)) return;
    this.incomingChallenge = challenge;
    this.telemetry.challengeStarted('daily', encodeChallenge(challenge));
    this.startGame();
  }

  /** 二级抽屉承载路线与收藏，避免把 20 关信息永久塞进开始页。 */
  private showCareerPanel(mode: 'route' | 'achievements'): void {
    this.hideCareerPanel();
    if (!this.levelSelectRoot) return;
    const vis = view.getVisibleSize();
    const root = new Node('CareerPanel');
    root.layer = 33554432;
    root.parent = this.levelSelectRoot;
    root.addComponent(UITransform).setContentSize(vis.width, vis.height);
    const scrim = root.addComponent(Graphics);
    scrim.fillColor = new Color(38, 32, 27, 180);
    scrim.rect(-vis.width / 2, -vis.height / 2, vis.width, vis.height);
    scrim.fill();

    const panelW = Math.min(vis.width * 0.9, 620);
    const panelH = Math.min(vis.height * 0.72, 700);
    const panel = new Node('CareerPaper');
    panel.layer = 33554432;
    panel.parent = root;
    panel.addComponent(UITransform).setContentSize(panelW, panelH);
    const pg = panel.addComponent(Graphics);
    pg.fillColor = GameRunner.START_CARD;
    pg.strokeColor = new Color(132, 98, 70, 245);
    pg.lineWidth = 3;
    pg.roundRect(-panelW / 2, -panelH / 2, panelW, panelH, 24);
    pg.fill(); pg.stroke();

    const title = mode === 'route'
      ? `职业路线 · ${totalStars(this.session.profile)}/${this.session.levelCount * 3}星`
      : `成长成就 · ${this.session.profile.achievements.length}/${Object.keys(AchievementLabels).length}`;
    const titleNode = this.mkLabel(panel, 'CareerTitle', 0, panelH * 0.42, title, Math.min(34, panelW * 0.068), panelW * 0.78, 52);
    this.styleStartLabel(titleNode, GameRunner.START_TEXT, true);
    this.makeCareerAction(panel, 'CareerCloseButton', panelW * 0.40, panelH * 0.42, 48, 44, '×', () => this.hideCareerPanel(), true);

    if (mode === 'route') this.populateCareerRoute(panel, panelW, panelH);
    else this.populateAchievements(panel, panelW, panelH);
    this.careerPanelNode = root;
  }

  private hideCareerPanel(): void {
    if (this.careerPanelNode?.isValid) this.careerPanelNode.destroy();
    this.careerPanelNode = null;
  }

  private populateCareerRoute(panel: Node, panelW: number, panelH: number): void {
    const gapX = panelW * 0.17;
    const btnW = Math.min(80, panelW * 0.135);
    const btnH = Math.min(58, panelH * 0.083);
    CareerChapters.forEach((chapter, chapterIndex) => {
      const rowY = panelH * 0.275 - chapterIndex * panelH * 0.19;
      const heading = this.mkLabel(panel, `Chapter${chapterIndex + 1}`, -panelW * 0.20, rowY + panelH * 0.064,
        `${chapter.title} · ${chapter.subtitle}`, Math.min(20, panelW * 0.036), panelW * 0.56, 30);
      this.styleStartLabel(
        heading,
        chapterIndex <= Math.floor(this.session.profile.highestUnlockedLevel / 5) ? GameRunner.START_TEXT : GameRunner.START_MUTED,
        true,
      );
      for (let i = chapter.startLevel; i <= chapter.endLevel; i++) {
        const col = i - chapter.startLevel;
        const unlocked = this.session.isLevelUnlocked(i);
        const stars = bestStarsFor(this.session.profile, i);
        const current = i === this.session.profile.highestUnlockedLevel;
        const boss = i === chapter.bossLevel;
        const state = stars > 0 ? '★'.repeat(stars) : current ? '当前' : boss ? 'BOSS' : '待挑战';
        const text = unlocked ? `${current ? '▶ ' : ''}${i + 1}\n${state}` : `${i + 1}\n锁定`;
        this.makeCareerAction(
          panel,
          `LevelRoute${i + 1}`,
          (col - 2) * gapX,
          rowY,
          btnW,
          btnH,
          text,
          () => { if (unlocked) this.onLevelSelected(i); },
          !unlocked,
        );
      }
    });
    const hook = getLevel(this.session.profile.highestUnlockedLevel).hook
      ?? getLevel(this.session.profile.highestUnlockedLevel).challengeHint
      ?? '新的任务正在排队';
    const stars = totalStars(this.session.profile);
    const milestone = nextStarMilestone(stars);
    const reward = milestone ? `下个收藏 · ${milestone.stars}★「${milestone.label}」` : '星级收藏全部解锁';
    const footer = this.mkLabel(panel, 'RouteHook', 0, -panelH * 0.43,
      `当前 · 第${this.session.profile.highestUnlockedLevel + 1}关 · ${hook}\n${reward}`, Math.min(21, panelW * 0.040), panelW * 0.84, 64);
    this.styleStartLabel(footer, GameRunner.START_MUTED, false);
  }

  private populateAchievements(panel: Node, panelW: number, panelH: number): void {
    const ids = Object.keys(AchievementLabels) as AchievementId[];
    ids.forEach((id, index) => {
      const unlocked = this.session.profile.achievements.includes(id);
      const y = panelH * 0.275 - index * panelH * 0.115;
      const row = new Node(`Achievement-${id}`);
      row.layer = 33554432;
      row.parent = panel;
      row.setPosition(0, y, 0);
      row.addComponent(UITransform).setContentSize(panelW * 0.82, panelH * 0.09);
      const g = row.addComponent(Graphics);
      g.fillColor = unlocked ? new Color(74, 145, 125, 34) : new Color(91, 70, 49, 18);
      g.strokeColor = unlocked ? new Color(74, 145, 125, 190) : new Color(126, 114, 99, 80);
      g.lineWidth = unlocked ? 2 : 1;
      g.roundRect(-panelW * 0.41, -panelH * 0.045, panelW * 0.82, panelH * 0.09, 12);
      g.fill(); g.stroke();
      const state = this.mkLabel(row, 'State', -panelW * 0.34, 0, unlocked ? '✓' : '○', 27, 38, 38);
      this.styleStartLabel(state, unlocked ? new Color(52, 127, 105, 255) : GameRunner.START_MUTED, true);
      const name = this.mkLabel(row, 'Name', -panelW * 0.08, panelH * 0.014, AchievementLabels[id], Math.min(25, panelW * 0.047), panelW * 0.52, 30);
      this.styleStartLabel(name, unlocked ? GameRunner.START_TEXT : GameRunner.START_MUTED, true);
      const hint = this.mkLabel(row, 'Hint', -panelW * 0.08, -panelH * 0.019, AchievementHints[id], Math.min(19, panelW * 0.036), panelW * 0.52, 25);
      this.styleStartLabel(hint, GameRunner.START_MUTED, false);
    });
    const stars = totalStars(this.session.profile);
    const milestone = nextStarMilestone(stars);
    const collection = this.session.profile.cosmetics.map((id) => CosmeticLabels[id]).join(' / ');
    const footer = this.mkLabel(panel, 'CosmeticCount', 0, -panelH * 0.43,
      `收藏 · ${collection}${milestone ? `\n再拿 ${milestone.stars - stars}★ 解锁「${milestone.label}」` : '\n星级收藏已全部解锁'}`,
      Math.min(20, panelW * 0.037), panelW * 0.84, 58);
    this.styleStartLabel(footer, GameRunner.START_MUTED, false);
  }

  private makeCareerAction(parent: Node, name: string, x: number, y: number, w: number, h: number, text: string, onTap: () => void, muted = false): Node {
    const btn = new Node(name);
    btn.layer = 33554432;
    btn.parent = parent;
    btn.setPosition(x, y, 0);
    btn.addComponent(UITransform).setContentSize(w, h);
    const g = btn.addComponent(Graphics);
    const labelNode = this.mkLabel(btn, `${name}Label`, 0, 0, text, Math.min(25, Math.max(16, h * 0.28)), w - 12, h - 8);
    const label = labelNode.getComponent(Label)!;
    label.isBold = true;
    label.color = muted ? GameRunner.START_MUTED : GameRunner.START_TEXT;
    const paint = (pressed: boolean) => {
      g.clear();
      g.fillColor = muted ? GameRunner.START_SOFT : new Color(238, 232, 220, 255);
      g.strokeColor = muted ? new Color(126, 114, 99, 75) : new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, 190);
      g.lineWidth = muted ? 1 : 2;
      g.roundRect(-w / 2, -h / 2 + (pressed ? -2 : 0), w, h, Math.min(13, h * 0.22));
      g.fill(); g.stroke();
      btn.setScale(pressed ? 0.96 : 1, pressed ? 0.96 : 1, 1);
    };
    paint(false);
    btn.on(Node.EventType.TOUCH_START, () => paint(true));
    btn.on(Node.EventType.TOUCH_CANCEL, () => paint(false));
    btn.on(Node.EventType.TOUCH_END, () => { paint(false); onTap(); });
    return btn;
  }

  /** 选关回调。 */
  private onLevelSelected(idx: number): void {
    if (!this.session.isLevelUnlocked(idx)) return;
    this.session.startLevel(idx);
    this.startGame();
  }

  /** 切换游戏 UI（传送带/道具/扫描指示器/顶部标签）的可见性。 */
  private setGameUIVisible(v: boolean): void {
    if (this.beltNode) this.beltNode.active = v;
    if (this.propButtons) this.propButtons.active = v;
    if (this.scanIndicator) this.scanIndicator.active = v;
    if (this.gameTitleNode) this.gameTitleNode.active = v;
    if (this.gameTimerNode) this.gameTimerNode.active = v;
    // 美术资源（背景/角色）跟随游戏 UI 一起隐藏
    if (this.bgFillNode) this.bgFillNode.active = v;
    if (this.bgNode) this.bgNode.active = v;
    if (this.monitorSurfaceNode) this.monitorSurfaceNode.active = v;
    if (this.conveyorTrackNode) this.conveyorTrackNode.active = v;
    if (this.deskDecorNode) this.deskDecorNode.active = v;
    this.deskItemNodes.forEach((node) => { if (node?.isValid) node.active = v; });
    if (this.charNode) this.charNode.active = v;
    if (this.pressureAtmosphereNode) this.pressureAtmosphereNode.active = v;
    if (this.pauseButtonNode) this.pauseButtonNode.active = v && !this.paused;
    if (this.subtitleNode) this.subtitleNode.active = v;
    if (this.lowerHudNode) this.lowerHudNode.active = v;
    if (this.timerPlateNode) this.timerPlateNode.active = v;
    if (this.monitorLabelNode) this.monitorLabelNode.active = v;
    const deskBand = this.node.getChildByName('DeskBand');
    if (deskBand) deskBand.active = v;
    if (this.monitorProcessLabelNode) this.monitorProcessLabelNode.active = v;
    if (this.monitorEntryLabelNode) this.monitorEntryLabelNode.active = v;
    if (this.tutorialRoot) this.tutorialRoot.active = v && this.shouldShowTutorial();
  }

  /** 工具：在 parent 下创建一个带 Label 的 Node。 */
  private mkLabel(parent: Node, name: string, x: number, y: number, text: string, fontSize: number, w: number, h: number): Node {
    const node = new Node(name);
    node.layer = 33554432;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(w, h);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontFamily = 'PingFang SC';
    label.fontSize = fontSize;
    label.lineHeight = fontSize + 8;
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    label.color = Color.WHITE;
    node.setPosition(x, y, 0);
    parent.addChild(node);
    return node;
  }

  private paintFullScreenStartBg(g: Graphics): void {
    const vis = view.getVisibleSize();
    const metrics = this.startCardMetrics();
    const cardW = metrics.width;
    const cardH = metrics.height;
    const cardCY = metrics.cy;
    const cardX = -cardW / 2;
    const cardY = cardCY - cardH / 2;
    const radius = Math.min(58, cardW * 0.085);
    g.clear();

    g.fillColor = GameRunner.START_BG;
    g.rect(-vis.width / 2, -vis.height / 2, vis.width, vis.height);
    g.fill();

    // 柔和纸面投影：不用深色外框，只用多层低透明度阴影托出卡片。
    const shadow = new Color(108, 88, 62, 20);
    for (let i = 0; i < 7; i++) {
      g.fillColor = new Color(shadow.r, shadow.g, shadow.b, Math.max(3, shadow.a - i * 3));
      g.roundRect(cardX + 4 - i, cardY - 11 - i * 4, cardW - 8 + i * 2, cardH + 1, radius + i * 2);
      g.fill();
    }

    g.fillColor = GameRunner.START_CARD;
    g.strokeColor = new Color(214, 203, 188, 185);
    g.lineWidth = 1.2;
    g.roundRect(cardX, cardY, cardW, cardH, radius);
    g.fill();
    g.stroke();
  }

  /** 在主面板顶部画轻量状态药丸。 */
  private paintStartAlertBar(parent: Node, cardW: number, cardH: number, cardCY: number): void {
    const node = new Node('StartStatusPill');
    node.layer = 33554432;
    node.parent = parent;
    const pillW = Math.min(cardW * 0.42, 390);
    const pillH = cardH * 0.057;
    node.addComponent(UITransform).setContentSize(pillW, pillH);
    node.setPosition(0, cardCY + cardH * 0.385, 0);

    const g = node.addComponent(Graphics);
    g.fillColor = GameRunner.START_SOFT;
    g.strokeColor = new Color(222, 214, 202, 180);
    g.lineWidth = 1;
    g.roundRect(-pillW / 2, -pillH / 2, pillW, pillH, pillH / 2);
    g.fill();
    g.stroke();

    const dot = new Node('BreathingDot');
    dot.layer = 33554432;
    dot.parent = node;
    dot.addComponent(UITransform).setContentSize(24, 24);
    dot.setPosition(-pillW / 2 + 54, 0, 0);
    const dotG = dot.addComponent(Graphics);
    dotG.fillColor = GameRunner.START_BLUE;
    dotG.circle(0, 0, 10);
    dotG.fill();
    dot.addComponent(UIOpacity).opacity = 230;
    if (!this.sensory.settings.reducedMotion) {
      tween(dot)
        .repeatForever(
          tween()
            .to(0.72, { scale: new Vec3(1.26, 1.26, 1) }, { easing: 'sineInOut' })
            .to(0.72, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' }),
        )
        .start();
    }

    const labelNode = this.mkLabel(node, 'AlertText', 28, 0, '岗位保卫战 · 20轮挑战', Math.min(29, Math.max(22, cardW * 0.031)), pillW - 86, pillH - 4);
    const label = labelNode.getComponent(Label);
    if (label) {
      label.fontFamily = 'PingFang SC';
      label.color = GameRunner.START_TEXT;
      label.isBold = true;
    }
  }

  /** 开始页的轻量反馈开关。默认开启、设置持久化，不把系统能力藏在调试 API 里。 */
  private makeFeedbackToggles(parent: Node, cardW: number, cardH: number, cardCY: number): void {
    const w = Math.min(112, cardW * 0.135);
    const h = Math.min(56, cardH * 0.062);
    const y = cardCY + cardH * 0.385;
    const inset = Math.min(34, cardW * 0.04);
    const specs: Array<{
      name: string;
      text: string;
      x: number;
      enabled: () => boolean;
      toggle: () => void;
    }> = [
      {
        name: 'SoundToggle',
        text: '音效',
        x: -cardW / 2 + inset + w / 2,
        enabled: () => this.sensory.settings.soundEnabled,
        toggle: () => {
          const next = !this.sensory.settings.soundEnabled;
          this.sensory.setSoundEnabled(next);
          if (next) { this.sensory.unlock(); this.sensory.play('pickup'); }
        },
      },
      {
        name: 'HapticsToggle',
        text: '震动',
        x: cardW / 2 - inset - w / 2,
        enabled: () => this.sensory.settings.hapticsEnabled,
        toggle: () => {
          const next = !this.sensory.settings.hapticsEnabled;
          this.sensory.setHapticsEnabled(next);
          if (next) this.sensory.haptic('medium', 0);
        },
      },
    ];
    specs.forEach((spec) => {
      const node = new Node(spec.name);
      node.layer = 33554432;
      node.parent = parent;
      node.addComponent(UITransform).setContentSize(w, h);
      node.setPosition(spec.x, y, 0);
      const g = node.addComponent(Graphics);
      const labelNode = this.mkLabel(node, `${spec.name}Label`, 7, 0, spec.text, Math.min(24, Math.max(19, w * 0.22)), w - 28, h - 4);
      const label = labelNode.getComponent(Label)!;
      label.isBold = true;
      const paint = (pressed = false) => {
        const enabled = spec.enabled();
        const accent = enabled ? GameRunner.START_BLUE : GameRunner.START_MUTED;
        g.clear();
        g.fillColor = pressed ? new Color(226, 218, 205, 255) : GameRunner.START_SOFT;
        g.strokeColor = new Color(accent.r, accent.g, accent.b, enabled ? 190 : 92);
        g.lineWidth = enabled ? 2 : 1;
        g.roundRect(-w / 2, -h / 2, w, h, h / 2);
        g.fill(); g.stroke();
        g.fillColor = new Color(accent.r, accent.g, accent.b, enabled ? 255 : 112);
        g.circle(-w / 2 + 18, 0, enabled ? 5 : 4);
        g.fill();
        label.color = enabled ? GameRunner.START_TEXT : GameRunner.START_MUTED;
        node.setScale(pressed ? 0.96 : 1, pressed ? 0.96 : 1, 1);
      };
      paint();
      node.on(Node.EventType.TOUCH_START, () => paint(true));
      node.on(Node.EventType.TOUCH_CANCEL, () => paint(false));
      node.on(Node.EventType.TOUCH_END, () => { spec.toggle(); paint(false); });
    });
  }

  private makeStartButton(parent: Node, x: number, y: number, w: number, h: number, text: string, onTap: () => void): Node {
    const btn = new Node('StartButton');
    btn.layer = 33554432;
    btn.parent = parent;
    btn.addComponent(UITransform).setContentSize(w, h + 18);
    btn.setPosition(x, y, 0);

    const g = btn.addComponent(Graphics);
    this.paintStartThickButton(g, w, h, false);

    const playNode = new Node('StartPlayIcon');
    playNode.layer = 33554432;
    playNode.parent = btn;
    const iconSide = Math.min(34, h * 0.46);
    playNode.addComponent(UITransform).setContentSize(iconSide, iconSide);
    playNode.setPosition(-w * 0.145, 5, 0);
    const playG = playNode.addComponent(Graphics);
    playG.fillColor = new Color(255, 252, 246, 238);
    playG.circle(0, 0, iconSide * 0.58);
    playG.fill();
    playG.strokeColor = new Color(166, 125, 88, 116);
    playG.lineWidth = 2;
    playG.circle(0, 0, iconSide * 0.58);
    playG.stroke();
    playG.fillColor = GameRunner.START_TEXT;
    playG.moveTo(-iconSide * 0.10, -iconSide * 0.22);
    playG.lineTo(iconSide * 0.24, 0);
    playG.lineTo(-iconSide * 0.10, iconSide * 0.22);
    playG.close();
    playG.fill();
    playG.fillColor = new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, 150);
    playG.circle(iconSide * 0.36, iconSide * 0.20, Math.max(2.5, iconSide * 0.08));
    playG.fill();

    const labelNode = this.mkLabel(btn, 'StartButtonLabel', 38, 5, text, Math.min(42, Math.max(32, h * 0.40)), w * 0.64, h - 12);
    const label = labelNode.getComponent(Label);
    if (label) {
      label.fontFamily = 'PingFang SC';
      label.isBold = true;
      label.color = GameRunner.START_TEXT;
      label.lineHeight = label.fontSize + 8;
      label.horizontalAlign = 1;
      label.verticalAlign = 1;
      label.overflow = Label.Overflow.SHRINK;
    }

    const setPressed = (pressed: boolean) => {
      this.paintStartThickButton(g, w, h, pressed);
      const dy = pressed ? -5 : 0;
      playNode.setPosition(-w * 0.145, 5 + dy, 0);
      labelNode.setPosition(38, 5 + dy, 0);
    };
    btn.on(Node.EventType.TOUCH_START, () => setPressed(true));
    btn.on(Node.EventType.TOUCH_CANCEL, () => setPressed(false));
    btn.on(Node.EventType.TOUCH_END, () => {
      setPressed(false);
      onTap();
    });
    return btn;
  }

  /** 每日挑战是次级、自愿入口：沿用纸质按键语言，但不与主线蓝色主按钮争抢权重。 */
  private makeStartSecondaryButton(parent: Node, name: string, x: number, y: number, w: number, h: number, text: string, onTap: () => void): Node {
    const btn = new Node(name);
    btn.layer = 33554432;
    btn.parent = parent;
    btn.addComponent(UITransform).setContentSize(w, h + 8);
    btn.setPosition(x, y, 0);
    const g = btn.addComponent(Graphics);
    const labelNode = this.mkLabel(btn, `${name}Label`, 0, 2, text, Math.min(24, Math.max(18, h * 0.38)), w - 14, h - 8);
    const label = labelNode.getComponent(Label)!;
    label.isBold = true;
    label.color = GameRunner.START_TEXT;
    const paint = (pressed: boolean) => {
      g.clear();
      g.fillColor = new Color(91, 70, 49, pressed ? 25 : 38);
      g.roundRect(-w / 2 + 4, -h / 2 - (pressed ? 1 : 6), w - 8, h, Math.min(16, h * 0.30));
      g.fill();
      g.fillColor = GameRunner.START_CARD;
      g.strokeColor = new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, pressed ? 170 : 220);
      g.lineWidth = 2.5;
      g.roundRect(-w / 2, -h / 2 + (pressed ? -2 : 1), w, h - 5, Math.min(16, h * 0.30));
      g.fill(); g.stroke();
      labelNode.setPosition(0, pressed ? -2 : 2, 0);
    };
    paint(false);
    btn.on(Node.EventType.TOUCH_START, () => paint(true));
    btn.on(Node.EventType.TOUCH_CANCEL, () => paint(false));
    btn.on(Node.EventType.TOUCH_END, () => { paint(false); onTap(); });
    return btn;
  }

  private paintStartThickButton(g: Graphics, w: number, h: number, pressed: boolean): void {
    // 入口 CTA 与主界面道具按钮统一：米白纸质键帽 + 暖棕描边/厚度，蓝色只做极少量点缀。
    g.clear();
    const faceShift = pressed ? -4 : 0;
    const lift = pressed ? 2 : 8;
    const radius = Math.min(24, Math.max(15, h * 0.24));

    g.fillColor = new Color(54, 48, 42, pressed ? 24 : 42);
    g.roundRect(-w / 2 + 6, -h / 2 - lift - 2, w - 12, h, radius);
    g.fill();

    g.fillColor = new Color(178, 139, 102, 210);
    g.roundRect(-w / 2 + 1, -h / 2 - lift, w - 2, h - 2, radius);
    g.fill();

    g.fillColor = GameRunner.START_CARD;
    g.strokeColor = new Color(146, 106, 76, pressed ? 210 : 238);
    g.lineWidth = 3;
    g.roundRect(-w / 2 + 2, -h / 2 + 4 + faceShift, w - 4, h - lift - 5, radius);
    g.fill(); g.stroke();

    g.strokeColor = new Color(125, 91, 65, pressed ? 160 : 220);
    g.lineWidth = 2.5;
    g.moveTo(-w / 2 + radius + 8, h / 2 - lift - 6 + faceShift);
    g.lineTo(w / 2 - radius - 8, h / 2 - lift - 6 + faceShift);
    g.stroke();

    g.fillColor = new Color(255, 255, 255, pressed ? 28 : 54);
    g.roundRect(-w / 2 + radius + 10, h / 2 - lift - 14 + faceShift, w - radius * 2 - 20, 6, 3);
    g.fill();

    g.fillColor = new Color(166, 125, 88, pressed ? 128 : 178);
    g.roundRect(-w / 2 + 24, -h / 2 + 12 + faceShift, w - 48, 5, 3);
    g.fill();
  }

  private styleStartLabel(node: Node, color: Color, bold: boolean): void {
    const label = node.getComponent(Label);
    if (!label) return;
    label.color = color;
    label.isBold = bold;
    label.overflow = Label.Overflow.SHRINK;
  }

  private makeStartDoodles(parent: Node, vis: { width: number; height: number }, cardW: number, cardH: number, cardCY: number): void {
    const steps = new Node('StartSteps');
    steps.layer = 33554432;
    steps.parent = parent;
    steps.addComponent(UITransform).setContentSize(vis.width, vis.height);
    const stepW = cardW * 0.27;
    const stepH = cardH * 0.205;
    const gap = cardW * 0.035;
    const y = cardCY - cardH * 0.123;
    const data: Array<[string, string]> = [
      ['hold', '1 轻点快投'],
      ['target', '2 拖动选卡'],
      ['throw', '3 松手甩出'],
    ];
    data.forEach(([icon, text], i) => {
      this.drawStartStepCard(steps, i, (i - 1) * (stepW + gap), y, stepW, stepH, text, icon);
    });
  }

  private drawStartStepCard(parent: Node, index: number, x: number, y: number, w: number, h: number, text: string, icon: string): void {
    const card = new Node(`StartStepCard${index}`);
    card.layer = 33554432;
    card.parent = parent;
    card.addComponent(UITransform).setContentSize(w, h);
    card.setPosition(x, y, 0);
    const g = card.addComponent(Graphics);
    const radius = Math.min(42, w * 0.30);
    g.fillColor = GameRunner.START_SOFT;
    g.roundRect(-w / 2, -h / 2, w, h, radius);
    g.fill();

    g.fillColor = new Color(255, 255, 255, 255);
    g.strokeColor = new Color(218, 209, 196, 150);
    g.lineWidth = 1;
    const iconR = Math.min(34, w * 0.16);
    g.circle(0, h * 0.22, iconR);
    g.fill();
    g.stroke();

    this.drawStartStepIcon(g, icon, 0, h * 0.22, iconR);

    const labelNode = this.mkLabel(card, `StartStepText${index}`, 0, -h * 0.28, text, Math.min(28, Math.max(22, w * 0.12)), w - 18, h * 0.34);
    const label = labelNode.getComponent(Label);
    if (label) {
      label.fontFamily = 'PingFang SC';
      label.color = GameRunner.START_TEXT;
      label.isBold = true;
      label.horizontalAlign = 1;
      label.verticalAlign = 1;
      label.overflow = Label.Overflow.SHRINK;
    }
  }

  private drawStartStepIcon(g: Graphics, icon: string, cx: number, cy: number, r: number): void {
    g.strokeColor = GameRunner.START_BLUE;
    g.fillColor = new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, 40);
    g.lineWidth = Math.max(3, r * 0.13);
    if (icon === 'hold') {
      g.moveTo(cx - r * 0.34, cy + r * 0.34);
      g.lineTo(cx + r * 0.42, cy);
      g.lineTo(cx - r * 0.18, cy - r * 0.18);
      g.lineTo(cx - r * 0.34, cy - r * 0.56);
      g.close();
      g.stroke();
      return;
    }
    if (icon === 'target') {
      g.circle(cx, cy, r * 0.42);
      g.stroke();
      g.moveTo(cx - r * 0.62, cy);
      g.lineTo(cx - r * 0.32, cy);
      g.moveTo(cx + r * 0.32, cy);
      g.lineTo(cx + r * 0.62, cy);
      g.moveTo(cx, cy - r * 0.62);
      g.lineTo(cx, cy - r * 0.32);
      g.moveTo(cx, cy + r * 0.32);
      g.lineTo(cx, cy + r * 0.62);
      g.stroke();
      g.fillColor = GameRunner.START_BLUE;
      g.circle(cx, cy, r * 0.12);
      g.fill();
      return;
    }
    g.moveTo(cx - r * 0.52, cy + r * 0.12);
    g.lineTo(cx + r * 0.55, cy + r * 0.42);
    g.lineTo(cx + r * 0.18, cy - r * 0.54);
    g.close();
    g.stroke();
    g.moveTo(cx + r * 0.55, cy + r * 0.42);
    g.lineTo(cx - r * 0.05, cy - r * 0.08);
    g.stroke();
  }

  /** 战报：自包含的小卡片 + 内嵌可点击按钮，与 scene 节点解耦。 */
  private finishAndShowReport(): void {
    if (this.reported) return;
    this.reported = true;
    this.uiState = 'result';
    this.hideTutorial();
    this.clearPaperAim(true);
    const idx = this.session.currentIndex;
    const report = this.game.buildReport(idx);
    const canRevive = report.result === 'lose' && !this.game.revived;
    const challengeBeforeFinish = this.session.activeChallenge;
    const dailyKey = challengeBeforeFinish?.mode === 'daily' ? challengeBeforeFinish.keyHash.toString(36) : null;
    this.pendingTelemetryReport = {
      report,
      failReason: this.game.lastFailReason ?? 'unknown',
    };
    if (!canRevive) this.finalizePendingTelemetry();
    this.session.finishLevel(report);
    const progression = this.session.lastProgression;
    const newAchievementLabels = (progression?.newAchievements ?? [])
      .map((id) => AchievementLabels[id])
      .filter((label): label is string => Boolean(label));
    const newCosmeticLabels = (progression?.newCosmetics ?? [])
      .map((id) => CosmeticLabels[id])
      .filter((label): label is string => Boolean(label));
    const currentDaily = dailyKey ? this.session.profile.dailyRecords.find((record) => record.key === dailyKey) : undefined;
    const dailyRewardLine = progression?.daily && currentDaily
      ? progression.daily.firstAttempt
        ? `今日首通奖励 ✓ 蓝色纸团外观 +「${AchievementLabels['daily-first']}」`
        : progression.daily.newRecord
          ? `今日新纪录 ${progression.daily.previousBest}→${currentDaily.score}`
          : `今日最佳 ${currentDaily.score} · 再冲一次刷新纪录`
      : '';
    this.approvalGaugeView?.snap(report.finalApproval, this.game.approval.currentZone, '', report.timeUsedSec);

    const vis = view.getVisibleSize();
    const resultLayout = UiTokens.layout.result;
    const pw = Math.min(vis.width * resultLayout.widthRatio, resultLayout.maxWidth);
    const ph = Math.min(vis.height * resultLayout.heightRatio, resultLayout.maxHeight);
    const won = report.result !== 'lose';
    const objectiveLine = report.objectiveLabel
      ? `${report.objectiveMet ? '目标达成 ✓' : '目标未达'} · ${report.objectiveLabel}`
      : '';
    const highlightLine = report.highlightTitle ? `本局高光 · ${report.highlightTitle}` : '';
    const achievementLine = newAchievementLabels.length > 0 ? `新成就 · ${newAchievementLabels.join(' / ')}` : '';
    const cosmeticLine = !dailyRewardLine && newCosmeticLabels.length > 0 ? `新收藏 · ${newCosmeticLabels.join(' / ')}` : '';
    const accolades = [dailyRewardLine, highlightLine, achievementLine, cosmeticLine].filter(Boolean);
    const primaryAccolade = accolades[0] ?? '';
    const secondaryAccolade = accolades.slice(1).join(' · ');
    const failureCoach = this.game.getFailureCoach();
    const learningLine = report.perfectHits > 0
      ? `本局 ${report.perfectHits} 次 Perfect · 精准投掷正在变稳`
      : report.missedThrows === 0
        ? `全程零失误 · 有效命中 ${report.effectiveHits} 次`
        : `有效命中 ${report.effectiveHits} 次 · 下局先减少空投`;
    const reviewTitle = won
      ? this.compactResultText(primaryAccolade || objectiveLine || (report.result === 'win-hunt' ? '主动反杀 · AI 被你劝退了' : '生存成功 · 今天的岗位守住了'), 30)
      : this.compactResultText(`失败复盘 · ${failureCoach.title}`, 30);
    const reviewBody = won
      ? this.compactResultText(secondaryAccolade || (primaryAccolade ? objectiveLine : '') || learningLine, 48)
      : this.compactResultText([achievementLine, cosmeticLine, failureCoach.advice].filter(Boolean).join(' · '), 54);
    const rank = this.session.rankLabel;
    const day = this.session.daysEmployed;
    const currentBestStars = progression?.bestStarsAfter ?? bestStarsFor(this.session.profile, idx);
    const previousBestStars = progression?.bestStarsBefore ?? currentBestStars;
    const starsGained = Math.max(0, currentBestStars - previousBestStars);
    const starRecord = starsGained > 0
      ? `新收集 +${starsGained}★ · 本关最佳 ${currentBestStars}★`
      : `本关最佳 ${currentBestStars}★`;
    const rankGain = Math.max(0, (progression?.rankScoreAfter ?? 0) - (progression?.rankScoreBefore ?? 0));
    const rankUp = !!progression && progression.rankAfter !== progression.rankBefore;
    const currentRankProgress = rankProgress(this.session.profile);
    const previousRankProgress = progression ? rankProgressFromScore(progression.rankScoreBefore) : currentRankProgress;
    const careerLine = dailyKey
      ? `每日挑战 · ${currentDaily ? `今日最佳 ${currentDaily.score}` : '成绩已记录'} · 奖励不增加战斗数值`
      : `${starRecord} · 总星${totalStars(this.session.profile)}/${this.session.levelCount * 3}${progression?.unlockedNextLevel ? ' · 新关卡已解锁' : ''}`;
    const growthTitle = progression?.daily
      ? progression.daily.firstAttempt ? '今日奖励已入库' : progression.daily.newRecord ? '今日纪录刷新' : '今日成绩已记录'
      : progression?.mode === 'friend'
        ? '好友挑战 · 独立计分'
        : rankUp
          ? `段位晋升 · ${RankLabels[progression!.rankAfter]}`
          : `${rank}${rankGain > 0 ? ` · 成长 +${rankGain}` : ''}`;
    const growthDetail = progression?.daily
      ? `本局 ${progression.daily.score} · 最佳 ${progression.daily.best}`
      : progression?.mode === 'friend'
        ? '不影响主线星级与段位'
        : currentRankProgress.next
          ? `${progression?.rankScoreBefore ?? currentRankProgress.score}→${currentRankProgress.score} · 距${RankLabels[currentRankProgress.next]} ${Math.ceil(currentRankProgress.remaining)}分`
          : `${currentRankProgress.score}分 · 已达最高段位`;
    const canNext = won && this.session.hasNext;
    const nextLevel = canNext ? getLevel(idx + 1) : null;
    const nextHook = this.compactResultText(canNext
      ? `下一关 · ${nextLevel?.hook ?? nextLevel?.objective?.label ?? nextLevel?.challengeHint ?? '新的任务正在排队'}`
      : this.session.activeChallenge
        ? '同一套任务流 · 晒出战报让好友接招'
      : won
        ? '全部轮次完成 · 回到选关复盘高光'
        : `再试一次 · ${onboardingRetryHint(idx) ?? report.objectiveLabel ?? getLevel(idx).challengeHint ?? '稳住认可度'}`, 44);

    if (this.reportLabel) this.reportLabel.node.active = false;
    if (this.retryBtn) this.retryBtn.active = false;
    if (this.nextBtn) this.nextBtn.active = false;
    if (this.reviveBtn) this.reviveBtn.active = false;

    // 内嵌可点击按钮：根据实际按钮数量自动居中，避免胜利/失败状态下出现空槽偏移。
    const buttons: ResultDialogButton[] = won
      ? [
        { name: 'BtnRetry', text: '再玩一次', color: UiTokens.color.walnut, variant: 'secondary', tap: () => this.onRetry() },
        { name: 'BtnShare', text: '晒战报', color: UiTokens.color.blue, variant: 'secondary', tap: () => { void this.onShareReport(report, rank, day); } },
        {
          name: 'BtnNext',
          text: canNext ? '下一关' : '回到选关',
          color: UiTokens.color.blue,
          variant: 'primary',
          tap: () => canNext ? this.onNext() : this.onBackToSelect(),
        },
      ]
      : [
        { name: 'BtnRetry', text: '立即重试', color: UiTokens.color.blue, variant: 'primary', tap: () => this.onRetry() },
        ...(canRevive
          ? [{ name: 'BtnRevive', text: this.rewardedAds.config.enabled ? '看广告复活' : '复活 +8s', color: UiTokens.color.amber, variant: 'reward' as const, tap: () => { void this.onRevive(); } }]
          : []),
        ...(!canRevive
          ? [{ name: 'BtnShare', text: '晒战报', color: UiTokens.color.blue, variant: 'secondary' as const, tap: () => { void this.onShareReport(report, rank, day); } }]
          : []),
        { name: 'BtnBack', text: '回到选关', color: UiTokens.color.walnut, variant: 'secondary', tap: () => this.onBackToSelect() },
      ];

    if (!this.resultDialogView) this.resultDialogView = new ResultDialogView();
    const nodes = this.resultDialogView.show({
      parent: this.node,
      layer: 1 << 25,
      viewWidth: vis.width,
      viewHeight: vis.height,
      width: pw,
      height: ph,
      won,
      result: report.result,
      title: report.result === 'win-hunt' ? '反杀成功!' : report.result === 'win-survive' ? '岗位守住!' : '被 AI 优化了…',
      badgeText: report.highlightTitle ?? (report.result === 'win-hunt' ? '猎杀通关' : report.result === 'win-survive' ? '生存通关' : '淘汰'),
      stars: report.stars,
      peakApproval: report.peakApproval,
      finalApproval: report.finalApproval,
      timeUsedSec: report.timeUsedSec,
      maxCombo: report.maxCombo,
      effectiveHits: report.effectiveHits,
      perfectHits: report.perfectHits,
      missedThrows: report.missedThrows,
      rank,
      day,
      careerLine,
      growthTitle,
      growthDetail,
      growthRatio: progression?.mode === 'main' ? currentRankProgress.ratio : null,
      growthPreviousRatio: progression?.mode === 'main' && !rankUp ? previousRankProgress.ratio : rankUp ? 0 : null,
      growthEmphasized: rankUp || !!progression?.daily?.newRecord,
      reviewTitle,
      reviewBody,
      nextHook,
      buttons,
    });
    this.resultPanelNode = nodes.panel;
    this.resultScrimNode = nodes.scrim;
  }

  private compactResultText(text: string, maxChars: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > maxChars ? `${normalized.slice(0, Math.max(1, maxChars - 1))}…` : normalized;
  }

  private async onShareReport(report: RunReport, rank: string, day: number): Promise<void> {
    const payload = buildSharePayload(report, rank, day, this.currentSeed);
    this.telemetry.shareOpened(payload.card.variant);
    const outcome = await this.shareBridge.share(payload);
    this.telemetry.shareResult(outcome);
    // Web 预览无系统分享面板时复制挑战链接；结果页不额外弹阻断式弹窗。
    if (outcome === 'copied') {
      // eslint-disable-next-line no-console
      console.info('[Share] 挑战链接已复制');
    }
  }

  private finalizePendingTelemetry(): void {
    const pending = this.pendingTelemetryReport;
    if (!pending) return;
    this.pendingTelemetryReport = null;
    this.telemetry.endLevel(pending.report, pending.failReason);
  }

  private resultPanelNode: Node | null = null;
  private resultDialogView: ResultDialogView | null = null;

  private hideReport(): void {
    this.resultDialogView?.hide();
    if (this.resultPanelNode) this.resultPanelNode.active = false;
    if (this.resultScrimNode) this.resultScrimNode.active = false;
    if (this.reportLabel) this.reportLabel.node.active = false;
    if (this.nextBtn) this.nextBtn.active = false;
    if (this.retryBtn) this.retryBtn.active = false;
    if (this.reviveBtn) this.reviveBtn.active = false;
  }

  /* ---------- 主循环 ---------- */

  update(dt: number): void {
    this.runtimeMonitor?.observeFrame(dt);
    // 选关页：不驱动游戏逻辑
    if (this.uiState === 'select') return;

    if (this.paused) {
      this.updateAmbientPresentation(0);
      return;
    }

    // 常驻表现独立于固定逻辑步进；QA 场景只同步状态、不推进时间。
    this.updateAmbientPresentation(this.qaConfig && this.qaApplied ? 0 : dt);
    // QA 只冻结玩法规则，不冻结手势表现，保证固定场景仍可验收跟手与投掷反馈。
    if (this.aimingProp !== null) this.updateAimFrame(dt);

    // QA URL 是静态视觉基线：场景建立完成后冻结规则推进，保证等待多久截图都一致。
    if (this.qaConfig && this.qaApplied) return;

    this.telemetry.sampleFrame(dt);

    if (this.game.over) {
      if (!this.reported) this.finishAndShowReport();
      return;
    }

    // 蓄力扫描视觉进度（时长读配置，避免与逻辑脱节）
    const charging = this.game.prop.chargingProp;
    if (charging !== null) {
      this.scanPos = Math.min(1, this.scanPos + dt / BalanceConfig.control.scanSec);
    } else {
      this.scanPos = 0;
    }
    // 逻辑固定步进
    this.accumulator += dt;
    let guard = 0;
    while (this.accumulator >= this.dt && guard++ < 100) {
      this.accumulator -= this.dt;
      this.game.tick(this.dt);
      if (this.game.over) break;
    }
    this.render();
  }

  /* ---------- 输入 ---------- */

  private bindPropButtons(): void {
    if (!this.propButtons) {
      // eslint-disable-next-line no-console
      console.warn('[GameRunner] propButtons 未接线：底部4个道具按钮点不到。把 Props 节点拖进 propButtons 槽。');
      return;
    }
    // 缓存场景里的 4 个真实按钮。后续会在 Props 下加入背景节点，不能再直接遍历 children。
    this.propButtonNodes = this.propButtons.children.filter((child: Node) => /^Prop\d+$/.test(child.name));
    this.propButtonNodes.forEach((btn: Node, i: number) => {
      const type = GameRunner.PROP_TYPES[i];
      // 文字标签：底部两行（纸团意象 / 作用+次数），overflow 收缩防超宽
      const label = btn.getComponent(Label);
      if (label) {
        label.enabled = false;
      }
      const actionNode = btn.getChildByName('ActionLabel') ?? new Node('ActionLabel');
      actionNode.layer = 1 << 25;
      if (!actionNode.parent) actionNode.parent = btn;
      if (!actionNode.getComponent(UITransform)) actionNode.addComponent(UITransform);
      const actionLabel = actionNode.getComponent(Label) ?? actionNode.addComponent(Label);
      actionLabel.string = GameRunner.PROP_ACTION_LABELS[i] ?? '';
      actionLabel.fontFamily = 'PingFang SC';
      actionLabel.horizontalAlign = 1;
      actionLabel.verticalAlign = 1;
      actionLabel.isBold = true;
      actionLabel.overflow = Label.Overflow.SHRINK;
      this.propActionLabels[i] = actionLabel;
      // 图标 Sprite：运行时由 renderPropHUD 按 propSfFor 装载；没素材则隐藏、文字标签上移兜底
      let icon = this.propIconSprites[i] ?? null;
      if (!icon) {
        const iconNode = new Node(`PropIcon${i}`);
        iconNode.layer = 1 << 25;
        iconNode.addComponent(UITransform);
        icon = iconNode.addComponent(Sprite);
        icon.sizeMode = Sprite.SizeMode.CUSTOM;
        iconNode.parent = btn;
        iconNode.setSiblingIndex(0); // 图标在文字之下层（先绘制），避免遮住状态文字
        this.propIconSprites[i] = icon;
      }
      // 同一次手势优先由按钮闭环处理。微信小游戏里节点触摸可能不会继续冒泡到
      // input.TOUCH_END；全局监听只作为手指拖出按钮后的兜底。状态机会过滤重复派发。
      btn.on(Node.EventType.TOUCH_START, (event: EventTouch) => this.onPropDown(type, event));
      btn.on(Node.EventType.TOUCH_END, (event: EventTouch) => this.onPropUp(type, event, true));
      btn.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => this.onPropCancel(type, event));
    });
  }

  private bindFlowButtons(): void {
    this.nextBtn?.on(Node.EventType.TOUCH_END, () => this.onNext());
    this.retryBtn?.on(Node.EventType.TOUCH_END, () => this.onRetry());
    this.reviveBtn?.on(Node.EventType.TOUCH_END, () => this.onRevive());
  }

  private onPropDown(prop: PropType, event?: EventTouch): void {
    if (this.paused) return;
    if (this.propInteractionState !== 'idle') return;
    this.sensory.unlock();
    this.sensory.play('press');
    this.sensory.haptic('light', 80);
    this.telemetry.propHoldStarted(prop);
    if (prop === PT.KissUp) {
      const st = this.game.prop.getState(prop);
      const usable = this.game.prop.isUnlocked(prop) && st.uses > 0 && st.ready;
      if (usable) {
        this.sensory.play('pickup');
        this.propInteractionState = 'launching';
        this.telemetry.released(prop);
        this.game.useKissUp();
        this.animatePaperToRobot(prop);
      } else {
        this.setEventText(`${this.propDisplayName(prop)}暂时不能用`);
      }
      this.punchButton(prop, true);
      this.scheduleOnce(() => this.punchButton(prop, false), UiTokens.motion.releaseSec);
      return;
    }
    if (this.game.beginCharge(prop, true)) {
      this.sensory.play('pickup');
      this.aimStart = this.propSourcePoint(prop);
      const recommendation = this.game.getTargetRecommendation(prop);
      this.aimingSlot = recommendation?.slot ?? this.slotFromAimPoint(this.aimStart);
      this.aimPoint = this.aimStart.clone();
      this.showPaperAim(prop);
      this.activeAimTouchId = event?.getID() ?? null;
      this.propInteractionState = 'arming';
      this.aimingProp = prop;
      this.aimManualTargeting = false;
      this.lockAimCardAtSlot(prop, this.aimingSlot);
      const pointer = event ? this.pointFromPointer(event) : this.aimStart.clone();
      this.aimGestureStart.set(pointer);
      this.aimGestureLast.set(pointer);
      this.aimGestureLastMs = Date.now();
      this.aimReleaseVelocityX = 0;
      this.aimReleaseVelocityY = 0;
      this.aimHasLeftSource = false;
      this.aimReturnCancel = false;
      const recommendedPoint = this.targetPointForSlot(this.aimingSlot);
      this.aimSelectionX = recommendedPoint.x;
      // 起手纸团留在手指下，不再为了推荐目标横向瞬移。
      this.aimDesiredPoint.set(pointer.x, pointer.y, 0);
      this.updateAimFrame(1 / 60);
      this.advanceTutorial(1, UiTokens.tutorial.dragHint);
      this.setEventText(this.aimRecommendationText(prop), UiTokens.feedback.eventHintTtlSec, 7);
    } else {
      this.setEventText(`${this.propDisplayName(prop)}暂时不能扔`);
    }
    this.punchButton(prop, true);
  }
  private onPropUp(prop: PropType, event?: EventTouch | EventMouse, trustedNodeEnd = false): void {
    if (this.propInteractionState !== 'arming' && this.propInteractionState !== 'dragging') return;
    if (!trustedNodeEnd && event && !this.activeAimPointerMatches(event)) return;
    if (prop === PT.KissUp) return;
    this.finishPaperThrow(prop, event);
    this.punchButton(prop, false);
  }
  private onPropCancel(prop: PropType, event?: EventTouch): void {
    if (this.propInteractionState === 'launching' || this.propInteractionState === 'idle') return;
    if (event && !this.activeAimPointerMatches(event)) return;
    if (this.aimingProp === prop) {
      // 手指移出按钮时 Cocos 会合法派发 TOUCH_CANCEL，投掷仍由全局 END 闭环。
      // 隐藏/暂停会在生命周期回调中真正清理，这里不抢先取消手势。
      this.punchButton(prop, false);
      return;
    }
    if (prop !== PT.KissUp) this.game.cancel(prop);
    this.punchButton(prop, false);
  }

  private finishPaperThrow(prop: PropType, event?: EventTouch | EventMouse): void {
    if (this.aimingProp !== prop) return;
    if (event) this.updateReturnCancelState(prop, this.sampleAimGesture(event));
    if (this.aimReturnCancel) {
      this.cancelPaperThrow(prop, '已收回道具');
      return;
    }
    let lockedSlot = this.resolvedAimSlot(prop);
    if (lockedSlot < 0) {
      const fallback = this.game.getTargetRecommendation(prop)?.slot ?? this.closestValidAimSlot(prop, this.aimSelectionX);
      if (fallback < 0) {
        this.telemetry.releaseNoop(prop, 'no-valid-target');
        this.cancelPaperThrow(prop, '当前没有可用目标，道具未消耗');
        return;
      }
      lockedSlot = fallback;
      this.lockAimCardAtSlot(prop, lockedSlot);
    }
    this.aimingSlot = lockedSlot;
    this.updateAimFrame(1 / 60, true);
    const slot = lockedSlot;
    const quality = this.currentDragHitQuality();
    const velocityFresh = Date.now() - this.aimGestureLastMs <= UiTokens.aim.releaseVelocityHoldMs;
    const throwStrength = throwPresentationStrength(velocityFresh ? this.aimReleaseVelocityY : 0);
    const lockedCardId = this.aimLockedCardId;
    const lockedCardOffset = this.aimLockedCardOffset;
    this.telemetry.released(prop);
    this.propInteractionState = 'launching';
    const resolveArrivalSlot = (): number => {
      const arrivalAnchorSlot = prop === PT.ChangeDemand || prop === PT.ThrowPot
        ? findLockedCardSlot(this.game.conveyor.cards, lockedCardId)
        : slot;
      return arrivalAnchorSlot < 0 ? -1 : arrivalAnchorSlot - lockedCardOffset;
    };
    this.animatePaperThrow(
      prop,
      slot,
      quality,
      throwStrength,
      this.aimManualTargeting,
      new Vec3(this.aimReleaseVelocityX, this.aimReleaseVelocityY, 0),
      () => {
        const liveSlot = resolveArrivalSlot();
        return liveSlot >= 0 && liveSlot < this.game.conveyor.cards.length
          ? this.targetPointForSlot(liveSlot)
          : this.targetPointForSlot(slot);
      },
      () => {
        const arrivalSlot = resolveArrivalSlot();
        if (arrivalSlot < 0 || arrivalSlot >= this.game.conveyor.cards.length) {
          this.telemetry.releaseNoop(prop, 'target-left-belt');
          this.game.cancel(prop);
          return this.targetPointForSlot(slot);
        }
        const arrivalPoint = this.targetPointForSlot(arrivalSlot);
        this.game.releaseAtSlot(prop, arrivalSlot, quality);
        return arrivalPoint;
      },
    );
    this.clearPaperAim(false);
    this.punchButton(prop, false);
  }

  private onGlobalTouchMove(event: EventTouch): void {
    if (this.paused) return;
    if (this.aimingProp === null) return;
    if (!this.activeAimPointerMatches(event)) return;
    this.handleAimPointerMove(event);
  }

  private onGlobalTouchEnd(event: EventTouch): void {
    if (this.paused) return;
    if (!this.activeAimPointerMatches(event)) return;
    const prop = this.aimingProp;
    if (prop === null) return;
    this.onPropUp(prop, event);
  }

  private onGlobalTouchCancel(event: EventTouch): void {
    if (this.paused) return;
    if (!this.activeAimPointerMatches(event)) return;
    const prop = this.aimingProp;
    if (prop === null) return;
    // 手指移出按钮或捕获转移时会收到合成 CANCEL；投掷仍由对应 END 闭环。
    // 应用失焦/暂停另有显式清理，这里不让一次伪取消吃掉松手。
    this.punchButton(prop, false);
  }

  private onGlobalMouseMove(event: EventMouse): void {
    if (this.paused) return;
    if (this.aimingProp === null) return;
    this.handleAimPointerMove(event);
  }

  private onGlobalMouseUp(event: EventMouse): void {
    if (this.paused) return;
    const prop = this.aimingProp;
    if (prop === null) return;
    this.onPropUp(prop, event);
  }

  /** 鼠标始终视为同一指针；触摸只接受发起当前投掷的那根手指。 */
  private activeAimPointerMatches(event: EventTouch | EventMouse): boolean {
    const getId = (event as EventTouch).getID;
    if (typeof getId !== 'function') return true;
    const id = getId.call(event);
    return this.activeAimTouchId === null || id === this.activeAimTouchId;
  }

  private handleAimPointerMove(event: EventTouch | EventMouse): void {
    const raw = this.sampleAimGesture(event);
    const dx = raw.x - this.aimGestureStart.x;
    const dy = raw.y - this.aimGestureStart.y;
    if (this.propInteractionState === 'arming' && isManualThrowGesture(dx, dy)) {
      this.propInteractionState = 'dragging';
      this.telemetry.dragStarted();
      this.telemetry.manualThrowStarted(this.aimingProp);
      this.aimManualTargeting = true;
      this.advanceTutorial(2, UiTokens.tutorial.releaseHint);
    }
    if (this.aimManualTargeting) {
      const targetY = this.aimSlotTargets[0]?.y ?? this.targetPointForSlot(0).y;
      this.aimSelectionX = projectedThrowTargetX(
        this.aimGestureStart.x,
        this.aimGestureStart.y,
        raw.x,
        raw.y,
        targetY,
      );
    }
    this.updateReturnCancelState(this.aimingProp, raw);
    // 纸团始终跟随真实手指；目标选择由 aimSelectionX 独立控制。
    this.queueAimRawPoint(raw);
  }

  private sampleAimGesture(event: EventTouch | EventMouse): Vec3 {
    const raw = this.pointFromPointer(event);
    const now = Date.now();
    const dt = (now - this.aimGestureLastMs) / 1000;
    const dx = raw.x - this.aimGestureLast.x;
    const dy = raw.y - this.aimGestureLast.y;
    if (this.aimGestureLastMs > 0 && dt > 0.004 && Math.hypot(dx, dy) > 0.5) {
      const sampleDt = Math.min(dt, 0.08);
      const velocityX = dx / sampleDt;
      const velocityY = dy / sampleDt;
      this.aimReleaseVelocityX += (velocityX - this.aimReleaseVelocityX) * UiTokens.aim.releaseVelocitySmoothing;
      this.aimReleaseVelocityY += (velocityY - this.aimReleaseVelocityY) * UiTokens.aim.releaseVelocitySmoothing;
    }
    if (Math.hypot(raw.x - this.aimGestureLast.x, dy) > 0.5) {
      this.aimGestureLast.set(raw);
      this.aimGestureLastMs = now;
    }
    return raw;
  }

  private updateReturnCancelState(prop: PropType, raw: Vec3): void {
    if (this.propInteractionState !== 'dragging') return;
    const source = this.propSourcePoint(prop);
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const ut = this.propButtonNodes[idx]?.getComponent(UITransform);
    const base = Math.max(ut?.width ?? 76, ut?.height ?? 76);
    const distance = Math.hypot(raw.x - source.x, raw.y - source.y);
    if (distance >= Math.max(64, base * 0.72)) this.aimHasLeftSource = true;
    const returning = this.aimHasLeftSource && distance <= Math.max(42, base * 0.48);
    if (returning === this.aimReturnCancel) return;
    this.aimReturnCancel = returning;
    this.punchButton(prop, returning);
    if (returning) this.setEventText('松手收回 · 不消耗道具', 0.8, 9);
    else this.setEventText(this.aimRecommendationText(prop), 0.65, 7);
  }

  private cancelPaperThrow(prop: PropType, message: string): void {
    this.game.cancel(prop);
    this.clearPaperAim(true);
    this.punchButton(prop, false);
    this.setEventText(message, 1.4, 9);
  }

  private lockAimCardAtSlot(prop: PropType, slot: number): void {
    this.aimLockedCardOffset = 0;
    if (prop !== PT.ChangeDemand && prop !== PT.ThrowPot) {
      this.aimLockedCardId = null;
      return;
    }
    let anchorSlot = slot;
    if (prop === PT.ThrowPot && !this.game.conveyor.slotAt(slot)) {
      const nearby = [slot - 1, slot + 1].find((candidate) => this.game.conveyor.slotAt(candidate));
      if (nearby !== undefined) anchorSlot = nearby;
    }
    this.aimLockedCardId = this.game.conveyor.slotAt(anchorSlot)?.id ?? null;
    this.aimLockedCardOffset = anchorSlot - slot;
  }

  private resolvedAimSlot(prop: PropType): number {
    if (prop !== PT.ChangeDemand && prop !== PT.ThrowPot) return this.aimingSlot;
    const anchorSlot = findLockedCardSlot(this.game.conveyor.cards, this.aimLockedCardId);
    if (anchorSlot < 0) return -1;
    const slot = anchorSlot - this.aimLockedCardOffset;
    return slot >= 0 && slot < this.game.conveyor.cards.length ? slot : -1;
  }

  private propSourcePoint(prop: PropType): Vec3 {
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const btn = idx >= 0 ? this.propButtonNodes[idx] : null;
    return btn ? this.nodePointInRoot(btn) : new Vec3(0, -240, 0);
  }

  private propDisplayName(prop: PropType): string {
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    return GameRunner.PROP_LABELS[idx] ?? '纸团';
  }

  private aimRecommendationText(prop: PropType): string {
    const recommendation = this.game.getTargetRecommendation(prop);
    return recommendation
      ? `轻点投向 ${recommendation.slot + 1} 号卡 · 拖向其他卡可改选`
      : '拖向任务卡，松手投出';
  }

  private pointFromPointer(event: EventTouch | EventMouse): Vec3 {
    const loc = event.getUILocation();
    const ut = this.node.getComponent(UITransform);
    if (!ut) return new Vec3(loc.x, loc.y, 0);
    return ut.convertToNodeSpaceAR(new Vec3(loc.x, loc.y, 0));
  }

  private nodePointInRoot(node: Node): Vec3 {
    const ut = this.node.getComponent(UITransform);
    if (!ut) return node.worldPosition.clone();
    return ut.convertToNodeSpaceAR(node.worldPosition);
  }

  private targetPointForSlot(slot: number): Vec3 {
    const node = this.visualNodeAtSlot(slot) ?? this.slotNodes[slot];
    return node ? this.nodePointInRoot(node) : new Vec3(0, 120, 0);
  }

  /** 选槽几何必须固定，不能跟着卡片换挡 tween 漂移。 */
  private slotAnchorPointForSlot(slot: number): Vec3 {
    const node = this.slotNodes[slot];
    return node ? this.nodePointInRoot(node) : new Vec3(0, 120, 0);
  }

  private slotFromAimPoint(point: Vec3): number {
    return this.slotFromAimX(point.x);
  }

  private slotFromAimX(x: number): number {
    const targets = this.aimSlotTargets.length === this.slotNodes.length
      ? this.aimSlotTargets
      : this.slotNodes.map((_, i) => this.slotAnchorPointForSlot(i));
    if (targets.length === 0) return 0;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      const dx = Math.abs(x - p.x);
      if (dx < bestDist) {
        best = i;
        bestDist = dx;
      }
    }
    return best;
  }

  /** 手势只能吸附到当前真正可作用的卡片，避免“准星亮了但松手无效”。 */
  private closestValidAimSlot(prop: PropType, x: number): number {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.slotNodes.length; i++) {
      if (!this.isAimTargetValid(prop, i)) continue;
      const target = this.aimSlotTargets[i] ?? this.targetPointForSlot(i);
      const dist = Math.abs(x - target.x);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    const current = this.aimingSlot;
    if (best < 0 || best === current || !this.isAimTargetValid(prop, current)) return best;
    const currentPoint = this.aimSlotTargets[current] ?? this.targetPointForSlot(current);
    const bestPoint = this.aimSlotTargets[best] ?? this.targetPointForSlot(best);
    const direction = Math.sign(bestPoint.x - currentPoint.x);
    const gap = Math.abs(bestPoint.x - currentPoint.x);
    const switchThreshold = (currentPoint.x + bestPoint.x) * 0.5 + direction * gap * 0.10;
    if (direction > 0 && x < switchThreshold) return current;
    if (direction < 0 && x > switchThreshold) return current;
    return best;
  }

  private showPaperAim(prop: PropType): void {
    this.clearPaperAim(true);
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = GameRunner.PROP_COLORS[idx] ?? UiTokens.color.blue;
    this.aimSlotTargets = this.slotNodes.map((_, i) => this.slotAnchorPointForSlot(i));
    this.aimRenderedSlot = -1;
    this.aimVelocityX = 0;
    this.aimVisualTime = 0;
    this.aimTargetKick = 0;
    this.aimLockSec = 0;
    this.aimPerfectReady = false;
    this.aimTargetValid = true;
    this.aimRecommendationSlot = this.game.getTargetRecommendation(prop)?.slot ?? -1;
    this.aimDesiredPoint.set(this.aimPoint.x, this.aimPoint.y, 0);

    const propNode = new Node('PropDragAim');
    propNode.layer = 1 << 25;
    propNode.addComponent(UITransform).setContentSize(UiTokens.aim.dragSize, UiTokens.aim.dragSize);
    propNode.setPosition(this.aimPoint);

    const visualNode = new Node('PropDragVisual');
    visualNode.layer = 1 << 25;
    visualNode.parent = propNode;
    visualNode.addComponent(UITransform).setContentSize(UiTokens.aim.dragSize, UiTokens.aim.dragSize);
    const propG = visualNode.addComponent(Graphics);
    propG.fillColor = new Color(54, 48, 42, 220);
    propG.circle(0, -5, UiTokens.aim.dragRadius + 3);
    propG.fill();
    propG.fillColor = new Color(base.r, base.g, base.b, 246);
    propG.strokeColor = new Color(255, 250, 241, 238);
    propG.lineWidth = 3;
    propG.circle(0, 0, UiTokens.aim.dragRadius);
    propG.fill();
    propG.stroke();
    propG.strokeColor = new Color(54, 48, 42, 210);
    propG.lineWidth = 2.5;
    propG.circle(0, 0, UiTokens.aim.dragRadius - 3);
    propG.stroke();
    propG.strokeColor = new Color(255, 255, 255, 158);
    propG.lineWidth = 3;
    propG.arc(-2, 2, 24, Math.PI * 0.90, Math.PI * 1.75, false);
    propG.stroke();
    propG.fillColor = new Color(255, 255, 255, 72);
    propG.circle(-10, 10, 5.5);
    propG.fill();

    const iconFrame = this.propSfFor(prop);
    if (iconFrame) {
      const iconNode = new Node('PropDragIcon');
      iconNode.layer = 1 << 25;
      iconNode.parent = visualNode;
      iconNode.addComponent(UITransform).setContentSize(UiTokens.aim.iconSize, UiTokens.aim.iconSize);
      const icon = iconNode.addComponent(Sprite);
      icon.sizeMode = Sprite.SizeMode.CUSTOM;
      icon.spriteFrame = iconFrame;
      icon.color = Color.WHITE;
      iconNode.setPosition(0, 1, 0);
    } else {
      this.drawPaperWad(visualNode, prop, 1);
    }

    const target = new Node('PropAimTarget');
    target.layer = 1 << 25;
    target.addComponent(UITransform).setContentSize(UiTokens.aim.targetSize, UiTokens.aim.targetSize);
    target.addComponent(Graphics);
    target.addComponent(UIOpacity).opacity = 220;
    this.node.addChild(target);
    this.aimTargetNode = target;
    target.setPosition(this.targetPointForSlot(this.aimingSlot));
    this.paintAimTarget(prop, false, true);

    // 完整弹道固定在 root-local 坐标，每帧从手指纸团画到真实卡片。
    const direction = new Node('PropAimDirection');
    direction.layer = 1 << 25;
    direction.addComponent(UITransform).setContentSize(1, 1);
    direction.addComponent(Graphics);
    direction.addComponent(UIOpacity).opacity = 180;
    this.node.addChild(direction);
    direction.setPosition(0, 0, 0);
    direction.setSiblingIndex(Math.max(0, target.getSiblingIndex() - 1));
    this.aimDirectionNode = direction;

    const effectPreview = new Node('PropEffectPreview');
    effectPreview.layer = 1 << 25;
    effectPreview.addComponent(UITransform).setContentSize(1, 1);
    effectPreview.addComponent(Graphics);
    this.node.addChild(effectPreview);
    effectPreview.setSiblingIndex(Math.max(0, target.getSiblingIndex() - 1));
    this.aimEffectPreviewNode = effectPreview;
    this.paintAimEffectPreview(prop, this.aimingSlot, true);

    this.aimPredictionView = new AimPredictionView(this.node, 1 << 25);
    this.updateAimPrediction(prop, this.aimingSlot, true);

    const shadow = new Node('PropDragShadow');
    shadow.layer = 1 << 25;
    shadow.addComponent(UITransform).setContentSize(UiTokens.aim.dragSize + 22, 40);
    const shadowG = shadow.addComponent(Graphics);
    shadowG.fillColor = new Color(54, 48, 42, 62);
    shadowG.ellipse(0, 0, UiTokens.aim.dragRadius + 9, 13);
    shadowG.fill();
    shadow.addComponent(UIOpacity).opacity = 150;
    shadow.setPosition(this.aimPoint.x + 4, this.aimPoint.y - UiTokens.aim.shadowDrop, 0);
    this.node.addChild(shadow);
    this.paperAimShadowNode = shadow;

    this.node.addChild(propNode);
    this.paperAimNode = propNode;
    const tuning = this.paperTuning(prop);
    visualNode.setScale(0.72, 0.72, 1);
    tween(visualNode)
      .to(UiTokens.aim.liftSec, { scale: new Vec3(tuning.liftScale, tuning.liftScale, 1) }, { easing: 'backOut' })
      .to(0.06, { scale: new Vec3(1, 1, 1) }, { easing: 'quadInOut' })
      .start();
  }

  /** 触摸回调只做坐标裁切，真正的视觉跟随在 update 中每帧最多执行一次。 */
  private queueAimRawPoint(raw: Vec3): void {
    const vis = view.getVisibleSize();
    const safe = sys.getSafeAreaRect(false);
    const safeBottomY = safe.y - vis.height / 2;
    let minX = -vis.width / 2 + UiTokens.aim.clampInset;
    let maxX = vis.width / 2 - UiTokens.aim.clampInset;
    let minY = safeBottomY + Math.max(UiTokens.aim.minFreeY, vis.height * UiTokens.aim.minFreeYRatio);
    let maxY = safeBottomY + Math.max(UiTokens.aim.minMaxFreeY, vis.height * UiTokens.aim.maxFreeYRatio);
    const fingerLift = this.propInteractionState === 'dragging' && !this.aimReturnCancel ? 28 : 0;
    this.aimDesiredPoint.set(
      Math.max(minX, Math.min(maxX, raw.x)),
      Math.max(minY, Math.min(maxY, raw.y + fingerLift)),
      0,
    );
  }

  /** 每帧最多执行一次的拖动表现更新：跟手、速度形变、影子、吸附与轨迹。 */
  private updateAimFrame(dt: number, force = false): void {
    if (this.aimingProp === null) return;
    this.aimSlotTargets = this.slotNodes.map((_, i) => this.slotAnchorPointForSlot(i));
    const tuning = this.paperTuning(this.aimingProp);
    const prevX = this.aimPoint.x;
    // 意图死区只决定是否换目标，不再拖慢纸团；从按下第一帧起就严格跟手。
    this.aimPoint.set(this.aimDesiredPoint);
    const instantVelocityX = (this.aimPoint.x - prevX) / Math.max(dt, 1 / 120);
    this.aimVelocityX += (instantVelocityX - this.aimVelocityX) * (force ? 1 : UiTokens.aim.velocitySmoothing);
    const identitySlot = this.resolvedAimSlot(this.aimingProp);
    const manualSlot = this.aimManualTargeting
      ? this.closestValidAimSlot(this.aimingProp, this.aimSelectionX)
      : -1;
    const nextSlot = this.aimManualTargeting && manualSlot >= 0
      ? manualSlot
      : identitySlot >= 0 ? identitySlot : this.aimingSlot;
    const slotChanged = nextSlot !== this.aimRenderedSlot;
    const targetValid = this.isAimTargetValid(this.aimingProp, nextSlot);
    const validityChanged = targetValid !== this.aimTargetValid;
    const recommendationSlot = this.game.getTargetRecommendation(this.aimingProp)?.slot ?? -1;
    const recommendationChanged = recommendationSlot !== this.aimRecommendationSlot;
    this.aimRecommendationSlot = recommendationSlot;
    if (this.aimManualTargeting && nextSlot !== this.aimingSlot) {
      this.lockAimCardAtSlot(this.aimingProp, nextSlot);
    }
    this.aimingSlot = nextSlot;
    this.aimTargetValid = targetValid;
    const resolvedVisualSlot = this.resolvedAimSlot(this.aimingProp);
    const visualTargetSlot = resolvedVisualSlot >= 0 ? resolvedVisualSlot : nextSlot;
    if (slotChanged) {
      const previousSlot = this.aimRenderedSlot;
      this.aimRenderedSlot = nextSlot;
      this.aimTargetKick = UiTokens.aim.targetKick;
      const target = this.targetPointForSlot(visualTargetSlot);
      this.aimTargetNode?.setPosition(target);
      this.paintAimEffectPreview(this.aimingProp, nextSlot, targetValid);
      this.updateAimPrediction(this.aimingProp, nextSlot, targetValid);
      this.aimLockSec = 0;
      if (this.aimPerfectReady) {
        this.aimPerfectReady = false;
      }
      if (previousSlot >= 0) this.lightAimFeedback('tick');
      if (previousSlot >= 0) this.telemetry.targetChanged(this.aimingProp, previousSlot, nextSlot);
    }
    if (!slotChanged && this.aimTargetNode?.isValid) {
      this.aimTargetNode.setPosition(this.targetPointForSlot(visualTargetSlot));
    }
    const alignment = this.aimManualTargeting ? this.aimAlignmentRatio(nextSlot) : 1;
    if (targetValid && !slotChanged && alignment <= UiTokens.aim.perfectAlignmentRatio) {
      this.aimLockSec = Math.min(UiTokens.aim.perfectLockSec * 2, this.aimLockSec + dt);
    } else if (!targetValid || alignment > UiTokens.aim.perfectAlignmentRatio) {
      this.aimLockSec = Math.max(0, this.aimLockSec - dt * 2.5);
    }
    const perfectReady = targetValid
      && this.aimLockSec >= UiTokens.aim.perfectLockSec
      && alignment <= UiTokens.aim.perfectAlignmentRatio;
    if (perfectReady !== this.aimPerfectReady || validityChanged || slotChanged || recommendationChanged) {
      this.aimPerfectReady = perfectReady;
      this.paintAimTarget(this.aimingProp, perfectReady, targetValid);
      if (validityChanged || recommendationChanged) {
        this.paintAimEffectPreview(this.aimingProp, nextSlot, targetValid);
        this.updateAimPrediction(this.aimingProp, nextSlot, targetValid);
      }
      if (perfectReady) {
        this.lightAimFeedback('lock');
        if (!this.perfectTipShown) {
          this.perfectTipShown = true;
          sys.localStorage?.setItem(GameRunner.PERFECT_TIP_KEY, '1');
          this.setEventText('金色准星 = PERFECT，松手获得随机奖励', 3.4, 8);
        }
      }
    }

    // 纸团严格跟手；吸附只体现在轨道刻度与卡片准星，不再暗改纸团位置。
    const visualAimX = this.aimPoint.x;

    if (this.paperAimNode?.isValid) {
      this.paperAimNode.setPosition(visualAimX, this.aimPoint.y, 0);
      const speed = Math.min(UiTokens.aim.velocityCap, Math.abs(this.aimVelocityX));
      const stretch = Math.min(
        UiTokens.aim.dragStretchMax,
        1 + (Math.abs(this.aimPoint.y - this.aimStart.y) / 980 + speed * UiTokens.aim.dragSpeedStretch) * tuning.dragStretchFactor,
      );
      this.paperAimNode.setScale(stretch, 1 / stretch, 1);
      const tilt = Math.max(
        -UiTokens.aim.dragTiltMaxDeg,
        Math.min(UiTokens.aim.dragTiltMaxDeg, this.aimVelocityX * UiTokens.aim.dragTiltPerVelocity),
      );
      this.paperAimNode.angle = tilt;
    }
    if (this.paperAimShadowNode?.isValid) {
      const shadowPos = this.paperAimShadowNode.position;
      const shadowFollow = force ? 1 : UiTokens.aim.shadowFollow;
      this.paperAimShadowNode.setPosition(
        shadowPos.x + (visualAimX + 5 - shadowPos.x) * shadowFollow,
        shadowPos.y + (this.aimPoint.y - UiTokens.aim.shadowDrop - shadowPos.y) * shadowFollow,
        0,
      );
      const shadowStretch = 1 + Math.min(0.34, Math.abs(this.aimVelocityX) / UiTokens.aim.velocityCap * 0.34);
      this.paperAimShadowNode.setScale(shadowStretch, 1 / shadowStretch, 1);
    }
    if (this.aimDirectionNode?.isValid) {
      const targetPoint = this.targetPointForSlot(visualTargetSlot);
      if (this.aimReturnCancel) this.aimDirectionNode.getComponent(Graphics)?.clear();
      else this.paintAimTrajectory(this.aimingProp, this.aimPoint, targetPoint, targetValid);
    }
    if (this.aimEffectPreviewNode?.isValid) this.aimEffectPreviewNode.active = !this.aimReturnCancel;
    if (this.aimPredictionView) {
      this.aimPredictionView.setActive(!this.aimReturnCancel);
      this.positionAimPrediction(visualTargetSlot);
    }
    this.aimVisualTime += dt;
    if (this.aimTargetNode?.isValid) {
      const targetOpacity = this.aimTargetNode.getComponent(UIOpacity);
      if (targetOpacity) targetOpacity.opacity = this.aimReturnCancel ? 64 : 220;
      this.aimTargetKick = Math.max(0, this.aimTargetKick - dt);
      const kick = this.aimTargetKick > 0 ? this.aimTargetKick / UiTokens.aim.targetKick : 0;
      const pulse = this.sensory.settings.reducedMotion
        ? 1 + kick * 0.08
        : 1 + Math.sin(this.aimVisualTime * UiTokens.aim.targetPulseHz * Math.PI * 2) * 0.035 + kick * 0.16;
      this.aimTargetNode.setScale(pulse, pulse, 1);
    }
  }

  private paintAimTrajectory(prop: PropType, start: Vec3, end: Vec3, targetValid: boolean): void {
    const g = this.aimDirectionNode?.getComponent(Graphics);
    if (!g) return;
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = targetValid ? (GameRunner.PROP_COLORS[idx] ?? UiTokens.color.blue) : UiTokens.color.muted;
    const desiredLift = this.paperTuning(prop).arcHeight * 0.18;
    const guidedLead = guidedThrowLeadPoint(
      start,
      end,
      { x: this.aimReleaseVelocityX, y: this.aimReleaseVelocityY },
      this.aimManualTargeting,
    );
    const control = this.aimManualTargeting
      ? this.clampThrowPoint(guidedLead)
      : new Vec3(
        (start.x + end.x) * 0.5,
        boundedThrowPeakY(start.y, end.y, this.throwViewportTopY(), desiredLift),
        0,
      );
    g.clear();
    g.fillColor = new Color(base.r, base.g, base.b, targetValid ? 205 : 110);
    for (let i = 1; i <= 9; i++) {
      const t = i / 10;
      const inv = 1 - t;
      const x = inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x;
      const y = inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y;
      g.circle(x, y, 2.5 + t * 1.7);
      g.fill();
    }
  }

  private aimAlignmentRatio(slot: number): number {
    const target = this.aimSlotTargets[slot] ?? this.targetPointForSlot(slot);
    const left = this.aimSlotTargets[Math.max(0, slot - 1)];
    const right = this.aimSlotTargets[Math.min(this.aimSlotTargets.length - 1, slot + 1)];
    const leftGap = left && left !== target ? Math.abs(target.x - left.x) : Number.POSITIVE_INFINITY;
    const rightGap = right && right !== target ? Math.abs(right.x - target.x) : Number.POSITIVE_INFINITY;
    const nearestGap = Math.min(leftGap, rightGap);
    const halfSpan = Number.isFinite(nearestGap)
      ? Math.max(18, nearestGap * 0.5)
      : Math.max(36, view.getVisibleSize().width / Math.max(2, this.slotNodes.length) * 0.5);
    return Math.abs(this.aimSelectionX - target.x) / halfSpan;
  }

  private currentDragHitQuality(): HitQuality {
    return this.aimPerfectReady
      && this.aimAlignmentRatio(this.aimingSlot) <= UiTokens.aim.perfectAlignmentRatio
      ? HQ.Perfect
      : HQ.Normal;
  }

  private isAimTargetValid(prop: PropType | null, slot: number): boolean {
    if (!prop || prop === PT.AddDemand) return true;
    if (prop === PT.ChangeDemand) return this.game.conveyor.slotAt(slot)?.state === CS.ActiveWhite;
    if (prop === PT.ThrowPot) return this.game.conveyor.hasCardsInRange(slot, 1);
    return true;
  }

  private paintAimTarget(prop: PropType | null, perfectReady: boolean, targetValid: boolean): void {
    const g = this.aimTargetNode?.getComponent(Graphics);
    if (!g) return;
    const idx = prop ? GameRunner.PROP_TYPES.indexOf(prop) : -1;
    const base = GameRunner.PROP_COLORS[idx] ?? UiTokens.color.blue;
    const focus = !targetValid ? UiTokens.color.muted : perfectReady ? UiTokens.color.gold : base;
    g.clear();
    g.fillColor = new Color(focus.r, focus.g, focus.b, perfectReady ? 64 : 30);
    g.circle(0, 0, UiTokens.aim.targetInnerRadius);
    g.fill();
    g.strokeColor = new Color(255, 252, 246, 246);
    g.lineWidth = 5;
    g.circle(0, 0, UiTokens.aim.targetInnerRadius);
    g.stroke();
    g.strokeColor = new Color(focus.r, focus.g, focus.b, 242);
    g.lineWidth = perfectReady ? 4 : 3;
    g.circle(0, 0, UiTokens.aim.targetOuterRadius);
    g.stroke();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      g.moveTo(Math.cos(a) * (UiTokens.aim.targetInnerRadius + 2), Math.sin(a) * (UiTokens.aim.targetInnerRadius + 2));
      g.lineTo(Math.cos(a) * UiTokens.aim.targetTickOuter, Math.sin(a) * UiTokens.aim.targetTickOuter);
    }
    g.stroke();
  }

  private paintAimEffectPreview(prop: PropType | null, slot: number, targetValid: boolean): void {
    const g = this.aimEffectPreviewNode?.getComponent(Graphics);
    if (!g || !prop) return;
    g.clear();
    const radius = prop === PT.ThrowPot ? 1 : 0;
    const lo = Math.max(0, slot - radius);
    const hi = Math.min(this.slotNodes.length - 1, slot + radius);
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = targetValid ? (GameRunner.PROP_COLORS[idx] ?? UiTokens.color.blue) : UiTokens.color.muted;
    for (let i = lo; i <= hi; i++) {
      const slotNode = this.slotNodes[i];
      const ut = slotNode?.getComponent(UITransform);
      const point = this.aimSlotTargets[i] ?? this.targetPointForSlot(i);
      const hasCard = this.game.conveyor.slotAt(i) !== null;
      const w = (ut?.width ?? 76) + 10;
      const h = (ut?.height ?? 66) + 10;
      g.fillColor = new Color(base.r, base.g, base.b, hasCard ? 34 : 12);
      g.strokeColor = new Color(base.r, base.g, base.b, i === slot ? 220 : hasCard ? 145 : 70);
      g.lineWidth = i === slot ? 3 : 2;
      g.roundRect(point.x - w / 2, point.y - h / 2, w, h, 13);
      g.fill(); g.stroke();
    }
    const recommendation = this.game.getTargetRecommendation(prop);
    if (recommendation && recommendation.slot >= 0 && recommendation.slot < this.slotNodes.length) {
      const point = this.aimSlotTargets[recommendation.slot] ?? this.targetPointForSlot(recommendation.slot);
      const ut = this.slotNodes[recommendation.slot]?.getComponent(UITransform);
      const w = (ut?.width ?? 76) + 16;
      const h = (ut?.height ?? 66) + 16;
      const gold = UiTokens.color.gold;
      g.strokeColor = new Color(gold.r, gold.g, gold.b, recommendation.slot === slot ? 245 : 190);
      g.lineWidth = recommendation.slot === slot ? 3.5 : 2.5;
      g.roundRect(point.x - w / 2, point.y - h / 2, w, h, 15);
      g.stroke();
      g.fillColor = new Color(gold.r, gold.g, gold.b, 240);
      g.moveTo(point.x - 8, point.y + h / 2 + 6);
      g.lineTo(point.x + 8, point.y + h / 2 + 6);
      g.lineTo(point.x, point.y + h / 2 - 3);
      g.close();
      g.fill();
    }
  }

  private updateAimPrediction(prop: PropType, slot: number, targetValid: boolean): void {
    const prediction = this.aimPredictionView;
    if (!prediction) return;
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = targetValid ? (GameRunner.PROP_COLORS[idx] ?? UiTokens.color.blue) : UiTokens.color.muted;
    const position = this.aimPredictionPosition(slot);
    prediction.update(this.aimPredictionText(prop, slot, targetValid), base, targetValid, position.x, position.y);
  }

  private positionAimPrediction(slot: number): void {
    if (!this.aimPredictionView) return;
    const position = this.aimPredictionPosition(slot);
    this.aimPredictionView.node.setPosition(position.x, position.y, 0);
  }

  private aimPredictionPosition(slot: number): { x: number; y: number } {
    const vis = view.getVisibleSize();
    const target = this.targetPointForSlot(slot);
    const width = this.aimPredictionView?.width ?? 236;
    const height = this.aimPredictionView?.height ?? 40;
    const x = Math.max(-vis.width / 2 + width / 2 + 18, Math.min(vis.width / 2 - width / 2 - 18, target.x));
    const targetH = this.slotNodes[slot]?.getComponent(UITransform)?.height ?? 72;
    const preferredY = target.y + targetH / 2 + 34;
    const y = Math.min(this.throwViewportTopY() - height / 2 - 18, preferredY);
    return { x, y };
  }

  private aimPredictionText(prop: PropType, slot: number, targetValid: boolean): string {
    if (prop === PT.AddDemand) return '推荐落点 · 队列缓冲 +1 格';
    if (!targetValid) return '无效目标 · 松手不消耗';
    if (prop === PT.ChangeDemand) {
      const card = this.game.conveyor.slotAt(slot);
      if (!card) return '空位 · 松手不消耗';
      if ((card.guard ?? 0) > 0) return `命中精英盾 · 风险先降 ${Math.min(2, card.weight)}`;
      return `命中此卡 · 返工抵达 -${card.weight}`;
    }
    if (prop === PT.ThrowPot) {
      const cards = this.game.conveyor.cards.slice(Math.max(0, slot - 1), Math.min(this.game.conveyor.cards.length, slot + 2));
      const affected = cards.filter(Boolean).length;
      const prevented = cards.reduce((sum, card) => sum + (card?.state === CS.ActiveWhite ? card.weight : 0), 0);
      return `范围清场 ${affected} 张 · 挡住 ${prevented} 风险`;
    }
    return '命中 AI · 暂停任务队列';
  }

  private lightAimFeedback(kind: 'tick' | 'lock'): void {
    this.sensory.play(kind === 'lock' ? 'target-lock' : 'target-tick');
    this.sensory.haptic(kind === 'lock' ? 'medium' : 'light', UiTokens.aim.hapticMinIntervalMs);
  }

  private releaseAimFeedback(prop: PropType, strength = 0): void {
    this.sensory.playRelease(prop);
    this.sensory.haptic(prop === PT.ThrowPot || strength >= 0.58 ? 'heavy' : 'medium', 72);
  }

  private clearPaperAim(destroyPaper: boolean): void {
    this.aimingProp = null;
    this.aimEffectPreviewNode?.destroy();
    this.aimEffectPreviewNode = null;
    this.aimPredictionView?.destroy();
    this.aimPredictionView = null;
    this.aimDirectionNode?.destroy();
    this.aimDirectionNode = null;
    this.aimTargetNode?.destroy();
    this.aimTargetNode = null;
    this.paperAimShadowNode?.destroy();
    this.paperAimShadowNode = null;
    if (destroyPaper) {
      this.paperAimNode?.destroy();
    }
    this.paperAimNode = null;
    this.aimSlotTargets = [];
    this.aimRenderedSlot = -1;
    this.aimVelocityX = 0;
    this.aimTargetKick = 0;
    this.aimLockSec = 0;
    this.aimPerfectReady = false;
    this.aimTargetValid = true;
    this.aimRecommendationSlot = -1;
    this.aimManualTargeting = false;
    this.aimSelectionX = 0;
    this.aimLockedCardId = null;
    this.aimLockedCardOffset = 0;
    this.aimGestureLastMs = 0;
    this.aimReleaseVelocityX = 0;
    this.aimReleaseVelocityY = 0;
    this.aimHasLeftSource = false;
    this.aimReturnCancel = false;
    this.activeAimTouchId = null;
    if (this.propInteractionState !== 'launching') this.propInteractionState = 'idle';
    if (this.propButtons) {
      const vis = view.getVisibleSize();
      this.layoutPropButtons(vis.width, vis.height);
    }
  }

  private animatePaperThrow(
    prop: PropType,
    slot: number,
    quality: HitQuality,
    strength: number,
    manualThrow: boolean,
    releaseVelocity: Vec3,
    resolveTargetPoint: () => Vec3,
    onArrive: () => Vec3 | void,
  ): void {
    const paper = this.paperAimNode?.isValid ? this.paperAimNode : this.makePaperWadNode(prop, 'PaperWadThrow');
    const tuning = this.paperTuning(prop);
    const outcome = this.paperOutcome(prop, slot);
    const start = this.aimPoint.clone();
    const end = this.targetPointForSlot(slot);
    const desiredLift = tuning.arcHeight * 0.18;
    const guidedLead = guidedThrowLeadPoint(start, end, releaseVelocity, manualThrow);
    const leadPoint = manualThrow
      ? this.clampThrowPoint(guidedLead)
      : new Vec3(
        (start.x + end.x) * 0.5,
        boundedThrowPeakY(start.y, end.y, this.throwViewportTopY(), desiredLift),
        0,
      );
    if (!paper.parent) this.node.addChild(paper);
    paper.setPosition(start);
    paper.setScale(tuning.startScale);
    const op = paper.getComponent(UIOpacity) ?? paper.addComponent(UIOpacity);
    op.opacity = 255;
    this.emitLaunchBurst(start, prop, strength);
    this.releaseAimFeedback(prop, strength);
    const flightDuration = tuning.duration * (manualThrow ? 1 - strength * 0.30 : 0.72);
    const outDuration = flightDuration * (manualThrow ? 0.32 : prop === PT.ThrowPot ? 0.42 : 0.48);
    const inDuration = Math.max(0.08, flightDuration - outDuration);
    const launchScale = new Vec3(tuning.startScale.x * (1.16 + strength * 0.32), tuning.startScale.y * (0.76 - strength * 0.14), 1);
    const spin = tuning.spin * (manualThrow ? 0.78 + strength * 0.48 : 0.26);
    tween(paper)
      .to(UiTokens.feedback.releaseSquashSec, { scale: launchScale }, { easing: 'quadOut' })
      .to(outDuration, { position: leadPoint, angle: spin * 0.32, scale: tuning.midScale }, { easing: 'quadOut' })
      .call(() => {
        const guidedEnd = resolveTargetPoint();
        tween(paper)
          .to(inDuration, { position: guidedEnd, angle: spin, scale: tuning.endScale }, {
            easing: prop === PT.ThrowPot ? 'sineIn' : 'quadIn',
          })
          .call(() => {
            const impactPoint = onArrive() ?? guidedEnd;
            // 传送带在飞行期间可能移动；落点和结算始终追踪同一张卡。
            paper.setPosition(impactPoint);
            this.propInteractionState = 'idle';
            this.paperImpact(impactPoint, prop, outcome, strength);
            this.paperOutcomeText(impactPoint, prop, outcome, quality, strength);
            this.settlePaperWad(paper, op, prop, outcome);
          })
          .start();
      })
      .start();
  }

  private throwViewportTopY(): number {
    const vis = view.getVisibleSize();
    const safe = sys.getSafeAreaRect(false);
    return safe.y + safe.height - vis.height / 2;
  }

  private clampThrowPoint(point: { x: number; y: number }): Vec3 {
    const vis = view.getVisibleSize();
    const safe = sys.getSafeAreaRect(false);
    const left = safe.x - vis.width / 2 + 28;
    const right = safe.x + safe.width - vis.width / 2 - 28;
    const bottom = safe.y - vis.height / 2 + 28;
    const top = this.throwViewportTopY() - 28;
    return new Vec3(
      Math.max(left, Math.min(right, point.x)),
      Math.max(bottom, Math.min(top, point.y)),
      0,
    );
  }

  /** 松手瞬间的局部发射反馈：短环 + 速度线，只创建一次，不参与拖动帧更新。 */
  private emitLaunchBurst(origin: Vec3, prop: PropType, strength = 0): void {
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = GameRunner.PROP_COLORS[idx] ?? UiTokens.color.blue;
    const node = new Node('PropLaunchBurst');
    node.layer = 1 << 25;
    node.addComponent(UITransform).setContentSize(116, 116);
    node.setPosition(origin);
    node.setScale(0.74, 0.74, 1);
    this.node.addChild(node);
    const g = node.addComponent(Graphics);
    g.strokeColor = new Color(base.r, base.g, base.b, 220);
    g.lineWidth = 4;
    g.circle(0, 0, 31);
    g.stroke();
    g.strokeColor = new Color(255, 252, 241, 225);
    g.lineWidth = 2.5;
    const rayCount = strength >= 0.58 ? 12 : 8;
    for (let i = 0; i < rayCount; i++) {
      const a = i * Math.PI * 2 / rayCount;
      g.moveTo(Math.cos(a) * 39, Math.sin(a) * 39);
      g.lineTo(Math.cos(a) * (52 + strength * 14), Math.sin(a) * (52 + strength * 14));
    }
    g.stroke();
    const op = node.addComponent(UIOpacity);
    op.opacity = 220;
    tween(node)
      .to(0.16, { scale: new Vec3(1.24 + strength * 0.24, 1.24 + strength * 0.24, 1), angle: 12 + strength * 10 }, { easing: 'quadOut' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
    tween(op).to(0.16, { opacity: 0 }, { easing: 'quadIn' }).start();
  }

  private animatePaperToRobot(prop: PropType): void {
    const paper = this.makePaperWadNode(prop, 'PaperWadKissUp');
    const tuning = this.paperTuning(prop);
    const start = this.propSourcePoint(prop);
    const end = this.charNode?.isValid ? this.nodePointInRoot(this.charNode) : new Vec3(0, -20, 0);
    const peak = new Vec3((start.x + end.x) * 0.5, Math.max(start.y, end.y) + tuning.arcHeight, 0);
    this.node.addChild(paper);
    paper.setPosition(start);
    paper.setScale(tuning.startScale);
    this.emitLaunchBurst(start, prop);
    this.releaseAimFeedback(prop);
    tween(paper)
      .to(tuning.duration * 0.55, { position: peak, angle: tuning.spin * 0.42, scale: tuning.midScale }, { easing: 'quadOut' })
      .to(tuning.duration * 0.45, { position: end, angle: tuning.spin, scale: tuning.endScale }, { easing: 'backIn' })
      .call(() => {
        this.propInteractionState = 'idle';
        this.paperImpact(end, prop, 'hit');
        this.paperOutcomeText(end, prop, 'hit');
        const op = paper.getComponent(UIOpacity) ?? paper.addComponent(UIOpacity);
        this.settlePaperWad(paper, op, prop, 'hit');
      })
      .start();
  }

  private paperTuning(prop: PropType): PaperTuning {
    return GameRunner.PAPER_TUNING[prop] ?? GameRunner.PAPER_TUNING[PT.AddDemand];
  }

  private paperOutcome(prop: PropType, slot: number): PaperOutcome {
    if (prop === PT.AddDemand) return 'hit';
    if (prop === PT.ChangeDemand) {
      const card = this.game.conveyor.slotAt(slot);
      if (!card) return 'miss';
      return card.state === CS.ActiveWhite ? 'hit' : 'invalid';
    }
    if (prop === PT.ThrowPot) {
      return this.game.conveyor.hasCardsInRange(slot, 1) ? 'hit' : 'miss';
    }
    return 'hit';
  }

  private paperImpact(pos: Vec3, prop: PropType, outcome: PaperOutcome, strength = 0): void {
    const ring = new Node('PaperImpact');
    ring.layer = 1 << 25;
    ring.addComponent(UITransform).setContentSize(64, 64);
    const g = ring.addComponent(Graphics);
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = GameRunner.PROP_COLORS[idx] ?? new Color(255, 255, 255);
    const miss = outcome !== 'hit';
    g.strokeColor = miss
      ? new Color(130, 125, 118, 150)
      : new Color(base.r, base.g, base.b, prop === PT.ThrowPot ? 230 : 190);
    g.lineWidth = miss ? 2 : prop === PT.ThrowPot ? 5 : 3;
    g.circle(0, 0, miss ? 8 : prop === PT.ThrowPot ? 15 : 10);
    g.stroke();
    this.node.addChild(ring);
    ring.setPosition(pos);
    const op = ring.addComponent(UIOpacity);
    op.opacity = miss ? 130 : prop === PT.ThrowPot ? 230 : 180;
    const scale = (miss ? 0.9 : prop === PT.ThrowPot ? 1.55 : prop === PT.ChangeDemand ? 1.35 : 1.2) * (1 + strength * 0.55);
    tween(ring)
      .to(UiTokens.feedback.impactSec, { scale: new Vec3(scale, scale, 1) }, { easing: 'quadOut' })
      .call(() => { if (ring.isValid) ring.destroy(); })
      .start();
    tween(op).to(UiTokens.feedback.impactSec, { opacity: 0 }, { easing: 'quadOut' }).start();
  }

  private paperOutcomeText(pos: Vec3, prop: PropType, outcome: PaperOutcome, quality: HitQuality = HQ.Normal, strength = 0): void {
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = GameRunner.PROP_COLORS[idx] ?? new Color(255, 255, 255);
    const text = quality === HQ.Perfect && outcome === 'hit'
      ? 'PERFECT!'
      : strength >= 0.68 && outcome === 'hit' ? '重甩!' : this.paperOutcomeLabel(prop, outcome);
    const color = quality === HQ.Perfect
      ? new Color(UiTokens.color.gold.r, UiTokens.color.gold.g, UiTokens.color.gold.b, 255)
      : outcome === 'hit' ? new Color(base.r, base.g, base.b, 255) : new Color(120, 115, 108, 255);
    const node = new Node('PaperOutcomeText');
    node.layer = 1 << 25;
    node.addComponent(UITransform).setContentSize(96, 34);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = quality === HQ.Perfect || strength >= 0.68 ? 25 : outcome === 'hit' && prop === PT.ThrowPot ? 24 : 20;
    label.lineHeight = label.fontSize + 4;
    label.isBold = true;
    label.color = color;
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    this.node.addChild(node);
    node.setPosition(pos.x, pos.y + 26, 0);
    const op = node.addComponent(UIOpacity);
    op.opacity = 230;
    tween(node)
      .by(UiTokens.feedback.outcomeRiseSec, { position: new Vec3(0, 22, 0) }, { easing: 'quadOut' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
    tween(op).delay(UiTokens.feedback.outcomeFadeDelay).to(UiTokens.feedback.outcomeFadeSec, { opacity: 0 }, { easing: 'quadOut' }).start();
  }

  private paperOutcomeLabel(prop: PropType, outcome: PaperOutcome): string {
    if (outcome === 'miss') return '没中';
    if (outcome === 'invalid') return '无效';
    if (prop === PT.AddDemand) return '+需求';
    if (prop === PT.ChangeDemand) return '返工!';
    if (prop === PT.ThrowPot) return '甩锅!';
    return '拍中!';
  }

  private settlePaperWad(paper: Node, opacity: UIOpacity, prop: PropType, outcome: PaperOutcome): void {
    if (!paper.isValid) return;
    const hit = outcome === 'hit';
    const squash = hit
      ? prop === PT.ThrowPot ? new Vec3(0.95, 0.55, 1) : new Vec3(0.68, 0.46, 1)
      : new Vec3(0.52, 0.36, 1);
    tween(paper)
      .to(UiTokens.feedback.settleSquashSec, { scale: squash }, { easing: 'quadOut' })
      .delay(hit ? 0.08 : 0.03)
      .to(UiTokens.feedback.settleShrinkSec, { scale: new Vec3(0.18, 0.18, 1) }, { easing: 'quadIn' })
      .call(() => { if (paper.isValid) paper.destroy(); })
      .start();
    tween(opacity)
      .delay(hit ? 0.08 : 0.02)
      .to(UiTokens.feedback.settleFadeSec, { opacity: 0 }, { easing: 'quadOut' })
      .start();
  }

  private makePaperWadNode(prop: PropType, name: string): Node {
    const node = new Node(name);
    node.layer = 1 << 25;
    node.addComponent(UITransform).setContentSize(44, 44);
    node.addComponent(Graphics);
    this.drawPaperWad(node, prop, 1);
    return node;
  }

  private drawPaperWad(node: Node, prop: PropType, alpha: number): void {
    const g = node.getComponent(Graphics);
    if (!g) return;
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = GameRunner.PROP_COLORS[idx] ?? new Color(250, 246, 236);
    const tint = idx === 0 ? new Color(248, 246, 238) : new Color(
      Math.round(base.r * 0.30 + 248 * 0.70),
      Math.round(base.g * 0.30 + 246 * 0.70),
      Math.round(base.b * 0.30 + 238 * 0.70),
      255,
    );
    g.clear();
    g.fillColor = new Color(tint.r, tint.g, tint.b, Math.round(255 * alpha));
    g.strokeColor = new Color(42, 38, 34, Math.round(230 * alpha));
    g.lineWidth = 3;
    g.circle(0, 0, 19);
    g.fill();
    g.stroke();
    g.strokeColor = new Color(base.r, base.g, base.b, Math.round(210 * alpha));
    g.lineWidth = 2;
    g.moveTo(-10, 3);
    g.lineTo(-2, 11);
    g.lineTo(6, 2);
    g.lineTo(13, 8);
    g.moveTo(-11, -7);
    g.lineTo(-1, -2);
    g.lineTo(8, -10);
    g.stroke();
  }

  /** 道具按钮按下/松开缩放反馈（不依赖 Sprite，Label 节点也有视觉反馈）。 */
  private punchButton(prop: PropType, down: boolean): void {
    const i = GameRunner.PROP_TYPES.indexOf(prop);
    const btn = this.propButtonNodes[i];
    if (!btn) return;
    const view = this.propButtonViews[i];
    if (view) {
      tween(btn)
        .to(down ? UiTokens.motion.pressSec : UiTokens.motion.releaseSec, {
          scale: down ? new Vec3(0.96, 0.92, 1) : new Vec3(1, 1, 1),
        }, { easing: down ? 'quadOut' : 'backOut' })
        .start();
      return;
    }
    btn.setScale(down ? 0.96 : 1, down ? 0.92 : 1, 1);
  }

  /**
   * 纸团武器槽 HUD：每帧刷新。视觉重心在大纸团 + 次数，CD 用纸团暗部表示。
   */
  private renderPropHUD(): void {
    if (!this.propButtons) return;
    this.propButtonNodes.forEach((btn: Node, i: number) => {
      const type = GameRunner.PROP_TYPES[i];
      const st = this.game.prop.getState(type);
      const unlocked = this.game.prop.isUnlocked(type);
      const name = GameRunner.PROP_ACTION_LABELS[i] ?? GameRunner.PROP_LABELS[i];
      const uses = unlocked ? st.uses : 0;
      const kissUp = type === PT.KissUp;
      let statusLine = '';
      if (!unlocked) statusLine = '未解锁';
      else if (uses <= 0) statusLine = '已用尽';
      else if (st.ready) statusLine = '就绪';
      else {
        if (st.acquisition === 'cd') statusLine = `${st.cdRemaining.toFixed(1)}s`;
        else statusLine = `${Math.round(st.energy * 100)}%`;
      }
      const count = kissUp ? '' : (uses > 0 ? `剩${uses}` : '');
      const charging = this.game.prop.chargingProp === type;
      const state: KeycapState = !unlocked ? 'locked'
        : uses <= 0 ? 'depleted'
        : charging ? 'charging'
        : st.ready ? 'ready'
        : 'cooldown';
      this.propButtonViews[i]?.render({
        base: GameRunner.PROP_COLORS[i] ?? UiTokens.color.blue,
        state,
        action: name,
        status: statusLine,
        count,
        icon: this.propSfFor(type),
      });
    });
  }

  /** 纸团武器槽：大纸团居中 + 次数叠在纸团上 + CD 用暗部表示 + 状态行。 */
  private drawPropButtonBackground(index: number, unlocked: boolean, hasUses: boolean, ready: boolean, cdPct: number, count: string, statusLine: string): void {
    const bg = this.propButtonBackgrounds[index];
    if (!bg) return;
    const ut = bg.getComponent(UITransform);
    const g = bg.getComponent(Graphics);
    if (!ut || !g) return;

    const w = ut.width;
    const h = ut.height;
    const base = GameRunner.PROP_COLORS[index] ?? new Color(80, 160, 255);
    const inactive = !unlocked || !hasUses;

    g.clear();

    // ── 实体键帽：深色底座 + 饱和功能色面 ──
    g.fillColor = new Color(28, 27, 25, inactive ? 105 : 255);
    g.roundRect(-w / 2, -h / 2 - 5, w, h, 18);
    g.fill();
    g.fillColor = inactive ? new Color(215, 210, 202, 255) : new Color(base.r, base.g, base.b, 255);
    g.strokeColor = inactive ? new Color(145, 140, 133, 210) : GameRunner.UI_INK;
    g.lineWidth = 3;
    g.roundRect(-w / 2, -h / 2, w, h, 18);
    g.fill();
    g.stroke();
    // 顶部高光仅提示材质，不做大面积渐变
    g.fillColor = new Color(255, 255, 255, inactive ? 20 : 54);
    g.roundRect(-w / 2 + 7, h / 2 - 22, w - 14, 12, 6);
    g.fill();
    if (ready && !inactive) {
      g.strokeColor = new Color(255, 250, 225, 220);
      g.lineWidth = 2;
      g.roundRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 14);
      g.stroke();
    }

    // ── 图标素材缺失时才画纸团兜底；正常路径使用 resources/art/props 的真素材 ──
    const cx = 0;
    const cy = h * 0.14;
    const r = Math.min(w * 0.24, h * 0.27);
    const c = inactive ? new Color(190, 185, 180, 200) : new Color(
      Math.round(base.r * 0.12 + 250 * 0.88),
      Math.round(base.g * 0.12 + 247 * 0.88),
      Math.round(base.b * 0.12 + 240 * 0.88),
      250,
    );
    if (!this.propIconSprites[index]?.spriteFrame) this.drawBigPaperPile(g, index, cx, cy, r, c, base, inactive);

    // ── CD 暗部覆盖在纸团上 ──
    if (!ready && !inactive) {
      const cdAlpha = inactive ? 0 : 180;
      g.fillColor = new Color(38, 34, 30, cdAlpha);
      const clipH = Math.max(5, (h - 12) * (1 - cdPct));
      g.fillColor = new Color(30, 28, 26, 92);
      g.roundRect(-w / 2 + 6, -h / 2 + 6, w - 12, clipH, 12);
      g.fill();
    }

    // ── ×N 次数大字（叠在纸团上） ──
    if (count) {
      const ctLabel = bg.getChildByName('CountText')?.getComponent(Label)
        ?? this.mkLabel(bg, 'CountText', 0, cy + r * 0.02, count, Math.min(28, Math.max(20, w * 0.20)), w, 34).getComponent(Label);
      if (ctLabel) {
        ctLabel.string = count;
        ctLabel.color = inactive ? new Color(130, 125, 120, 200) : Color.WHITE;
        ctLabel.isBold = true;
        ctLabel.horizontalAlign = 1;
        ctLabel.verticalAlign = 1;
        ctLabel.fontSize = Math.min(28, Math.max(20, w * 0.20));
        const ctNode = ctLabel.node;
        ctNode.setPosition(w * 0.32, h * 0.28, 0);
        ctNode.getComponent(UITransform)!.setContentSize(w * 0.30, 34);
      }
    }

    // ── 一行状态：就绪 / 2.3s / 空 / 锁 ──
    const statusNode = bg.getChildByName('StatusText');
    if (!statusNode) {
      const sn = this.mkLabel(bg, 'StatusText', -w * 0.26, h * 0.34, statusLine, 12, w * 0.42, 20);
      const sl = sn.getComponent(Label);
      if (sl) {
        sl.horizontalAlign = 1;
        sl.overflow = Label.Overflow.SHRINK;
      }
    }
    const sl = bg.getChildByName('StatusText')?.getComponent(Label);
    if (sl) {
      sl.string = statusLine;
      sl.color = inactive ? new Color(130, 125, 118, 200) : new Color(255, 250, 235, ready ? 230 : 185);
      sl.fontSize = Math.min(14, Math.max(11, w * 0.10));
      sl.node.setPosition(-w * 0.26, h * 0.34, 0);
      sl.node.getComponent(UITransform)!.setContentSize(w * 0.42, 20);
    }

    // 锁定/用尽状态只用文字与整体降饱和表达，避免低质的临时代码锁图标。
  }

  /** 大纸团中心渲染：4 种不同形状，以 (cx, cy) 为中心，基准半径 r。 */
  private drawBigPaperPile(g: Graphics, index: number, cx: number, cy: number, r: number, fillCol: Color, base: Color, inactive: boolean): void {
    const s = inactive ? new Color(120, 114, 108, 140) : new Color(42, 38, 34, 230);

    if (index === 0) {
      // 白纸团=加需求：三个大圆纸团
      g.fillColor = fillCol; g.strokeColor = s; g.lineWidth = 2.8;
      g.circle(cx - r * 0.28, cy - r * 0.25, r * 0.58); g.fill(); g.stroke();
      g.circle(cx + r * 0.22, cy - r * 0.08, r * 0.65); g.fill(); g.stroke();
      g.circle(cx, cy + r * 0.32, r * 0.55); g.fill(); g.stroke();
      g.strokeColor = new Color(base.r, base.g, base.b, inactive ? 90 : 180); g.lineWidth = 1.5;
      g.moveTo(cx - r * 0.5, cy + r * 0.05); g.lineTo(cx - r * 0.1, cy + r * 0.35); g.lineTo(cx + r * 0.3, cy); g.stroke();
    } else if (index === 1) {
      // 紫纸团=改需求：多边形皱纸团
      g.fillColor = fillCol; g.strokeColor = s; g.lineWidth = 2.8;
      g.moveTo(cx - r * 0.60, cy - r * 0.20); g.lineTo(cx + r * 0.20, cy - r * 0.65);
      g.lineTo(cx + r * 0.65, cy - r * 0.05); g.lineTo(cx + r * 0.50, cy + r * 0.45);
      g.lineTo(cx - r * 0.05, cy + r * 0.65); g.lineTo(cx - r * 0.65, cy + r * 0.10);
      g.close(); g.fill(); g.stroke();
      g.strokeColor = new Color(base.r, base.g, base.b, inactive ? 90 : 180); g.lineWidth = 1.3;
      g.moveTo(cx - r * 0.25, cy - r * 0.1); g.lineTo(cx + r * 0.15, cy + r * 0.2); g.stroke();
      g.moveTo(cx + r * 0.3, cy - r * 0.3); g.lineTo(cx - r * 0.1, cy + r * 0.35); g.stroke();
    } else if (index === 2) {
      // 咖啡团=甩锅：椭圆深色纸团+咖啡渍
      g.fillColor = fillCol; g.strokeColor = s; g.lineWidth = 2.8;
      g.circle(cx, cy - r * 0.05, r * 0.62); g.fill(); g.stroke();
      g.circle(cx - r * 0.40, cy + r * 0.22, r * 0.44); g.fill(); g.stroke();
      g.strokeColor = new Color(base.r, base.g, base.b, inactive ? 100 : 200); g.lineWidth = 1.5;
      g.moveTo(cx - r * 0.35, cy - r * 0.2); g.lineTo(cx + r * 0.2, cy + r * 0.25); g.stroke();
      g.fillColor = new Color(70, 48, 28, inactive ? 70 : 170);
      g.circle(cx + r * 0.25, cy - r * 0.15, r * 0.10); g.fill();
      g.circle(cx - r * 0.15, cy - r * 0.35, r * 0.07); g.fill();
      // 咖啡杯沿印
      g.strokeColor = new Color(110, 80, 55, inactive ? 60 : 150); g.lineWidth = 1.5;
      g.circle(cx - r * 0.05, cy + r * 0.15, r * 0.22); g.stroke();
    } else {
      // 粉便签=拍马屁：方形便签+折角
      g.fillColor = fillCol; g.strokeColor = s; g.lineWidth = 2.8;
      g.moveTo(cx - r * 0.60, cy - r * 0.45); g.lineTo(cx + r * 0.45, cy - r * 0.45);
      g.lineTo(cx + r * 0.45, cy + r * 0.35); g.lineTo(cx + r * 0.10, cy + r * 0.35);
      g.lineTo(cx - r * 0.10, cy + r * 0.55); g.lineTo(cx - r * 0.60, cy + r * 0.55);
      g.close(); g.fill(); g.stroke();
      // 折角
      g.strokeColor = new Color(base.r, base.g, base.b, inactive ? 80 : 180); g.lineWidth = 1.5;
      g.moveTo(cx + r * 0.10, cy + r * 0.35); g.lineTo(cx - r * 0.10, cy + r * 0.55); g.stroke();
      g.fillColor = fillCol; g.strokeColor = s; g.lineWidth = 1.5;
      g.moveTo(cx + r * 0.45, cy + r * 0.35); g.lineTo(cx + r * 0.10, cy + r * 0.35);
      g.lineTo(cx + r * 0.45, cy + r * 0.10); g.close(); g.fill(); g.stroke();
      // 横线
      g.strokeColor = new Color(base.r, base.g, base.b, inactive ? 70 : 140); g.lineWidth = 1;
      g.moveTo(cx - r * 0.3, cy + r * 0.05); g.lineTo(cx + r * 0.15, cy + r * 0.05); g.stroke();
      g.moveTo(cx - r * 0.3, cy + r * 0.20); g.lineTo(cx + r * 0.05, cy + r * 0.20); g.stroke();
    }
  }

  /* ---------- 渲染 ---------- */

  private render(): void {
    const snap = this.game.getSnapshot();

    if (this.gameTitleNode) {
      const tl = this.gameTitleNode.getComponent(Label);
      if (tl) {
        tl.string = `本关目标 · ${this.game.level.def.objective?.label ?? '守住岗位'}`;
        tl.fontSize = Math.min(32, Math.max(24, view.getVisibleSize().width * 0.050));
        tl.lineHeight = tl.fontSize + 6;
        tl.color = GameRunner.START_MUTED;
        tl.isBold = true;
      }
    }

    const remain = Math.max(0, snap.duration - snap.elapsed);
    const urgent = remain <= 10 && !this.game.over;
    const resultText: Record<string, string> = { 'win-survive': '通关', 'win-hunt': '猎杀', lose: '淘汰' };
    if (this.gameTimerNode) {
      const tl = this.gameTimerNode.getComponent(Label)!;
      const timerText = this.game.over
        ? `${Math.ceil(remain)}s ${resultText[this.game.result] ?? ''}`
        : `${Math.ceil(remain)}s`;
      if (timerText !== this.lastTimerText) {
        this.lastTimerText = timerText;
        tl.string = timerText;
      }
      const timerSize = this.game.over ? 22 : 28;
      if (tl.fontSize !== timerSize) {
        tl.fontSize = timerSize;
        tl.lineHeight = timerSize + 4;
      }
      const timerColor = urgent ? new Color(220, 72, 66, 255) : GameRunner.START_TEXT;
      if (!tl.color.equals(timerColor)) tl.color = timerColor;
      if (!tl.isBold) tl.isBold = true;
      const pulse = urgent && !this.sensory.settings.reducedMotion ? 1 + Math.sin(snap.elapsed * 8) * 0.035 : 1;
      this.gameTimerNode.setScale(pulse, pulse, 1);
      this.timerPlateNode?.setScale(pulse, pulse, 1);
    }
    if (this.timerPlateNode) {
      const ut = this.timerPlateNode.getComponent(UITransform)!;
      const w = ut.width;
      const h = ut.height;
      const g = this.timerPlateNode.getComponent(Graphics)!;
      const pct = snap.duration > 0 ? Math.max(0, Math.min(1, remain / snap.duration)) : 0;
      const accent = urgent ? new Color(220, 72, 66, 255) : GameRunner.START_BLUE;
      const paintSignature = `${Math.floor(remain * 10)}|${urgent ? 1 : 0}|${Math.round(w)}|${Math.round(h)}`;
      if (paintSignature !== this.lastTimerPaintSignature) {
        this.lastTimerPaintSignature = paintSignature;
        g.clear();
        g.fillColor = new Color(150, 132, 105, 42);
        g.roundRect(-w / 2 + 3, -h / 2 - 5, w - 6, h, h / 2);
        g.fill();
        g.fillColor = GameRunner.START_CARD;
        g.strokeColor = new Color(224, 214, 198, 230);
        g.lineWidth = 1.4;
        g.roundRect(-w / 2, -h / 2, w, h, h / 2);
        g.fill(); g.stroke();
        const iconX = -w / 2 + h * 0.48;
        g.strokeColor = urgent ? accent : GameRunner.START_TEXT;
        g.lineWidth = 3;
        g.circle(iconX, h * 0.06, h * 0.16);
        g.stroke();
        g.moveTo(iconX, h * 0.06);
        g.lineTo(iconX + h * 0.08, h * 0.15);
        g.stroke();
        g.moveTo(iconX - h * 0.07, h * 0.27);
        g.lineTo(iconX + h * 0.07, h * 0.27);
        g.stroke();
        const barW = w * 0.42;
        const barH = Math.max(5, h * 0.085);
        const barX = w * 0.08;
        const barY = -h * 0.24;
        g.fillColor = new Color(218, 210, 195, 255);
        g.roundRect(barX - barW / 2, barY - barH / 2, barW, barH, barH / 2);
        g.fill();
        g.fillColor = accent;
        g.roundRect(barX - barW / 2, barY - barH / 2, barW * pct, barH, barH / 2);
        g.fill();
      }
    }

    const queueText = this.monitorEntryLabelNode?.getChildByName('QueueText')?.getComponent(Label);
    if (queueText) {
      const forecast = this.game.getThreatForecast(3);
      const delta = Math.round(forecast.delta);
      const deltaText = `${delta >= 0 ? '+' : ''}${delta}`;
      if (snap.bossActive) {
        queueText.string = `临检中 ${deltaText}`;
        queueText.color = UiTokens.color.danger;
      } else if (snap.nextBossInSec !== null) {
        queueText.string = snap.nextBossInSec <= 6
          ? `临检${Math.ceil(snap.nextBossInSec)}s ${deltaText}`
          : forecast.label;
        queueText.color = snap.nextBossInSec <= 6 || forecast.projectedApproval >= 70
          ? UiTokens.color.danger
          : delta >= 8 ? UiTokens.color.gold : GameRunner.START_MUTED;
      } else {
        queueText.string = forecast.label;
        queueText.color = forecast.projectedApproval >= 70
          ? UiTokens.color.danger
          : delta >= 8 ? UiTokens.color.gold : GameRunner.START_MUTED;
      }
    }

    this.maybeShowOnboardingNudge();
    this.updateLowerHud(
      Math.round(snap.approval),
      snap.zone,
      remain,
      snap.huntProgress,
      snap.huntThreshold,
      snap.huntHoldSec,
    );

    const cards = this.game.conveyor.cards;
    this.ensureSlotBackgrounds();
    for (let i = 0; i < this.slotNodes.length; i++) {
      this.drawCardBackground(i, null);
      const slot = this.slotNodes[i];
      if (!this.emptySlotRendered.has(slot.uuid)) {
        this.renderSlot(slot, null, i);
        this.emptySlotRendered.add(slot.uuid);
      }
    }
    this.syncCardVisuals(cards);
    this.maybeShowHighRiskTip(cards);

    if (this.scanIndicator) {
      // 指针拖动时使用新的吸附目标圈；旧扫描指示器只保留给键盘蓄力兜底，避免双重光圈抢视觉。
      const charging = this.game.prop.chargingProp !== null && this.aimingProp === null;
      this.scanIndicator.active = charging;
      if (charging) {
        const idx = Math.min(this.slotNodes.length - 1, Math.floor(this.scanPos * this.slotNodes.length));
        const target = this.slotNodes[idx];
        if (target) this.scanIndicator.setPosition(target.position.x, target.position.y, 0);
        const s = 0.6 + this.scanPos * 0.8;
        this.scanIndicator.setScale(s, s, 1);
      }
    }

    this.renderPropHUD();
  }

  /** 前三关目标迟迟没有进展时给一次短提示，不暂停、不遮挡操作区。 */
  private maybeShowOnboardingNudge(): void {
    if (this.onboardingNudgeShown || !this.game || this.game.over) return;
    const snap = this.game.getSnapshot();
    const cue = onboardingNudge({
      levelIndex: this.session.currentIndex,
      elapsedSec: snap.elapsed,
      bestStars: bestStarsFor(this.session.profile, this.session.currentIndex),
      effectiveHits: this.game.effectiveHits,
      perfectHits: this.game.perfectHits,
      huntProgress: snap.huntProgress,
      huntThreshold: snap.huntThreshold,
      huntHoldSec: snap.huntHoldSec,
    });
    if (!cue) return;
    if (snap.elapsed <= this.eventTextUntilSec && this.eventTextPriority > 7) return;
    this.onboardingNudgeShown = true;
    this.setEventText(cue, 4.8, 7);
  }

  /** 高危卡第一次出现时只占用事件提示行，不弹窗、不暂停传送带。 */
  private maybeShowHighRiskTip(cards: Array<Card | null>): void {
    if (this.highRiskTipShown || !cards.some((card) => card?.state === CS.ActiveWhite && card.isThreat && card.weight >= 7)) return;
    this.highRiskTipShown = true;
    sys.localStorage?.setItem(GameRunner.HIGH_RISK_TIP_KEY, '1');
    this.setEventText('首次高危：橙红角标越大，进处理区时风险越高 · 优先用“改需求”压低权重', 4.8, 8);
  }

  /** 为每个传送带卡槽创建 Graphics 背景节点。背景跟随卡槽自身，避免被显示器层级吞掉。 */
  private ensureSlotBackgrounds(): void {
    if (!this.beltNode || this.slotBackgrounds.length > 0) return;
    this.slotNodes.forEach((slot: Node, i: number) => {
      const bg = new Node(`SlotBg${i}`);
      bg.layer = 1 << 25;
      bg.addComponent(UITransform);
      bg.addComponent(Graphics);
      slot.addChild(bg);
      bg.setSiblingIndex(0); // 卡槽内最底层，位于图标和权重文字之前
      const slotUt = slot.getComponent(UITransform);
      const bgUt = bg.getComponent(UITransform);
      if (slotUt && bgUt) bgUt.setContentSize(slotUt.width, slotUt.height);
      bg.setPosition(0, 0, 0);
      bg.active = true;
      this.slotBackgrounds.push(bg);
    });
  }

  /** 黑色线稿图标配浅色类别卡片：保证在深色显示器里有足够对比且类别一眼可分。 */
  private drawCardBackground(slotIndex: number, card: Card | null): void {
    const bg = this.slotBackgrounds[slotIndex];
    if (!bg) return;
    this.drawCardBackgroundNode(bg, card);
  }

  /** 同一绘制逻辑同时服务固定占位槽和按 id 生成的真实卡片节点。 */
  private drawCardBackgroundNode(bg: Node, card: Card | null): void {
    const ut = bg.getComponent(UITransform);
    const g = bg.getComponent(Graphics);
    if (!ut || !g) return;
    const w = ut.width;
    const h = ut.height;
    if (w <= 0 || h <= 0) return;
    const signature = card
      ? `${Math.round(w)}x${Math.round(h)}|${card.category}|${card.state}|${card.weight}|${card.isThreat ? 1 : 0}|${card.elite ? 1 : 0}|${card.guard ?? 0}|${card.linkId ?? 0}`
      : `${Math.round(w)}x${Math.round(h)}|empty`;
    if (this.cardBackgroundSignatures.get(bg.uuid) === signature) return;
    this.cardBackgroundSignatures.set(bg.uuid, signature);
    const baseSprite = this.spriteChild(bg, 'TaskCardBase', 0);
    const accentSprite = this.spriteChild(bg, 'TaskCardAccent', 1);
    if (!card) {
      baseSprite.enabled = false;
      accentSprite.enabled = false;
      g.clear();
      // 空槽 = 虚线描边"幽灵槽"：实心灰块看起来像素材加载失败，
      // 虚线轮廓 + 极淡底传达"这里会来卡片"的预期，且不与真卡抢视觉。
      const foot = Math.max(5, Math.min(8, h * 0.08));
      const gx = -w / 2 + 7;
      const gy = -h / 2 + 7;
      const gw = w - 14;
      const gh = h - foot - 14;
      g.fillColor = new Color(225, 216, 202, 30);
      g.roundRect(gx, gy, gw, gh, Math.min(12, w * 0.16));
      g.fill();
      g.strokeColor = new Color(72, 63, 54, 60);
      g.lineWidth = 2;
      const dash = 7;
      const gapLen = 6;
      const dashLine = (x1: number, y1: number, x2: number, y2: number) => {
        const len = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(1, Math.floor(len / (dash + gapLen)));
        const ux = (x2 - x1) / len;
        const uy = (y2 - y1) / len;
        for (let s = 0; s < steps; s++) {
          const sx = x1 + ux * s * (dash + gapLen);
          const sy = y1 + uy * s * (dash + gapLen);
          g.moveTo(sx, sy);
          g.lineTo(sx + ux * dash, sy + uy * dash);
        }
        g.stroke();
      };
      const inset = 4;
      dashLine(gx + inset, gy, gx + gw - inset, gy);
      dashLine(gx + gw, gy + inset, gx + gw, gy + gh - inset);
      dashLine(gx + gw - inset, gy + gh, gx + inset, gy + gh);
      dashLine(gx, gy + gh - inset, gx, gy + inset);
      return;
    }
    baseSprite.enabled = false;
    accentSprite.enabled = false;
    const base = GameRunner.CARD_BORDER_COLORS[card.category] ?? GameRunner.CARD_BORDER_COLORS.routine;
    const shellState: CardShellState = card.state === CS.Rework ? 'rework'
      : card.state === CS.Inserted ? 'inserted'
      : card.state === CS.Idle ? 'idle'
      : card.state === CS.Boss ? 'boss'
      : 'active';
    UiPainter.card(g, w, h, base, shellState);

    if (card.elite) {
      const shieldColor = (card.guard ?? 0) > 0 ? new Color(76, 169, 205, 255) : new Color(126, 114, 99, 210);
      const sx = w * 0.29;
      const sy = h * 0.29;
      g.fillColor = alphaColor(shieldColor, 225);
      g.strokeColor = alphaColor(Color.WHITE, 220);
      g.lineWidth = 2;
      g.moveTo(sx, sy + 10);
      g.lineTo(sx + 10, sy + 5);
      g.lineTo(sx + 7, sy - 8);
      g.lineTo(sx, sy - 14);
      g.lineTo(sx - 7, sy - 8);
      g.lineTo(sx - 10, sy + 5);
      g.close();
      g.fill(); g.stroke();
    }
    if (card.linkId !== undefined && (card.linkBonus ?? 0) > 0) {
      const lx = w * 0.29;
      const ly = -h * 0.10;
      g.strokeColor = alphaColor(UiTokens.color.gold, 235);
      g.lineWidth = 3;
      g.circle(lx - 5, ly + 5, 5);
      g.circle(lx + 5, ly - 5, 5);
      g.moveTo(lx - 1, ly + 1);
      g.lineTo(lx + 1, ly - 1);
      g.stroke();
    }

    const isBoss = card.state === CS.Boss;
    const isRework = card.state === CS.Rework;
    const severity = isBoss ? 3 : card.isThreat && card.weight >= 10 ? 3
      : card.isThreat && card.weight >= 7 ? 2
      : card.isThreat && card.weight >= 5 ? 1
      : 0;
    if (severity > 0 || isRework) {
      const alertColor = isRework ? UiTokens.color.good
        : severity >= 3 ? UiTokens.color.danger
        : severity === 2 ? new Color(230, 113, 58, 255)
        : UiTokens.color.gold;
      const chipW = Math.max(26, w * 0.34);
      const chipH = Math.max(17, h * 0.16);
      const chipX = -w * 0.27;
      const chipY = h * 0.30;
      g.fillColor = alphaColor(alertColor, 235);
      g.roundRect(chipX - chipW / 2, chipY - chipH / 2, chipW, chipH, chipH / 2);
      g.fill();

      // 高危卡多一条侧边警示带，在快速移动中也能靠轮廓辨认，而非只靠小字。
      if (severity >= 2) {
        const bandW = Math.max(4, w * 0.055);
        g.fillColor = alertColor;
        g.roundRect(-w / 2 + 3, -h * 0.28, bandW, h * 0.56, bandW / 2);
        g.fill();
      }
      if (severity >= 3) {
        g.strokeColor = alphaColor(alertColor, 210);
        g.lineWidth = 2.5;
        g.roundRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, Math.min(13, w * 0.15));
        g.stroke();
      }
      if (severity >= 2 && !isBoss) {
        // 高危任务使用三道斜切刻痕；即使看不清角标，也能靠轮廓快速识别。
        g.strokeColor = alphaColor(alertColor, 210);
        g.lineWidth = 2.5;
        for (let i = 0; i < 3; i++) {
          const x = w * 0.18 + i * 7;
          g.moveTo(x, -h * 0.34);
          g.lineTo(x + 7, -h * 0.22);
        }
        g.stroke();
      }
      if (isBoss) {
        const fullScan = this.game.level.def.boss.inspectionLimit === undefined;
        const bossColor = fullScan ? new Color(164, 42, 42, 255) : alertColor;
        g.fillColor = alphaColor(bossColor, 238);
        g.roundRect(-w * 0.34, -h * 0.44, w * 0.68, Math.max(18, h * 0.19), 8);
        g.fill();
        g.strokeColor = alphaColor(Color.WHITE, 170);
        g.lineWidth = fullScan ? 3 : 2;
        const scanY = h * 0.03;
        g.moveTo(-w * 0.28, scanY);
        g.lineTo(w * 0.28, scanY);
        g.stroke();
        if (fullScan) {
          g.strokeColor = alphaColor(bossColor, 220);
          g.lineWidth = 2;
          g.roundRect(-w / 2 + 7, -h / 2 + 7, w - 14, h - 14, Math.min(11, w * 0.13));
          g.stroke();
        }
      }
    }
  }

  private renderSlot(node: Node, card: Card | null, slotIndex: number): void {
    // 场景模板/复制出的 CardVisual 里可能残留默认 Label="label"。
    // 任务卡现在完全走图标 + 卡壳状态，不让任何旧文字参与显示。
    node.getComponentsInChildren(Label).forEach((label) => { label.enabled = false; });
    const title = TaskCardView.titleLabelFor(node);
    const value = TaskCardView.valueLabelFor(node);
    const sprite = this.taskIconFor(node);

    // 清空样式默认值
    sprite.color = Color.WHITE;

    // 无卡：预览占位图标 + 空底（drawCardBackground 已处理空槽半透底）
    if (!card) {
      sprite.spriteFrame = null;
      sprite.enabled = false;
      title.enabled = false;
      value.enabled = false;
      return;
    }

    // 有卡：用纯图标承载语义，避免卡面文字破坏截图目标里的大色块节奏。
    const sf = this.cardSfFor(card.category);
    if (sf) {
      sprite.spriteFrame = sf;
      sprite.color = Color.WHITE;
      sprite.enabled = true;
    } else {
      sprite.spriteFrame = null;
      sprite.enabled = false;
    }

    // 任务卡在移动端尺寸有限，底部小字会和图标/角标抢层级，显得碎且廉价。
    // 语义交给大图标和类别角标表达，保留更干净的游戏道具感。
    const bossLimit = card.state === 'boss' ? this.game.level.def.boss.inspectionLimit : undefined;
    const modifierTitle = card.state === CS.Rework
      ? '返工 · 抵达减分'
      : card.elite && (card.guard ?? 0) > 0
        ? card.linkId !== undefined ? '精英盾1·抱团' : '精英·盾1'
        : card.linkId !== undefined ? `抱团+${card.linkBonus ?? 1}` : '';
    title.enabled = card.state === 'boss' || !!modifierTitle;
    title.string = card.state === 'boss' ? (bossLimit === undefined ? '全量扫描' : `抽查${bossLimit}张`) : modifierTitle || getCardDef(card.category).label;
    title.color = Color.WHITE;
    title.isBold = true;

    const weightText = card.state === 'boss' ? (bossLimit === undefined ? '全' : `查${bossLimit}`)
      : card.state === 'rework' ? `-${card.weight}`
      : card.isThreat ? `+${card.weight}`
      : card.weight > 0 ? `+${card.weight}` : '';
    const showWeight = card.state === 'boss'
      || card.state === 'rework'
      || (card.isThreat && card.weight >= 5);
    value.enabled = showWeight;
    value.string = weightText;
    value.color = new Color(255, 252, 242, 255);
    value.isBold = true;
    if (showWeight) value.node.setSiblingIndex(node.children.length - 1);
  }

  private spriteChild(parent: Node, name: string, siblingIndex: number): Sprite {
    let child = parent.getChildByName(name);
    if (!child) {
      child = new Node(name);
      child.layer = parent.layer;
      parent.addChild(child);
      child.addComponent(UITransform);
      const sprite = child.addComponent(Sprite);
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    }
    child.setSiblingIndex(Math.min(siblingIndex, parent.children.length - 1));
    const sprite = child.getComponent(Sprite) ?? child.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    return sprite;
  }

  private applySpriteFrame(sprite: Sprite, frame: SpriteFrame | null, width: number, height: number, color: Readonly<Color>): void {
    sprite.spriteFrame = frame;
    sprite.enabled = !!frame;
    sprite.color = new Color(color.r, color.g, color.b, color.a);
    sprite.node.getComponent(UITransform)?.setContentSize(width, height);
    sprite.node.setPosition(0, 0, 0);
  }

  /**
   * 将逻辑队列同步到按 card.id 持有的视觉节点。
   *
   * 重要约束：节点在移动期间不重绘。如果同一张卡在移动中被改需求，
   * 新状态会在到达下一槽后再刷新；绝不会在半路换成另一张卡。
   */
  private syncCardVisuals(cards: readonly (Card | null)[]): void {
    if (!this.beltNode || this.slotNodes.length < 2) return;
    const liveIds = new Set<number>();

    cards.forEach((card, slotIndex) => {
      if (!card) return;
      liveIds.add(card.id);
      const snapshot = this.copyCard(card);
      const signature = this.cardSignature(snapshot);
      let visual = this.cardVisuals.get(card.id);

      if (!visual) {
        visual = this.createCardVisual(snapshot, slotIndex);
        this.cardVisuals.set(card.id, visual);
        return;
      }

      if (visual.signature !== signature) {
        if (visual.moving) visual.pendingCard = snapshot;
        else this.paintCardVisual(visual, snapshot);
      }

      if (visual.slotIndex !== slotIndex) this.moveCardVisual(visual, slotIndex, this.shiftDuration());
    });

    // 从逻辑队列移除的 slot0 卡片不直接销毁：继续左移，由 Belt Mask 逐像素裁掉。
    for (const [id, visual] of Array.from(this.cardVisuals.entries())) {
      if (liveIds.has(id)) continue;
      this.cardVisuals.delete(id);
      if (visual.slotIndex === 0) this.exitCardVisual(visual);
      else this.destroyCardVisual(visual);
    }
  }

  /** 创建一张真实卡片的独立��点；入口卡从屏幕右外侧线性进入。 */
  private createCardVisual(card: Card, slotIndex: number): CardVisual {
    const template = this.slotNodes[Math.min(slotIndex, this.slotNodes.length - 1)];
    const node = instantiate(template);
    node.name = `CardVisual-${card.id}`;
    node.parent = this.beltNode!;
    node.setSiblingIndex(this.beltNode!.children.length - 1);
    node.active = true;
    node.setScale(1, 1, 1);

    const visual: CardVisual = {
      node,
      slotIndex,
      signature: '',
      moving: false,
      pendingCard: null,
    };
    this.paintCardVisual(visual, card);

    const target = this.slotPosition(slotIndex);
    const last = this.slotNodes.length - 1;
    if (slotIndex === last) {
      const gap = this.slotGap();
      node.setPosition(target.x + gap, target.y, target.z);
      node.setScale(0.92, 0.96, 1);
      const opacity = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
      opacity.opacity = 0;
      this.enterCardVisual(visual, slotIndex);
    } else {
      node.setPosition(target);
    }
    return visual;
  }

  /** 重绘同一 card.id 的状态，不改变位置和节点身份。 */
  private paintCardVisual(visual: CardVisual, card: Card): void {
    if (!visual.node.isValid) return;
    const bg = visual.node.children.find((child) => !!child.getComponent(Graphics));
    if (bg) this.drawCardBackgroundNode(bg, card);
    this.renderSlot(visual.node, card, visual.slotIndex);
    visual.signature = this.cardSignature(card);
    visual.pendingCard = null;
  }

  /** 新卡进入队列：仍保持同一像素速度，但给卡面一个轻微“落位”弹性，避免像网页轮播一样硬滑入。 */
  private enterCardVisual(visual: CardVisual, slotIndex: number): void {
    const node = visual.node;
    if (!node.isValid) return;
    const target = this.slotPosition(slotIndex);
    const opacity = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    Tween.stopAllByTarget(node);
    Tween.stopAllByTarget(opacity);
    visual.slotIndex = slotIndex;
    visual.moving = true;
    tween(opacity)
      .to(Math.min(0.14, this.entryDuration() * 0.45), { opacity: 255 }, { easing: 'quadOut' })
      .start();
    tween(node)
      .to(this.entryDuration(), { position: target, scale: new Vec3(1.02, 1.02, 1) }, { easing: 'sineOut' })
      .to(0.07, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' })
      .call(() => {
        if (!node.isValid) return;
        node.setPosition(target);
        node.setScale(1, 1, 1);
        opacity.opacity = 255;
        visual.moving = false;
        if (visual.pendingCard) this.paintCardVisual(visual, visual.pendingCard);
      })
      .start();
  }

  /** 槽位变化时始终从当前位置线性移到新槽，不瞬移、不缩放、不渐变。 */
  private moveCardVisual(visual: CardVisual, slotIndex: number, duration: number, force = false): void {
    const node = visual.node;
    if (!node.isValid) return;
    if (!force && visual.slotIndex === slotIndex) return;
    const target = this.slotPosition(slotIndex);
    Tween.stopAllByTarget(node);
    node.setScale(1, 1, 1);
    visual.slotIndex = slotIndex;
    visual.moving = true;
    tween(node)
      .to(duration, { position: target }, { easing: 'linear' })
      .call(() => {
        if (!node.isValid) return;
        node.setPosition(target);
        visual.moving = false;
        if (visual.pendingCard) this.paintCardVisual(visual, visual.pendingCard);
      })
      .start();
  }

  /**
   * 出口使用"卡片宽度"作为完整移出距离：
   * 0%=完整，25%=裁左 1/4，50%=只剩右半，75%=只剩右 1/4，100%=完全移出。
   */
  private exitCardVisual(visual: CardVisual): void {
    const node = visual.node;
    if (!node.isValid) return;
    const start = node.position.clone();
    const cardW = node.getComponent(UITransform)?.width ?? Math.max(1, this.slotGap() - 8);
    const target = new Vec3(start.x - cardW, start.y, start.z);
    // 与整条履带保持同一像素速度；卡宽小于槽距，因此完全移出会略早于一次换档结束。
    const duration = this.shiftDuration() * Math.min(1, cardW / this.slotGap());
    Tween.stopAllByTarget(node);
    node.setScale(1, 1, 1);
    visual.moving = true;
    tween(node)
      .to(duration, { position: target }, { easing: 'linear' })
      .call(() => this.destroyCardVisual(visual))
      .start();
  }

  private destroyCardVisual(visual: CardVisual): void {
    if (!visual.node.isValid) return;
    Tween.stopAllByTarget(visual.node);
    visual.node.children
      .filter((child) => !!child.getComponent(Graphics))
      .forEach((child) => this.cardBackgroundSignatures.delete(child.uuid));
    visual.node.destroy();
  }

  private resetCardVisuals(): void {
    for (const visual of this.cardVisuals.values()) this.destroyCardVisual(visual);
    this.cardVisuals.clear();
  }

  /** 屏幕尺寸变化时重新吸附到对应槽位，避免保留旧分辨率坐标。 */
  private relayoutCardVisuals(): void {
    for (const visual of this.cardVisuals.values()) {
      if (!visual.node.isValid) continue;
      Tween.stopAllByTarget(visual.node);
      visual.node.setPosition(this.slotPosition(visual.slotIndex));
      visual.node.setScale(1, 1, 1);
      visual.moving = false;
      if (visual.pendingCard) this.paintCardVisual(visual, visual.pendingCard);
    }
  }

  private visualNodeAtSlot(slotIndex: number): Node | null {
    for (const visual of this.cardVisuals.values()) {
      if (visual.slotIndex === slotIndex && visual.node.isValid) return visual.node;
    }
    return null;
  }

  private slotPosition(slotIndex: number): Vec3 {
    return this.slotNodes[slotIndex]?.position.clone() ?? new Vec3();
  }

  private slotGap(): number {
    if (this.slotNodes.length < 2) return 1;
    return Math.max(1, Math.abs(this.slotNodes[1].position.x - this.slotNodes[0].position.x));
  }

  private shiftDuration(): number {
    return Math.max(0.48, BalanceConfig.phases[this.game.phase].slotPeriodSec * 0.92);
  }

  private entryDuration(): number {
    return Math.max(0.48, Math.min(0.82, BalanceConfig.phases[this.game.phase].slotPeriodSec * 0.72));
  }

  private copyCard(card: Card): Card {
    return { ...card };
  }

  private cardSignature(card: Card): string {
    return `${card.id}:${card.category}:${card.state}:${card.weight}:${card.isThreat ? 1 : 0}:${card.elite ? 1 : 0}:${card.guard ?? 0}:${card.linkId ?? 0}:${card.linkBonus ?? 0}`;
  }

  /** 队列图标使用独立子节点，避免与槽位本身的 Label 渲染器争用同一节点。 */
  private taskIconFor(slot: Node): Sprite {
    let iconNode = slot.getChildByName('TaskIcon');
    if (!iconNode) {
      iconNode = new Node('TaskIcon');
      iconNode.layer = 1 << 25;
      iconNode.addComponent(UITransform);
      const sprite = iconNode.addComponent(Sprite);
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      iconNode.parent = slot;
    }
    iconNode.setSiblingIndex(Math.min(1, slot.children.length - 1));
    const slotUt = slot.getComponent(UITransform);
    const iconUt = iconNode.getComponent(UITransform)!;
    if (slotUt) {
      // 图标是任务卡的主语义层。之前按 60%/50% 缩放会把源图透明边距也一起算进去，
      // 实际可见图案偏小，整体像廉价贴纸；这里改成占据卡面主体。
      const iconSize = Math.min(slotUt.width * 0.84, slotUt.height * 0.74);
      iconUt.setContentSize(iconSize, iconSize);
    }
    iconNode.setPosition(0, slotUt ? slotUt.height * 0.02 : 0, 0);
    return iconNode.getComponent(Sprite)!;
  }

  /** 卡牌类别 → SpriteFrame ��射（null = 没素材，走 Label 兜底）。 */
  private cardSfFor(cat: Card['category']): SpriteFrame | null {
    const key = GameRunner.CARD_ART_KEYS[cat] ?? `card-${cat}`;
    return this.artSprites.get(key) ?? this.artSprites.get(`card-${cat}`) ?? null;
  }

  private cardShellSfFor(card: Card | null): SpriteFrame | null {
    if (!card) return this.artSprites.get(GameRunner.CARD_SHELL_ART_KEYS.empty) ?? null;
    const stateKey = card.state === CS.Rework ? 'rework'
      : card.state === CS.Inserted ? 'inserted'
      : card.state === CS.Boss ? 'boss'
      : card.category;
    const key = GameRunner.CARD_SHELL_ART_KEYS[stateKey] ?? GameRunner.CARD_SHELL_ART_KEYS.routine;
    return this.artSprites.get(key) ?? null;
  }

  /** 道具类型 → SpriteFrame 映射（null = 没素材，走纯文字兜底）。
   *  文件名约定：props/prop-add-demand.png → 查 "prop-add-demand"。 */
  private propSfFor(prop: PropType): SpriteFrame | null {
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    if (idx < 0) return null;
    return this.artSprites.get(GameRunner.PROP_ART_KEYS[idx]) ?? null;
  }

  /** 背景图比例常量（白底AI图纯抠透明，无插入，角色可稍挡显示器底部）。
   *  显示器内屏：y ∈ [24.3%, 59.3%]；桌面线：y = 62.7%。 */
  private static readonly BG_SCREEN_TOP = 0.243;
  private static readonly BG_SCREEN_BOTTOM = 0.593;
  private static readonly BG_SCREEN_LEFT = 0.035;
  private static readonly BG_SCREEN_RIGHT = 0.964;
  private static readonly BG_DESK_TOP = 0.627;

  /** 角色图实测比例常量（char-back.png 已裁掉透明边距，646×927，PIL alpha>128 逐行扫描）：
   *  头顶(天线顶) y=0%；键盘前沿(最宽处) y=58.3%。
   *  头到键盘距离 = 58.3% 的角色高度。宽高比 = 646/927 ≈ 0.697。 */
  private static readonly CHAR_HANDS_Y = 0.583;
  private static readonly CHAR_HEAD_TOP = 0.0;
  private static readonly CHAR_ASPECT = 646 / 927; // 宽/高
  /** 角色整体上下微调。正=上移，负=下移，单位=背景图高度的比例（0.05=下移5%背景高）。
   *  改这一个值就能调角色位置，不用动其他代码。 */
  private static readonly CHAR_Y_OFFSET = -0.10;

  /** 挂背景 + 角色 Sprite，位置按背景图实测比例动态计算（不再猜固定像素）。
   *  背景按宽度等比完整显示，绝不再用 cover 裁掉显示器两侧；超长屏多出的底部区域用背景底色延伸，
   *  作为道具操作区。再用图片实测比例反算显示器/桌面位置，把 Belt/Char/Props 对齐上去。 */
  private applyBgCharSprites(): void {
    const LAYER_2D = 1 << 25;
    const visSize = view.getVisibleSize();
    const topY = visSize.height / 2;
    const bottomY = -visSize.height / 2;
    const safe = sys.getSafeAreaRect(false);
    const safeTopY = safe.y + safe.height - visSize.height / 2;
    const safeBottomY = safe.y - visSize.height / 2;

    // 一套与新版开始页一致的暖纸质背景，主界面不再依赖整张旧办公室图来决定层级。
    if (!this.bgFillNode) {
      this.bgFillNode = new Node('BgFill');
      this.bgFillNode.layer = LAYER_2D;
      this.bgFillNode.parent = this.node;
      this.bgFillNode.addComponent(UITransform);
      this.bgFillNode.addComponent(Graphics);
      this.bgFillNode.active = this.uiState === 'playing';
    }
    this.bgFillNode.getComponent(UITransform)!.setContentSize(visSize.width, visSize.height);
    this.bgFillNode.setPosition(0, 0, 0);
    this.bgFillNode.setSiblingIndex(0);
    const fillG = this.bgFillNode.getComponent(Graphics)!;
    fillG.clear();
    fillG.fillColor = GameRunner.START_BG;
    fillG.rect(-visSize.width / 2, -visSize.height / 2, visSize.width, visSize.height);
    fillG.fill();

    if (this.bgNode) this.bgNode.active = false;

    // 顶部：主标题 + 左关卡胶囊 + 右计时胶囊，形成一套统一 HUD。
    if (!this.gameTitleNode) {
      this.gameTitleNode = new Node('GameTitle');
      this.gameTitleNode.layer = LAYER_2D;
      this.gameTitleNode.parent = this.node;
      this.gameTitleNode.addComponent(UITransform);
      const lbl = this.gameTitleNode.addComponent(Label);
      lbl.fontFamily = 'PingFang SC';
      lbl.horizontalAlign = 1;
      lbl.verticalAlign = 1;
      lbl.isBold = true;
      lbl.overflow = Label.Overflow.SHRINK;
    }
    const titleY = Math.min(safeTopY - 34, topY - Math.max(34, visSize.height * 0.042));
    this.gameTitleNode.getComponent(UITransform)!.setContentSize(Math.min(visSize.width * 0.76, 520), 54);
    this.gameTitleNode.setPosition(0, titleY, 0);
    const titleLabel = this.gameTitleNode.getComponent(Label)!;
    // 美术资源可能在选关页异步加载完成；此时 game 尚未创建，标题必须从当前关配置兜底读取。
    const activeLevelDef = this.game?.level.def ?? getLevel(this.session.currentIndex);
    titleLabel.string = `本关目标 · ${activeLevelDef.objective?.label ?? '守住岗位'}`;
    titleLabel.fontSize = Math.min(32, Math.max(24, visSize.width * 0.050));
    titleLabel.lineHeight = titleLabel.fontSize + 6;
    titleLabel.color = GameRunner.START_MUTED;
    titleLabel.isBold = true;

    const hudY = titleY - Math.max(70, visSize.height * 0.082);
    // 顶部小标题与倒计时按显示器左右边缘对齐，而不是按屏幕安全边距贴边。
    // 这样 HUD 和核心玩法区会形成两条稳定的竖向视觉基线。
    const monitorW = Math.min(visSize.width * 0.91, 760);
    const pillW = Math.min(142, Math.max(112, visSize.width * 0.18));
    const pillH = Math.min(70, Math.max(56, visSize.height * 0.070));
    const hudLeftX = -monitorW / 2 + pillW / 2;

    if (!this.monitorLabelNode) {
      this.monitorLabelNode = new Node('LevelPill');
      this.monitorLabelNode.layer = LAYER_2D;
      this.monitorLabelNode.parent = this.node;
      this.monitorLabelNode.addComponent(UITransform);
      this.monitorLabelNode.addComponent(Graphics);
      const text = new Node('LevelPillText');
      text.layer = LAYER_2D;
      text.parent = this.monitorLabelNode;
      text.addComponent(UITransform);
      const lbl = text.addComponent(Label);
      lbl.fontFamily = 'PingFang SC';
      lbl.horizontalAlign = 1;
      lbl.verticalAlign = 1;
      lbl.isBold = true;
      lbl.overflow = Label.Overflow.SHRINK;
    }
    this.monitorLabelNode.getComponent(UITransform)!.setContentSize(pillW, pillH);
    this.monitorLabelNode.setPosition(hudLeftX, hudY, 0);
    this.monitorLabelNode.setSiblingIndex(2);
    const levelG = this.monitorLabelNode.getComponent(Graphics)!;
    levelG.clear();
    levelG.fillColor = GameRunner.START_SOFT;
    levelG.roundRect(-pillW / 2, -pillH / 2, pillW, pillH, pillH * 0.46);
    levelG.fill();
    const levelText = this.monitorLabelNode.getChildByName('LevelPillText')?.getComponent(Label);
    if (levelText) {
      const rawTitle = getLevel(this.session.currentIndex).title ?? '';
      const missionName = rawTitle.includes('·') ? rawTitle.split('·').slice(-1)[0] : rawTitle;
      levelText.string = `第 ${this.session.currentIndex + 1} 关\n${missionName || '替代警报'}`;
      levelText.fontSize = Math.min(23, Math.max(18, pillW * 0.17));
      levelText.lineHeight = levelText.fontSize + 6;
      levelText.color = GameRunner.START_TEXT;
      levelText.node.getComponent(UITransform)!.setContentSize(pillW - 20, pillH - 10);
      levelText.node.setPosition(0, 0, 0);
    }
    if (this.subtitleNode) this.subtitleNode.active = false;

    if (!this.timerPlateNode) {
      this.timerPlateNode = new Node('TimerPlate');
      this.timerPlateNode.layer = LAYER_2D;
      this.timerPlateNode.parent = this.node;
      this.timerPlateNode.addComponent(UITransform);
      this.timerPlateNode.addComponent(Graphics);
    }
    const timerW = Math.min(196, Math.max(152, visSize.width * 0.245));
    const timerH = Math.min(72, Math.max(56, visSize.height * 0.066));
    const timerX = monitorW / 2 - timerW / 2;
    this.timerPlateNode.getComponent(UITransform)!.setContentSize(timerW, timerH);
    this.timerPlateNode.setPosition(timerX, hudY, 0);
    this.timerPlateNode.setSiblingIndex(2);
    if (!this.gameTimerNode) {
      this.gameTimerNode = new Node('GameTimer');
      this.gameTimerNode.layer = LAYER_2D;
      this.gameTimerNode.parent = this.node;
      this.gameTimerNode.addComponent(UITransform);
      const timer = this.gameTimerNode.addComponent(Label);
      timer.fontFamily = 'PingFang SC';
      timer.horizontalAlign = 1;
      timer.verticalAlign = 1;
      timer.isBold = true;
      timer.overflow = Label.Overflow.SHRINK;
    }
    this.gameTimerNode.getComponent(UITransform)!.setContentSize(timerW * 0.45, timerH * 0.58);
    this.gameTimerNode.setPosition(timerX + timerW * 0.10, hudY + timerH * 0.10, 0);

    // 中央核心：收件箱显示器。厚边框保留玩具感，内屏留给传送带和任务卡。
    const monitorH = Math.min(visSize.height * 0.315, monitorW * 0.58);
    const monitorY = hudY - timerH * 0.5 - Math.max(monitorH * 0.55 + 20, visSize.height * 0.175);
    if (!this.monitorSurfaceNode) {
      this.monitorSurfaceNode = new Node('InboxMonitor');
      this.monitorSurfaceNode.layer = LAYER_2D;
      this.monitorSurfaceNode.parent = this.node;
      this.monitorSurfaceNode.addComponent(UITransform);
      this.monitorSurfaceNode.addComponent(Graphics);
    }
    this.monitorSurfaceNode.getComponent(UITransform)!.setContentSize(monitorW, monitorH);
    this.monitorSurfaceNode.setPosition(0, monitorY, 0);
    this.monitorSurfaceNode.setSiblingIndex(1);
    const surfaceG = this.monitorSurfaceNode.getComponent(Graphics)!;
    surfaceG.clear();
    const monitorR = Math.min(42, monitorH * 0.16);
    surfaceG.fillColor = new Color(68, 56, 46, 255);
    surfaceG.roundRect(-monitorW / 2, -monitorH / 2, monitorW, monitorH, monitorR);
    surfaceG.fill();
    surfaceG.fillColor = new Color(255, 252, 246, 255);
    surfaceG.roundRect(-monitorW / 2 + 22, -monitorH / 2 + 22, monitorW - 44, monitorH - 44, monitorR * 0.72);
    surfaceG.fill();

    const innerW = monitorW - 44;
    const innerH = monitorH - 44;
    const headerH = Math.min(64, Math.max(46, innerH * 0.21));
    const innerLeft = -innerW / 2;
    const innerTop = innerH / 2;
    surfaceG.strokeColor = new Color(226, 216, 198, 255);
    surfaceG.lineWidth = 1.2;
    surfaceG.moveTo(innerLeft + 2, innerTop - headerH);
    surfaceG.lineTo(innerLeft + innerW - 2, innerTop - headerH);
    surfaceG.stroke();
    [new Color(240, 92, 96, 255), new Color(238, 176, 78, 255), new Color(79, 178, 112, 255)].forEach((c, i) => {
      surfaceG.fillColor = c;
      surfaceG.circle(innerLeft + 42 + i * 28, innerTop - headerH / 2, 9);
      surfaceG.fill();
    });
    const dotColor = new Color(226, 216, 198, 92);
    for (let x = innerLeft + 36; x < innerLeft + innerW - 28; x += 28) {
      for (let y = -innerH / 2 + 70; y < innerTop - headerH - 8; y += 28) {
        surfaceG.fillColor = dotColor;
        surfaceG.circle(x, y, 1.6);
        surfaceG.fill();
      }
    }

    if (!this.monitorProcessLabelNode) {
      this.monitorProcessLabelNode = new Node('InboxTitle');
      this.monitorProcessLabelNode.layer = LAYER_2D;
      this.monitorProcessLabelNode.parent = this.monitorSurfaceNode;
      this.monitorProcessLabelNode.addComponent(UITransform);
      const lbl = this.monitorProcessLabelNode.addComponent(Label);
      lbl.fontFamily = 'PingFang SC';
      lbl.horizontalAlign = 0;
      lbl.verticalAlign = 1;
      lbl.isBold = true;
      lbl.overflow = Label.Overflow.SHRINK;
    }
    const inboxLabel = this.monitorProcessLabelNode.getComponent(Label)!;
    inboxLabel.string = '收件箱 · 待处理';
    inboxLabel.fontSize = Math.min(22, Math.max(16, monitorW * 0.028));
    inboxLabel.lineHeight = inboxLabel.fontSize + 4;
    inboxLabel.color = GameRunner.START_MUTED;
    this.monitorProcessLabelNode.getComponent(UITransform)!.setContentSize(innerW * 0.50, headerH - 8);
    this.monitorProcessLabelNode.setPosition(innerLeft + 132 + innerW * 0.25, innerTop - headerH / 2, 0);

    if (!this.monitorEntryLabelNode) {
      this.monitorEntryLabelNode = new Node('QueuePill');
      this.monitorEntryLabelNode.layer = LAYER_2D;
      this.monitorEntryLabelNode.parent = this.monitorSurfaceNode;
      this.monitorEntryLabelNode.addComponent(UITransform);
      this.monitorEntryLabelNode.addComponent(Graphics);
      const text = new Node('QueueText');
      text.layer = LAYER_2D;
      text.parent = this.monitorEntryLabelNode;
      text.addComponent(UITransform);
      const lbl = text.addComponent(Label);
      lbl.fontFamily = 'PingFang SC';
      lbl.horizontalAlign = 1;
      lbl.verticalAlign = 1;
      lbl.isBold = true;
      lbl.overflow = Label.Overflow.SHRINK;
    }
    const queueW = Math.min(98, innerW * 0.16);
    const queueH = Math.min(36, headerH * 0.64);
    this.monitorEntryLabelNode.getComponent(UITransform)!.setContentSize(queueW, queueH);
    this.monitorEntryLabelNode.setPosition(innerW / 2 - queueW / 2 - 30, innerTop - headerH / 2, 0);
    const queueG = this.monitorEntryLabelNode.getComponent(Graphics)!;
    queueG.clear();
    queueG.fillColor = GameRunner.START_SOFT;
    queueG.roundRect(-queueW / 2, -queueH / 2, queueW, queueH, queueH / 2);
    queueG.fill();
    const qText = this.monitorEntryLabelNode.getChildByName('QueueText')?.getComponent(Label);
    if (qText) {
      qText.string = '队列中';
      qText.fontSize = Math.min(18, queueH * 0.50);
      qText.lineHeight = qText.fontSize + 3;
      qText.color = GameRunner.START_MUTED;
      qText.node.getComponent(UITransform)!.setContentSize(queueW - 14, queueH - 4);
      qText.node.setPosition(0, 0, 0);
    }

    if (this.beltNode) {
      const beltW = innerW * 0.84;
      const beltH = Math.max(116, innerH - headerH - 66);
      const beltY = monitorY - monitorH * 0.02;
      this.beltNode.setPosition(0, beltY, 0);
      let beltUt = this.beltNode.getComponent(UITransform);
      if (!beltUt) beltUt = this.beltNode.addComponent(UITransform);
      beltUt.setContentSize(beltW, beltH);
      const mask = this.beltNode.getComponent(Mask) ?? this.beltNode.addComponent(Mask);
      mask.type = Mask.Type.GRAPHICS_RECT;
      this.layoutBeltSlots(beltW, beltH);
    }

    if (!this.conveyorTrackNode) {
      this.conveyorTrackNode = new Node('ConveyorTrack');
      this.conveyorTrackNode.layer = LAYER_2D;
      this.conveyorTrackNode.parent = this.node;
      this.conveyorTrackNode.addComponent(UITransform);
      this.conveyorTrackNode.addComponent(Graphics);
    }
    const trackW = innerW * 0.88;
    const trackH = Math.min(54, Math.max(42, monitorH * 0.13));
    const trackY = monitorY - monitorH / 2 + 52;
    this.conveyorTrackNode.getComponent(UITransform)!.setContentSize(trackW, trackH);
    this.conveyorTrackNode.setPosition(0, trackY, 0);
    this.conveyorTrackNode.setSiblingIndex(2);
    const trackG = this.conveyorTrackNode.getComponent(Graphics)!;
    trackG.clear();
    trackG.fillColor = new Color(136, 124, 111, 255);
    trackG.roundRect(-trackW / 2, -trackH / 2, trackW, trackH, trackH / 2);
    trackG.fill();
    const rollerR = trackH * 0.34;
    [-trackW / 2 + trackH * 0.55, trackW / 2 - trackH * 0.55].forEach((x) => {
      trackG.fillColor = new Color(252, 249, 242, 255);
      trackG.circle(x, 0, rollerR);
      trackG.fill();
    });
    trackG.fillColor = new Color(210, 201, 190, 255);
    for (let x = -trackW / 2 + trackH * 1.2; x < trackW / 2 - trackH * 1.2; x += trackH * 0.62) {
      trackG.roundRect(x, -trackH * 0.14, trackH * 0.16, trackH * 0.28, 2);
      trackG.fill();
    }

    // 工位压缩成一条完整的浅色底座带：保留办公室叙事，但不再和玩法区抢视觉权重。
    const propLayout = UiTokens.layout.props;
    const hudLayout = UiTokens.layout.lowerHud;
    const approxPad = Math.max(propLayout.minHorizontalPadding, visSize.width * propLayout.horizontalPaddingRatio);
    const approxGap = Math.max(propLayout.minGap, visSize.width * propLayout.gapRatio);
    const approxTotalW = Math.min(visSize.width - approxPad * 2, propLayout.maxTotalWidth);
    const approxBtnW = Math.min((approxTotalW - approxGap * (this.propButtonNodes.length - 1)) / Math.max(1, this.propButtonNodes.length), propLayout.maxButtonWidth);
    const approxBtnH = Math.min(propLayout.maxButtonHeight, Math.max(propLayout.minButtonHeight, approxBtnW * propLayout.buttonHeightRatio));
    const approxPanelH = Math.min(hudLayout.maxPanelHeight, Math.max(hudLayout.minPanelHeight, visSize.height * hudLayout.panelHeightRatio));
    const approxBtnY = safeBottomY + approxBtnH / 2 + Math.max(propLayout.minBottomSafe, visSize.height * propLayout.bottomSafeRatio);
    const approxPanelY = approxBtnY + approxBtnH / 2 + approxPanelH / 2 + Math.max(hudLayout.minGap, visSize.height * hudLayout.gapRatio);
    const deskTop = monitorY - monitorH / 2 - Math.max(16, visSize.height * 0.018);
    const deskBottom = approxPanelY + approxPanelH / 2 + Math.max(12, visSize.height * 0.012);
    const deskAvailableH = deskTop - deskBottom;
    const deskH = Math.max(150, Math.min(430, deskAvailableH));
    // 工位整体稍微上移，让桌面更贴近显示器/角色手部，减少下方漂浮感；物件和 AI 使用同一个 deskY 保持相对关系。
    const deskLift = Math.min(30, Math.max(14, visSize.height * 0.020));
    const deskY = deskTop - deskH / 2 + deskLift;

    const deskBand = this.node.getChildByName('DeskBand') ?? new Node('DeskBand');
    if (!deskBand.parent) {
      deskBand.layer = LAYER_2D;
      deskBand.parent = this.node;
      deskBand.addComponent(UITransform);
      deskBand.addComponent(Graphics);
    }
    // 桌面作为场景底座应延展到屏幕两侧，物件自然外扩；核心玩法区仍由上方显示器承担。
    const bandW = Math.min(Math.max(visSize.width * 1.04, monitorW * 1.18), 920);
    deskBand.getComponent(UITransform)!.setContentSize(bandW, deskH);
    deskBand.setPosition(0, deskY, 0);
    deskBand.setSiblingIndex(1);
    deskBand.active = this.uiState === 'playing';
    const bandG = deskBand.getComponent(Graphics)!;
    bandG.clear();
    bandG.fillColor = new Color(248, 226, 190, 82);
    bandG.roundRect(-bandW / 2, -deskH / 2, bandW, deskH, 10);
    bandG.fill();
    bandG.fillColor = new Color(230, 174, 106, 48);
    bandG.ellipse(0, -deskH * 0.42, bandW * 0.52, deskH * 0.11);
    bandG.fill();

    const tableDepth = Math.max(38, Math.min(62, deskH * 0.20));
    const tableFaceH = Math.max(18, Math.min(30, deskH * 0.095));
    const tableSurfaceBaseY = -deskH * 0.08;
    const tableBoardLift = Math.min(16, Math.max(10, deskH * 0.045));
    const tableSurfaceY = tableSurfaceBaseY + tableBoardLift;
    const tableW = bandW * 0.98;
    const tableBackW = tableW * 0.78;
    const tableFrontW = tableW;
    const tableBackY = tableSurfaceY + tableDepth * 0.34;
    const tableFrontY = tableSurfaceY - tableDepth * 0.66;
    const objectTableFrontY = tableSurfaceBaseY - tableDepth * 0.66;

    // 桌面投影：先落在桌子下方，后续桌腿和桌面覆盖在上面，建立纵深。
    bandG.fillColor = new Color(126, 82, 52, 42);
    bandG.roundRect(-tableFrontW / 2 + 8, tableFrontY - tableFaceH - 9, tableFrontW - 16, tableFaceH + 12, 10);
    bandG.fill();

    // 上表面：梯形透视，后边稍窄、前边稍宽，看起来不再是一条扁平横条。
    bandG.fillColor = new Color(196, 132, 78, 245);
    bandG.strokeColor = new Color(111, 72, 49, 185);
    bandG.lineWidth = 2;
    bandG.moveTo(-tableBackW / 2, tableBackY);
    bandG.lineTo(tableBackW / 2, tableBackY);
    bandG.lineTo(tableFrontW / 2, tableFrontY);
    bandG.lineTo(-tableFrontW / 2, tableFrontY);
    bandG.close();
    bandG.fill();
    bandG.stroke();

    bandG.fillColor = new Color(226, 170, 103, 130);
    bandG.moveTo(-tableBackW / 2 + 16, tableBackY - 3);
    bandG.lineTo(tableBackW / 2 - 16, tableBackY - 3);
    bandG.lineTo(tableFrontW / 2 - 32, tableFrontY + tableDepth * 0.25);
    bandG.lineTo(-tableFrontW / 2 + 32, tableFrontY + tableDepth * 0.25);
    bandG.close();
    bandG.fill();

    // 侧面暗部 + 前沿厚度：让桌面有体积。
    bandG.fillColor = new Color(132, 82, 52, 224);
    bandG.moveTo(-tableFrontW / 2, tableFrontY);
    bandG.lineTo(tableFrontW / 2, tableFrontY);
    bandG.lineTo(tableFrontW * 0.48, tableFrontY - tableFaceH);
    bandG.lineTo(-tableFrontW * 0.48, tableFrontY - tableFaceH);
    bandG.close();
    bandG.fill();

    bandG.fillColor = new Color(104, 65, 48, 170);
    bandG.moveTo(-tableFrontW / 2, tableFrontY);
    bandG.lineTo(-tableBackW / 2, tableBackY);
    bandG.lineTo(-tableBackW * 0.48, tableBackY - tableFaceH * 0.40);
    bandG.lineTo(-tableFrontW * 0.48, tableFrontY - tableFaceH);
    bandG.close();
    bandG.fill();
    bandG.moveTo(tableFrontW / 2, tableFrontY);
    bandG.lineTo(tableBackW / 2, tableBackY);
    bandG.lineTo(tableBackW * 0.48, tableBackY - tableFaceH * 0.40);
    bandG.lineTo(tableFrontW * 0.48, tableFrontY - tableFaceH);
    bandG.close();
    bandG.fill();

    bandG.fillColor = new Color(86, 72, 60, 155);
    const legW = Math.max(14, tableW * 0.035);
    const legH = Math.max(56, deskH * 0.30);
    [-tableW * 0.38, tableW * 0.38].forEach((x) => {
      bandG.roundRect(x - legW / 2, tableFrontY - tableFaceH - legH, legW, legH, 5);
      bandG.fill();
    });

    bandG.fillColor = new Color(230, 174, 106, 92);
    bandG.roundRect(-tableFrontW / 2 + 18, tableFrontY - 5, tableFrontW - 36, 5, 3);
    bandG.fill();

    // 物件接触阴影：先在桌面上落两组轻阴影，再把 decor sprite 盖上去，物件会更像“站在桌上”。
    const objectRestY = objectTableFrontY + tableDepth * 0.56;
    const objectClusterX = Math.min(tableW * 0.36, bandW * 0.40);
    bandG.fillColor = new Color(80, 48, 30, 42);
    bandG.ellipse(-objectClusterX, objectRestY - 5, tableW * 0.16, tableDepth * 0.16);
    bandG.fill();
    bandG.ellipse(objectClusterX, objectRestY - 5, tableW * 0.18, tableDepth * 0.16);
    bandG.fill();

    const decorSf = this.artSprites.get('desk-decor');
    if (decorSf) {
      if (this.deskDecorNode) this.deskDecorNode.active = false;
      const itemDefs = [
        { name: 'DeskPlant', rect: new Rect(20, 225, 282, 402), x: -tableFrontW * 0.33, h: Math.min(deskH * 0.34, 122), bottom: objectRestY + 1 },
        { name: 'DeskPens', rect: new Rect(290, 285, 232, 360), x: -tableFrontW * 0.21, h: Math.min(deskH * 0.31, 110), bottom: objectRestY + 1 },
        // 水杯把手和日历左边缘在原图中有轻微横向重叠，矩形裁切会把彼此带进来；
        // 这里收窄相邻边，避免杯子和日历之间出现脏线/残片。
        { name: 'DeskCup', rect: new Rect(1195, 308, 294, 326), x: tableFrontW * 0.225, h: Math.min(deskH * 0.30, 106), bottom: objectRestY - 1 },
        { name: 'DeskNote', rect: new Rect(1490, 224, 264, 452), x: tableFrontW * 0.335, h: Math.min(deskH * 0.39, 138), bottom: objectRestY },
      ];
      const tex = decorSf.texture;
      while (this.deskItemNodes.length < itemDefs.length) {
        const i = this.deskItemNodes.length;
        const def = itemDefs[i];
        const node = new Node(def.name);
        node.layer = LAYER_2D;
        node.parent = this.node;
        node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        const sf = new SpriteFrame();
        sf.texture = tex;
        sf.rect = def.rect;
        sprite.spriteFrame = sf;
        this.deskItemNodes.push(node);
      }
      this.deskItemNodes.forEach((node, i) => {
        const def = itemDefs[i];
        if (!def || !node?.isValid) {
          if (node?.isValid) node.active = false;
          return;
        }
        const w = def.h * (def.rect.width / def.rect.height);
        node.getComponent(UITransform)!.setContentSize(w, def.h);
        node.setPosition(def.x, deskY + def.bottom + def.h / 2, 0);
        node.setSiblingIndex(2);
        node.active = this.uiState === 'playing';
      });
    }
    const charSf = this.artSprites.get('char-back');
    if (charSf) {
      if (!this.charNode) {
        this.charNode = new Node('Char');
        this.charNode.layer = LAYER_2D;
        this.charNode.parent = this.node;
        this.charNode.addComponent(UITransform);
      }
      if (!this.characterRigView) this.characterRigView = new CharacterRigView(this.charNode, charSf);
      else this.characterRigView.setSpriteFrame(charSf);
      const charH = Math.min(deskH * 0.84, visSize.height * 0.210);
      const charW = charH * GameRunner.CHAR_ASPECT;
      this.characterRigView.layout(charW, charH);
      const keyboardRestY = objectTableFrontY + tableDepth * 0.26;
      this.charNode.setPosition(0, deskY + keyboardRestY + charH * 0.11, 0);
      this.charNode.setSiblingIndex(3);
      this.charNode.active = this.uiState === 'playing';
    }

    this.layoutPropButtons(visSize.width, visSize.height);
    this.layoutLowerHud(visSize.width, visSize.height);
    this.layoutTutorialHint();

    const playing = this.uiState === 'playing';
    [this.bgFillNode, this.gameTitleNode, this.monitorLabelNode, this.timerPlateNode, this.gameTimerNode,
      this.monitorSurfaceNode, this.monitorProcessLabelNode, this.monitorEntryLabelNode, this.conveyorTrackNode,
      this.node.getChildByName('DeskBand'), this.charNode, this.lowerHudNode].forEach((node) => {
      if (node) node.active = playing;
    });
    this.deskItemNodes.forEach((node) => { if (node?.isValid) node.active = playing; });
    if (this.deskDecorNode) this.deskDecorNode.active = false;
    this.layoutPauseButton(hudY, pillH);

    if (!this.pressureAtmosphereNode) {
      this.pressureAtmosphereNode = new Node('PressureAtmosphere');
      this.pressureAtmosphereNode.layer = LAYER_2D;
      this.pressureAtmosphereNode.parent = this.node;
      this.pressureAtmosphereView = new PressureAtmosphereView(this.pressureAtmosphereNode);
    }
    this.pressureAtmosphereView?.layout(visSize.width, visSize.height);
    this.pressureAtmosphereNode.setSiblingIndex(this.node.children.length - 1);
    this.pressureAtmosphereNode.active = playing;
    this.updateAmbientPresentation(0);
  }

  private layoutPauseButton(hudY: number, referenceHeight: number): void {
    if (!this.pauseButtonNode) {
      const node = new Node('PauseButton');
      node.layer = 1 << 25;
      node.parent = this.node;
      node.addComponent(UITransform);
      node.addComponent(Graphics);
      node.on(Node.EventType.TOUCH_START, () => node.setScale(0.94, 0.94, 1));
      node.on(Node.EventType.TOUCH_CANCEL, () => node.setScale(1, 1, 1));
      node.on(Node.EventType.TOUCH_END, () => {
        node.setScale(1, 1, 1);
        this.sensory.unlock();
        this.sensory.play('press');
        this.setPaused(true);
      });
      this.pauseButtonNode = node;
    }
    const node = this.pauseButtonNode;
    const size = Math.min(52, Math.max(44, referenceHeight * 0.78));
    node.getComponent(UITransform)!.setContentSize(size + 10, size + 10);
    node.setPosition(0, hudY, 0);
    node.setSiblingIndex(this.node.children.length - 1);
    node.active = this.uiState === 'playing' && !this.paused;
    const g = node.getComponent(Graphics)!;
    g.clear();
    g.fillColor = new Color(54, 48, 42, 30);
    g.circle(2, -4, size / 2);
    g.fill();
    g.fillColor = new Color(255, 252, 246, 252);
    g.strokeColor = new Color(211, 196, 177, 235);
    g.lineWidth = 1.5;
    g.circle(0, 0, size / 2);
    g.fill(); g.stroke();
    g.fillColor = UiTokens.color.inkDeep;
    const barW = Math.max(3.5, size * 0.09);
    const barH = size * 0.34;
    const gap = size * 0.10;
    g.roundRect(-gap - barW, -barH / 2, barW, barH, barW / 2);
    g.roundRect(gap, -barH / 2, barW, barH, barW / 2);
    g.fill();
  }

  /** 角色微动和常驻边缘氛围只读取快照，不参与任何玩法判定。 */
  private updateAmbientPresentation(dt: number): void {
    if (!this.game) return;
    const snap = this.game.getSnapshot();
    const remainingSec = Math.max(0, snap.duration - snap.elapsed);
    this.characterRigView?.update(dt, {
      zone: snap.zone,
      phase: snap.phase,
      combo: snap.combo,
      frozen: snap.frozen,
    });
    this.pressureAtmosphereView?.update(dt, {
      zone: snap.zone,
      phase: snap.phase,
      remainingSec,
      nextBossInSec: snap.nextBossInSec,
      bossActive: snap.bossActive,
      lastChanceImminent: snap.lastChanceImminent,
      playing: this.uiState === 'playing' && !this.game.over && !this.paused,
    });
  }

  /** 认可度仪表：尺寸与状态由 ApprovalGaugeView 统一管理。 */
  private layoutLowerHud(viewWidth: number, viewHeight: number): void {
    if (!this.lowerHudNode) {
      const node = new Node('LowerHud');
      node.layer = 1 << 25;
      node.parent = this.node;
      node.addComponent(UITransform);
      node.addComponent(Graphics);
      this.lowerHudNode = node;
      this.approvalGaugeView = new ApprovalGaugeView(node);
    }

    const hudLayout = UiTokens.layout.lowerHud;
    const btnY = this.propButtons?.position.y ?? -viewHeight / 2 + hudLayout.buttonFallbackY;
    const btnH = this.propButtonNodes[0]?.getComponent(UITransform)?.height
      ?? Math.min(hudLayout.maxButtonFallbackHeight, Math.max(hudLayout.minButtonFallbackHeight, viewHeight * hudLayout.buttonFallbackHeightRatio));
    const panelW = Math.min(viewWidth * hudLayout.panelWidthRatio, hudLayout.maxPanelWidth);
    const panelH = Math.min(hudLayout.maxPanelHeight, Math.max(hudLayout.minPanelHeight, viewHeight * hudLayout.panelHeightRatio));
    const panelY = btnY + btnH / 2 + panelH / 2 + Math.max(hudLayout.minGap, viewHeight * hudLayout.gapRatio);

    const node = this.lowerHudNode;
    node.setSiblingIndex(this.node.children.length - 1);
    node.getComponent(UITransform)!.setContentSize(panelW, panelH);
    node.setPosition(0, panelY, 0);
    this.approvalGaugeView?.layout(panelW, panelH);
    node.active = this.uiState === 'playing';
  }

  private updateLowerHud(
    approval: number,
    zone: string,
    remainingSec = 0,
    huntProgress = 0,
    huntThreshold = 18,
    huntHoldSec = 2,
  ): void {
    const elapsed = this.game?.getSnapshot().elapsed ?? 0;
    const hint = elapsed <= this.eventTextUntilSec ? this.lastEventText : '';
    const objective = this.objectiveHudText();
    this.approvalGaugeView?.update(
      approval,
      zone,
      hint,
      elapsed,
      remainingSec,
      huntProgress,
      huntThreshold,
      huntHoldSec,
      objective,
    );
  }

  private objectiveHudText(): string {
    const objective = this.game?.getObjectiveSnapshot();
    if (!objective) return '';
    if (objective.mode === 'hunt') {
      const pct = objective.target > 0 ? Math.round(objective.current / objective.target * 100) : 0;
      return `反杀锁定 ${Math.min(100, pct)}%${objective.complete ? ' ✓' : ''}`;
    }
    if (objective.mode === 'guard') {
      const name = objective.kind === 'boss-safe' ? '临检生效' : '失误';
      return `${name} ${Math.round(objective.current)} 次 · 保持 0${objective.complete ? ' ✓' : ''}`;
    }
    const name = objective.kind === 'effective-hits' ? '有效命中'
      : objective.kind === 'perfect' ? 'Perfect'
        : objective.kind === 'combo' ? '最高连击'
          : objective.prop ? this.propDisplayName(objective.prop) : '目标';
    return `${name} ${Math.min(objective.target, Math.round(objective.current))}/${objective.target}${objective.complete ? ' ✓' : ''}`;
  }

  /** 把 Belt 下的 6 个卡槽横向等距重新排布到指定区域内（居中）。 */
  private layoutBeltSlots(totalW: number, slotH: number): void {
    if (!this.beltNode || this.slotNodes.length === 0) return;
    const n = this.slotNodes.length;
    const sideInset = Math.max(8, Math.min(14, totalW * 0.02));
    const usableW = totalW - sideInset * 2;

    // 卡片要保持“可读的大卡”质感，但槽位不能再把 6 张硬塞进同一行。
    // 这里用固定正间距队列：中心区域稳定露出约 3–4 张，更多卡片自然从右侧进入，交给 belt mask 裁切。
    const maxCardW = Math.max(72, (usableW - 16 * 2) / 3.35);
    const slotW = Math.min(slotH * 1.02, maxCardW);
    const gap = Math.max(18, Math.min(30, slotW * 0.22));
    const stride = slotW + gap;
    const visibleSlots = Math.min(n, 4);
    const visibleSpan = (visibleSlots - 1) * stride;
    const startX = -visibleSpan / 2;

    const cardH = Math.min(slotH * 0.88, slotW * 0.84);
    const cardY = Math.max(slotH * 0.15, 14);
    this.slotNodes.forEach((slot: Node, i: number) => {
      let ut = slot.getComponent(UITransform);
      if (!ut) ut = slot.addComponent(UITransform);
      ut.setContentSize(slotW, cardH);
      TaskCardView.layout(slot, slotW, cardH);
      const label = slot.getComponent(Label);
      if (label) {
        label.fontSize = Math.min(22, slotW * 0.21);
        label.lineHeight = Math.min(28, slotH * 0.24);
        label.overflow = Label.Overflow.SHRINK;
      }
      slot.setPosition(startX + i * stride, cardY, 0);

      const bg = this.slotBackgrounds[i];
      if (bg) {
        const bgUt = bg.getComponent(UITransform);
        if (bgUt) bgUt.setContentSize(slotW, cardH);
        bg.setPosition(0, 0, 0);
      }
    });
    this.fx?.refreshSlotBases();
    this.relayoutCardVisuals();
  }

  /** 统一 HUD 标签的命中盒、字号和位置。 */
  private layoutHudLabel(label: Label | null, x: number, y: number, w: number, h: number, fontSize: number): void {
    if (!label) return;
    const ut = label.node.getComponent(UITransform);
    if (ut) ut.setContentSize(w, h);
    label.fontSize = fontSize;
    label.lineHeight = fontSize + 6;
    label.overflow = Label.Overflow.SHRINK;
    label.node.setPosition(x, y, 0);
  }

  /** 底部独立操作区：4 个按钮固定贴屏幕最底部（标准手游拇指热区），并为微信 home indicator 留足安全距离。
   *  按钮高度加高一档以容纳大纸团。 */
  private layoutPropButtons(viewWidth: number, viewHeight: number): void {
    if (!this.propButtons || this.propButtonNodes.length === 0) return;
    const propLayout = UiTokens.layout.props;
    const safe = sys.getSafeAreaRect(false);
    const safeBottomY = safe.y - viewHeight / 2;
    const horizontalPadding = Math.max(propLayout.minHorizontalPadding, viewWidth * propLayout.horizontalPaddingRatio);
    const gap = Math.max(propLayout.minGap, viewWidth * propLayout.gapRatio);
    const totalW = Math.min(viewWidth - horizontalPadding * 2, propLayout.maxTotalWidth);
    const btnW = Math.min((totalW - gap * (this.propButtonNodes.length - 1)) / this.propButtonNodes.length, propLayout.maxButtonWidth);
    const usedW = btnW * this.propButtonNodes.length + gap * (this.propButtonNodes.length - 1);
    const btnH = Math.min(propLayout.maxButtonHeight, Math.max(propLayout.minButtonHeight, btnW * propLayout.buttonHeightRatio));
    const startX = -usedW / 2 + btnW / 2;
    const y = safeBottomY + btnH / 2 + Math.max(propLayout.minBottomSafe, viewHeight * propLayout.bottomSafeRatio);
    this.propButtons.setPosition(0, y, 0);

    this.ensurePropButtonBackgrounds();
    this.propButtonNodes.forEach((btn: Node, i: number) => {
      const x = startX + i * (btnW + gap);
      btn.active = true;
      const buttonOpacity = btn.getComponent(UIOpacity) ?? btn.addComponent(UIOpacity);
      buttonOpacity.opacity = 255;
      let ut = btn.getComponent(UITransform);
      if (!ut) ut = btn.addComponent(UITransform);
      ut.setContentSize(btnW, btnH);
      btn.setPosition(x, 0, 0);
      const label = btn.getComponent(Label);
      if (label) {
        label.fontSize = Math.min(18, Math.max(13, btnW * 0.14));
        label.lineHeight = label.fontSize + 4;
        label.overflow = Label.Overflow.SHRINK;
      }
      const actionLabel = this.propActionLabels[i];
      if (actionLabel) {
        actionLabel.string = GameRunner.PROP_ACTION_LABELS[i] ?? '';
        actionLabel.fontSize = Math.min(20, Math.max(14, btnW * 0.15));
        actionLabel.lineHeight = actionLabel.fontSize + 4;
        actionLabel.color = GameRunner.START_TEXT;
        actionLabel.node.getComponent(UITransform)!.setContentSize(btnW - 16, 30);
        actionLabel.node.setPosition(0, -btnH * 0.27, 0);
      }

      const bg = this.propButtonBackgrounds[i];
      if (bg) {
        bg.active = true;
        const bgOpacity = bg.getComponent(UIOpacity) ?? bg.addComponent(UIOpacity);
        bgOpacity.opacity = 255;
        bg.getComponent(UITransform)!.setContentSize(btnW, btnH);
        bg.setPosition(x, 0, 0);
      }
      this.propButtonViews[i]?.layout(x, btnW, btnH);
    });
  }

  /** 背景是按钮的兄弟节点并排在按钮之前，保证不会遮住 Label，也不会污染按钮��件列表。 */
  private ensurePropButtonBackgrounds(): void {
    if (!this.propButtons || this.propButtonBackgrounds.length > 0) return;
    this.propButtonNodes.forEach((_, i: number) => {
      const bg = new Node(`PropBg${i}`);
      bg.layer = 1 << 25;
      bg.addComponent(UITransform);
      bg.addComponent(Graphics);
      const asset = new Node('PropBgAsset');
      asset.layer = 1 << 25;
      asset.parent = bg;
      asset.addComponent(UITransform);
      const sprite = asset.addComponent(Sprite);
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      this.propButtons!.addChild(bg);
      bg.setSiblingIndex(i);
      this.propButtonBackgrounds.push(bg);
      const icon = this.propIconSprites[i];
      const actionLabel = this.propActionLabels[i];
      if (icon && actionLabel) this.propButtonViews[i] = new PropButtonView(this.propButtonNodes[i], bg, icon, actionLabel);
    });
  }

  /** §3.1 类别色（与 cards.json 的 color 字段对应，数据驱动配色铁律在视觉层落地）→ Cocos Color。 */
  private categoryColor(cat: Card['category']): Color {
    switch (getCardDef(cat).color) {
      case 'orange': return new Color(255, 160, 60); // 汇报
      case 'purple': return new Color(160, 86, 224); // 关键
      case 'cyan': return new Color(58, 186, 202); // 提案
      case 'amber': return new Color(244, 172, 32); // 紧急（全场最高威胁，暖色但不撞"返工红"）
      case 'gray': return new Color(120, 120, 120); // 摸鱼
      case 'black': return new Color(82, 78, 72); // Boss
      default: return new Color(68, 150, 236); // blue / 常规
    }
  }
}

/**
 * 平台存档适配：微信小游戏 wx 优先，浏览器 localStorage 兜底，都没有则不持久化。
 * 只存纯数据字段（daysEmployed 是 getter，由 core/Session.hydrateProfile 在读档时重建）。
 */
class CocosStorage implements Storage {
  private readonly KEY = 'braatn_profile_v1';

  loadProfile(): PlayerProfile | null {
    const raw = this.read();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PlayerProfile;
    } catch {
      return null;
    }
  }

  saveProfile(p: PlayerProfile): void {
    const data = JSON.stringify({
      highestUnlockedLevel: p.highestUnlockedLevel,
      huntWinCount: p.huntWinCount,
      star3Levels: p.star3Levels,
      bestStars: p.bestStars,
      achievements: p.achievements,
      cosmetics: p.cosmetics,
      dailyRecords: p.dailyRecords,
    });
    this.write(data);
  }

  private read(): string | null {
    const w = (globalThis as { wx?: { getStorageSync?: (k: string) => unknown } }).wx;
    if (w?.getStorageSync) {
      try {
        const v = w.getStorageSync(this.KEY);
        return v && typeof v === 'string' ? v : null;
      } catch {
        /* fall through */
      }
    }
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (ls) {
      try {
        return ls.getItem(this.KEY);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  private write(data: string): void {
    const w = (globalThis as { wx?: { setStorageSync?: (k: string, v: string) => void } }).wx;
    if (w?.setStorageSync) {
      try {
        w.setStorageSync(this.KEY, data);
        return;
      } catch {
        /* fall through */
      }
    }
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (ls) {
      try {
        ls.setItem(this.KEY, data);
      } catch {
        /* ignore */
      }
    }
  }
}

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
