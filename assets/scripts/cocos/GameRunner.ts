import { _decorator, Component, Node, Label, Color, UITransform, UIOpacity, tween, Tween, Vec3, input, Input, EventKeyboard, EventTouch, EventMouse, Sprite, SpriteFrame, resources, Texture2D, view, Graphics, sys, Mask, instantiate, profiler } from 'cc';
import { Game } from '../core/Game';
import { getLevel, BalanceConfig, getCardDef } from '../core/config';
import { SeededRng } from '../core/rng';
import { Session } from '../core/Session';
import type { Storage } from '../core/Session';
import { buildReportText } from '../core/profile';
import type { PlayerProfile } from '../core/profile';
import { CardState as CS, PropType as PT } from '../core/types';
import type { Card, PropType } from '../core/types';
import { FxLayer } from './FxLayer';
import { ApprovalGaugeView } from './ui/ApprovalGaugeView';
import { PropButtonView } from './ui/PropButtonView';
import { TaskCardView } from './ui/TaskCardView';
import { UiPainter, type CardShellState, type KeycapState } from './ui/UiPainter';
import { UiTokens } from './ui/UiTokens';

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
  guideDots: number;
  guideDotRadius: number;
}

type PaperOutcome = 'hit' | 'miss' | 'invalid';

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
  private charNode: Node | null = null;
  /** 动态创建的游戏标题和倒计时（不依赖场景绑定节点） */
  private gameTitleNode: Node | null = null;
  private gameTimerNode: Node | null = null;
  /** 显示器外的顶部/底部 HUD。保持显示器背景与内屏节点不被重绘。 */
  private subtitleNode: Node | null = null;
  private lowerHudNode: Node | null = null;
  /** 方案 3 的实体控制台底座与计时器铭牌。 */
  private actionDockNode: Node | null = null;
  private timerPlateNode: Node | null = null;
  private monitorLabelNode: Node | null = null;
  private monitorProcessLabelNode: Node | null = null;
  private monitorEntryLabelNode: Node | null = null;
  private resultScrimNode: Node | null = null;
  /** 蓄力时吸附到目标卡槽的光圈，和虚线弹道一起构成完整预判。 */
  private aimTargetNode: Node | null = null;

  private session!: Session;
  private game!: Game;
  private readonly dt = 0.05; // 逻辑固定步进
  private accumulator = 0;
  private slotNodes: Node[] = [];
  /** 每个卡槽的 Graphics 背景节点（代码画圆角矩形底）。创建/定位见 ensureSlotBackgrounds / layoutBeltSlots。 */
  private slotBackgrounds: Node[] = [];
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
  private aimingSlot = 0;
  private aimStart = new Vec3();
  private aimPoint = new Vec3();
  private paperAimNode: Node | null = null;
  private aimGuideNode: Node | null = null;
  private scanPos = 0;
  private reported = false; // 本局是否已结算展示（防止重复 finishLevel）
  private uiState: 'select' | 'playing' | 'result' = 'select';
  private levelSelectRoot: Node | null = null;
  private tutorialRoot: Node | null = null;
  private tutorialStep = 0;
  private tutorialDone = false;
  private fx: FxLayer | null = null;
  private eventUnsubs: Array<() => void> = [];
  private lastEventText = '';
  private compactHeader = false;

  private static readonly PROP_LABELS = ['白纸团', '紫纸团', '咖啡团', '粉便签'];
  private static readonly PROP_ACTION_LABELS = ['加需求', '改需求', '甩锅', '拍马屁'];
  private static readonly PROP_TYPES: PropType[] = [PT.AddDemand, PT.ChangeDemand, PT.ThrowPot, PT.KissUp];

  /** 道具按钮主色：收敛到 胡桃木/琥珀 暖色家族，甩锅保留警示红族。
   *  功能区分靠图标 + 键帽底部细色带，不再整面换高饱和糖果色。 */
  private static readonly PROP_COLORS: ReadonlyArray<Readonly<Color>> = [
    new Color(168, 124, 88),   // 加需求：胡桃木
    new Color(196, 152, 64),   // 改需求：琥珀
    new Color(198, 92, 70),    // 甩锅：暖警示红（与危险红同族、低饱和）
    new Color(168, 124, 88),   // 拍马屁：胡桃木（粉便签图标已承担识别）
  ];
  /** 道具 key → artSprites 索引名（与 props/ 目录文件名约定一致）。 */
  private static readonly PROP_ART_KEYS = ['prop-add-demand', 'prop-change-demand', 'prop-throw-pot', 'prop-kiss-up'];
  /** 纸团飞行手感参数：表现层先集中调，手感稳定后再沉到 JSON。 */
  private static readonly PAPER_TUNING: Readonly<Record<PropType, PaperTuning>> = {
    [PT.AddDemand]: {
      arcHeight: 125,
      duration: 0.30,
      spin: 380,
      startScale: new Vec3(1, 1, 1),
      midScale: new Vec3(0.92, 1.08, 1),
      endScale: new Vec3(0.72, 0.72, 1),
      guideDots: 8,
      guideDotRadius: 3.2,
    },
    [PT.ChangeDemand]: {
      arcHeight: 175,
      duration: 0.38,
      spin: 520,
      startScale: new Vec3(1.03, 0.97, 1),
      midScale: new Vec3(0.84, 1.16, 1),
      endScale: new Vec3(0.66, 0.66, 1),
      guideDots: 9,
      guideDotRadius: 3,
    },
    [PT.ThrowPot]: {
      arcHeight: 72,
      duration: 0.24,
      spin: 240,
      startScale: new Vec3(1.08, 1.08, 1),
      midScale: new Vec3(1.08, 0.92, 1),
      endScale: new Vec3(0.82, 0.82, 1),
      guideDots: 7,
      guideDotRadius: 3.8,
    },
    [PT.KissUp]: {
      arcHeight: 96,
      duration: 0.34,
      spin: -420,
      startScale: new Vec3(0.96, 0.96, 1),
      midScale: new Vec3(0.86, 1.12, 1),
      endScale: new Vec3(0.42, 0.42, 1),
      guideDots: 8,
      guideDotRadius: 3.1,
    },
  };
  /** 任务队列使用专用图标卡，不再回退成英文类别文字。 */
  private static readonly CARD_ART_KEYS: Record<string, string> = {
    routine: 'task-normal-doc',
    report: 'task-report-stamp',
    key: 'task-key-tag',
    proposal: 'task-key-tag',
    urgent: 'task-urgent-memo',
    meeting: 'card-coffee',
    document: 'task-normal-doc',
    boss: 'card-boss-audit',
  };
  /** 卡片角标切片：底板统一，类别色只来自这层资产。 */
  private static readonly CARD_ACCENT_ART_KEYS: Record<string, string> = {
    routine: 'task-card-accent-normal',
    report: 'task-card-accent-report',
    key: 'task-card-accent-key',
    proposal: 'task-card-accent-proposal',
    urgent: 'task-card-accent-urgent',
    meeting: 'task-card-accent-idle',
    document: 'task-card-accent-normal',
    boss: 'task-card-accent-boss',
  };
  /** 空槽也显示即将到来的任务预览，避免队列退化成一排 "---"。 */
  private static readonly QUEUE_PREVIEW_ART_KEYS = ['card-doc-blue-a', 'card-doc-stack', 'card-target', 'card-idea', 'card-alarm', 'card-coffee'];
  private static readonly QUEUE_PREVIEW_COLORS: ReadonlyArray<Readonly<Color>> = [
    new Color(68, 150, 236), new Color(134, 132, 126), new Color(160, 86, 224),
    new Color(58, 186, 202), new Color(244, 172, 32), new Color(112, 111, 106),
  ];

  /** 卡牌 Graphics 背景样式常量。卡牌 = 代码画圆角矩形底 + 纯图标 Sprite（见美术指南「卡牌/按钮=代码画底+纯图标」）。 */
  private static readonly CARD_BORDER_COLORS: Readonly<Record<string, Readonly<Color>>> = Object.freeze({
    routine:  new Color(68, 150, 236),   // 蓝：目标图蓝，但降低荧光
    report:   new Color(246, 142, 44),   // 橙：更暖、更厚实
    key:      new Color(160, 86, 224),   // 紫：少一点霓虹感
    proposal: new Color(58, 186, 202),   // 青：偏蓝绿，和暖底更融
    urgent:   new Color(244, 172, 32),   // 琥珀：保留威胁感
    meeting:  new Color(112, 111, 106),  // 灰：暖灰
    document: new Color(112, 111, 106),  // 灰：暖灰
    boss:     new Color(82, 78, 72),     // Boss：暖深灰，不用脏黑
  });
  private static readonly CARD_FILL_COLOR = new Color(245, 240, 232, 255); // 米色 #F5F0E8
  private static readonly CARD_BORDER_WIDTH = 4;
  private static readonly CARD_CORNER_RADIUS = 16;
  /** Rework 返工卡底色（红底覆盖） */
  private static readonly COLOR_REWORK = new Color(220, 76, 76, 255);
  /** Inserted 杂活卡底色（灰底斜纹覆盖） */
  private static readonly COLOR_INSERTED = new Color(160, 160, 160, 255);
  /** Idle 摸鱼卡底色（压暗原色） */
  private static readonly CARD_IDLE_DIM = 0.45;
  /** ActiveWhite 边框亮度（正常色），非活跃状态压暗系数 */
  private static readonly CARD_STROKE_DIM = 0.55;

  /** 环境色（视觉规范§1.5，非功能区氛围底色）。 */
  private static readonly ENV_PANEL = new Color(250, 245, 235, 240);  // 面板底色 #FAF5EB
  private static readonly ENV_WALL = new Color(235, 225, 210, 255);   // 墙面色 #EBE1D2
  private static readonly ENV_DARK = new Color(60, 58, 55, 255);      // 显示器外壳 #3C3A37

  /** “精密桌面玩具”主题令牌：环境克制，功能色爆发。 */
  private static readonly UI_IVORY = new Color(244, 235, 221, 255);
  private static readonly UI_PAPER = new Color(255, 250, 241, 255);
  private static readonly UI_INK = new Color(76, 67, 58, 255);
  private static readonly UI_MUTED = new Color(126, 114, 99, 255);
  private static readonly UI_WALNUT = new Color(168, 124, 88, 255);
  private static readonly UI_DANGER = new Color(220, 60, 60, 255);

  onLoad(): void {
    this.hideDebugOverlays();
    this.session = new Session(new CocosStorage());
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
    this.node.on(Node.EventType.TOUCH_MOVE, this.onGlobalTouchMove, this);
    this.node.on(Node.EventType.TOUCH_END, this.onGlobalTouchEnd, this);
    this.node.on(Node.EventType.TOUCH_CANCEL, this.onGlobalTouchCancel, this);
    this.node.on(Node.EventType.MOUSE_MOVE, this.onGlobalMouseMove, this);
    this.node.on(Node.EventType.MOUSE_UP, this.onGlobalMouseUp, this);

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
      return;
    }
    let remaining = infos.length;
    for (const info of infos) {
      resources.load(info.path, Texture2D, (err: Error | null, tex: Texture2D) => {
        remaining--;
        if (err || !tex) {
          // eslint-disable-next-line no-console
          console.warn(`[GameRunner] 加载失败: ${info.path}`, err?.message);
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
    this.node.off(Node.EventType.TOUCH_MOVE, this.onGlobalTouchMove, this);
    this.node.off(Node.EventType.TOUCH_END, this.onGlobalTouchEnd, this);
    this.node.off(Node.EventType.TOUCH_CANCEL, this.onGlobalTouchCancel, this);
    this.node.off(Node.EventType.MOUSE_MOVE, this.onGlobalMouseMove, this);
    this.node.off(Node.EventType.MOUSE_UP, this.onGlobalMouseUp, this);
    this.fx?.dispose();
    this.resetCardVisuals();
    this.clearPaperAim(true);
    this.clearEventFeed();
    this.hideTutorial();
  }

  /** 键盘操控：1/2/3 蓄力(松手释放)、4 拍马屁、R 重试、N 下一关、B/Escape 返回选关。 */
  private onKeyDown(e: EventKeyboard): void {
    // 开始页：Enter/Space/1 开始第一关
    if (this.uiState === 'select') {
      if (e.keyCode === 13 || e.keyCode === 32 || e.keyCode === 49) this.onLevelSelected(0);
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
    // 游玩中：B/Escape 返回选关
    if (e.keyCode === 66 || e.keyCode === 27) { this.onBackToSelect(); return; }
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
    if (this.uiState !== 'playing') return;
    switch (e.keyCode) {
      case 49: this.game.release(PT.AddDemand); break; // '1'
      case 50: this.game.release(PT.ChangeDemand); break; // '2'
      case 51: this.game.release(PT.ThrowPot); break; // '3'
    }
  }

  /* ---------- 关卡流 ---------- */

  /** 用 Session 当前关开新一局。 */
  private startGame(): void {
    this.resetCardVisuals();
    this.clearPaperAim(true);
    const idx = this.session.currentIndex;
    const seed = (Date.now() % 100000) ^ ((idx + 1) * 2654435761); // 每关/每次尝试不同
    this.game = new Game(getLevel(idx), new SeededRng(seed >>> 0), this.session.allowedPropsFor(idx));
    this.accumulator = 0;
    this.scanPos = 0;
    this.reported = false;
    this.uiState = 'playing';
    this.lastEventText = '长按纸团，拖向任务卡';
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
    );
    this.bindEventFeed();
    this.beginTutorialIfNeeded();
  }

  /** 命中/认可度/Boss 等即时反馈全部由 FxLayer 飘字承担；
   *  HUD 提示行只保留教学引导文案，命中后清空，避免变成第二个控制台。 */
  private bindEventFeed(): void {
    this.clearEventFeed();
    this.eventUnsubs.push(
      this.game.bus.on('CardHit', () => {
        this.setEventText('');
        this.completeTutorial();
      }),
    );
  }

  private clearEventFeed(): void {
    this.eventUnsubs.forEach((off) => off());
    this.eventUnsubs = [];
  }

  private setEventText(text: string): void {
    this.lastEventText = text.replace(/^事件\s*[·:：]\s*/, '');
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
    this.showTutorial('长按一个纸团');
  }

  private advanceTutorial(step: number, text: string): void {
    if (!this.shouldShowTutorial() || step <= this.tutorialStep) return;
    this.tutorialStep = step;
    this.showTutorial(text);
    this.setEventText(text);
  }

  private completeTutorial(): void {
    if (!this.shouldShowTutorial()) return;
    this.tutorialDone = true;
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
    // 教学直接复用事件条，避免浮层压住认可度刻度与当前值。
    this.setEventText(`教学 · ${text}`);
    const vis = view.getVisibleSize();
    const w = Math.min(vis.width * 0.68, 420);
    const h = 40;
    const root = this.tutorialRoot;
    root.getComponent(UITransform)!.setContentSize(w, h);
    const g = root.getComponent(Graphics)!;
    g.clear();
    g.fillColor = new Color(35, 32, 28, 230);
    g.strokeColor = new Color(255, 236, 160, 255);
    g.lineWidth = 2;
    g.roundRect(-w / 2, -h / 2, w, h, 14);
    g.fill(); g.stroke();
    const label = root.getChildByName('TutorialText')?.getComponent(Label);
    if (label) {
      label.string = text;
      label.fontSize = 18;
      label.lineHeight = 24;
      label.color = new Color(255, 246, 220, 255);
      label.node.getComponent(UITransform)!.setContentSize(w - 24, h - 6);
    }
    this.layoutTutorialHint();
    root.active = false;
    root.setSiblingIndex(this.node.children.length - 1);
  }

  private layoutTutorialHint(): void {
    if (!this.tutorialRoot?.isValid) return;
    const vis = view.getVisibleSize();
    const propY = this.propButtons?.position.y ?? -vis.height / 2 + 180;
    this.tutorialRoot.setPosition(0, propY + Math.max(92, vis.height * 0.09), 0);
  }

  private onNext(): void {
    if (this.session.startNext()) this.startGame();
  }
  private onRetry(): void {
    this.startGame();
  }
  private onBackToSelect(): void {
    this.showLevelSelect();
  }
  /** §2.1 复活：仅 lose 且本关未用过复活时有效。成功后回到 playing 继续本关（core 已回滚认可度到69/+8s/清Boss）。 */
  private onRevive(): void {
    if (!this.game.over || this.game.result !== 'lose') return;
    if (!this.game.revive()) return; // 每关限1次，core 内部再兜一次
    this.reported = false;
    this.uiState = 'playing';
    this.hideReport();
  }

  /* ---------- 开始页 ---------- */

  /** 显示开始页：隐藏游戏 UI，创建/显示开局覆盖层。 */
  private showLevelSelect(): void {
    this.hideDebugOverlays();
    this.uiState = 'select';
    this.setGameUIVisible(false);
    this.hideReport();
    this.hideTutorial();
    if (!this.levelSelectRoot) {
      this.levelSelectRoot = this.createLevelSelectUI();
    }
    this.levelSelectRoot.active = true;
    this.updateLevelSelectContent();
  }

  private hideLevelSelect(): void {
    if (this.levelSelectRoot) this.levelSelectRoot.active = false;
  }

  private hideDebugOverlays(): void {
    try {
      profiler.hideStats();
    } catch {
      /* profiler 在部分运行环境可能不存在，忽略即可 */
    }
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

  /** 动态创建开始页覆盖层 —— 方案 3：精密桌面玩具式入口。 */
  private createLevelSelectUI(): Node {
    const root = new Node('LevelSelectUI');
    root.layer = 33554432; // UI_2D
    root.addComponent(UITransform).setContentSize(view.getVisibleSize().width, view.getVisibleSize().height);
    const bg = root.addComponent(Graphics);
    this.paintFullScreenStartBg(bg);
    this.node.addChild(root);

    const vis = view.getVisibleSize();
    const posterW = Math.min(vis.width * 0.88, 650);
    const posterH = Math.min(vis.height * 0.56, 610);
    const posterCY = vis.height * 0.055;

    // ── 顶部铭牌：把题材说清楚，但不抢主标题 ──
    this.paintStartAlertBar(root, posterW, posterH, posterCY);

    // ── 主标题：单一强焦点，不再做倾斜海报 ──
    const titleNode = new Node('StartTitle');
    titleNode.layer = 33554432;
    titleNode.parent = root;
    titleNode.setPosition(0, posterCY + posterH * 0.18, 0);
    const titleUt = titleNode.addComponent(UITransform);
    titleUt.setContentSize(posterW * 0.84, 120);
    const titleLabel = titleNode.addComponent(Label);
    titleLabel.string = '别让AI替代你';
    titleLabel.fontFamily = 'PingFang SC';
    titleLabel.fontSize = 42;
    titleLabel.lineHeight = 52;
    titleLabel.horizontalAlign = 1; // CENTER
    titleLabel.verticalAlign = 1;
    titleLabel.color = new Color(28, 22, 18, 255);
    titleLabel.isBold = true;
    titleLabel.overflow = Label.Overflow.NONE;

    // ── 玩法承诺：一眼讲清“扔回去” ──
    const crisis = this.mkLabel(root, 'CrisisText', 0, posterCY + posterH * 0.02,
      '长按纸团 · 对准卡片 · 把麻烦扔回去', 18, posterW * 0.82, 42);
    this.styleStartLabel(crisis, GameRunner.UI_MUTED, false);

    // ── 唯一 CTA：继续最高已解锁关，避免老玩家每次回到第 1 关 ──
    this.makeStartButton(root, 0, posterCY - posterH * 0.22, Math.min(posterW * 0.62, 360), 74,
      `继续第${this.session.profile.highestUnlockedLevel + 1}关`, () => this.onLevelSelected(this.session.profile.highestUnlockedLevel));

    // ── 底部进度：轻量一行 ──
    const rank = this.mkLabel(root, 'RankInfo', 0, posterCY - posterH * 0.39, '', 16, posterW * 0.76, 30);
    this.styleStartLabel(rank, GameRunner.UI_MUTED, false);

    // ── 装饰涂鸦 ──
    this.makeStartDoodles(root, vis, posterW, posterCY);

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
        const day = this.session.daysEmployed;
        label.string = `已到第${this.session.profile.highestUnlockedLevel + 1}关 · 坚守第${day}天`;
        label.color = GameRunner.UI_MUTED;
        label.isBold = false;
      }
    }
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
    if (this.charNode) this.charNode.active = v;
    if (this.subtitleNode) this.subtitleNode.active = v;
    if (this.lowerHudNode) this.lowerHudNode.active = v;
    if (this.actionDockNode) this.actionDockNode.active = v;
    if (this.timerPlateNode) this.timerPlateNode.active = v;
    if (this.monitorLabelNode) this.monitorLabelNode.active = v;
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
    const posterW = Math.min(vis.width * 0.88, 650);
    const posterH = Math.min(vis.height * 0.56, 610);
    const posterX = -posterW / 2;
    const posterCY = vis.height * 0.055;
    const posterY = posterCY - posterH / 2;
    g.clear();

    // 暖象牙墙面
    g.fillColor = GameRunner.UI_IVORY;
    g.rect(-vis.width / 2, -vis.height / 2, vis.width, vis.height);
    g.fill();

    // 极轻纸纹：只给环境，不污染功能区
    g.strokeColor = new Color(205, 189, 166, 42);
    g.lineWidth = 1;
    for (let y = -vis.height / 2 + 28; y < vis.height / 2; y += 34) {
      g.moveTo(-vis.width / 2 + 20, y);
      g.lineTo(vis.width / 2 - 20, y + 2);
      g.stroke();
    }

    // 入口页不再露出桌面色块；保持完整暖墙背景，避免下半屏断层。

    // 入口页改成同主界面一套“显示器/桌面玩具”材质，而不是网页表单卡片。
    g.fillColor = new Color(44, 39, 34, 92);
    g.roundRect(posterX + 6, posterY - 10, posterW, posterH, 28);
    g.fill();
    g.fillColor = new Color(44, 42, 38, 255);
    g.strokeColor = new Color(24, 23, 21, 230);
    g.lineWidth = 4;
    g.roundRect(posterX, posterY, posterW, posterH, 28);
    g.fill();
    g.stroke();

    const headerH = 46;
    g.fillColor = new Color(82, 78, 70, 255);
    g.roundRect(posterX + 8, posterY + posterH - headerH - 8, posterW - 16, headerH, 18);
    g.fill();
    g.fillColor = GameRunner.UI_PAPER;
    g.roundRect(posterX + 8, posterY + 8, posterW - 16, posterH - headerH - 16, 18);
    g.fill();
    g.strokeColor = new Color(255, 255, 255, 118);
    g.lineWidth = 2;
    g.moveTo(posterX + 30, posterY + posterH - 20);
    g.lineTo(posterX + posterW - 30, posterY + posterH - 20);
    g.stroke();
  }

  /** 在主面板顶部画深炭色产品铭牌。 */
  private paintStartAlertBar(parent: Node, posterW: number, _posterH: unknown, posterCY: number): void {
    const node = new Node('StartAlertBar');
    node.layer = 33554432;
    node.parent = parent;
    const barW = posterW * 0.48;
    const barH = 32;
    const barY = posterCY + Math.min(view.getVisibleSize().height * 0.56, 610) * 0.43;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(barW, barH);
    node.setPosition(0, barY, 0);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(49, 46, 41, 255);
    g.strokeColor = new Color(255, 255, 255, 70);
    g.lineWidth = 2;
    g.roundRect(-barW / 2, -barH / 2, barW, barH, 12);
    g.fill();
    g.stroke();
    const labelNode = this.mkLabel(node, 'AlertText', 0, 0, 'AI显示器 · 生存实验', 15, barW - 24, barH - 6);
    const label = labelNode.getComponent(Label);
    if (label) {
      label.color = new Color(239, 233, 220, 255);
      label.isBold = true;
    }
  }

  private makeStartButton(parent: Node, x: number, y: number, w: number, h: number, text: string, onTap: () => void): Node {
    const btn = new Node('StartButton');
    btn.layer = 33554432;
    btn.parent = parent;
    btn.addComponent(UITransform).setContentSize(w, h);
    btn.setPosition(x, y, 0);

    const g = btn.addComponent(Graphics);
    UiPainter.keycap(g, w, h, GameRunner.PROP_COLORS[0], 'ready');

    const labelNode = this.mkLabel(btn, 'StartButtonLabel', 0, 4, text, 27, w - 28, h - 12);
    const label = labelNode.getComponent(Label);
    if (label) {
      label.isBold = true;
      label.color = UiTokens.color.inkDeep;
      label.lineHeight = 32;
      label.horizontalAlign = 1;
      label.verticalAlign = 1;
    }
    btn.on(Node.EventType.TOUCH_START, () => {
      btn.setScale(0.96, 0.94, 1);
      UiPainter.keycap(g, w, h, GameRunner.PROP_COLORS[0], 'pressed');
    });
    btn.on(Node.EventType.TOUCH_CANCEL, () => {
      btn.setScale(1, 1, 1);
      UiPainter.keycap(g, w, h, GameRunner.PROP_COLORS[0], 'ready');
    });
    btn.on(Node.EventType.TOUCH_END, () => {
      btn.setScale(1, 1, 1);
      UiPainter.keycap(g, w, h, GameRunner.PROP_COLORS[0], 'ready');
      onTap();
    });
    return btn;
  }

  private styleStartLabel(node: Node, color: Color, bold: boolean): void {
    const label = node.getComponent(Label);
    if (!label) return;
    label.color = color;
    label.isBold = bold;
    label.overflow = Label.Overflow.SHRINK;
  }

  private makeStartDoodles(parent: Node, vis: { width: number; height: number }, posterW: number, posterCY: number): void {
    const doodle = new Node('StartDoodles');
    doodle.layer = 33554432;
    doodle.parent = parent;
    doodle.addComponent(UITransform).setContentSize(vis.width, vis.height);
    const posterH = Math.min(vis.height * 0.56, 610);
    const y = posterCY - posterH * 0.055;
    const labels = ['长按蓄力', '拖向任务', '松手投出'];
    labels.forEach((text, i) => {
      const x = (i - 1) * posterW * 0.25;
      const chip = this.mkLabel(doodle, `StartStep${i}`, x, y, `${i + 1}  ${text}`, 14, posterW * 0.23, 30);
      const label = chip.getComponent(Label);
      if (label) {
        label.color = i === 0 ? GameRunner.PROP_COLORS[0] : GameRunner.UI_MUTED;
        label.isBold = i === 0;
      }
    });
  }

  /** 战报：自包含的小卡片 + 内嵌可点击按钮，与 scene 节点解耦。 */
  private finishAndShowReport(): void {
    if (this.reported) return;
    this.reported = true;
    this.uiState = 'result';
    const idx = this.session.currentIndex;
    const report = this.game.buildReport(idx);
    this.session.finishLevel(report);

    const vis = view.getVisibleSize();
    const pw = Math.min(vis.width * 0.86, 600);
    const ph = Math.min(vis.height * 0.50, 520);
    const won = report.result !== 'lose';
    const meme = buildReportText(this.session.profile, report, idx);
    const rank = this.session.rankLabel;
    const day = this.session.daysEmployed;
    const canRevive = report.result === 'lose' && !this.game.revived;
    const canNext = this.session.hasNext;

    if (this.reportLabel) this.reportLabel.node.active = false;
    if (this.retryBtn) this.retryBtn.active = false;
    if (this.nextBtn) this.nextBtn.active = false;
    if (this.reviveBtn) this.reviveBtn.active = false;

    if (!this.resultPanelNode) {
      this.resultPanelNode = new Node('ResultPanel');
      this.resultPanelNode.layer = 1 << 25;
      this.resultPanelNode.parent = this.node;
      this.resultPanelNode.addComponent(UITransform);
      this.resultPanelNode.addComponent(Graphics);
    }
    this.resultPanelNode.getComponent(UITransform)!.setContentSize(pw, ph);
    this.resultPanelNode.setPosition(0, vis.height * 0.015, 0);
    this.resultPanelNode.active = true;

    if (!this.resultScrimNode) {
      this.resultScrimNode = new Node('ResultScrim');
      this.resultScrimNode.layer = 1 << 25;
      this.resultScrimNode.parent = this.node;
      this.resultScrimNode.addComponent(UITransform);
      this.resultScrimNode.addComponent(Graphics);
      this.resultScrimNode.addComponent(UIOpacity);
    }
    this.resultScrimNode.getComponent(UITransform)!.setContentSize(vis.width, vis.height);
    const sg = this.resultScrimNode.getComponent(Graphics)!;
    sg.clear();
    sg.fillColor = new Color(78, 68, 56, 86);
    sg.rect(-vis.width / 2, -vis.height / 2, vis.width, vis.height);
    sg.fill();
    this.resultScrimNode.setPosition(0, 0, 0);
    this.resultScrimNode.active = true;
    this.resultScrimNode.setSiblingIndex(Math.max(0, this.resultPanelNode.getSiblingIndex() - 1));

    // 销毁旧的子节点，每次重新创建（避免复用旧位置）
    this.resultPanelNode.removeAllChildren();

    const cg = this.resultPanelNode.getComponent(Graphics)!;
    UiPainter.panel(cg, pw, ph, false);

    // 顶部战报状态胶囊：收窄并带落影，避免一整条红块像系统错误弹窗。
    const statusW = pw * 0.70;
    const statusH = 48;
    const statusY = ph / 2 - 48;
    cg.fillColor = new Color(72, 58, 44, 48);
    cg.roundRect(-statusW / 2 + 4, statusY - statusH / 2 - 4, statusW - 8, statusH, 14);
    cg.fill();
    cg.fillColor = won ? new Color(82, 172, 92, 246) : new Color(222, 84, 72, 246);
    cg.strokeColor = new Color(104, 92, 78, 96);
    cg.lineWidth = 1.5;
    cg.roundRect(-statusW / 2, statusY - statusH / 2, statusW, statusH, 14);
    cg.fill(); cg.stroke();
    cg.strokeColor = new Color(255, 255, 255, 80);
    cg.lineWidth = 2;
    cg.moveTo(-statusW / 2 + 22, statusY + statusH / 2 - 10);
    cg.lineTo(statusW / 2 - 22, statusY + statusH / 2 - 10);
    cg.stroke();

    const starY = ph / 2 - 110;
    const starStr = `评价 ${report.stars} / 3`;
    const starW = 160;
    cg.fillColor = new Color(255, 248, 225, 255);
    cg.strokeColor = new Color(230, 178, 56, 180);
    cg.lineWidth = 2;
    cg.roundRect(-starW / 2, starY - 20, starW, 40, 11);
    cg.fill(); cg.stroke();

    // 三个指标筹码，替代原来一行“表格感”的 stats。
    const chipY = ph / 2 - 166;
    const chipW = (pw - 70) / 3;
    [-1, 0, 1].forEach((offset) => {
      const cx = offset * (chipW + 10);
      cg.fillColor = new Color(249, 243, 232, 255);
      cg.strokeColor = new Color(185, 169, 145, 86);
      cg.lineWidth = 1.5;
      cg.roundRect(cx - chipW / 2, chipY - 24, chipW, 48, 12);
      cg.fill(); cg.stroke();
    });

    // 正文纸条：独立承载吐槽文本，不再在大空白里飘一行字。
    const noteW = pw - 54;
    const noteH = 82;
    const noteY = -30;
    cg.fillColor = new Color(255, 252, 244, 255);
    cg.strokeColor = new Color(219, 204, 178, 82);
    cg.lineWidth = 1.5;
    cg.roundRect(-noteW / 2, noteY - noteH / 2, noteW, noteH, 13);
    cg.fill(); cg.stroke();

    // 创建标签子节点
    this.addResultLabel(this.resultPanelNode, 'Title', 0, statusY,
      won ? '岗位守住!' : '被 AI 优化了…', 28, pw * 0.85, 42,
      new Color(255, 252, 240, 255), true);
    this.addResultLabel(this.resultPanelNode, 'Stars', 0, starY, starStr, 30, pw * 0.6, 42,
      new Color(166, 112, 0, 255), true);
    this.addResultLabel(this.resultPanelNode, 'StatsApproval', -(chipW + 10), chipY,
      `峰值\n${Math.round(report.peakApproval)}`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addResultLabel(this.resultPanelNode, 'StatsTime', 0, chipY,
      `耗时\n${report.timeUsedSec.toFixed(1)}s`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addResultLabel(this.resultPanelNode, 'StatsCombo', chipW + 10, chipY,
      `连击\n${report.maxCombo}`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addResultLabel(this.resultPanelNode, 'Stats2', 0, chipY - 48,
      `${rank}   ·   第${day}轮反击`, 15, pw * 0.85, 24, new Color(95, 84, 70, 255), false);
    this.addResultLabel(this.resultPanelNode, 'Meme', 0, -30,
      meme, 15, noteW - 28, 62, new Color(100, 88, 72, 255), false);

    // 内嵌可点击按钮：3 个横排在卡片底部
    this.makeResultButton(this.resultPanelNode, 'BtnRetry', -pw * 0.31, -ph / 2 + 46, pw * 0.27, 58, '重试', UiTokens.color.walnut, () => this.onRetry());
    this.makeResultButton(this.resultPanelNode, 'BtnNext', 0, -ph / 2 + 46, pw * 0.27, 58,
      canNext ? '下一关' : '回到选关', GameRunner.PROP_COLORS[0], () => canNext ? this.onNext() : this.onBackToSelect());
    if (canRevive) {
      this.makeResultButton(this.resultPanelNode, 'BtnRevive', pw * 0.31, -ph / 2 + 46, pw * 0.27, 58, '复活', UiTokens.color.amber, () => this.onRevive());
    }
    // 结果出现采用一次短促“落桌”反馈，避免常驻漂浮动画。
    const panelOpacity = this.resultPanelNode.getComponent(UIOpacity) ?? this.resultPanelNode.addComponent(UIOpacity);
    panelOpacity.opacity = 0;
    this.resultPanelNode.setScale(0.84, 0.84, 1);
    tween(this.resultPanelNode).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    tween(panelOpacity).to(0.14, { opacity: 255 }, { easing: 'quadOut' }).start();
  }

  private resultPanelNode: Node | null = null;

  private addResultLabel(parent: Node, name: string, x: number, y: number, text: string, size: number, w: number, h: number, color: Color, bold: boolean): void {
    const node = new Node(name);
    node.layer = 1 << 25;
    node.parent = parent;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(w, h);
    node.setPosition(x, y, 0);
    const lbl = node.addComponent(Label);
    lbl.string = text;
    UiPainter.label(lbl, size, color, bold);
    lbl.horizontalAlign = 1;
    lbl.verticalAlign = 1;
    lbl.overflow = Label.Overflow.SHRINK;
  }

  private makeResultButton(parent: Node, name: string, x: number, y: number, w: number, h: number, text: string, base: Color, onTap: () => void): void {
    const btn = new Node(name);
    btn.layer = 1 << 25;
    btn.parent = parent;
    btn.addComponent(UITransform).setContentSize(w, h);
    btn.setPosition(x, y, 0);
    const g = btn.addComponent(Graphics);
    UiPainter.keycap(g, w, h, base, 'ready');
    const labelNode = new Node(`${name}Label`);
    labelNode.layer = 1 << 25;
    labelNode.parent = btn;
    labelNode.addComponent(UITransform).setContentSize(w - 12, h - 6);
    const lbl = labelNode.addComponent(Label);
    lbl.string = text;
    // 键帽面已统一为纸色系，文字一律用深墨保证对比。
    UiPainter.label(lbl, 19, UiTokens.color.inkDeep, true);
    lbl.horizontalAlign = 1;
    lbl.verticalAlign = 1;
    btn.on(Node.EventType.TOUCH_END, () => { btn.setScale(1, 1, 1); onTap(); });
    btn.on(Node.EventType.TOUCH_START, () => btn.setScale(0.95, 0.95, 1));
    btn.on(Node.EventType.TOUCH_CANCEL, () => btn.setScale(1, 1, 1));
  }

  private hideReport(): void {
    if (this.resultPanelNode) this.resultPanelNode.active = false;
    if (this.resultScrimNode) this.resultScrimNode.active = false;
    if (this.reportLabel) this.reportLabel.node.active = false;
    if (this.nextBtn) this.nextBtn.active = false;
    if (this.retryBtn) this.retryBtn.active = false;
    if (this.reviveBtn) this.reviveBtn.active = false;
  }

  /* ---------- 主循环 ---------- */

  update(dt: number): void {
    // 选关页：不驱动游戏逻辑
    if (this.uiState === 'select') return;

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
      btn.on(Node.EventType.TOUCH_START, (event: EventTouch) => this.onPropDown(type, event));
      btn.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => this.onPropMove(type, event));
      btn.on(Node.EventType.TOUCH_END, (event: EventTouch) => this.onPropUp(type, event));
      btn.on(Node.EventType.TOUCH_CANCEL, () => this.onPropCancel(type));
    });
  }

  private bindFlowButtons(): void {
    this.nextBtn?.on(Node.EventType.TOUCH_END, () => this.onNext());
    this.retryBtn?.on(Node.EventType.TOUCH_END, () => this.onRetry());
    this.reviveBtn?.on(Node.EventType.TOUCH_END, () => this.onRevive());
  }

  private onPropDown(prop: PropType, event?: EventTouch): void {
    if (prop === PT.KissUp) {
      const st = this.game.prop.getState(prop);
      const usable = this.game.prop.isUnlocked(prop) && st.uses > 0 && st.ready;
      if (usable) {
        this.aimStart = this.propSourcePoint(prop);
        this.aimPoint = event ? this.pointFromPointer(event) : this.aimStart.clone();
        this.aimingSlot = this.slotFromAimPoint(this.aimPoint);
        this.showPaperAim(prop);
        this.aimingProp = prop;
        { const vis = view.getVisibleSize(); this.layoutPropButtons(vis.width, vis.height); }
        this.updatePaperAim(event);
        this.setEventText('拖动道具操作区，松手刷出去');
      } else {
        this.setEventText(`${this.propDisplayName(prop)}暂时不能用`);
      }
      this.punchButton(prop, true);
      return;
    }
    if (this.game.beginCharge(prop)) {
      this.aimStart = this.propSourcePoint(prop);
      this.aimPoint = event ? this.pointFromPointer(event) : this.aimStart.clone();
      this.aimingSlot = this.slotFromAimPoint(this.aimPoint);
      this.showPaperAim(prop);
      this.aimingProp = prop;
      { const vis = view.getVisibleSize(); this.layoutPropButtons(vis.width, vis.height); }
      this.updatePaperAim(event);
      this.advanceTutorial(1, '拖向显示器里的任务卡');
      this.setEventText('拖动道具操作区，对准任务卡松手');
    } else {
      this.setEventText(`${this.propDisplayName(prop)}暂时不能扔`);
    }
    this.punchButton(prop, true);
  }
  private onPropMove(prop: PropType, event: EventTouch): void {
    if (this.aimingProp !== prop) return;
    this.updatePaperAim(event);
    this.advanceTutorial(2, '松手投出纸团');
  }
  private onPropUp(prop: PropType, event?: EventTouch | EventMouse): void {
    if (prop === PT.KissUp) {
      if (this.aimingProp === prop) {
        if (event) this.updatePaperAim(event);
        if (this.game.useKissUp()) this.animatePaperToRobot(prop);
        this.clearPaperAim(true);
      }
      this.punchButton(prop, false);
      return;
    }
    this.finishPaperThrow(prop, event);
    this.punchButton(prop, false);
  }
  private onPropCancel(prop: PropType): void {
    if (this.aimingProp === prop) {
      // 按住后会把原按钮隐藏，Cocos 会给这个按钮派发 TOUCH_CANCEL。
      // 这是视觉切换产生的按钮级取消，不是玩家取消拖拽；真实取消仍由 onGlobalTouchCancel 处理。
      if (this.actionDockNode?.active) return;
      if (prop !== PT.KissUp) this.game.cancel(prop);
      this.clearPaperAim(true);
      this.punchButton(prop, false);
      return;
    }
    if (prop !== PT.KissUp) this.game.cancel(prop);
    this.punchButton(prop, false);
  }

  private finishPaperThrow(prop: PropType, event?: EventTouch | EventMouse): void {
    if (this.aimingProp !== prop) return;
    if (event) this.updatePaperAim(event);
    const slot = this.aimingSlot;
    this.animatePaperThrow(prop, slot, () => this.game.releaseAtSlot(prop, slot));
    this.clearPaperAim(false);
    this.punchButton(prop, false);
  }

  private onGlobalTouchMove(event: EventTouch): void {
    if (this.aimingProp === null) return;
    this.updatePaperAim(event);
    this.advanceTutorial(2, '松手投出纸团');
  }

  private onGlobalTouchEnd(event: EventTouch): void {
    const prop = this.aimingProp;
    if (prop === null) return;
    this.onPropUp(prop, event);
  }

  private onGlobalTouchCancel(): void {
    const prop = this.aimingProp;
    if (prop === null) return;
    this.game.cancel(prop);
    this.clearPaperAim(true);
    this.punchButton(prop, false);
  }

  private onGlobalMouseMove(event: EventMouse): void {
    if (this.aimingProp === null) return;
    this.updatePaperAim(event);
    this.advanceTutorial(2, '松手投出纸团');
  }

  private onGlobalMouseUp(event: EventMouse): void {
    const prop = this.aimingProp;
    if (prop === null) return;
    this.onPropUp(prop, event);
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

  private slotFromAimPoint(point: Vec3): number {
    if (this.slotNodes.length === 0) return 0;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.slotNodes.length; i++) {
      const p = this.targetPointForSlot(i);
      const dx = Math.abs(point.x - p.x);
      if (dx < bestDist) {
        best = i;
        bestDist = dx;
      }
    }
    return best;
  }

  private showPaperAim(prop: PropType): void {
    this.clearPaperAim(true);
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = GameRunner.PROP_COLORS[idx] ?? UiTokens.color.blue;

    const propNode = new Node('PropDragAim');
    propNode.layer = 1 << 25;
    propNode.addComponent(UITransform).setContentSize(78, 78);
    const propG = propNode.addComponent(Graphics);
    propG.clear();
    propG.fillColor = new Color(42, 36, 30, 70);
    propG.circle(4, -5, 34);
    propG.fill();
    propG.fillColor = new Color(base.r, base.g, base.b, 246);
    propG.strokeColor = new Color(42, 36, 30, 225);
    propG.lineWidth = 4;
    propG.circle(0, 0, 31);
    propG.fill();
    propG.stroke();
    propG.strokeColor = new Color(255, 255, 255, 132);
    propG.lineWidth = 3;
    propG.arc(0, 0, 22, Math.PI * 0.92, Math.PI * 1.82, false);
    propG.stroke();

    const iconFrame = this.propSfFor(prop);
    if (iconFrame) {
      const iconNode = new Node('PropDragIcon');
      iconNode.layer = 1 << 25;
      iconNode.parent = propNode;
      iconNode.addComponent(UITransform).setContentSize(45, 45);
      const icon = iconNode.addComponent(Sprite);
      icon.sizeMode = Sprite.SizeMode.CUSTOM;
      icon.spriteFrame = iconFrame;
      icon.color = Color.WHITE;
      iconNode.setPosition(0, 1, 0);
    } else {
      this.drawPaperWad(propNode, prop, 1);
    }
    this.node.addChild(propNode);
    this.paperAimNode = propNode;

    const guide = new Node('PropThrowGuide');
    guide.layer = 1 << 25;
    guide.addComponent(UITransform).setContentSize(1, 1);
    guide.addComponent(Graphics);
    this.node.addChild(guide);
    guide.setSiblingIndex(Math.max(0, propNode.getSiblingIndex() - 1));
    this.aimGuideNode = guide;

    const target = new Node('PropAimTarget');
    target.layer = 1 << 25;
    target.addComponent(UITransform).setContentSize(86, 86);
    target.addComponent(Graphics);
    target.addComponent(UIOpacity).opacity = 220;
    this.node.addChild(target);
    target.setSiblingIndex(Math.max(0, propNode.getSiblingIndex() - 1));
    this.aimTargetNode = target;
  }

  private updatePaperAim(event?: EventTouch | EventMouse): void {
    if (event) {
      const raw = this.pointFromPointer(event);
      const vis = view.getVisibleSize();
      const safe = sys.getSafeAreaRect(false);
      const safeBottomY = safe.y - vis.height / 2;
      let minX = -vis.width / 2 + 42;
      let maxX = vis.width / 2 - 42;
      let minY = safeBottomY + Math.max(58, vis.height * 0.07);
      let maxY = safeBottomY + Math.max(360, vis.height * 0.42);
      if (this.actionDockNode?.active) {
        const dockUt = this.actionDockNode.getComponent(UITransform);
        const dockW = dockUt?.contentSize.width ?? 0;
        const dockH = dockUt?.contentSize.height ?? 0;
        const dockX = this.actionDockNode.position.x;
        const dockY = this.actionDockNode.position.y;
        if (dockH > 0) {
          minX = dockX - dockW / 2 + 48;
          maxX = dockX + dockW / 2 - 48;
          minY = dockY - dockH / 2 + 58;
          maxY = dockY + dockH / 2 - 58;
        }
      }
      this.aimPoint = new Vec3(
        Math.max(minX, Math.min(maxX, raw.x)),
        Math.max(minY, Math.min(maxY, raw.y)),
        0,
      );
    }
    this.aimingSlot = this.slotFromAimPoint(this.aimPoint);
    if (this.paperAimNode?.isValid) {
      this.paperAimNode.setPosition(this.aimPoint.x, this.aimPoint.y, 0);
      const stretch = Math.min(1.18, 0.96 + Math.abs(this.aimPoint.y - this.aimStart.y) / 900);
      this.paperAimNode.setScale(stretch, 1 / stretch, 1);
    }
    if (this.aimTargetNode?.isValid) {
      const target = this.targetPointForSlot(this.aimingSlot);
      this.aimTargetNode.setPosition(target);
      const tg = this.aimTargetNode.getComponent(Graphics)!;
      const idx = this.aimingProp ? GameRunner.PROP_TYPES.indexOf(this.aimingProp) : 0;
      const base = GameRunner.PROP_COLORS[idx] ?? GameRunner.PROP_COLORS[0];
      const pulse = 1 + Math.sin(this.scanPos * Math.PI * 6) * 0.07;
      this.aimTargetNode.setScale(pulse, pulse, 1);
      tg.clear();
      tg.strokeColor = new Color(255, 252, 236, 235);
      tg.lineWidth = 5;
      tg.circle(0, 0, 30);
      tg.stroke();
      tg.strokeColor = new Color(base.r, base.g, base.b, 235);
      tg.lineWidth = 3;
      tg.circle(0, 0, 38);
      tg.stroke();
      // 四个短刻线强化“吸附目标”，不遮挡卡面。
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2;
        tg.moveTo(Math.cos(a) * 32, Math.sin(a) * 32);
        tg.lineTo(Math.cos(a) * 43, Math.sin(a) * 43);
        tg.stroke();
      }
    }
    this.drawAimGuide();
  }

  private drawAimGuide(): void {
    const g = this.aimGuideNode?.getComponent(Graphics);
    if (!g) return;
    const prop = this.aimingProp;
    const tuning = this.paperTuning(prop ?? PT.AddDemand);
    const start = this.aimStart;
    const end = this.targetPointForSlot(this.aimingSlot);
    const peak = new Vec3((start.x + end.x) * 0.5, Math.max(start.y, end.y) + tuning.arcHeight * 0.82, 0);
    g.clear();
    const idx = prop ? GameRunner.PROP_TYPES.indexOf(prop) : 0;
    const base = GameRunner.PROP_COLORS[idx] ?? new Color(42, 38, 34);
    g.fillColor = new Color(
      Math.round(base.r * 0.25 + 42 * 0.75),
      Math.round(base.g * 0.25 + 38 * 0.75),
      Math.round(base.b * 0.25 + 34 * 0.75),
      prop === PT.ThrowPot ? 210 : 170,
    );
    // 起点蓄力环：半径随 scanPos 增长，给长按过程一个明确节奏。
    g.strokeColor = new Color(base.r, base.g, base.b, 180);
    g.lineWidth = 3;
    g.circle(start.x, start.y, 24 + this.scanPos * 12);
    g.stroke();
    for (let i = 1; i <= tuning.guideDots; i++) {
      const t = i / (tuning.guideDots + 1);
      const x = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * peak.x + t * t * end.x;
      const y = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * peak.y + t * t * end.y;
      const r = tuning.guideDotRadius * (0.75 + t * 0.35);
      g.circle(x, y, r);
      g.fill();
    }
  }

  private clearPaperAim(destroyPaper: boolean): void {
    this.aimingProp = null;
    this.aimGuideNode?.destroy();
    this.aimGuideNode = null;
    this.aimTargetNode?.destroy();
    this.aimTargetNode = null;
    if (destroyPaper) {
      this.paperAimNode?.destroy();
    }
    this.paperAimNode = null;
    if (this.propButtons) {
      const vis = view.getVisibleSize();
      this.layoutPropButtons(vis.width, vis.height);
    }
  }

  private animatePaperThrow(prop: PropType, slot: number, onArrive: () => void): void {
    const paper = this.paperAimNode?.isValid ? this.paperAimNode : this.makePaperWadNode(prop, 'PaperWadThrow');
    const tuning = this.paperTuning(prop);
    const outcome = this.paperOutcome(prop, slot);
    const start = this.aimPoint.clone();
    const end = this.targetPointForSlot(slot);
    const peak = new Vec3((start.x + end.x) * 0.5, Math.max(start.y, end.y) + tuning.arcHeight, 0);
    if (!paper.parent) this.node.addChild(paper);
    paper.setPosition(start);
    paper.setScale(tuning.startScale);
    const op = paper.getComponent(UIOpacity) ?? paper.addComponent(UIOpacity);
    op.opacity = 255;
    const outDuration = tuning.duration * (prop === PT.ThrowPot ? 0.42 : 0.48);
    const inDuration = Math.max(0.08, tuning.duration - outDuration);
    tween(paper)
      .to(outDuration, { position: peak, angle: tuning.spin * 0.52, scale: tuning.midScale }, { easing: 'quadOut' })
      .to(inDuration, { position: end, angle: tuning.spin, scale: tuning.endScale }, { easing: prop === PT.ThrowPot ? 'sineIn' : 'quadIn' })
      .call(() => {
        onArrive();
        this.paperImpact(end, prop, outcome);
        this.paperOutcomeText(end, prop, outcome);
        this.settlePaperWad(paper, op, prop, outcome);
      })
      .start();
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
    tween(paper)
      .to(tuning.duration * 0.55, { position: peak, angle: tuning.spin * 0.42, scale: tuning.midScale }, { easing: 'quadOut' })
      .to(tuning.duration * 0.45, { position: end, angle: tuning.spin, scale: tuning.endScale }, { easing: 'backIn' })
      .call(() => {
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

  private paperImpact(pos: Vec3, prop: PropType, outcome: PaperOutcome): void {
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
    const scale = miss ? 0.9 : prop === PT.ThrowPot ? 1.55 : prop === PT.ChangeDemand ? 1.35 : 1.2;
    tween(ring)
      .to(0.16, { scale: new Vec3(scale, scale, 1) }, { easing: 'quadOut' })
      .call(() => { if (ring.isValid) ring.destroy(); })
      .start();
    tween(op).to(0.16, { opacity: 0 }, { easing: 'quadOut' }).start();
  }

  private paperOutcomeText(pos: Vec3, prop: PropType, outcome: PaperOutcome): void {
    const idx = GameRunner.PROP_TYPES.indexOf(prop);
    const base = GameRunner.PROP_COLORS[idx] ?? new Color(255, 255, 255);
    const text = this.paperOutcomeLabel(prop, outcome);
    const color = outcome === 'hit' ? new Color(base.r, base.g, base.b, 255) : new Color(120, 115, 108, 255);
    const node = new Node('PaperOutcomeText');
    node.layer = 1 << 25;
    node.addComponent(UITransform).setContentSize(96, 34);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = outcome === 'hit' && prop === PT.ThrowPot ? 24 : 20;
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
      .by(0.38, { position: new Vec3(0, 22, 0) }, { easing: 'quadOut' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
    tween(op).delay(0.18).to(0.2, { opacity: 0 }, { easing: 'quadOut' }).start();
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
      .to(0.06, { scale: squash }, { easing: 'quadOut' })
      .delay(hit ? 0.08 : 0.03)
      .to(0.12, { scale: new Vec3(0.18, 0.18, 1) }, { easing: 'quadIn' })
      .call(() => { if (paper.isValid) paper.destroy(); })
      .start();
    tween(opacity)
      .delay(hit ? 0.08 : 0.02)
      .to(0.14, { opacity: 0 }, { easing: 'quadOut' })
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

    // ── 标题：主标题 + 关卡号合并成一条，去掉会被显示器压住的独立副标题 ──
    if (this.gameTitleNode) {
      const tl = this.gameTitleNode.getComponent(Label);
      if (tl) {
        tl.string = `别让AI替代你 · 第${this.session.currentIndex + 1}关`;
        tl.fontSize = 30;
        tl.lineHeight = tl.fontSize + 6;
        tl.color = new Color(48, 40, 34, 255);
        tl.isBold = true;
      }
    }
    // ── 计时器：动态节点，黑字加粗 ──
    if (this.gameTimerNode) {
      const tl = this.gameTimerNode.getComponent(Label)!;
      const remain = Math.max(0, snap.duration - snap.elapsed);
      const resultText: Record<string, string> = { 'win-survive': '通关', 'win-hunt': '猎杀', lose: '淘汰' };
      tl.string = this.game.over
        ? `${Math.ceil(remain)}s ${resultText[this.game.result] ?? ''}`
        : `${Math.ceil(remain)}s`;
      tl.fontSize = this.game.over ? 22 : (this.compactHeader ? 24 : 28);
      tl.lineHeight = tl.fontSize + 4;
      tl.color = new Color(70, 60, 50, 255);
      tl.isBold = true;
    }
    this.updateLowerHud(Math.round(snap.approval), snap.zone);

    const cards = this.game.conveyor.cards;
    this.ensureSlotBackgrounds();
    // 槽位只作为固定坐标和底层占位；真实卡片由 cardVisuals 按 id 独立渲染。
    for (let i = 0; i < this.slotNodes.length; i++) {
      this.drawCardBackground(i, null);
      this.renderSlot(this.slotNodes[i], null, i);
    }
    this.syncCardVisuals(cards);

    if (this.scanIndicator) {
      const charging = this.game.prop.chargingProp !== null;
      this.scanIndicator.active = charging;
      if (charging) {
        const idx = this.aimingProp !== null
          ? this.aimingSlot
          : Math.min(this.slotNodes.length - 1, Math.floor(this.scanPos * this.slotNodes.length));
        const target = this.slotNodes[idx];
        if (target) this.scanIndicator.setPosition(target.position.x, target.position.y, 0);
        // 蓄力进度可视化：指示器随 scanPos 0→1 放大，给"蓄满了"的直观反馈
        const s = this.aimingProp !== null ? 1.18 : 0.6 + this.scanPos * 0.8;
        this.scanIndicator.setScale(s, s, 1);
      }
    }

    this.renderPropHUD();
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
    const baseFrame = this.artSprites.get('task-card-base') ?? null;
    const accentKey = card.state === CS.Boss
      ? 'task-card-accent-boss'
      : card.state === CS.Idle || card.state === CS.Inserted
        ? 'task-card-accent-idle'
        : GameRunner.CARD_ACCENT_ART_KEYS[card.category] ?? 'task-card-accent-normal';
    const accentFrame = this.artSprites.get(accentKey) ?? null;
    if (baseFrame) {
      g.clear();
      this.applySpriteFrame(baseSprite, baseFrame, w, h, Color.WHITE);
      this.applySpriteFrame(accentSprite, accentFrame, w, h, Color.WHITE);
      return;
    }
    const base = GameRunner.CARD_BORDER_COLORS[card.category] ?? GameRunner.CARD_BORDER_COLORS.routine;
    const shellState: CardShellState = card.state === CS.Rework ? 'rework'
      : card.state === CS.Inserted ? 'inserted'
      : card.state === CS.Idle ? 'idle'
      : card.state === CS.Boss ? 'boss'
      : 'active';
    UiPainter.card(g, w, h, base, shellState);
  }

  private renderSlot(node: Node, card: Card | null, slotIndex: number): void {
    const legacyLabel = node.getComponent(Label);
    if (legacyLabel) legacyLabel.enabled = false;
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
    title.enabled = false;
    title.string = getCardDef(card.category).label;
    title.color = Color.WHITE;
    title.isBold = true;

    const weightText = card.state === 'boss' ? '!'
      : card.isThreat ? `+${card.weight}`
      : card.state === 'rework' ? `-${card.weight}`
      : card.weight > 0 ? `+${card.weight}` : '';
    value.enabled = false;
    value.string = weightText;
    value.color = card.state === 'rework' ? new Color(255, 248, 185, 255)
      : card.state === 'boss' ? new Color(255, 232, 120, 255)
      : new Color(255, 252, 242, 232);
    value.isBold = true;
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
      this.moveCardVisual(visual, slotIndex, this.entryDuration(), true);
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
    return `${card.id}:${card.category}:${card.state}:${card.weight}:${card.isThreat ? 1 : 0}`;
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
    const LAYER_2D = 1 << 25; // UI_2D
    const visSize = view.getVisibleSize();
    const bgSf = this.artSprites.get('bg-office');
    if (!bgSf) return;

    const texSize = bgSf.originalSize; // 原图像素尺寸，如 1088×1920
    // width-fit：显示器横向结构完整保留；超长屏额外高度留给底部操作区，不再牺牲左右画面。
    const scale = visSize.width / texSize.width;
    const bgDisplayW = texSize.width * scale;
    const bgDisplayH = texSize.height * scale; // 缩放后背景图的显示高度
    // 顶部只轻微裁切，让完整显示器落到微信胶囊下方；图片下方的剩余高度自然成为操作区。
    const extraHeight = Math.max(0, visSize.height - bgDisplayH);
    // 超长屏把背景整体稍下沉，给标题与计时器真正的呼吸空间。
    const bottomExtension = Math.max(226, extraHeight * 0.78 + 92);
    const bgBottomY = -visSize.height / 2 + bottomExtension;
    const bgCenterY = bgBottomY + bgDisplayH / 2;
    const bgTopY = bgCenterY + bgDisplayH / 2;

    // 图片没有铺到的区域使用原图墙面底色延伸，避免灰底或硬接缝。
    if (!this.bgFillNode) {
      this.bgFillNode = new Node('BgFill');
      this.bgFillNode.layer = LAYER_2D;
      this.bgFillNode.parent = this.node;
      this.bgFillNode.addComponent(UITransform);
      this.bgFillNode.addComponent(Graphics);
      this.bgFillNode.active = this.uiState === 'playing';
    }
    const fillUt = this.bgFillNode.getComponent(UITransform)!;
    fillUt.setContentSize(visSize.width, visSize.height);
    const fillG = this.bgFillNode.getComponent(Graphics)!;
    fillG.clear();
    fillG.fillColor = new Color(240, 228, 208, 255); // bg-office.png 实测墙面色
    fillG.rect(-visSize.width / 2, -visSize.height / 2, visSize.width, visSize.height);
    fillG.fill();
    this.bgFillNode.setPosition(0, 0, 0);
    this.bgFillNode.setSiblingIndex(0);

    if (!this.bgNode) {
      this.bgNode = new Node('Bg');
      this.bgNode.layer = LAYER_2D;
      this.bgNode.parent = this.node;
      this.bgNode.addComponent(UITransform);
      const sprite = this.bgNode.addComponent(Sprite);
      sprite.sizeMode = Sprite.SizeMode.CUSTOM; // 必须先设，避免被 spriteFrame 赋值时的自动尺寸覆盖
      sprite.spriteFrame = bgSf;
      this.bgNode.active = this.uiState === 'playing';
    }
    this.bgNode.getComponent(UITransform)!.setContentSize(bgDisplayW, bgDisplayH);
    this.bgNode.setPosition(0, bgCenterY, 0); // 每次调用都刷新（防止 visSize 变化，比如窗口 resize）
    this.bgNode.setSiblingIndex(1);

    // 用比例常量反算显示器屏幕区域在当前屏幕坐标系下的像素位置
    // 背景图顶部世界坐标 = bgTopY；某比例 p 处的世界 y = bgTopY - p * bgDisplayH
    const screenTopY = bgTopY - GameRunner.BG_SCREEN_TOP * bgDisplayH;
    const screenBottomY = bgTopY - GameRunner.BG_SCREEN_BOTTOM * bgDisplayH;
    const screenWidthPx = (GameRunner.BG_SCREEN_RIGHT - GameRunner.BG_SCREEN_LEFT) * bgDisplayW;
    const deskTopY = bgTopY - GameRunner.BG_DESK_TOP * bgDisplayH;

    // 美术稿是暖色工作台屏幕，而不是一整块死黑灰；独立内屏面只覆盖显示区域，保留原监视器外壳。
    if (!this.monitorSurfaceNode) {
      this.monitorSurfaceNode = new Node('MonitorSurface');
      this.monitorSurfaceNode.layer = LAYER_2D;
      this.monitorSurfaceNode.parent = this.node;
      this.monitorSurfaceNode.addComponent(UITransform);
      this.monitorSurfaceNode.addComponent(Graphics);
    }
    const surfaceW = screenWidthPx * 0.96;
    const surfaceH = (screenTopY - screenBottomY) * 0.92;
    this.monitorSurfaceNode.getComponent(UITransform)!.setContentSize(surfaceW, surfaceH);
    this.monitorSurfaceNode.setPosition(0, (screenTopY + screenBottomY) / 2, 0);
    this.monitorSurfaceNode.setSiblingIndex(2);
    const surfaceG = this.monitorSurfaceNode.getComponent(Graphics)!;
    surfaceG.clear();
    const surfaceRadius = 14;
    // 深灰标题栏信息价值低且压缩内屏空间，降级为一条细状态灯带（保留"设备感"）。
    const surfaceHeaderH = 16;
    surfaceG.fillColor = new Color(246, 238, 225, 255);
    surfaceG.strokeColor = new Color(88, 78, 68, 210);
    surfaceG.lineWidth = 2.5;
    surfaceG.roundRect(-surfaceW / 2, -surfaceH / 2, surfaceW, surfaceH, surfaceRadius);
    surfaceG.fill(); surfaceG.stroke();
    surfaceG.fillColor = new Color(88, 78, 68, 36);
    surfaceG.roundRect(-surfaceW / 2 + 3, surfaceH / 2 - surfaceHeaderH, surfaceW - 6, surfaceHeaderH - 3, surfaceRadius * 0.6);
    surfaceG.fill();
    // 左上角三颗小指示灯（琥珀主色 + 两颗墨灰），代替整条文字标题。
    const lampY = surfaceH / 2 - surfaceHeaderH / 2 - 1;
    const lampColors = [new Color(244, 172, 32, 255), new Color(136, 126, 112, 255), new Color(136, 126, 112, 255)];
    lampColors.forEach((c, i) => {
      surfaceG.fillColor = c;
      surfaceG.circle(-surfaceW / 2 + 18 + i * 14, lampY, 3.2);
      surfaceG.fill();
    });

    // 桌面陈设是独立真素材：补足办公室叙事，同时中央 48% 保持透明给机器人与弹道。
    const decorSf = this.artSprites.get('desk-decor');
    if (decorSf) {
      if (!this.deskDecorNode) {
        this.deskDecorNode = new Node('DeskDecor');
        this.deskDecorNode.layer = LAYER_2D;
        this.deskDecorNode.parent = this.node;
        this.deskDecorNode.addComponent(UITransform);
        const sprite = this.deskDecorNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = decorSf;
      }
      const decorW = Math.min(visSize.width * 1.18, 760);
      const decorH = decorW / 2;
      this.deskDecorNode.getComponent(UITransform)!.setContentSize(decorW, decorH);
      this.deskDecorNode.setPosition(0, deskTopY - decorH * 0.15, 0);
      this.deskDecorNode.setSiblingIndex(3);
      this.deskDecorNode.active = this.uiState === 'playing';
    }

    // HUD 贴合显示器内屏，而不是沿用 960×640 横屏场景里的固定 y 坐标。
    const monitorPadding = Math.max(18, visSize.width * 0.028);
    const hudTopY = screenTopY - monitorPadding;
    const hudBottomY = screenBottomY + monitorPadding;

    // 标题区：放在显示器上方 50px 处的墙面区
    const safe = sys.getSafeAreaRect(false);
    const safeTopY = safe.y + safe.height - visSize.height / 2;
    const headerGap = safeTopY - screenTopY;
    this.compactHeader = false;
    // 主标题保持可见且靠近游戏内容，不再被安全区压成弱提示。
    const titleY = safeTopY - Math.max(44, visSize.height * 0.050);

    // 隐藏场景旧节点，改用代码动态创建（避免编辑器绑定问题）
    if (this.levelLabel) this.levelLabel.node.active = false;
    if (this.timerLabel) this.timerLabel.node.active = false;
    if (this.approvalLabel) this.approvalLabel.node.active = false;
    if (this.zoneLabel) this.zoneLabel.node.active = false;

    // ── 动态标题（极简：单节点 + Label） ──
    if (!this.gameTitleNode) {
      this.gameTitleNode = new Node('GameTitle');
      this.gameTitleNode.layer = 1 << 25;
      this.gameTitleNode.parent = this.node;
      this.gameTitleNode.addComponent(UITransform);
      const lbl = this.gameTitleNode.addComponent(Label);
      lbl.fontFamily = 'PingFang SC';
      lbl.horizontalAlign = 1;
      lbl.verticalAlign = 1;
      lbl.isBold = true;
      lbl.overflow = Label.Overflow.SHRINK;
      lbl.color = new Color(70, 60, 50, 255);
    }
    this.gameTitleNode.getComponent(UITransform)!.setContentSize(Math.min(visSize.width * 0.62, 440), 50);
    // 标题略偏左，给右侧计时器铭牌让位，两者同一行同一水平线。
    this.gameTitleNode.setPosition(-visSize.width * 0.06, titleY, 0);
    const tl = this.gameTitleNode.getComponent(Label)!;
    tl.string = `别让AI替代你 · 第${this.session.currentIndex + 1}关`;
    tl.fontSize = 30;
    tl.lineHeight = tl.fontSize + 6;
    tl.color = new Color(48, 40, 34, 255);

    // 独立副标题已合并进主标题，彻底移��被显示器边框遮挡的问题节点。
    if (this.subtitleNode) {
      this.subtitleNode.destroy();
      this.subtitleNode = null;
    }

    // ── 动态计时器 ──
    if (!this.gameTimerNode) {
      this.gameTimerNode = new Node('GameTimer');
      this.gameTimerNode.layer = 1 << 25;
      this.gameTimerNode.parent = this.node;
      this.gameTimerNode.addComponent(UITransform);
      const timer = this.gameTimerNode.addComponent(Label);
      timer.fontFamily = 'PingFang SC';
    }
    const timerLabel = this.gameTimerNode.getComponent(Label)!;
    timerLabel.horizontalAlign = 1; // CENTER
    timerLabel.verticalAlign = 1;
    timerLabel.overflow = Label.Overflow.SHRINK;
    timerLabel.isBold = true;
    const plateW = Math.min(Math.max(118, visSize.width * 0.27), 140);
    const plateH = 54;
    const timerX = visSize.width / 2 - plateW / 2 - Math.max(22, visSize.width * 0.045);
    this.gameTimerNode.getComponent(UITransform)!.setContentSize(plateW - 18, 42);
    this.gameTimerNode.setPosition(timerX + 4, titleY, 0);
    if (!this.timerPlateNode) {
      this.timerPlateNode = new Node('TimerPlate');
      this.timerPlateNode.layer = 1 << 25;
      this.timerPlateNode.parent = this.node;
      this.timerPlateNode.addComponent(UITransform);
      this.timerPlateNode.addComponent(Graphics);
    }
    this.timerPlateNode.getComponent(UITransform)!.setContentSize(plateW, plateH);
    this.timerPlateNode.setPosition(timerX, titleY, 0);
    this.timerPlateNode.setSiblingIndex(Math.max(0, this.gameTimerNode.getSiblingIndex() - 1));
    const plateG = this.timerPlateNode.getComponent(Graphics)!;
    plateG.clear();
    plateG.fillColor = new Color(72, 64, 55, 46);
    plateG.roundRect(-plateW / 2 + 5, -plateH / 2 - 5, plateW - 10, plateH, 16);
    plateG.fill();
    plateG.fillColor = new Color(255, 251, 243, 246);
    plateG.strokeColor = new Color(102, 91, 79, 176);
    plateG.lineWidth = 2.5;
    plateG.roundRect(-plateW / 2, -plateH / 2, plateW, plateH, 15);
    plateG.fill(); plateG.stroke();
    plateG.strokeColor = new Color(255, 255, 255, 112);
    plateG.lineWidth = 2;
    plateG.moveTo(-plateW / 2 + 20, plateH / 2 - 10);
    plateG.lineTo(plateW / 2 - 18, plateH / 2 - 10);
    plateG.stroke();
    plateG.fillColor = new Color(244, 172, 32, 255);
    plateG.circle(-plateW / 2 + 15, plateH / 2 - 13, 4);
    plateG.fill();

    // "AI显示器·任务流"与"处理→/←入口"浮动文字全部移除：
    // 内屏灯带提供设备感，流向信息由传送带两端的图形化箭头槽口承担（见 conveyorTrack 绘制）。
    if (this.monitorLabelNode) { this.monitorLabelNode.destroy(); this.monitorLabelNode = null; }
    if (this.monitorProcessLabelNode) { this.monitorProcessLabelNode.destroy(); this.monitorProcessLabelNode = null; }
    if (this.monitorEntryLabelNode) { this.monitorEntryLabelNode.destroy(); this.monitorEntryLabelNode = null; }

    // Belt（传送带卡槽）放在标题和状态行之间，卡牌始终限制在显示器内。
    if (this.beltNode) {
      const beltY = (hudTopY + hudBottomY) / 2 - (screenTopY - screenBottomY) * 0.040;
      this.beltNode.setPosition(this.beltNode.position.x, beltY, 0);
      let beltUt = this.beltNode.getComponent(UITransform);
      if (!beltUt) beltUt = this.beltNode.addComponent(UITransform);
      // 6 个卡槽横排，整体宽度不超过屏幕内屏可用宽度。
      // 标题栏降级为灯带后内屏可用高度增加，全部还给卡片：目标要大、要可点。
      const beltW = Math.min(screenWidthPx * 0.94, visSize.width * 0.92);
      const beltH = Math.max(170, Math.min((screenTopY - screenBottomY) * 0.80, 230));
      beltUt.setContentSize(beltW, beltH);
      if (!this.conveyorTrackNode) {
        this.conveyorTrackNode = new Node('ConveyorTrack');
        this.conveyorTrackNode.layer = LAYER_2D;
        this.conveyorTrackNode.parent = this.node;
        this.conveyorTrackNode.addComponent(UITransform);
        this.conveyorTrackNode.addComponent(Graphics);
      }
      const trackH = Math.max(44, Math.min(58, beltH * 0.36));
      const trackOuterW = beltW + Math.max(34, visSize.width * 0.045);
      this.conveyorTrackNode.getComponent(UITransform)!.setContentSize(trackOuterW, trackH + 14);
      this.conveyorTrackNode.setPosition(0, beltY - beltH * 0.31, 0);
      this.conveyorTrackNode.setSiblingIndex(Math.max(3, this.beltNode.getSiblingIndex() - 1));
      const trackG = this.conveyorTrackNode.getComponent(Graphics)!;
      trackG.clear();
      const trackRadius = trackH / 2;
      const rollerR = trackH * 0.40;
      const rollerX = trackOuterW / 2 - rollerR - 3;
      trackG.fillColor = new Color(96, 84, 72, 52);
      trackG.roundRect(-trackOuterW / 2 + 2, -trackH / 2 - 5, trackOuterW - 4, trackH + 2, trackRadius);
      trackG.fill();
      trackG.fillColor = new Color(105, 103, 96, 255);
      trackG.strokeColor = new Color(84, 74, 64, 190);
      trackG.lineWidth = 2.5;
      trackG.roundRect(-trackOuterW / 2, -trackH / 2, trackOuterW, trackH, trackRadius);
      trackG.fill(); trackG.stroke();
      trackG.fillColor = new Color(124, 121, 112, 255);
      trackG.roundRect(-trackOuterW / 2 + 9, -trackH / 2 + 7, trackOuterW - 18, trackH * 0.50, trackRadius * 0.45);
      trackG.fill();
      trackG.fillColor = new Color(88, 84, 77, 255);
      trackG.roundRect(-trackOuterW / 2 + 9, -trackH / 2 + 7, trackOuterW - 18, trackH * 0.18, trackRadius * 0.30);
      trackG.fill();
      trackG.strokeColor = new Color(255, 255, 255, 34);
      trackG.lineWidth = 2;
      trackG.moveTo(-trackOuterW / 2 + trackRadius, trackH / 2 - 8);
      trackG.lineTo(trackOuterW / 2 - trackRadius, trackH / 2 - 8);
      trackG.stroke();
      trackG.strokeColor = new Color(82, 72, 62, 58);
      trackG.lineWidth = 2;
      const segment = beltW / 6;
      for (let i = 1; i < 6; i++) {
        const x = -beltW / 2 + segment * i;
        trackG.moveTo(x, -trackH / 2 + 7);
        trackG.lineTo(x, trackH / 2 - 8);
        trackG.stroke();
      }
      [-rollerX, rollerX].forEach((x) => {
        trackG.fillColor = new Color(124, 121, 113, 255);
        trackG.strokeColor = new Color(84, 74, 64, 170);
        trackG.lineWidth = 2.5;
        trackG.circle(x, 0, rollerR);
        trackG.fill(); trackG.stroke();
        trackG.fillColor = new Color(92, 86, 78, 255);
        trackG.strokeColor = new Color(84, 74, 64, 115);
        trackG.lineWidth = 2;
        trackG.circle(x, 0, rollerR * 0.55);
        trackG.fill(); trackG.stroke();
        // 滚轮上的向左流向箭头：替代原"处理→ / ←入口"浮动文字，图形化表达任务流向。
        const aw = rollerR * 0.46;
        trackG.fillColor = new Color(238, 233, 222, 235);
        trackG.moveTo(x - aw, 0);
        trackG.lineTo(x + aw * 0.5, aw * 0.85);
        trackG.lineTo(x + aw * 0.5, -aw * 0.85);
        trackG.close();
        trackG.fill();
      });
      const mask = this.beltNode.getComponent(Mask) ?? this.beltNode.addComponent(Mask);
      mask.type = Mask.Type.GRAPHICS_RECT;
      this.layoutBeltSlots(beltW, beltH);
    }

    // 角色：键盘前沿对齐桌面线。角色稍微挡住显示器底部是正常的（坐在桌前面对屏幕的视角）。
    const charSf = this.artSprites.get('char-back');
    if (charSf) {
      if (!this.charNode) {
        this.charNode = new Node('Char');
        this.charNode.layer = LAYER_2D;
        this.charNode.parent = this.node;
        this.charNode.addComponent(UITransform);
        const sprite = this.charNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = charSf;
        this.charNode.setSiblingIndex(2);
        this.charNode.active = this.uiState === 'playing';
      }
      // 角色占屏宽 56%，是视觉主体
      const charDisplayH = Math.min(visSize.width * 0.56, visSize.height * 0.31);
      const charDisplayW = charDisplayH * GameRunner.CHAR_ASPECT; // 646:927 不是正方形
      const charUt = this.charNode.getComponent(UITransform)!;
      charUt.setContentSize(charDisplayW, charDisplayH);
      // 键盘对齐桌面线，CHAR_Y_OFFSET 控制整体上下微调（正=上移，负=下移，单位=背景高度比例）
      const charCenterY = deskTopY + (GameRunner.CHAR_HANDS_Y - 0.5) * charDisplayH + GameRunner.CHAR_Y_OFFSET * bgDisplayH;
      this.charNode.setPosition(0, charCenterY, 0);
      // 角色是前景主体，始终压在桌面背景之上；下方 HUD 会在随后重新置顶。
      this.charNode.setSiblingIndex(Math.max(2, this.node.children.length - 1));
    }

    this.layoutPropButtons(visSize.width, visSize.height);
    this.layoutLowerHud(visSize.width, visSize.height);
    this.layoutTutorialHint();

    // 资源异步加载可能发生在入口页停留期间；动态创建的 HUD 必须再次服从页面状态。
    const playing = this.uiState === 'playing';
    if (this.gameTitleNode) this.gameTitleNode.active = playing;
    if (this.gameTimerNode) this.gameTimerNode.active = playing;
    if (this.timerPlateNode) this.timerPlateNode.active = playing;
    if (this.monitorLabelNode) this.monitorLabelNode.active = playing;
    if (this.monitorProcessLabelNode) this.monitorProcessLabelNode.active = playing;
    if (this.monitorEntryLabelNode) this.monitorEntryLabelNode.active = playing;
    if (this.monitorSurfaceNode) this.monitorSurfaceNode.active = playing;
    if (this.conveyorTrackNode) this.conveyorTrackNode.active = playing;
    if (this.deskDecorNode) this.deskDecorNode.active = playing;
    if (this.actionDockNode) this.actionDockNode.active = playing && this.aimingProp !== null;
    if (this.lowerHudNode) this.lowerHudNode.active = playing;
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

    const btnY = this.propButtons?.position.y ?? -viewHeight / 2 + 110;
    const btnH = Math.min(128, Math.max(96, viewHeight * 0.070));
    // 删除刻度行与事件条后，铭牌更矮更窄，贴近按钮区消除大片死区。
    const panelW = Math.min(viewWidth * 0.86, 620);
    const panelH = 112;
    const panelY = btnY + btnH / 2 + panelH / 2 + Math.max(40, viewHeight * 0.038);

    const node = this.lowerHudNode;
    node.setSiblingIndex(this.node.children.length - 1);
    node.getComponent(UITransform)!.setContentSize(panelW, panelH);
    node.setPosition(0, panelY, 0);
    this.approvalGaugeView?.layout(panelW, panelH);
    node.active = this.uiState === 'playing';
  }

  private updateLowerHud(approval: number, zone: string): void {
    const elapsed = this.game?.getSnapshot().elapsed ?? 0;
    const displayZone = approval >= 69 ? 'danger' : approval >= 49 ? 'ok' : approval >= 18 ? 'good' : zone;
    this.approvalGaugeView?.update(approval, displayZone, this.lastEventText, elapsed);
  }

  /** 把 Belt 下的 6 个卡槽横向等距重新排布到指定区域内（居中）。 */
  private layoutBeltSlots(totalW: number, slotH: number): void {
    if (!this.beltNode || this.slotNodes.length === 0) return;
    const n = this.slotNodes.length;
    const gap = Math.max(3, Math.min(6, totalW * 0.009));
    const sideInset = Math.max(6, Math.min(11, totalW * 0.018));
    const usableW = totalW - sideInset * 2;
    const slotW = (usableW - gap * (n - 1)) / n;
    // 任务卡跟随 demo 的实体��比例：宁愿轻微拥挤，也不要缩成廉价小标签。
    const cardH = Math.min(slotH * 0.88, slotW * 1.22);
    const cardY = Math.max(8, Math.min(14, slotH * 0.085));
    const startX = -totalW / 2 + sideInset + slotW / 2;
    this.slotNodes.forEach((slot: Node, i: number) => {
      let ut = slot.getComponent(UITransform);
      if (!ut) ut = slot.addComponent(UITransform);
      ut.setContentSize(slotW, cardH);
      TaskCardView.layout(slot, slotW, cardH);
      const label = slot.getComponent(Label);
      if (label) {
        label.fontSize = Math.min(24, slotW * 0.24);
        label.lineHeight = Math.min(30, slotH * 0.28);
        label.overflow = Label.Overflow.SHRINK;
      }
      slot.setPosition(startX + i * (slotW + gap), cardY, 0);

      // 同步 Graphics 背景节点：尺寸 + 位置对齐 slot
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
    const horizontalPadding = Math.max(28, viewWidth * 0.04);
    const gap = Math.max(10, viewWidth * 0.014);
    const totalW = Math.min(viewWidth - horizontalPadding * 2, 920);
    const btnW = (totalW - gap * (this.propButtonNodes.length - 1)) / this.propButtonNodes.length;
    const btnH = Math.min(112, Math.max(78, viewHeight * 0.064));
    const startX = -totalW / 2 + btnW / 2;
    const safe = sys.getSafeAreaRect(false);
    const safeBottomY = safe.y - viewHeight / 2;
    const y = safeBottomY + btnH / 2 + Math.max(22, viewHeight * 0.018);
    const aimingIndex = this.aimingProp ? GameRunner.PROP_TYPES.indexOf(this.aimingProp) : -1;
    const choosing = aimingIndex >= 0;
    this.propButtons.setPosition(0, y, 0);

    if (!this.actionDockNode) {
      this.actionDockNode = new Node('ActionDock');
      this.actionDockNode.layer = 1 << 25;
      this.actionDockNode.parent = this.node;
      this.actionDockNode.addComponent(UITransform);
      this.actionDockNode.addComponent(Graphics);
    }
    const dockW = totalW + 18;
    const dockH = choosing ? Math.max(300, btnH * 4.0) : btnH + 12;
    const dockY = choosing ? y + btnH * 1.55 : y - 4;
    this.actionDockNode.getComponent(UITransform)!.setContentSize(dockW, dockH);
    this.actionDockNode.setPosition(0, dockY, 0);
    this.actionDockNode.setSiblingIndex(Math.max(0, this.propButtons.getSiblingIndex() - 1));
    this.actionDockNode.active = choosing && this.uiState === 'playing';
    const dockG = this.actionDockNode.getComponent(Graphics)!;
    dockG.clear();
    if (choosing) {
      dockG.fillColor = new Color(52, 45, 38, 64);
      dockG.roundRect(-dockW / 2 + 7, -dockH / 2 - 7, dockW - 14, dockH, 24);
      dockG.fill();
      dockG.fillColor = new Color(255, 250, 241, 238);
      dockG.strokeColor = new Color(82, 73, 64, 190);
      dockG.lineWidth = 3;
      dockG.roundRect(-dockW / 2, -dockH / 2, dockW, dockH, 24);
      dockG.fill(); dockG.stroke();
      dockG.fillColor = new Color(82, 78, 70, 246);
      dockG.roundRect(-dockW / 2 + 14, dockH / 2 - 42, dockW - 28, 30, 13);
      dockG.fill();
      dockG.strokeColor = new Color(255, 255, 255, 78);
      dockG.lineWidth = 2;
      dockG.moveTo(-dockW / 2 + 34, dockH / 2 - 21);
      dockG.lineTo(dockW / 2 - 34, dockH / 2 - 21);
      dockG.stroke();
      dockG.strokeColor = new Color(118, 108, 94, 92);
      dockG.lineWidth = 2;
      const railY = -dockH * 0.08;
      dockG.moveTo(-dockW / 2 + 36, railY);
      dockG.lineTo(dockW / 2 - 36, railY);
      dockG.stroke();
      for (let i = 0; i < this.propButtonNodes.length; i++) {
        const x = startX + i * (btnW + gap);
        dockG.fillColor = i === aimingIndex ? GameRunner.PROP_COLORS[i] : new Color(202, 192, 178, 165);
        dockG.circle(x, railY, i === aimingIndex ? 7 : 4);
        dockG.fill();
      }
    }

    this.ensurePropButtonBackgrounds();
    this.propButtonNodes.forEach((btn: Node, i: number) => {
      const x = startX + i * (btnW + gap);
      btn.active = !choosing;
      let ut = btn.getComponent(UITransform);
      if (!ut) ut = btn.addComponent(UITransform);
      ut.setContentSize(btnW, btnH);
      btn.setPosition(x, 0, 0);
      const label = btn.getComponent(Label);
      if (label) {
        label.fontSize = Math.min(17, Math.max(13, btnW * 0.17));
        label.lineHeight = label.fontSize + 4;
        label.overflow = Label.Overflow.SHRINK;
      }
      const actionLabel = this.propActionLabels[i];
      if (actionLabel) {
        actionLabel.string = GameRunner.PROP_ACTION_LABELS[i] ?? '';
        actionLabel.fontSize = Math.min(18, Math.max(13, btnW * 0.13));
        actionLabel.lineHeight = actionLabel.fontSize + 4;
        actionLabel.color = Color.WHITE;
        actionLabel.node.getComponent(UITransform)!.setContentSize(btnW - 16, 28);
        actionLabel.node.setPosition(0, -btnH * 0.30, 0);
      }

      const bg = this.propButtonBackgrounds[i];
      if (bg) {
        bg.active = !choosing;
        const bgUt = bg.getComponent(UITransform)!;
        bgUt.setContentSize(btnW, btnH);
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
 * 只存 3 个数据字段（daysEmployed 是 getter，由 core/Session.hydrateProfile 在读档时重建）。
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
