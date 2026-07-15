import { _decorator, Component, Node, Label, Color, UITransform, UIOpacity, tween, Tween, Vec3, Rect, input, Input, EventKeyboard, EventTouch, EventMouse, Sprite, SpriteFrame, resources, Texture2D, view, Graphics, sys, Mask, instantiate, profiler } from 'cc';
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
  private deskItemNodes: Node[] = [];
  private charNode: Node | null = null;
  /** 动态创建的游戏标题和倒计时（不依赖场景绑定节点） */
  private gameTitleNode: Node | null = null;
  private gameTimerNode: Node | null = null;
  /** 显示器外的顶部/底部 HUD。保持显示器背景与内屏节点不被重绘。 */
  private subtitleNode: Node | null = null;
  private lowerHudNode: Node | null = null;
  /** 方案 3 的实体控制台底座与计时器铭牌。 */
  private actionDockNode: Node | null = null;
  private actionDockHintLabel: Label | null = null;
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
  private suppressSyntheticPropCancelUntil = 0;
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
  private eventTextUntilSec = 0;
  private compactHeader = false;

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
    this.setEventText('长按纸团，拖向任务卡', 6);
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
        this.setEventText(UiTokens.tutorial.hitHint);
        this.completeTutorial();
      }),
    );
  }

  private clearEventFeed(): void {
    this.eventUnsubs.forEach((off) => off());
    this.eventUnsubs = [];
  }

  private setEventText(text: string, ttlSec = UiTokens.feedback.eventHintTtlSec): void {
    this.lastEventText = text.replace(/^事件\s*[·:：]\s*/, '');
    const elapsed = this.game?.getSnapshot().elapsed ?? 0;
    this.eventTextUntilSec = elapsed + Math.max(0.1, ttlSec);
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
    this.showTutorial(UiTokens.tutorial.holdHint);
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
    root.active = this.shouldShowTutorial();
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
    this.levelSelectRoot.setSiblingIndex(this.node.children.length - 1);
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
      '长按纸团，对准卡片，把麻烦稳稳扔回去。', Math.min(34, Math.max(27, cardW * 0.036)), cardW * 0.78, cardH * 0.085);
    this.styleStartLabel(crisis, GameRunner.START_MUTED, false);

    this.makeStartDoodles(root, vis, cardW, cardH, cardCY);

    this.makeStartButton(root, 0, cardCY - cardH * 0.328, cardW * 0.875, cardH * 0.124,
      `继续第${this.session.profile.highestUnlockedLevel + 1}关`, () => this.onLevelSelected(this.session.profile.highestUnlockedLevel));

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
    this.deskItemNodes.forEach((node) => { if (node?.isValid) node.active = v; });
    if (this.charNode) this.charNode.active = v;
    if (this.subtitleNode) this.subtitleNode.active = v;
    if (this.lowerHudNode) this.lowerHudNode.active = v;
    if (this.actionDockNode) this.actionDockNode.active = v;
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
    tween(dot)
      .repeatForever(
        tween()
          .to(0.72, { scale: new Vec3(1.26, 1.26, 1) }, { easing: 'sineInOut' })
          .to(0.72, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' }),
      )
      .start();

    const labelNode = this.mkLabel(node, 'AlertText', 28, 0, 'AI显示器 · 生存实验', Math.min(29, Math.max(22, cardW * 0.031)), pillW - 86, pillH - 4);
    const label = labelNode.getComponent(Label);
    if (label) {
      label.fontFamily = 'PingFang SC';
      label.color = GameRunner.START_TEXT;
      label.isBold = true;
    }
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
    const iconSide = Math.min(40, h * 0.58);
    playNode.addComponent(UITransform).setContentSize(iconSide, iconSide);
    playNode.setPosition(-w * 0.155, 5, 0);
    const playG = playNode.addComponent(Graphics);
    playG.fillColor = GameRunner.START_TEXT;
    playG.moveTo(-iconSide * 0.20, -iconSide * 0.29);
    playG.lineTo(iconSide * 0.27, 0);
    playG.lineTo(-iconSide * 0.20, iconSide * 0.29);
    playG.close();
    playG.fill();
    playG.fillColor = new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, 150);
    playG.circle(iconSide * 0.36, iconSide * 0.20, Math.max(2.5, iconSide * 0.08));
    playG.fill();

    const labelNode = this.mkLabel(btn, 'StartButtonLabel', 44, 5, text, Math.min(48, Math.max(36, h * 0.48)), w * 0.62, h - 12);
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
      playNode.setPosition(-w * 0.155, 5 + dy, 0);
      labelNode.setPosition(44, 5 + dy, 0);
    };
    btn.on(Node.EventType.TOUCH_START, () => setPressed(true));
    btn.on(Node.EventType.TOUCH_CANCEL, () => setPressed(false));
    btn.on(Node.EventType.TOUCH_END, () => {
      setPressed(false);
      onTap();
    });
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
      ['hold', '1 长按蓄力'],
      ['target', '2 对准目标'],
      ['throw', '3 松手投出'],
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
    this.session.finishLevel(report);

    const vis = view.getVisibleSize();
    const resultLayout = UiTokens.layout.result;
    const pw = Math.min(vis.width * resultLayout.widthRatio, resultLayout.maxWidth);
    const ph = Math.min(vis.height * resultLayout.heightRatio, resultLayout.maxHeight);
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
    this.resultPanelNode.setPosition(0, vis.height * resultLayout.yRatio, 0);
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

    // 顶部战报状态牌：纸质底 + 小状态章，避免纯红/绿系统条破坏当前暖纸质世界观。
    const statusW = pw * resultLayout.statusWidthRatio;
    const statusH = resultLayout.statusHeight;
    const statusY = ph / 2 - resultLayout.statusTopInset;
    cg.fillColor = new Color(72, 58, 44, 48);
    cg.roundRect(-statusW / 2 + 4, statusY - statusH / 2 - 4, statusW - 8, statusH, 14);
    cg.fill();
    cg.fillColor = new Color(255, 250, 241, 255);
    cg.strokeColor = new Color(166, 125, 88, 214);
    cg.lineWidth = 3;
    cg.roundRect(-statusW / 2, statusY - statusH / 2, statusW, statusH, 14);
    cg.fill(); cg.stroke();
    const badgeW = resultLayout.badgeWidth;
    const badgeX = statusW / 2 - badgeW / 2 - 12;
    cg.fillColor = won ? new Color(83, 170, 93, 235) : new Color(222, 84, 72, 238);
    cg.roundRect(badgeX - badgeW / 2, statusY - 16, badgeW, 32, 11);
    cg.fill();
    cg.strokeColor = new Color(255, 255, 255, 78);
    cg.lineWidth = 2;
    cg.moveTo(-statusW / 2 + 18, statusY + statusH / 2 - 10);
    cg.lineTo(statusW / 2 - badgeW - 20, statusY + statusH / 2 - 10);
    cg.stroke();

    const starY = ph / 2 - resultLayout.starTopInset;
    const starStr = `评价 ${report.stars} / 3`;
    const starW = resultLayout.starWidth;
    cg.fillColor = new Color(76, 67, 58, 28);
    cg.roundRect(-starW / 2 + 3, starY - 22, starW - 6, 40, 12);
    cg.fill();
    cg.fillColor = new Color(255, 248, 225, 255);
    cg.strokeColor = new Color(202, 148, 56, 210);
    cg.lineWidth = 2;
    cg.roundRect(-starW / 2, starY - 20, starW, 40, 11);
    cg.fill(); cg.stroke();

    // 三个指标筹码，替代原来一行“表格感”的 stats。
    const chipY = ph / 2 - resultLayout.chipTopInset;
    const chipW = (pw - resultLayout.chipHorizontalInset) / 3;
    [-1, 0, 1].forEach((offset) => {
      const cx = offset * (chipW + resultLayout.chipGap);
      cg.fillColor = new Color(76, 67, 58, 22);
      cg.roundRect(cx - chipW / 2 + 3, chipY - resultLayout.chipHeight / 2 - 3, chipW - 6, resultLayout.chipHeight, 13);
      cg.fill();
      cg.fillColor = new Color(255, 250, 241, 255);
      cg.strokeColor = new Color(185, 149, 112, 150);
      cg.lineWidth = 2;
      cg.roundRect(cx - chipW / 2, chipY - resultLayout.chipHeight / 2, chipW, resultLayout.chipHeight, 12);
      cg.fill(); cg.stroke();
      cg.fillColor = new Color(166, 125, 88, 98);
      cg.roundRect(cx - chipW / 2 + 12, chipY - resultLayout.chipHeight / 2 + 3, chipW - 24, 4, 2);
      cg.fill();
    });

    // 正文纸条：独立承载吐槽文本，不再在大空白里飘一行字。
    const noteW = pw - resultLayout.noteHorizontalInset;
    const noteH = resultLayout.noteHeight;
    const noteY = resultLayout.noteY;
    cg.fillColor = new Color(76, 67, 58, 18);
    cg.roundRect(-noteW / 2 + 4, noteY - noteH / 2 - 4, noteW - 8, noteH, 14);
    cg.fill();
    cg.fillColor = new Color(255, 252, 244, 255);
    cg.strokeColor = new Color(202, 178, 145, 128);
    cg.lineWidth = 2;
    cg.roundRect(-noteW / 2, noteY - noteH / 2, noteW, noteH, 13);
    cg.fill(); cg.stroke();

    // 创建标签子节点
    this.addResultLabel(this.resultPanelNode, 'Title', -badgeW * 0.42, statusY,
      won ? '岗位守住!' : '被 AI 优化了…', 28, pw * 0.85, 42,
      UiTokens.color.inkDeep, true);
    this.addResultLabel(this.resultPanelNode, 'ResultBadge', badgeX, statusY,
      won ? '通过' : '淘汰', 18, badgeW - 10, 28, new Color(255, 252, 240, 255), true);
    this.addResultLabel(this.resultPanelNode, 'Stars', 0, starY, starStr, 30, pw * 0.6, 42,
      new Color(166, 112, 0, 255), true);
    this.addResultLabel(this.resultPanelNode, 'StatsApproval', -(chipW + resultLayout.chipGap), chipY,
      `峰值\n${Math.round(report.peakApproval)}`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addResultLabel(this.resultPanelNode, 'StatsTime', 0, chipY,
      `耗时\n${report.timeUsedSec.toFixed(1)}s`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addResultLabel(this.resultPanelNode, 'StatsCombo', chipW + resultLayout.chipGap, chipY,
      `连击\n${report.maxCombo}`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addResultLabel(this.resultPanelNode, 'Stats2', 0, chipY - resultLayout.chipHeight,
      `${rank}   ·   第${day}轮反击`, 15, pw * 0.85, 24, new Color(95, 84, 70, 255), false);
    this.addResultLabel(this.resultPanelNode, 'Meme', 0, noteY,
      meme, 15, noteW - 28, 62, new Color(100, 88, 72, 255), false);

    // 内嵌可点击按钮：根据实际按钮数量自动居中，避免胜利/失败状态下出现空槽偏移。
    const buttons: Array<{ name: string; text: string; color: Readonly<Color>; tap: () => void }> = [
      { name: 'BtnRetry', text: '重试', color: UiTokens.color.walnut, tap: () => this.onRetry() },
      { name: 'BtnNext', text: canNext ? '下一关' : '回到选关', color: GameRunner.PROP_COLORS[0], tap: () => canNext ? this.onNext() : this.onBackToSelect() },
    ];
    if (canRevive) {
      buttons.push({ name: 'BtnRevive', text: '复活', color: UiTokens.color.amber, tap: () => this.onRevive() });
    }
    const btnGap = Math.min(resultLayout.buttonGapMax, Math.max(resultLayout.buttonGapMin, pw * resultLayout.buttonGapRatio));
    const btnW = Math.min(pw * resultLayout.buttonMaxWidthRatio, (pw * resultLayout.buttonAreaWidthRatio - btnGap * (buttons.length - 1)) / buttons.length);
    const btnY = -ph / 2 + resultLayout.buttonBottomInset;
    const btnSpan = (buttons.length - 1) * (btnW + btnGap);
    buttons.forEach((button, i) => {
      this.makeResultButton(this.resultPanelNode!, button.name, -btnSpan / 2 + i * (btnW + btnGap), btnY, btnW, resultLayout.buttonHeight, button.text, button.color, button.tap);
    });
    // 结果出现采用一次短促“落桌”反馈，避免常驻漂浮动画。
    const panelOpacity = this.resultPanelNode.getComponent(UIOpacity) ?? this.resultPanelNode.addComponent(UIOpacity);
    panelOpacity.opacity = 0;
    this.resultPanelNode.setScale(resultLayout.appearScale, resultLayout.appearScale, 1);
    tween(this.resultPanelNode).to(UiTokens.motion.panelSec, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    tween(panelOpacity).to(UiTokens.motion.resultFadeSec, { opacity: 255 }, { easing: 'quadOut' }).start();
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
    const paint = (pressed: boolean) => this.paintResultKeycap(g, w, h, base, pressed);
    paint(false);
    const labelNode = new Node(`${name}Label`);
    labelNode.layer = 1 << 25;
    labelNode.parent = btn;
    labelNode.addComponent(UITransform).setContentSize(w - 12, h - 6);
    labelNode.setPosition(0, 1, 0);
    const lbl = labelNode.addComponent(Label);
    lbl.string = text;
    // 键帽面已统一为纸色系，文字一律用深墨保证对比。
    UiPainter.label(lbl, 19, UiTokens.color.inkDeep, true);
    lbl.horizontalAlign = 1;
    lbl.verticalAlign = 1;
    const setPressed = (pressed: boolean) => {
      paint(pressed);
      labelNode.setPosition(0, pressed ? -3 : 1, 0);
    };
    btn.on(Node.EventType.TOUCH_END, () => { setPressed(false); onTap(); });
    btn.on(Node.EventType.TOUCH_START, () => setPressed(true));
    btn.on(Node.EventType.TOUCH_CANCEL, () => setPressed(false));
  }

  private paintResultKeycap(g: Graphics, w: number, h: number, accent: Readonly<Color>, pressed: boolean): void {
    g.clear();
    const faceShift = pressed ? -3 : 0;
    const lift = pressed ? 2 : 7;
    const radius = Math.min(18, Math.max(12, h * 0.24));
    g.fillColor = new Color(54, 48, 42, pressed ? 20 : 38);
    g.roundRect(-w / 2 + 5, -h / 2 - lift - 2, w - 10, h, radius);
    g.fill();
    g.fillColor = new Color(178, 139, 102, 206);
    g.roundRect(-w / 2 + 1, -h / 2 - lift, w - 2, h - 2, radius);
    g.fill();
    g.fillColor = GameRunner.START_CARD;
    g.strokeColor = new Color(146, 106, 76, pressed ? 205 : 236);
    g.lineWidth = 3;
    g.roundRect(-w / 2 + 2, -h / 2 + 4 + faceShift, w - 4, h - lift - 5, radius);
    g.fill(); g.stroke();
    g.strokeColor = new Color(255, 255, 255, pressed ? 44 : 92);
    g.lineWidth = 2;
    g.moveTo(-w / 2 + radius + 5, h / 2 - lift - 10 + faceShift);
    g.lineTo(w / 2 - radius - 5, h / 2 - lift - 10 + faceShift);
    g.stroke();
    g.fillColor = new Color(accent.r, accent.g, accent.b, pressed ? 108 : 158);
    g.roundRect(-w / 2 + 16, -h / 2 + 11 + faceShift, w - 32, 5, 3);
    g.fill();
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
        this.suppressSyntheticPropCancelUntil = Date.now() + UiTokens.feedback.syntheticCancelMs;
        { const vis = view.getVisibleSize(); this.layoutPropButtons(vis.width, vis.height); }
        this.updatePaperAim(event);
        this.setEventText(UiTokens.tutorial.dockHint);
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
      this.suppressSyntheticPropCancelUntil = Date.now() + UiTokens.feedback.syntheticCancelMs;
      { const vis = view.getVisibleSize(); this.layoutPropButtons(vis.width, vis.height); }
      this.updatePaperAim(event);
      this.advanceTutorial(1, UiTokens.tutorial.dragHint);
      this.setEventText(UiTokens.tutorial.dockHint);
    } else {
      this.setEventText(`${this.propDisplayName(prop)}暂时不能扔`);
    }
    this.punchButton(prop, true);
  }
  private onPropMove(prop: PropType, event: EventTouch): void {
    if (this.aimingProp !== prop) return;
    this.suppressSyntheticPropCancelUntil = 0;
    this.updatePaperAim(event);
    this.advanceTutorial(2, UiTokens.tutorial.releaseHint);
  }
  private onPropUp(prop: PropType, event?: EventTouch | EventMouse): void {
    this.suppressSyntheticPropCancelUntil = 0;
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
    this.suppressSyntheticPropCancelUntil = 0;
    this.updatePaperAim(event);
    this.advanceTutorial(2, UiTokens.tutorial.releaseHint);
  }

  private onGlobalTouchEnd(event: EventTouch): void {
    const prop = this.aimingProp;
    if (prop === null) return;
    this.onPropUp(prop, event);
  }

  private onGlobalTouchCancel(): void {
    const prop = this.aimingProp;
    if (prop === null) return;
    if (this.actionDockNode?.active && Date.now() < this.suppressSyntheticPropCancelUntil) {
      // 进入道具拖拽时会隐藏/重排底部按钮，Cocos 会立刻派发一次全局 TOUCH_CANCEL。
      // 这不是玩家取消操作，忽略它，避免按住按钮后马上显示“取消”。
      return;
    }
    this.suppressSyntheticPropCancelUntil = 0;
    this.game.cancel(prop);
    this.clearPaperAim(true);
    this.punchButton(prop, false);
  }

  private onGlobalMouseMove(event: EventMouse): void {
    if (this.aimingProp === null) return;
    this.suppressSyntheticPropCancelUntil = 0;
    this.updatePaperAim(event);
    this.advanceTutorial(2, UiTokens.tutorial.releaseHint);
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
    propNode.addComponent(UITransform).setContentSize(UiTokens.aim.dragSize, UiTokens.aim.dragSize);
    const propG = propNode.addComponent(Graphics);
    propG.clear();
    propG.fillColor = new Color(42, 36, 30, 78);
    propG.circle(5, -6, 39);
    propG.fill();
    propG.fillColor = new Color(178, 139, 102, 230);
    propG.circle(0, -4, 39);
    propG.fill();
    propG.fillColor = new Color(base.r, base.g, base.b, 246);
    propG.strokeColor = new Color(42, 36, 30, 225);
    propG.lineWidth = 4;
    propG.circle(0, 0, UiTokens.aim.dragRadius);
    propG.fill();
    propG.stroke();
    propG.strokeColor = new Color(255, 255, 255, 148);
    propG.lineWidth = 3.5;
    propG.arc(-1, 1, 25, Math.PI * 0.92, Math.PI * 1.82, false);
    propG.stroke();
    propG.fillColor = new Color(255, 255, 255, 62);
    propG.circle(-9, 10, 6);
    propG.fill();

    const iconFrame = this.propSfFor(prop);
    if (iconFrame) {
      const iconNode = new Node('PropDragIcon');
      iconNode.layer = 1 << 25;
      iconNode.parent = propNode;
      iconNode.addComponent(UITransform).setContentSize(UiTokens.aim.iconSize, UiTokens.aim.iconSize);
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
    target.addComponent(UITransform).setContentSize(UiTokens.aim.targetSize, UiTokens.aim.targetSize);
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
      let minX = -vis.width / 2 + UiTokens.aim.clampInset;
      let maxX = vis.width / 2 - UiTokens.aim.clampInset;
      let minY = safeBottomY + Math.max(UiTokens.aim.minFreeY, vis.height * UiTokens.aim.minFreeYRatio);
      let maxY = safeBottomY + Math.max(UiTokens.aim.minMaxFreeY, vis.height * UiTokens.aim.maxFreeYRatio);
      if (this.actionDockNode?.active) {
        const dockUt = this.actionDockNode.getComponent(UITransform);
        const dockW = dockUt?.contentSize.width ?? 0;
        const dockH = dockUt?.contentSize.height ?? 0;
        const dockX = this.actionDockNode.position.x;
        const dockY = this.actionDockNode.position.y;
        if (dockH > 0) {
          minX = dockX - dockW / 2 + UiTokens.aim.dockClampInset;
          maxX = dockX + dockW / 2 - UiTokens.aim.dockClampInset;
          minY = dockY - dockH / 2 + UiTokens.aim.dockClampVerticalInset;
          maxY = dockY + dockH / 2 - UiTokens.aim.dockClampVerticalInset;
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
      tg.circle(0, 0, UiTokens.aim.targetInnerRadius);
      tg.stroke();
      tg.strokeColor = new Color(base.r, base.g, base.b, 235);
      tg.lineWidth = 3;
      tg.circle(0, 0, UiTokens.aim.targetOuterRadius);
      tg.stroke();
      // 四个短刻线强化“吸附目标”，不遮挡卡面。
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2;
        tg.moveTo(Math.cos(a) * (UiTokens.aim.targetInnerRadius + 2), Math.sin(a) * (UiTokens.aim.targetInnerRadius + 2));
        tg.lineTo(Math.cos(a) * UiTokens.aim.targetTickOuter, Math.sin(a) * UiTokens.aim.targetTickOuter);
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
    g.circle(start.x, start.y, UiTokens.aim.startChargeRadius + this.scanPos * UiTokens.aim.startChargePulse);
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
    this.suppressSyntheticPropCancelUntil = 0;
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
      .to(UiTokens.feedback.impactSec, { scale: new Vec3(scale, scale, 1) }, { easing: 'quadOut' })
      .call(() => { if (ring.isValid) ring.destroy(); })
      .start();
    tween(op).to(UiTokens.feedback.impactSec, { opacity: 0 }, { easing: 'quadOut' }).start();
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
        tl.string = '别让AI替代你';
        tl.fontSize = Math.min(44, Math.max(30, view.getVisibleSize().width * 0.070));
        tl.lineHeight = tl.fontSize + 6;
        tl.color = GameRunner.START_TEXT;
        tl.isBold = true;
      }
    }

    const remain = Math.max(0, snap.duration - snap.elapsed);
    const urgent = remain <= 10 && !this.game.over;
    const resultText: Record<string, string> = { 'win-survive': '通关', 'win-hunt': '猎杀', lose: '淘汰' };
    if (this.gameTimerNode) {
      const tl = this.gameTimerNode.getComponent(Label)!;
      tl.string = this.game.over
        ? `${Math.ceil(remain)}s ${resultText[this.game.result] ?? ''}`
        : `${Math.ceil(remain)}s`;
      tl.fontSize = this.game.over ? 22 : 28;
      tl.lineHeight = tl.fontSize + 4;
      tl.color = urgent ? new Color(220, 72, 66, 255) : GameRunner.START_TEXT;
      tl.isBold = true;
      const pulse = urgent ? 1 + Math.sin(snap.elapsed * 8) * 0.035 : 1;
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

    this.updateLowerHud(Math.round(snap.approval), snap.zone);

    const cards = this.game.conveyor.cards;
    this.ensureSlotBackgrounds();
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
    baseSprite.enabled = false;
    accentSprite.enabled = false;
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
    titleLabel.string = '别让AI替代你';
    titleLabel.fontSize = Math.min(44, Math.max(30, visSize.width * 0.070));
    titleLabel.lineHeight = titleLabel.fontSize + 6;
    titleLabel.color = GameRunner.START_TEXT;
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
        const sprite = this.charNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = charSf;
      }
      const charH = Math.min(deskH * 0.84, visSize.height * 0.210);
      const charW = charH * GameRunner.CHAR_ASPECT;
      this.charNode.getComponent(UITransform)!.setContentSize(charW, charH);
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
    if (this.actionDockNode) this.actionDockNode.active = playing && this.aimingProp !== null;
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

  private updateLowerHud(approval: number, zone: string): void {
    const elapsed = this.game?.getSnapshot().elapsed ?? 0;
    const displayZone = approval >= 69 ? 'danger' : approval >= 49 ? 'ok' : approval >= 18 ? 'good' : zone;
    const hint = elapsed <= this.eventTextUntilSec ? this.lastEventText : '';
    this.approvalGaugeView?.update(approval, displayZone, hint, elapsed);
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
    const dockLayout = UiTokens.layout.actionDock;
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
    const aimingIndex = this.aimingProp ? GameRunner.PROP_TYPES.indexOf(this.aimingProp) : -1;
    const choosing = aimingIndex >= 0;
    this.propButtons.setPosition(0, y, 0);

    if (!this.actionDockNode) {
      this.actionDockNode = new Node('ActionDock');
      this.actionDockNode.layer = 1 << 25;
      this.actionDockNode.parent = this.node;
      this.actionDockNode.addComponent(UITransform);
      this.actionDockNode.addComponent(Graphics);
      const hint = new Node('ActionDockHint');
      hint.layer = 1 << 25;
      hint.parent = this.actionDockNode;
      hint.addComponent(UITransform);
      this.actionDockHintLabel = hint.addComponent(Label);
      this.actionDockHintLabel.horizontalAlign = 1;
      this.actionDockHintLabel.verticalAlign = 1;
      this.actionDockHintLabel.enableWrapText = false;
    }
    const dockW = Math.min(usedW + dockLayout.sidePadding, viewWidth - horizontalPadding * 2 + dockLayout.extraWidth);
    const lowerHudGap = Math.max(dockLayout.minHudGap, viewHeight * dockLayout.hudGapRatio);
    const dockBottom = y - btnH / 2 - Math.max(dockLayout.minBottomGap, btnH * dockLayout.bottomGapRatio);
    const dockTopLimit = y + btnH / 2 + lowerHudGap - Math.max(dockLayout.minTopInset, viewHeight * dockLayout.topInsetRatio);
    const dockAvailableH = Math.max(dockLayout.minAvailableHeight, dockTopLimit - dockBottom);
    const dockH = choosing ? Math.max(dockLayout.minHeight, Math.min(dockLayout.maxHeight, dockAvailableH)) : btnH + dockLayout.idleExtraHeight;
    const dockY = choosing ? dockBottom + dockH / 2 : y - 4;
    this.actionDockNode.getComponent(UITransform)!.setContentSize(dockW, dockH);
    this.actionDockNode.setPosition(0, dockY, 0);
    this.actionDockNode.setSiblingIndex(Math.max(0, this.propButtons.getSiblingIndex() - 1));
    this.actionDockNode.active = choosing && this.uiState === 'playing';
    const dockG = this.actionDockNode.getComponent(Graphics)!;
    dockG.clear();
    if (this.actionDockHintLabel) {
      this.actionDockHintLabel.node.active = choosing;
      this.actionDockHintLabel.string = UiTokens.tutorial.dockHint;
      UiPainter.label(this.actionDockHintLabel, UiTokens.type.micro, new Color(118, 96, 72, 210), true);
      this.actionDockHintLabel.node.getComponent(UITransform)?.setContentSize(dockW - 52, dockLayout.hintHeight);
      this.actionDockHintLabel.node.setPosition(0, dockH / 2 - dockLayout.hintTopOffset, 0);
    }
    if (choosing) {
      const dockRadius = Math.min(dockLayout.radiusMax, Math.max(dockLayout.radiusMin, dockH * 0.15));
      dockG.fillColor = new Color(54, 48, 42, 32);
      dockG.roundRect(-dockW / 2 + 6, -dockH / 2 - 6, dockW - 12, dockH, dockRadius);
      dockG.fill();
      dockG.fillColor = new Color(255, 252, 246, 246);
      dockG.strokeColor = new Color(166, 125, 88, 218);
      dockG.lineWidth = 3;
      dockG.roundRect(-dockW / 2, -dockH / 2, dockW, dockH, dockRadius);
      dockG.fill(); dockG.stroke();
      dockG.fillColor = new Color(255, 255, 255, 64);
      dockG.roundRect(-dockW / 2 + 18, dockH / 2 - 20, dockW - 36, 5, 3);
      dockG.fill();
      dockG.fillColor = new Color(166, 125, 88, 40);
      dockG.roundRect(-dockW / 2 + 22, -dockH / 2 + 14, dockW - 44, 6, 3);
      dockG.fill();

      const railY = -dockH * 0.12;
      dockG.strokeColor = new Color(166, 125, 88, 150);
      dockG.lineWidth = 4;
      dockG.moveTo(-dockW / 2 + dockLayout.railInset, railY);
      dockG.lineTo(dockW / 2 - dockLayout.railInset, railY);
      dockG.stroke();
      for (let i = 0; i < this.propButtonNodes.length; i++) {
        const x = startX + i * (btnW + gap);
        if (i === aimingIndex) {
          dockG.fillColor = new Color(54, 48, 42, 34);
          dockG.circle(x + 3, railY - 3, dockLayout.handleRadius + 4);
          dockG.fill();
          dockG.fillColor = new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, 46);
          dockG.circle(x, railY, dockLayout.handleRadius + 3);
          dockG.fill();
          dockG.strokeColor = new Color(GameRunner.START_BLUE.r, GameRunner.START_BLUE.g, GameRunner.START_BLUE.b, 178);
          dockG.lineWidth = 3;
          dockG.circle(x, railY, dockLayout.handleRadius - 3);
          dockG.stroke();
          dockG.fillColor = GameRunner.START_BLUE;
          dockG.circle(x, railY, dockLayout.dotRadius + 1.5);
          dockG.fill();
        } else {
          dockG.fillColor = new Color(202, 190, 172, 210);
          dockG.circle(x, railY, dockLayout.dotRadius);
          dockG.fill();
        }
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
        bg.active = !choosing;
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
