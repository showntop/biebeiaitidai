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
  private charNode: Node | null = null;
  /** 动态创建的游戏标题和倒计时（不依赖场景绑定节点） */
  private gameTitleNode: Node | null = null;
  private gameTimerNode: Node | null = null;
  /** 显示器外的顶部/底部 HUD。保持显示器背景与内屏节点不被重绘。 */
  private subtitleNode: Node | null = null;
  private lowerHudNode: Node | null = null;

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
  /** 仪表盘面板内认可度条的本地坐标缓存（updateLowerHud 动态覆盖用） */
  private hudBarW = 0;
  private hudBarCY = 0;
  private hudBarH = 0;
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
  private lastEventText = '事件 · 等待下一条任务';
  private compactHeader = false;

  private static readonly PROP_LABELS = ['白纸团', '紫纸团', '咖啡团', '粉便签'];
  private static readonly PROP_ACTION_LABELS = ['加需求', '改需求', '甩锅', '拍马屁'];
  private static readonly PROP_TYPES: PropType[] = [PT.AddDemand, PT.ChangeDemand, PT.ThrowPot, PT.KissUp];

  /** 道具按钮主色（视觉规范§1.4 + UI稿：蓝/紫/红/粉，高饱和强对比）。 */
  private static readonly PROP_COLORS: ReadonlyArray<Readonly<Color>> = [
    new Color(80, 160, 255),   // 加需求 蓝 #50A0FF
    new Color(180, 100, 255),  // 改需求 紫 #B464FF
    new Color(220, 76, 76),    // 丢锅 红（与返工红同族 #DC3C3C）
    new Color(255, 105, 180),  // 拍马屁 粉 #FF69B4
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
    routine: 'card-doc-blue-a',
    report: 'card-doc-stack',
    key: 'card-target',
    proposal: 'card-idea',
    urgent: 'card-alarm',
    meeting: 'card-coffee',
    document: 'card-doc-blue-b',
    boss: 'card-boss-audit',
  };
  /** 空槽也显示即将到来的任务预览，避免队列退化成一排 "---"。 */
  private static readonly QUEUE_PREVIEW_ART_KEYS = ['card-doc-blue-a', 'card-doc-stack', 'card-target', 'card-idea', 'card-alarm', 'card-coffee'];
  private static readonly QUEUE_PREVIEW_COLORS: ReadonlyArray<Readonly<Color>> = [
    new Color(80, 160, 255), new Color(145, 145, 145), new Color(180, 100, 255),
    new Color(60, 200, 220), new Color(255, 180, 40), new Color(125, 125, 125),
  ];

  /** 卡牌 Graphics 背景样式常量。卡牌 = 代码画圆角矩形底 + 纯图标 Sprite（见美术指南「卡牌/按钮=代码画底+纯图标」）。 */
  private static readonly CARD_BORDER_COLORS: Readonly<Record<string, Readonly<Color>>> = Object.freeze({
    routine:  new Color(80, 160, 255),   // 蓝 #50A0FF
    report:   new Color(255, 160, 60),   // 橙 #FFA03C
    key:      new Color(180, 100, 255),  // 紫 #B464FF
    proposal: new Color(60, 200, 220),   // 青 #3CC8DC
    urgent:   new Color(255, 180, 40),   // 琥珀 #FFB428
    meeting:  new Color(120, 120, 120),  // 灰 #787878
    document: new Color(120, 120, 120),  // 灰 #787878
    boss:     new Color(40, 40, 40),     // 黑 #282828
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
    this.lastEventText = '事件 · 长按纸团，拖向任务卡';
    this.hideReport();
    this.hideLevelSelect();
    this.setGameUIVisible(true);
    // 道具 HUD（CD/能量/次数/就绪）由 render() 每帧刷新（renderPropHUD），无需此处单独调用
    // 动效层：每局重新订阅新 EventBus
    this.fx?.dispose();
    this.fx = new FxLayer(
      this.game.bus,
      this.node,
      this.slotNodes,
      this.approvalLabel,
      (slot) => this.visualNodeAtSlot(slot),
    );
    this.bindEventFeed();
    // 视觉层：挂背景和（有素材就挂，没有不影响 Label 兜底跑）
    this.applyBgCharSprites();
    this.beginTutorialIfNeeded();
  }

  /** 事件区只呈现对玩家有意义的最新结果，避免长期显示无效占位文案。 */
  private bindEventFeed(): void {
    this.clearEventFeed();
    const propName = (prop: PropType): string => GameRunner.PROP_LABELS[GameRunner.PROP_TYPES.indexOf(prop)] ?? '道具';
    this.eventUnsubs.push(
      this.game.bus.on('CardHit', ({ prop, slot, quality }) => {
        this.setEventText(`${propName(prop)}命中第${slot + 1}格 · ${quality === 'perfect' ? '精准' : '已处理'}`);
        this.completeTutorial();
      }),
      this.game.bus.on('ApprovalChanged', ({ delta }) => this.setEventText(`认可度 ${delta > 0 ? '+' : ''}${delta}`)),
      this.game.bus.on('PropUnavailable', ({ prop }) => this.setEventText(`${propName(prop)}暂时无法使用`)),
      this.game.bus.on('BossIncoming', () => this.setEventText('Boss 临检正在接近')),
      this.game.bus.on('KissUpFreeze', ({ durationSec }) => this.setEventText(`拍马屁生效 · 传送带暂停 ${durationSec.toFixed(1)}s`)),
    );
  }

  private clearEventFeed(): void {
    this.eventUnsubs.forEach((off) => off());
    this.eventUnsubs = [];
  }

  private setEventText(text: string): void {
    this.lastEventText = `事件 · ${text}`;
    const label = this.lowerHudNode?.getChildByName('Event')?.getComponent(Label);
    if (label) label.string = this.lastEventText;
  }

  private missionTitle(index = this.session.currentIndex): string {
    const title = getLevel(index).title ?? '';
    return title.includes('·') ? title.split('·').slice(1).join('·') : title || '替代警报';
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
    const vis = view.getVisibleSize();
    const w = Math.min(vis.width * 0.68, 420);
    const h = 44;
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
    root.active = true;
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

  /** 动态创建开始页覆盖层 —— "岗位替代警报"海报式入口。 */
  private createLevelSelectUI(): Node {
    const root = new Node('LevelSelectUI');
    root.layer = 33554432; // UI_2D
    root.addComponent(UITransform).setContentSize(view.getVisibleSize().width, view.getVisibleSize().height);
    const bg = root.addComponent(Graphics);
    this.paintFullScreenStartBg(bg);
    this.node.addChild(root);

    const vis = view.getVisibleSize();
    const posterW = Math.min(vis.width * 0.88, 650);
    const posterH = Math.min(vis.height * 0.62, 700);
    const posterCY = vis.height * 0.045; // poster 中心 Y

    // ── 警报条：红色倾斜横幅，压在 poster 顶部 ──
    this.paintStartAlertBar(root, posterW, posterH, posterCY);

    // ── 主标题：两行，手写海报感，微微旋转 ──
    const titleNode = new Node('StartTitle');
    titleNode.layer = 33554432;
    titleNode.parent = root;
    titleNode.setPosition(0, posterCY + posterH * 0.18, 0);
    titleNode.setRotationFromEuler(0, 0, -2); // -2° 手写海报倾斜
    const titleUt = titleNode.addComponent(UITransform);
    titleUt.setContentSize(posterW * 0.84, 120);
    const titleLabel = titleNode.addComponent(Label);
    titleLabel.string = '别让 AI\n替代你';
    titleLabel.fontSize = 52;
    titleLabel.lineHeight = 62;
    titleLabel.horizontalAlign = 1; // CENTER
    titleLabel.verticalAlign = 1;
    titleLabel.color = new Color(28, 22, 18, 255);
    titleLabel.isBold = true;
    titleLabel.overflow = Label.Overflow.NONE;

    // ── 危机说明：一句话 ──
    const crisis = this.mkLabel(root, 'CrisisText', 0, posterCY - posterH * 0.02, 'AI 正在接管你的任务队列', 22, posterW * 0.82, 40);
    this.styleStartLabel(crisis, new Color(72, 58, 44, 255), false);

    // ── 唯一 CTA：红色大按钮 ──
    this.makeStartButton(root, 0, posterCY - posterH * 0.22, Math.min(posterW * 0.52, 340), 72, '开始反击 →', () => this.onLevelSelected(0));

    // ── 底部进度：轻量一行 ──
    const rank = this.mkLabel(root, 'RankInfo', 0, posterCY - posterH * 0.38, '', 16, posterW * 0.76, 30);
    this.styleStartLabel(rank, new Color(96, 80, 62, 255), false);

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
        label.string = `第${this.session.profile.highestUnlockedLevel + 1}轮反击 · 坚守第${day}天`;
        label.color = new Color(96, 80, 62, 255);
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
    if (this.charNode) this.charNode.active = v;
    if (this.subtitleNode) this.subtitleNode.active = v;
    if (this.lowerHudNode) this.lowerHudNode.active = v;
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
    const posterH = Math.min(vis.height * 0.62, 700);
    const posterX = -posterW / 2;
    const posterCY = vis.height * 0.045;
    const posterY = posterCY - posterH / 2;
    g.clear();

    // 办公室墙面底色
    g.fillColor = new Color(238, 226, 207, 255);
    g.rect(-vis.width / 2, -vis.height / 2, vis.width, vis.height);
    g.fill();

    // 微弱横向纸纹
    g.strokeColor = new Color(219, 205, 184, 70);
    g.lineWidth = 1;
    for (let y = -vis.height / 2 + 28; y < vis.height / 2; y += 34) {
      g.moveTo(-vis.width / 2 + 20, y);
      g.lineTo(vis.width / 2 - 20, y + 2);
      g.stroke();
    }

    // 主海报阴影
    g.fillColor = new Color(75, 60, 42, 45);
    g.roundRect(posterX + 10, posterY - 10, posterW, posterH, 30);
    g.fill();

    // 主海报纸张
    g.fillColor = new Color(255, 247, 232, 255);
    g.strokeColor = new Color(34, 29, 24, 255);
    g.lineWidth = 5;
    g.roundRect(posterX, posterY, posterW, posterH, 30);
    g.fill();
    g.stroke();
  }

  /** 在 poster 顶部画倾斜红色警报横幅。 */
  private paintStartAlertBar(parent: Node, posterW: number, _posterH: unknown, posterCY: number): void {
    const node = new Node('StartAlertBar');
    node.layer = 33554432;
    node.parent = parent;
    const barW = posterW * 0.62;
    const barH = 46;
    const barY = posterCY + (Math.min(view.getVisibleSize().height * 0.62, 700) as number) * 0.40;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(barW, barH);
    node.setPosition(-posterW * 0.04, barY, 0);
    node.setRotationFromEuler(0, 0, -3); // 倾斜贴在公告顶部
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(224, 56, 46, 255);
    g.strokeColor = new Color(26, 22, 19, 255);
    g.lineWidth = 3;
    g.roundRect(-barW / 2, -barH / 2, barW, barH, 14);
    g.fill();
    g.stroke();
    const labelNode = this.mkLabel(node, 'AlertText', 0, 0, '⚠ 岗位替代警报', 22, barW - 24, barH - 6);
    const label = labelNode.getComponent(Label);
    if (label) {
      label.color = new Color(255, 241, 194, 255);
      label.isBold = true;
    }
  }

  private makeStartButton(parent: Node, x: number, y: number, w: number, h: number, text: string, onTap: () => void): Node {
    const btn = new Node('StartButton');
    btn.layer = 33554432;
    btn.parent = parent;
    btn.addComponent(UITransform).setContentSize(w, h);
    const g = btn.addComponent(Graphics);
    g.fillColor = new Color(229, 66, 54, 255);
    g.strokeColor = new Color(25, 23, 21, 255);
    g.lineWidth = 4;
    g.roundRect(-w / 2, -h / 2, w, h, 18);
    g.fill(); g.stroke();
    g.fillColor = new Color(255, 255, 255, 34);
    g.roundRect(-w / 2 + 8, h / 2 - 24, w - 16, 14, 8);
    g.fill();
    btn.setPosition(x, y, 0);
    const labelNode = this.mkLabel(btn, 'StartButtonLabel', 0, 1, text, 28, w - 24, h - 8);
    const label = labelNode.getComponent(Label);
    if (label) {
      label.isBold = true;
      label.color = Color.WHITE;
    }
    btn.on(Node.EventType.TOUCH_START, () => btn.setScale(0.97, 0.97, 1));
    btn.on(Node.EventType.TOUCH_CANCEL, () => btn.setScale(1, 1, 1));
    btn.on(Node.EventType.TOUCH_END, () => {
      btn.setScale(1, 1, 1);
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
    const g = doodle.addComponent(Graphics);
    const posterH = Math.min(vis.height * 0.62, 700);

    // 右上角红章：REPLACED? —— 被驳回的"替代"警告，打上红色问号
    const stampCX = posterW * 0.37;
    const stampCY = posterCY + posterH * 0.42;
    g.strokeColor = new Color(211, 42, 38, 190);
    g.lineWidth = 4;
    g.roundRect(stampCX - 60, stampCY - 28, 120, 56, 10);
    g.stroke();
    // 斜线划掉
    g.moveTo(stampCX - 50, stampCY - 14);
    g.lineTo(stampCX + 50, stampCY + 16);
    g.stroke();

    // 左下纸团涂鸦 —— 暗示"扔纸团反击"
    const paperX = -posterW * 0.38;
    const paperY = posterCY - posterH * 0.44;
    g.fillColor = new Color(255, 255, 255, 240);
    g.strokeColor = new Color(42, 36, 30, 220);
    g.lineWidth = 2;
    // 三个纸团聚一堆
    g.circle(paperX, paperY, 13); g.fill(); g.stroke();
    g.circle(paperX + 16, paperY + 4, 12); g.fill(); g.stroke();
    g.circle(paperX + 5, paperY + 18, 10); g.fill(); g.stroke();
    // 纸团褶皱线
    g.strokeColor = new Color(80, 160, 255, 160);
    g.moveTo(paperX - 6, paperY + 6);
    g.lineTo(paperX + 22, paperY + 2);
    g.moveTo(paperX + 2, paperY + 16);
    g.lineTo(paperX + 24, paperY + 10);
    g.stroke();
  }

  /** 局结束：写战报、解锁/段位/存档、展示结算。 */
  private finishAndShowReport(): void {
    if (this.reported) return;
    this.reported = true;
    this.uiState = 'result';
    const idx = this.session.currentIndex;
    const report = this.game.buildReport(idx);
    this.session.finishLevel(report); // applyRunResult + 存档 + phase=finished

    if (this.reportLabel) {
      const stars = '★'.repeat(report.stars) + '☆'.repeat(Math.max(0, 3 - report.stars));
      const meme = buildReportText(this.session.profile, report, idx);
      const rank = this.session.rankLabel;
      const day = this.session.daysEmployed;
      const canRevive = report.result === 'lose' && !this.game.revived;
      const verdict = report.result === 'lose' ? '被 AI 优化了' : '撑过这一轮';
      const nextLine = report.result === 'lose'
        ? `重试本关${canRevive ? ' / 复活一次' : ''}`
        : (this.session.hasNext ? '进入下一关' : '本轮完成');
      this.reportLabel.string =
        `${verdict}\n${stars}\n\n${meme}\n\n` +
        `峰值认可度：${Math.round(report.peakApproval)}  ·  用时：${report.timeUsedSec.toFixed(1)}s\n` +
        `最高连击：${report.maxCombo}  ·  段位：${rank} / 第${day}轮反击\n\n` +
        `${nextLine}\nR 重试   N 下一关   B 返回`;
      this.reportLabel.node.active = true;
    }
    if (this.nextBtn) this.nextBtn.active = this.session.hasNext;
    if (this.retryBtn) this.retryBtn.active = true;
    if (this.reviveBtn) this.reviveBtn.active = report.result === 'lose' && !this.game.revived;
  }

  private hideReport(): void {
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
        label.string = GameRunner.PROP_LABELS[i] ?? '';
        label.fontSize = 18;
        label.lineHeight = 20;
        label.overflow = Label.Overflow.SHRINK;
        label.horizontalAlign = 2;
        label.verticalAlign = 1;
      }
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
      if (this.game.useKissUp()) this.animatePaperToRobot(prop);
      this.punchButton(prop, true);
      return;
    }
    if (this.game.beginCharge(prop)) {
      this.aimStart = this.propSourcePoint(prop);
      this.aimPoint = event ? this.pointFromPointer(event) : this.aimStart.clone();
      this.aimingSlot = this.slotFromAimPoint(this.aimPoint);
      this.showPaperAim(prop);
      this.aimingProp = prop;
      this.updatePaperAim(event);
      this.advanceTutorial(1, '拖向显示器里的任务卡');
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
    if (prop !== PT.KissUp) this.finishPaperThrow(prop, event);
    this.punchButton(prop, false);
  }
  private onPropCancel(prop: PropType): void {
    if (this.aimingProp === prop) {
      this.finishPaperThrow(prop);
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
    const paper = new Node('PaperWadAim');
    paper.layer = 1 << 25;
    paper.addComponent(UITransform).setContentSize(44, 44);
    paper.addComponent(Graphics);
    this.drawPaperWad(paper, prop, 1);
    this.node.addChild(paper);
    this.paperAimNode = paper;

    const guide = new Node('PaperThrowGuide');
    guide.layer = 1 << 25;
    guide.addComponent(UITransform).setContentSize(1, 1);
    guide.addComponent(Graphics);
    this.node.addChild(guide);
    guide.setSiblingIndex(Math.max(0, paper.getSiblingIndex() - 1));
    this.aimGuideNode = guide;
  }

  private updatePaperAim(event?: EventTouch | EventMouse): void {
    if (event) this.aimPoint = this.pointFromPointer(event);
    this.aimingSlot = this.slotFromAimPoint(this.aimPoint);
    if (this.paperAimNode?.isValid) {
      this.paperAimNode.setPosition(this.aimPoint.x, this.aimPoint.y, 0);
      const stretch = Math.min(1.18, 0.96 + Math.abs(this.aimPoint.y - this.aimStart.y) / 900);
      this.paperAimNode.setScale(stretch, 1 / stretch, 1);
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
    if (destroyPaper) {
      this.paperAimNode?.destroy();
    }
    this.paperAimNode = null;
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
    const s = down ? 0.92 : 1;
    tween(btn).to(0.05, { scale: new Vec3(s, s, 1) }).start();
  }

  /**
   * 纸团武器槽 HUD：每帧刷新。视觉重心在大纸团 + 次数，CD 用纸团暗部表示。
   */
  private renderPropHUD(): void {
    if (!this.propButtons) return;
    this.propButtonNodes.forEach((btn: Node, i: number) => {
      const type = GameRunner.PROP_TYPES[i];
      const label = btn.getComponent(Label);
      const st = this.game.prop.getState(type);
      const unlocked = this.game.prop.isUnlocked(type);
      const name = GameRunner.PROP_ACTION_LABELS[i] ?? GameRunner.PROP_LABELS[i];
      const uses = unlocked ? st.uses : 0;
      const kissUp = type === PT.KissUp;
      const dim = !unlocked || uses <= 0;
      let cdPct = 1;
      let statusLine = '';
      if (!unlocked) { statusLine = '未解锁'; cdPct = 0; }
      else if (uses <= 0) { statusLine = '已用尽'; cdPct = 0; }
      else if (st.ready) statusLine = '就绪';
      else {
        if (st.acquisition === 'cd') { cdPct = 1 - st.cdRemaining / Math.max(1, st.cdDuration); statusLine = `${st.cdRemaining.toFixed(1)}s`; }
        else { cdPct = st.energy; statusLine = `${Math.round(st.energy * 100)}%`; }
      }
      const count = kissUp ? '' : (uses > 0 ? `×${uses}` : '');
      if (label) {
        label.string = `${name}`;
        label.color = dim ? new Color(140, 133, 128, 255) : new Color(34, 30, 27, 255);
        label.horizontalAlign = 1; // CENTER
        label.verticalAlign = 1;
        label.fontSize = Math.min(18, Math.max(14, (btn.getComponent(UITransform)?.width ?? 140) * 0.13));
        label.overflow = Label.Overflow.SHRINK;
      }
      this.drawPropButtonBackground(i, unlocked, uses > 0, st.ready, cdPct, count, statusLine);
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

    // ── 底卡：圆角矩形 ──
    g.fillColor = inactive
      ? new Color(225, 220, 212, 255)
      : new Color(Math.round(base.r * 0.08 + 248), Math.round(base.g * 0.08 + 244), Math.round(base.b * 0.08 + 235), 255);
    g.strokeColor = inactive ? new Color(150, 145, 138, 200) : ready ? base : new Color(68, 62, 56, 255);
    g.lineWidth = ready ? 3.5 : 2.5;
    g.roundRect(-w / 2, -h / 2, w, h, 16);
    g.fill();
    g.stroke();

    // ── 中心大纸团 ──
    const cx = 0;
    const cy = h * 0.1;
    const r = Math.min(w * 0.30, h * 0.34);
    const c = inactive ? new Color(190, 185, 180, 200) : new Color(
      Math.round(base.r * 0.12 + 250 * 0.88),
      Math.round(base.g * 0.12 + 247 * 0.88),
      Math.round(base.b * 0.12 + 240 * 0.88),
      250,
    );
    this.drawBigPaperPile(g, index, cx, cy, r, c, base, inactive);

    // ── CD 暗部覆盖在纸团上 ──
    if (!ready && !inactive) {
      const cdAlpha = inactive ? 0 : 180;
      g.fillColor = new Color(38, 34, 30, cdAlpha);
      const clipBottom = cy - r;
      const clipTop = cy + r;
      const clipH = (clipTop - clipBottom) * cdPct;
      g.rect(-w / 2, cy - r, w, clipH);
      g.fill();
    }

    // ── ×N 次数大字（叠在纸团上） ──
    if (count) {
      const ctLabel = bg.getChildByName('CountText')?.getComponent(Label)
        ?? this.mkLabel(bg, 'CountText', 0, cy + r * 0.02, count, Math.min(28, Math.max(20, w * 0.20)), w, 34).getComponent(Label);
      if (ctLabel) {
        ctLabel.string = count;
        ctLabel.color = inactive ? new Color(130, 125, 120, 200) : new Color(30, 26, 22, 230);
        ctLabel.isBold = true;
        ctLabel.horizontalAlign = 1;
        ctLabel.verticalAlign = 1;
        ctLabel.fontSize = Math.min(28, Math.max(20, w * 0.20));
        const ctNode = ctLabel.node;
        ctNode.setPosition(0, cy + r * 0.08, 0);
        ctNode.getComponent(UITransform)!.setContentSize(w, 34);
      }
    }

    // ── 一行状态：就绪 / 2.3s / 空 / 锁 ──
    const statusNode = bg.getChildByName('StatusText');
    if (!statusNode) {
      const sn = this.mkLabel(bg, 'StatusText', 0, -h / 2 + 16, statusLine, 14, w - 10, 22);
      const sl = sn.getComponent(Label);
      if (sl) {
        sl.horizontalAlign = 1;
        sl.overflow = Label.Overflow.SHRINK;
      }
    }
    const sl = bg.getChildByName('StatusText')?.getComponent(Label);
    if (sl) {
      sl.string = statusLine;
      sl.color = ready ? base : inactive ? new Color(130, 125, 118, 200) : new Color(80, 74, 66, 255);
      sl.fontSize = Math.min(16, Math.max(12, w * 0.11));
    }

    // ── 不可用图标 ──
    if (!unlocked) {
      g.strokeColor = new Color(130, 124, 118, 200);
      g.lineWidth = 2.5;
      g.circle(cx, cy, r * 0.35);
      g.stroke();
      g.rect(cx - r * 0.14, cy - r * 0.22, r * 0.28, r * 0.30);
      g.stroke();
    } else if (!hasUses) {
      g.strokeColor = new Color(130, 124, 118, 180);
      g.lineWidth = 2;
      g.moveTo(cx - r * 0.25, cy - r * 0.25);
      g.lineTo(cx + r * 0.25, cy + r * 0.25);
      g.stroke();
      g.moveTo(cx + r * 0.25, cy - r * 0.25);
      g.lineTo(cx - r * 0.25, cy + r * 0.25);
      g.stroke();
    }
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

    // ── 标题：动态节点 ──
    if (this.gameTitleNode) {
      const tl = this.gameTitleNode.getComponent(Label)!;
      tl.string = this.compactHeader
        ? `第${this.session.currentIndex + 1}关 · ${this.missionTitle()}`
        : '别让AI替代你';
      tl.fontSize = this.compactHeader ? 22 : 32;
      tl.lineHeight = tl.fontSize + 8;
      tl.color = new Color(38, 32, 26, 255);
      tl.isBold = true;
    }
    // ── 计时器：动态节点，黑字加粗 ──
    if (this.gameTimerNode) {
      const tl = this.gameTimerNode.getComponent(Label)!;
      const remain = Math.max(0, snap.duration - snap.elapsed);
      const resultText: Record<string, string> = { 'win-survive': '通关', 'win-hunt': '猎杀', lose: '淘汰' };
      tl.string = this.game.over
        ? `${remain.toFixed(1)}s ${resultText[this.game.result] ?? ''}`
        : `${remain.toFixed(1)}s`;
      tl.fontSize = this.compactHeader ? 22 : 34;
      tl.lineHeight = tl.fontSize + 4;
      tl.color = new Color(40, 34, 28, 255);
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
    if (!card) {
      // 空槽仅保留中性轮廓，避免入场卡与"预览图标"叠在一起产生内容变形。
      g.clear();
      g.fillColor = new Color(245, 241, 232, 28);
      g.strokeColor = new Color(225, 220, 210, 76);
      g.lineWidth = 2;
      g.roundRect(-w / 2, -h / 2, w, h, 13);
      g.fill();
      g.stroke();
      return;
    }
    const base = GameRunner.CARD_BORDER_COLORS[card.category] ?? GameRunner.CARD_BORDER_COLORS.routine;
    const mix = 0.66;
    const fill = new Color(
      Math.round(base.r * (1 - mix) + 250 * mix),
      Math.round(base.g * (1 - mix) + 246 * mix),
      Math.round(base.b * (1 - mix) + 238 * mix),
      255,
    );
    g.clear();
    g.fillColor = fill;
    g.strokeColor = new Color(base.r, base.g, base.b, 255);
    g.lineWidth = 3.5;
    g.roundRect(-w / 2, -h / 2, w, h, 13);
    g.fill();
    g.stroke();
  }

  private renderSlot(node: Node, card: Card | null, slotIndex: number): void {
    const label = node.getComponent(Label);
    const sprite = this.taskIconFor(node);

    // 清空样式默认值
    sprite.color = Color.WHITE;

    // 无卡：预览占位图标 + 空底（drawCardBackground 已处理空槽半透底）
    if (!card) {
      sprite.spriteFrame = null;
      sprite.enabled = false;
      if (label) { label.enabled = false; }
      return;
    }

    // 有卡：图标 + 权重数字
    const sf = this.cardSfFor(card.category);
    if (sf) {
      sprite.spriteFrame = sf;
      sprite.color = Color.WHITE;
      sprite.enabled = true;
    } else {
      sprite.spriteFrame = null;
      sprite.enabled = false;
    }

    // 权重数字：底边居中小字，白色描边感
    if (label) {
      label.enabled = true;
      const weightText = card.state === 'boss' ? '!!!'
        : card.isThreat ? `+${card.weight}`
        : card.state === 'rework' ? `-${card.weight}`
        : card.state === 'inserted' ? '+0'
        : card.weight > 0 ? `+${card.weight}` : '';
      label.string = weightText;
      label.color = card.state === 'rework' ? new Color(255, 255, 220)
        : card.state === 'boss' ? new Color(255, 60, 40)
        : card.state === 'active-white' ? new Color(50, 50, 50, 255)
        : new Color(100, 100, 100, 255);
      label.fontSize = card.state === 'boss' ? 22 : 16;
      label.verticalAlign = 1; // bottom
      label.horizontalAlign = 1; // center
    }
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

  /** 创建一张真实卡片的独立节点；入口卡从屏幕右外侧线性进入。 */
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
    // 美术卡片自身包含圆角底板与图标，整张卡按比例展示，不再拆成灰底+小图标。
    if (slotUt) {
      const iconSize = Math.min(slotUt.width * 0.56, slotUt.height * 0.56);
      iconUt.setContentSize(iconSize, iconSize);
    }
    iconNode.setPosition(0, slotUt ? slotUt.height * 0.02 : 0, 0);
    return iconNode.getComponent(Sprite)!;
  }

  /** 卡牌类别 → SpriteFrame 映射（null = 没素材，走 Label 兜底）。 */
  private cardSfFor(cat: Card['category']): SpriteFrame | null {
    const key = GameRunner.CARD_ART_KEYS[cat] ?? `card-${cat}`;
    return this.artSprites.get(key) ?? this.artSprites.get(`card-${cat}`) ?? null;
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
    const bottomExtension = Math.max(160, extraHeight + 20);
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

    // HUD 贴合显示器内屏，而不是沿用 960×640 横屏场景里的固定 y 坐标。
    const monitorPadding = Math.max(24, visSize.width * 0.035);
    const hudTopY = screenTopY - monitorPadding;
    const hudBottomY = screenBottomY + monitorPadding;

    // 标题区：紧贴安全区下方，确保不会被刘海/胶囊裁切
    const safe = sys.getSafeAreaRect(false);
    const safeTopY = safe.y + safe.height - visSize.height / 2;
    const headerGap = safeTopY - screenTopY;
    this.compactHeader = headerGap < Math.max(66, visSize.height * 0.078);
    // 标题放在安全区下 12px，倒计时同行
    const titleY = safeTopY - Math.max(24, visSize.height * 0.03);

    // 隐藏场景旧节点，改用代码动态创建（避免编辑器绑定问题）
    if (this.levelLabel) this.levelLabel.node.active = false;
    if (this.timerLabel) this.timerLabel.node.active = false;
    if (this.approvalLabel) this.approvalLabel.node.active = false;
    if (this.zoneLabel) this.zoneLabel.node.active = false;

    // ── 动态标题 ──
    if (!this.gameTitleNode) {
      this.gameTitleNode = new Node('GameTitle');
      this.gameTitleNode.layer = 1 << 25;
      this.gameTitleNode.parent = this.node;
      this.gameTitleNode.addComponent(UITransform);
      this.gameTitleNode.addComponent(Label);
    }
    const titleLabel = this.gameTitleNode.getComponent(Label)!;
    titleLabel.horizontalAlign = 1; // CENTER
    titleLabel.verticalAlign = 1;
    titleLabel.overflow = Label.Overflow.SHRINK;
    titleLabel.isBold = true;
    this.gameTitleNode.getComponent(UITransform)!.setContentSize(Math.min(visSize.width * 0.72, 520), 44);
    this.gameTitleNode.setPosition(0, titleY, 0);

    if (!this.compactHeader) this.layoutSubtitle(visSize.width, titleY - Math.max(30, visSize.height * 0.035));

    // ── 动态计时器 ──
    if (!this.gameTimerNode) {
      this.gameTimerNode = new Node('GameTimer');
      this.gameTimerNode.layer = 1 << 25;
      this.gameTimerNode.parent = this.node;
      this.gameTimerNode.addComponent(UITransform);
      this.gameTimerNode.addComponent(Label);
    }
    const timerLabel = this.gameTimerNode.getComponent(Label)!;
    timerLabel.horizontalAlign = 2; // RIGHT
    timerLabel.verticalAlign = 1;
    timerLabel.overflow = Label.Overflow.SHRINK;
    timerLabel.isBold = true;
    const timerW = Math.min(visSize.width * 0.28, 240);
    const timerX = Math.min(visSize.width * 0.36, screenWidthPx * 0.38);
    this.gameTimerNode.getComponent(UITransform)!.setContentSize(timerW, 44);
    this.gameTimerNode.setPosition(timerX, titleY, 0);

    // Belt（传送带卡槽）放在标题和状态行之间，卡牌始终限制在显示器内。
    if (this.beltNode) {
      const beltY = (hudTopY + hudBottomY) / 2;
      this.beltNode.setPosition(this.beltNode.position.x, beltY, 0);
      let beltUt = this.beltNode.getComponent(UITransform);
      if (!beltUt) beltUt = this.beltNode.addComponent(UITransform);
      // 6 个卡槽横排，整体宽度不超过屏幕内屏可用宽度
      const beltW = Math.min(screenWidthPx * 0.92, visSize.width * 0.9);
      const beltH = Math.max(92, Math.min((screenTopY - screenBottomY) * 0.42, 150));
      beltUt.setContentSize(beltW, beltH);
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
      const charDisplayH = Math.min(visSize.width * 0.56, visSize.height * 0.35);
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
  }
  /** 副标题固定在主标题与显示器之间，不进入显示器内屏。 */
  private layoutSubtitle(viewWidth: number, y: number): void {
    if (!this.subtitleNode) {
      const node = new Node('Subtitle');
      node.layer = 1 << 25;
      node.addComponent(UITransform);
      const label = node.addComponent(Label);
      label.color = new Color(65, 57, 49, 255);
      label.horizontalAlign = 1;
      label.verticalAlign = 1;
      label.isBold = true;
      label.overflow = Label.Overflow.SHRINK;
      node.parent = this.node;
      this.subtitleNode = node;
    }
    const label = this.subtitleNode.getComponent(Label)!;
    label.string = `第${this.session.currentIndex + 1}关 · ${this.missionTitle()}`;
    label.fontSize = Math.min(20, Math.max(15, viewWidth * .045));
    label.lineHeight = label.fontSize + 5;
    this.subtitleNode.getComponent(UITransform)!.setContentSize(Math.min(viewWidth * .7, 460), 28);
    this.subtitleNode.setPosition(0, y, 0);
    this.subtitleNode.active = this.uiState === 'playing';
  }

  /** 仪表盘专用动态覆盖图层（每帧重绘，状态层不动底图） */
  private hudBarFillNode: Node | null = null;
  private hudScaleMarkNode: Node | null = null;
  /** 文字动态覆盖层（每帧重绘：值、分区、事件） */
  private hudTextLayer: Node | null = null;

  /** 统一仪表盘面板：认可度值 + 分区 + 四段色条 + 事件日志，单一圆角面板。 */
  private layoutLowerHud(viewWidth: number, viewHeight: number): void {
    if (!this.lowerHudNode) {
      const node = new Node('LowerHud');
      node.layer = 1 << 25;
      node.parent = this.node;
      node.addComponent(UITransform);
      node.addComponent(Graphics);

      // 静态层：面板纸底 + 四段色条
      const value = this.makeHudLabel(node, 'ApprovalValue', '', 28, new Color(38, 34, 30, 255));
      value.isBold = true;
      const zone = this.makeHudLabel(node, 'Zone', '', 22, new Color(220, 60, 60, 255));
      zone.isBold = true;
      const evt = this.makeHudLabel(node, 'Event', '', 15, new Color(72, 62, 54, 255));
      evt.overflow = Label.Overflow.CLAMP;
      this.makeHudLabel(node, 'Scale', '猎杀          良好          勉强          危险', 12, new Color(110, 100, 90, 255));
      this.lowerHudNode = node;

      // 动态层：单独的 Graphics 子节点，每帧 clear+redraw，不会污染静态底图
      const fill = new Node('HudBarFill');
      fill.layer = 1 << 25;
      fill.parent = node;
      fill.addComponent(UITransform);
      fill.addComponent(Graphics);
      this.hudBarFillNode = fill;

      // 刻度游标：当前值小三角
      const mark = new Node('HudScaleMark');
      mark.layer = 1 << 25;
      mark.parent = node;
      mark.addComponent(UITransform);
      mark.addComponent(Graphics);
      this.hudScaleMarkNode = mark;
    }

    const btnY = this.propButtons?.position.y ?? -viewHeight / 2 + 150;
    const btnH = Math.min(132, Math.max(104, viewHeight * 0.075));
    const panelY = btnY + btnH / 2 + Math.max(145, viewHeight * 0.17);
    const panelW = Math.min(viewWidth * 0.88, 680);
    const barH = Math.max(38, Math.min(50, viewHeight * 0.050));
    const valueH = 40;
    const eventH = 30;
    const padTop = 18;
    const padBot = 12;
    const gap = 8;
    const panelH = padTop + valueH + gap + barH + gap + 22 + gap + eventH + padBot;

    const node = this.lowerHudNode;
    node.setSiblingIndex(this.node.children.length - 1);
    node.getComponent(UITransform)!.setContentSize(panelW, panelH);
    node.setPosition(0, panelY, 0);

    const g = node.getComponent(Graphics)!;
    g.clear();
    // 面板底纸
    g.fillColor = new Color(252, 246, 237, 255);
    g.strokeColor = new Color(38, 34, 30, 255);
    g.lineWidth = 3;
    g.roundRect(-panelW / 2, -panelH / 2, panelW, panelH, 16);
    g.fill();
    g.stroke();

    // 认可度条（本地坐标，相对于面板中心）
    const barW = panelW - 40;
    const barCY = panelH / 2 - padTop - valueH - gap - barH / 2;
    this.hudBarW = barW; this.hudBarCY = barCY; this.hudBarH = barH;
    g.fillColor = new Color(240, 234, 224, 255);
    g.strokeColor = new Color(48, 43, 38, 255);
    g.lineWidth = 2;
    g.roundRect(-barW / 2, barCY - barH / 2, barW, barH, 10);
    g.fill();
    g.stroke();

    // 四段分区色
    const sc = [new Color(111, 76, 225, 255), new Color(78, 174, 74, 255), new Color(245, 199, 52, 255), new Color(231, 61, 47, 255)];
    const sr = [0.18, 0.31, 0.20, 0.31];
    let sx = -barW / 2 + 4;
    const inset = 4;
    for (let i = 0; i < 4; i++) {
      const sw = (barW - 8) * sr[i];
      g.fillColor = sc[i];
      g.rect(sx, barCY - barH / 2 + inset, sw, barH - inset * 2);
      g.fill();
      sx += sw;
    }

    // 标签位置
    this.placeHudLabel(node, 'ApprovalValue', -barW * 0.16, panelH / 2 - padTop - valueH / 2 + 2, panelW * 0.38, valueH);
    this.placeHudLabel(node, 'Zone', barW * 0.24, panelH / 2 - padTop - valueH / 2 + 2, panelW * 0.22, valueH);
    this.placeHudLabel(node, 'Scale', 0, barCY - barH / 2 - 12, barW, 20);
    this.placeHudLabel(node, 'Event', 0, -panelH / 2 + padBot + eventH / 2, panelW - 28, eventH);

    // 动态覆盖层：与面板同坐标系，铺满整面板
    if (this.hudBarFillNode) {
      this.hudBarFillNode.getComponent(UITransform)!.setContentSize(panelW, panelH);
      this.hudBarFillNode.setPosition(0, 0, 0);
    }
    if (this.hudScaleMarkNode) {
      this.hudScaleMarkNode.getComponent(UITransform)!.setContentSize(panelW, panelH);
      this.hudScaleMarkNode.setPosition(0, 0, 0);
    }

    node.active = this.uiState === 'playing';
  }

  private makeHudLabel(parent: Node, name: string, text: string, size: number, color: Color): Label {
    const node = new Node(name);
    node.layer = 1 << 25;
    node.parent = parent;
    node.addComponent(UITransform);
    const label = node.addComponent(Label);
    label.string = text; label.fontSize = size; label.lineHeight = size + 5; label.color = color;
    label.horizontalAlign = 1; label.verticalAlign = 1; label.overflow = Label.Overflow.SHRINK;
    return label;
  }

  private placeHudLabel(parent: Node, name: string, x: number, y: number, w: number, h: number): void {
    const node = parent.getChildByName(name);
    if (!node) return;
    node.getComponent(UITransform)!.setContentSize(w, h);
    node.setPosition(x, y, 0);
  }

  private updateLowerHud(approval: number, zone: string): void {
    if (!this.lowerHudNode) return;
    // 更新数值与分区文字
    const value = this.lowerHudNode.getChildByName('ApprovalValue')?.getComponent(Label);
    if (value) value.string = `认可度 ← ${approval} →`;
    const label = this.lowerHudNode.getChildByName('Zone')?.getComponent(Label);
    if (label) {
      const map: Record<string, string> = { hunt: '猎杀!', good: '良好', ok: '勉强', danger: '危险!' };
      const zoneColor: Record<string, Color> = {
        hunt: new Color(100, 80, 255),
        good: new Color(80, 180, 80),
        ok: new Color(200, 180, 60),
        danger: new Color(220, 60, 60),
      };
      label.string = map[zone] ?? zone;
      label.color = zoneColor[zone] ?? new Color(45, 40, 35);
    }

    // 动态覆盖图层：每帧 clear 后重绘，不会污染静态四段底色
    if (!this.hudBarFillNode || this.hudBarW <= 0) return;
    const fillG = this.hudBarFillNode.getComponent(Graphics);
    if (!fillG) return;
    const bw = this.hudBarW;
    const bh = this.hudBarH;
    const bcy = this.hudBarCY;
    const pct = Math.max(0, Math.min(1, approval / 100));
    fillG.clear();
    // 已达标部分：蒙半透明黑色 = 让四段分区色变暗，提示"未达"
    fillG.fillColor = new Color(40, 36, 32, 175);
    fillG.rect(-bw / 2 + bw * pct, bcy - bh / 2 + 4, bw * (1 - pct) - 4, bh - 8);
    fillG.fill();
    // 当前值小三角游标
    if (this.hudScaleMarkNode) {
      const markG = this.hudScaleMarkNode.getComponent(Graphics);
      if (markG) {
        markG.clear();
        const x = -bw / 2 + bw * pct;
        markG.fillColor = new Color(30, 26, 22, 255);
        markG.moveTo(x, bcy + bh / 2 + 2);
        markG.lineTo(x - 7, bcy + bh / 2 + 14);
        markG.lineTo(x + 7, bcy + bh / 2 + 14);
        markG.close();
        markG.fill();
      }
    }
  }

  /** 把 Belt 下的 6 个卡槽横向等距重新排布到指定区域内（居中）。 */
  private layoutBeltSlots(totalW: number, slotH: number): void {
    if (!this.beltNode || this.slotNodes.length === 0) return;
    const n = this.slotNodes.length;
    const gap = 8;
    const slotW = (totalW - gap * (n - 1)) / n;
    const cardH = Math.min(slotH, slotW * 1.18);
    const startX = -totalW / 2 + slotW / 2;
    this.slotNodes.forEach((slot: Node, i: number) => {
      let ut = slot.getComponent(UITransform);
      if (!ut) ut = slot.addComponent(UITransform);
      ut.setContentSize(slotW, cardH);
      const label = slot.getComponent(Label);
      if (label) {
        label.fontSize = Math.min(24, slotW * 0.24);
        label.lineHeight = Math.min(30, slotH * 0.28);
        label.overflow = Label.Overflow.SHRINK;
      }
      slot.setPosition(startX + i * (slotW + gap), slot.position.y, 0);

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
    const gap = Math.max(12, viewWidth * 0.016);
    const totalW = Math.min(viewWidth - horizontalPadding * 2, 920);
    const btnW = (totalW - gap * (this.propButtonNodes.length - 1)) / this.propButtonNodes.length;
    const btnH = Math.min(160, Math.max(130, viewHeight * 0.09));
    const startX = -totalW / 2 + btnW / 2;
    // 固定贴底部，留安全距离避开 home indicator
    const y = -viewHeight / 2 + Math.max(250, viewHeight * 0.16);
    this.propButtons.setPosition(0, y, 0);

    this.ensurePropButtonBackgrounds();
    this.propButtonNodes.forEach((btn: Node, i: number) => {
      const x = startX + i * (btnW + gap);
      let ut = btn.getComponent(UITransform);
      if (!ut) ut = btn.addComponent(UITransform);
      ut.setContentSize(btnW, btnH);
      btn.setPosition(x, 0, 0);
      const label = btn.getComponent(Label);
      if (label) {
        label.fontSize = Math.min(18, Math.max(14, btnW * 0.18));
        label.lineHeight = label.fontSize + 4;
        label.overflow = Label.Overflow.SHRINK;
      }

      const bg = this.propButtonBackgrounds[i];
      if (bg) {
        const bgUt = bg.getComponent(UITransform)!;
        bgUt.setContentSize(btnW, btnH);
        bg.setPosition(x, 0, 0);
      }
    });
  }

  /** 背景是按钮的兄弟节点并排在按钮之前，保证不会遮住 Label，也不会污染按钮事件列表。 */
  private ensurePropButtonBackgrounds(): void {
    if (!this.propButtons || this.propButtonBackgrounds.length > 0) return;
    this.propButtonNodes.forEach((_, i: number) => {
      const bg = new Node(`PropBg${i}`);
      bg.layer = 1 << 25;
      bg.addComponent(UITransform);
      bg.addComponent(Graphics);
      this.propButtons!.addChild(bg);
      bg.setSiblingIndex(i);
      this.propButtonBackgrounds.push(bg);
    });
  }

  /** §3.1 类别色（与 cards.json 的 color 字段对应，数据驱动配色铁律在视觉层落地）→ Cocos Color。 */
  private categoryColor(cat: Card['category']): Color {
    switch (getCardDef(cat).color) {
      case 'orange': return new Color(255, 160, 60); // 汇报
      case 'purple': return new Color(180, 100, 255); // 关键
      case 'cyan': return new Color(60, 200, 220); // 提案
      case 'amber': return new Color(255, 180, 40); // 紧急（全场最高威胁，暖色但不撞"返工红"）
      case 'gray': return new Color(120, 120, 120); // 摸鱼
      case 'black': return new Color(40, 40, 40); // Boss
      default: return new Color(80, 160, 255); // blue / 常规
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
