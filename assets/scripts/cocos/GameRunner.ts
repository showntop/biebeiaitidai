import { _decorator, Component, Node, Label, Color, UITransform, tween, Vec3, input, Input, EventKeyboard, Sprite, SpriteFrame, resources, Texture2D, view, Graphics, sys, Mask } from 'cc';
import { Game } from '../core/Game';
import { getLevel, BalanceConfig, getCardDef } from '../core/config';
import { SeededRng } from '../core/rng';
import { Session } from '../core/Session';
import type { Storage } from '../core/Session';
import { summarizeReport } from '../core/RunReport';
import { buildReportText } from '../core/profile';
import type { PlayerProfile } from '../core/profile';
import { PropType as PT } from '../core/types';
import type { Card, PropType } from '../core/types';
import { FxLayer } from './FxLayer';

const { ccclass, property } = _decorator;

/**
 * Cocos 表现层薄壳 —— 持有 core.Session + core.Game，只做：驱动 tick、转发输入、按 Session 状态渲染。
 *
 * 关卡流（继续进度 / 选关 / 结算 / 解锁 / 段位 / 战报 / 下一关 / 重试）的可测逻辑全在 core/Session，
 * 这里只把按钮事件翻译成 Session/Game 调用、把 Session 状态反映到节点。
 *
 * 【需在编辑器验证的节点接线】新增节点（相对旧版）：
 *   - LevelLabel (Label)  顶部：当前关标题 + 段位 + 入职第N天
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
  /** 显示器外的顶部/底部 HUD。保持显示器背景与内屏节点不被重绘。 */
  private subtitleNode: Node | null = null;
  private lowerHudNode: Node | null = null;
  private monitorMetaNode: Node | null = null;

  private session!: Session;
  private game!: Game;
  private readonly dt = 0.05; // 逻辑固定步进
  private accumulator = 0;
  private slotNodes: Node[] = [];
  /** 每个卡槽的 Graphics 背景节点（代码画圆角矩形底）。创建/定位见 ensureSlotBackgrounds / layoutBeltSlots。 */
  private slotBackgrounds: Node[] = [];
  private propButtonNodes: Node[] = [];
  private propButtonBackgrounds: Node[] = [];
  private propIconSprites: (Sprite | null)[] = [];
  private scanPos = 0;
  private reported = false; // 本局是否已结算展示（防止重复 finishLevel）
  private uiState: 'select' | 'playing' | 'result' = 'select';
  private levelSelectRoot: Node | null = null;
  private fx: FxLayer | null = null;
  private eventUnsubs: Array<() => void> = [];
  private lastEventText = '事件 · 等待下一条任务';
  private compactHeader = false;

  private static readonly PROP_LABELS = ['加需求', '改需求', '丢锅', '拍马屁'];
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
    this.showLevelSelect(); // M3: 先进选关页，不直接开打

    // 桌面预览键盘兜底（绕过按钮命中区问题，先验证游戏逻辑）
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);

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
    this.fx?.dispose();
    this.clearEventFeed();
  }

  /** 键盘操控：1/2/3 蓄力(松手释放)、4 拍马屁、R 重试、N 下一关、B/Escape 返回选关。 */
  private onKeyDown(e: EventKeyboard): void {
    // 选关页：数字键1-9选关，0=10
    if (this.uiState === 'select') {
      const num = e.keyCode - 48; // '0'=48
      if (num >= 1 && num <= 9) this.onLevelSelected(num - 1);
      else if (num === 0) this.onLevelSelected(9); // '0' = L10
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
    const idx = this.session.currentIndex;
    const seed = (Date.now() % 100000) ^ ((idx + 1) * 2654435761); // 每关/每次尝试不同
    this.game = new Game(getLevel(idx), new SeededRng(seed >>> 0), this.session.allowedPropsFor(idx));
    this.accumulator = 0;
    this.scanPos = 0;
    this.reported = false;
    this.uiState = 'playing';
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
      () => BalanceConfig.phases[this.game.phase].slotPeriodSec,
    );
    this.bindEventFeed();
    // 视觉层：挂背景和（有素材就挂，没有不影响 Label 兜底跑）
    this.applyBgCharSprites();
  }

  /** 事件区只呈现对玩家有意义的最新结果，避免长期显示无效占位文案。 */
  private bindEventFeed(): void {
    this.clearEventFeed();
    const propName = (prop: PropType): string => GameRunner.PROP_LABELS[GameRunner.PROP_TYPES.indexOf(prop)] ?? '道具';
    this.eventUnsubs.push(
      this.game.bus.on('CardHit', ({ prop, slot, quality }) => this.setEventText(`${propName(prop)}命中第${slot + 1}格 · ${quality === 'perfect' ? '精准' : '已处理'}`)),
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

  /* ---------- M3: 关卡选择页 ---------- */

  /** 显示选关页：隐藏游戏 UI，创建/显示选关覆盖层。 */
  private showLevelSelect(): void {
    this.uiState = 'select';
    this.setGameUIVisible(false);
    this.hideReport();
    if (!this.levelSelectRoot) {
      this.levelSelectRoot = this.createLevelSelectUI();
    }
    this.levelSelectRoot.active = true;
    this.updateLevelSelectContent();
  }

  private hideLevelSelect(): void {
    if (this.levelSelectRoot) this.levelSelectRoot.active = false;
  }

  /** 动态创建选关覆盖层（纯代码，不依赖场景节点）。 */
  private createLevelSelectUI(): Node {
    const root = new Node('LevelSelectUI');
    root.layer = 33554432; // UI_2D
    this.node.addChild(root);

    // 标题
    const title = this.mkLabel(root, 'Title', 0, 270, '别让AI替代你', 40, 600, 50);

    // 段位信息行
    this.mkLabel(root, 'RankInfo', 0, 220, '', 24, 700, 35);

    // 关卡列表（20关，每关一行）
    for (let i = 0; i < 20; i++) {
      const y = 180 - i * 32;
      const btn = new Node(`LevelBtn${i}`);
      btn.layer = 33554432;
      const ut = btn.addComponent(UITransform);
      ut.setContentSize(500, 36);
      const label = btn.addComponent(Label);
      label.fontSize = 22;
      label.lineHeight = 30;
      label.horizontalAlign = 1;
      label.verticalAlign = 1;
      label.color = Color.WHITE;
      btn.setPosition(0, y, 0);
      root.addChild(btn);
      // 触摸选关
      btn.on(Node.EventType.TOUCH_END, () => this.onLevelSelected(i));
    }

    // 底部提示
    this.mkLabel(root, 'Hint', 0, -270, '按数字键 1~9 或点击列表选关', 16, 500, 25);

    return root;
  }

  /** 刷新选关页内容（段位/关卡解锁/星级）。 */
  private updateLevelSelectContent(): void {
    if (!this.levelSelectRoot) return;
    const rankInfo = this.levelSelectRoot.getChildByName('RankInfo');
    if (rankInfo) {
      const label = rankInfo.getComponent(Label);
      if (label) {
        label.string = `${this.session.rankLabel} · 入职第${this.session.daysEmployed}天 · 最高解锁：第${this.session.profile.highestUnlockedLevel + 1}关`;
      }
    }
    for (let i = 0; i < 20; i++) {
      const btn = this.levelSelectRoot.getChildByName(`LevelBtn${i}`);
      if (!btn) continue;
      const label = btn.getComponent(Label);
      if (!label) continue;
      const def = getLevel(i);
      const unlocked = this.session.isLevelUnlocked(i);
      const has3 = this.session.profile.star3Levels.includes(i);
      const stars = has3 ? '★★★' : '☆☆☆';
      const lockText = unlocked ? '' : ' [锁]';
      label.string = `第${i + 1}关 ${def.title ?? def.id} ${stars}${lockText}`;
      label.color = unlocked ? Color.WHITE : new Color(100, 100, 100, 160);
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
    if (this.approvalLabel) this.approvalLabel.node.active = v;
    if (this.zoneLabel) this.zoneLabel.node.active = v;
    if (this.timerLabel) this.timerLabel.node.active = v;
    if (this.levelLabel) this.levelLabel.node.active = v;
    // 美术资源（背景/角色）跟随游戏 UI 一起隐藏，避免选关页/结算页时穿透显示
    if (this.bgFillNode) this.bgFillNode.active = v;
    if (this.bgNode) this.bgNode.active = v;
    if (this.charNode) this.charNode.active = v;
    if (this.subtitleNode) this.subtitleNode.active = v;
    if (this.lowerHudNode) this.lowerHudNode.active = v;
    if (this.monitorMetaNode) this.monitorMetaNode.active = v;
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
      const head = summarizeReport(report);
      const meme = buildReportText(this.session.profile, report, idx);
      const rank = this.session.rankLabel;
      const day = this.session.daysEmployed;
      const canRevive = report.result === 'lose' && !this.game.revived;
      const reviveHint = canRevive ? ' [V]复活' : '';
      this.reportLabel.string = `${stars}\n${meme}\n\n${head}\n段位：${rank} · 入职第${day}天\n[N]下一关 [R]重试${reviveHint} [B]返回选关`;
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
      // 文字标签：底部两行（名称 / 状态+次数），overflow 收缩防超宽
      const label = btn.getComponent(Label);
      if (label) {
        label.string = GameRunner.PROP_LABELS[i] ?? '';
        label.fontSize = 20;
        label.lineHeight = 22;
        label.overflow = Label.Overflow.SHRINK;
        label.horizontalAlign = 1;
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
      btn.on(Node.EventType.TOUCH_START, () => this.onPropDown(type));
      btn.on(Node.EventType.TOUCH_END, () => this.onPropUp(type));
      btn.on(Node.EventType.TOUCH_CANCEL, () => this.onPropCancel(type));
    });
  }

  private bindFlowButtons(): void {
    this.nextBtn?.on(Node.EventType.TOUCH_END, () => this.onNext());
    this.retryBtn?.on(Node.EventType.TOUCH_END, () => this.onRetry());
    this.reviveBtn?.on(Node.EventType.TOUCH_END, () => this.onRevive());
  }

  private onPropDown(prop: PropType): void {
    if (prop === PT.KissUp) this.game.useKissUp();
    else this.game.beginCharge(prop);
    this.punchButton(prop, true);
  }
  private onPropUp(prop: PropType): void {
    if (prop !== PT.KissUp) this.game.release(prop);
    this.punchButton(prop, false);
  }
  private onPropCancel(prop: PropType): void {
    if (prop !== PT.KissUp) this.game.cancel(prop);
    this.punchButton(prop, false);
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
   * §4.1 道具 HUD：每帧把 PropSystem.getState() 渲染到 4 个道具按钮。
   *  布局：上半图标 Sprite（有素材时）+ 下半两行文字（名称 / 状态×次数）。
   *  - CD 类：显示剩余冷却秒（就绪时"就绪"）
   *  - 能量类：显示充能百分比（就绪时"就绪"）
   *  - 始终显示剩余次数 ×N
   *  底色按道具功能色（蓝/紫/红/粉）着色；未解锁/用尽压暗，就绪提亮。
   */
  private renderPropHUD(): void {
    if (!this.propButtons) return;
    this.propButtonNodes.forEach((btn: Node, i: number) => {
      const type = GameRunner.PROP_TYPES[i];
      const label = btn.getComponent(Label);
      const st = this.game.prop.getState(type);
      const unlocked = this.game.prop.isUnlocked(type);
      const name = GameRunner.PROP_LABELS[i];
      let line2: string;
      if (!unlocked) line2 = '未解锁';
      else if (st.uses <= 0) line2 = '已用尽';
      else if (st.ready) line2 = '就绪';
      else if (st.acquisition === 'cd') line2 = `${st.cdRemaining.toFixed(1)}s`;
      else line2 = `${Math.round(st.energy * 100)}%`;
      const usesText = !unlocked || type === PT.KissUp ? '' : ` ×${st.uses}`;
      const sf = this.propSfFor(type);
      if (label) {
        label.string = `${name}\n${line2}${usesText}`;
        label.color = !unlocked || st.uses <= 0 ? new Color(115, 110, 105, 255) : new Color(42, 38, 34, 255);
        // Label 就挂在按钮节点本身，不能再移动 label.node（会把整个按钮移回原点）。
        label.horizontalAlign = sf ? 2 : 1;
        label.verticalAlign = 1;
      }
      // 图标：有素材就显示并上移到按钮上半；没素材则隐藏，文字标签居中兜底
      const icon = this.propIconSprites[i];
      const btnUt = btn.getComponent(UITransform);
      const btnW = btnUt?.width ?? 140;
      const btnH = btnUt?.height ?? 96;
      if (icon) {
        if (sf) {
          // 顺序锁死（复刻卡牌 Sprite 的正常模式）：先 setContentSize 固定节点尺寸，
          // 再 sizeMode=CUSTOM，最后赋 spriteFrame。CUSTOM 模式下赋值不会用原图覆盖节点尺寸。
          const ut = icon.node.getComponent(UITransform);
          if (ut) {
            const iconW = Math.min(btnW * 0.48, btnH * 0.52);
            const aspect = sf.originalSize.height > 0 ? sf.originalSize.width / sf.originalSize.height : 1;
            ut.setContentSize(iconW, iconW / aspect);
            icon.node.setPosition(-btnW * 0.22, btnH * 0.05, 0); // 图标靠左，文字在右侧
          }
          icon.sizeMode = Sprite.SizeMode.CUSTOM;
          icon.spriteFrame = sf;
          icon.enabled = true;
        } else {
          icon.enabled = false;
        }
      }
      this.drawPropButtonBackground(i, unlocked, st.uses > 0, st.ready);
    });
  }

  /** 道具按钮统一为浅色功能卡：与黑色线稿图标同一视觉语言，靠彩色描边表达类别。 */
  private drawPropButtonBackground(index: number, unlocked: boolean, hasUses: boolean, ready: boolean): void {
    const bg = this.propButtonBackgrounds[index];
    if (!bg) return;
    const ut = bg.getComponent(UITransform);
    const g = bg.getComponent(Graphics);
    if (!ut || !g) return;

    const w = ut.width;
    const h = ut.height;
    const base = GameRunner.PROP_COLORS[index] ?? new Color(80, 160, 255);

    const inactive = !unlocked || !hasUses;
    const mix = inactive ? 0.87 : ready ? 0.72 : 0.80;
    const fill = new Color(
      Math.round(base.r * (1 - mix) + 250 * mix),
      Math.round(base.g * (1 - mix) + 245 * mix),
      Math.round(base.b * (1 - mix) + 235 * mix),
      255,
    );
    const stroke = inactive
      ? new Color(130, 125, 118, 210)
      : new Color(base.r, base.g, base.b, 255);

    g.clear();
    g.fillColor = fill;
    g.strokeColor = stroke;
    g.lineWidth = ready ? 4 : 3;
    g.roundRect(-w / 2, -h / 2, w, h, 16);
    g.fill();
    g.stroke();
  }

  /* ---------- 渲染 ---------- */

  private render(): void {
    const snap = this.game.getSnapshot();

    if (this.levelLabel) this.levelLabel.string = this.compactHeader
      ? `第${this.session.currentIndex + 1}关 · ${this.session.rankLabel}`
      : '别让AI替代你';
    if (this.approvalLabel) this.approvalLabel.string = `认可度: ${Math.round(snap.approval)}`;
    if (this.zoneLabel) {
      const zoneText: Record<string, string> = {
        hunt: '猎杀区',
        good: '状态良好',
        ok: '勉强',
        danger: '危险!',
      };
      this.zoneLabel.string = zoneText[snap.zone] ?? snap.zone;
      // 分区色对齐视觉规范§1.3：猎杀紫/良好绿/勉强黄/危险红
      const colors: Record<string, Color> = {
        hunt: new Color(100, 80, 255),
        good: new Color(80, 180, 80),
        ok: new Color(200, 200, 80),
        danger: new Color(220, 60, 60),
      };
      this.zoneLabel.color = colors[snap.zone] ?? Color.WHITE;
    }
    if (this.timerLabel) {
      const remain = Math.max(0, snap.duration - snap.elapsed);
      const resultText: Record<string, string> = {
        'win-survive': '生存通关',
        'win-hunt': '猎杀通关',
        lose: '被淘汰',
      };
      this.timerLabel.string = this.game.over
        ? `${remain.toFixed(1)}s · ${resultText[this.game.result] ?? this.game.result}`
        : `${remain.toFixed(1)}s`;
    }
    this.updateLowerHud(Math.round(snap.approval), snap.zone);

    const cards = this.game.conveyor.cards;
    this.ensureSlotBackgrounds();
    for (let i = 0; i < this.slotNodes.length; i++) {
      const c = cards[i] ?? null;
      this.drawCardBackground(i, c);
      this.renderSlot(this.slotNodes[i], c, i);
    }

    if (this.scanIndicator) {
      const charging = this.game.prop.chargingProp !== null;
      this.scanIndicator.active = charging;
      if (charging) {
        const idx = Math.min(this.slotNodes.length - 1, Math.floor(this.scanPos * this.slotNodes.length));
        const target = this.slotNodes[idx];
        if (target) this.scanIndicator.setPosition(target.position.x, target.position.y, 0);
        // 蓄力进度可视化：指示器随 scanPos 0→1 放大，给"蓄满了"的直观反馈
        const s = 0.6 + this.scanPos * 0.8;
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
    const ut = bg.getComponent(UITransform);
    const g = bg.getComponent(Graphics);
    if (!ut || !g) return;
    const w = ut.width;
    const h = ut.height;
    if (w <= 0 || h <= 0) return;
    const base = card
      ? (GameRunner.CARD_BORDER_COLORS[card.category] ?? GameRunner.CARD_BORDER_COLORS.routine)
      : (GameRunner.QUEUE_PREVIEW_COLORS[slotIndex % GameRunner.QUEUE_PREVIEW_COLORS.length] ?? new Color(120, 120, 120));
    const muted = !card;
    const mix = muted ? 0.76 : 0.66;
    const fill = new Color(
      Math.round(base.r * (1 - mix) + 250 * mix),
      Math.round(base.g * (1 - mix) + 246 * mix),
      Math.round(base.b * (1 - mix) + 238 * mix),
      muted ? 220 : 255,
    );
    g.clear();
    g.fillColor = fill;
    g.strokeColor = new Color(base.r, base.g, base.b, muted ? 190 : 255);
    g.lineWidth = muted ? 2.5 : 3.5;
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
      const previewKey = GameRunner.QUEUE_PREVIEW_ART_KEYS[slotIndex % GameRunner.QUEUE_PREVIEW_ART_KEYS.length];
      const preview = this.artSprites.get(previewKey) ?? null;
      if (preview) {
        sprite.spriteFrame = preview;
        sprite.color = new Color(255, 255, 255, 210);
        sprite.enabled = true;
      } else {
        sprite.spriteFrame = null;
        sprite.enabled = false;
      }
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
  private static readonly CHAR_Y_OFFSET = -0.12;

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
    const statInsetX = Math.min(visSize.width * 0.34, screenWidthPx * 0.36);

    // 标题区遵守真实安全区。空间不足时退化成单行关卡标题，绝不被刘海/胶囊裁切。
    const safe = sys.getSafeAreaRect(false);
    const safeTopY = safe.y + safe.height - visSize.height / 2;
    const headerGap = safeTopY - screenTopY;
    this.compactHeader = headerGap < Math.max(66, visSize.height * 0.078);
    if (this.compactHeader) {
      const compactY = screenTopY + Math.max(13, Math.min(28, Math.max(13, headerGap * 0.5)));
      this.layoutHudLabel(this.levelLabel, 0, compactY, Math.min(visSize.width * 0.62, 420), 28, 17);
      if (this.subtitleNode) this.subtitleNode.active = false;
    } else {
      const mainTitleY = screenTopY + Math.max(42, visSize.height * 0.05);
      this.layoutHudLabel(this.levelLabel, 0, mainTitleY, Math.min(visSize.width * 0.72, 520), 36, 28);
      this.layoutSubtitle(visSize.width, screenTopY + Math.max(16, visSize.height * 0.02));
    }
    if (this.levelLabel) { this.levelLabel.color = new Color(55, 48, 42, 255); this.levelLabel.isBold = true; }
    this.layoutMonitorMeta(screenTopY, screenWidthPx, visSize.width);
    // 状态行上移到显示器内部安全带，避开角色天线与头部。
    const statY = hudBottomY + Math.min(64, (screenTopY - screenBottomY) * 0.14);
    this.layoutHudLabel(this.approvalLabel, -statInsetX, statY, screenWidthPx * 0.28, 36, 19);
    this.layoutHudLabel(this.timerLabel, 0, statY, screenWidthPx * 0.22, 36, 19);
    this.layoutHudLabel(this.zoneLabel, statInsetX, statY, screenWidthPx * 0.28, 36, 19);

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
      // 不用 Mask 裁剪（在本项目/引擎版本下不可靠，且 shift 动画中移动的卡片会被误裁）。
      // 出队"被显示器吞没"效果改用 FxLayer.spawnOutgoingGhost 的逐帧收窄矩形实现，不依赖 Mask。
      const oldMask = this.beltNode.getComponent(Mask);
      if (oldMask) oldMask.destroy();
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
  }

  /** 显示器内只保留一条任务流说明，填补空屏但不重绘显示器美术。 */
  private layoutMonitorMeta(screenTopY: number, screenWidth: number, viewWidth: number): void {
    if (!this.monitorMetaNode) {
      const node = new Node('MonitorMeta');
      node.layer = 1 << 25;
      node.parent = this.node;
      node.addComponent(UITransform);
      const label = node.addComponent(Label);
      label.string = 'AI 显示器 · 任务流';
      label.color = new Color(220, 220, 214, 235);
      label.horizontalAlign = 1;
      label.verticalAlign = 1;
      label.isBold = true;
      label.overflow = Label.Overflow.SHRINK;
      this.monitorMetaNode = node;
    }
    const label = this.monitorMetaNode.getComponent(Label)!;
    label.fontSize = Math.min(18, Math.max(14, viewWidth * 0.04));
    label.lineHeight = label.fontSize + 4;
    this.monitorMetaNode.getComponent(UITransform)!.setContentSize(Math.min(screenWidth * 0.6, 380), 28);
    this.monitorMetaNode.setPosition(0, screenTopY - Math.max(24, viewWidth * 0.055), 0);
    this.monitorMetaNode.active = this.uiState === 'playing';
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
    label.string = `第${this.session.currentIndex + 1}关 · ${this.session.rankLabel}`;
    label.fontSize = Math.min(20, Math.max(15, viewWidth * .045));
    label.lineHeight = label.fontSize + 5;
    this.subtitleNode.getComponent(UITransform)!.setContentSize(Math.min(viewWidth * .7, 460), 28);
    this.subtitleNode.setPosition(0, y, 0);
    this.subtitleNode.active = this.uiState === 'playing';
  }

  /** 下方认可度与事件区：采用同一宽度、中心线和间距，和道具区形成清晰的三段式结构。 */
  private layoutLowerHud(viewWidth: number, viewHeight: number): void {
    if (!this.lowerHudNode) {
      const node = new Node('LowerHud');
      node.layer = 1 << 25;
      node.parent = this.node;
      node.addComponent(UITransform);
      const graphics = node.addComponent(Graphics);
      const value = this.makeHudLabel(node, 'ApprovalValue', '认可度 40', 18, new Color(45, 40, 35, 255));
      value.isBold = true;
      const zone = this.makeHudLabel(node, 'Zone', '当前：良好', 16, new Color(45, 40, 35, 255));
      zone.isBold = true;
      this.makeHudLabel(node, 'Scale', '0        18        49        69       100', 13, new Color(55, 50, 45, 255));
      this.makeHudLabel(node, 'Event', this.lastEventText, 16, new Color(55, 50, 45, 255));
      graphics.clear();
      this.lowerHudNode = node;
    }
    const btnY = this.propButtons?.position.y ?? -viewHeight / 2 + 150;
    const btnH = Math.min(132, Math.max(104, viewHeight * 0.075));
    const barY = btnY + btnH / 2 + Math.max(160, viewHeight * 0.18);
    const width = Math.min(viewWidth * 0.9, 720);
    const barH = Math.max(34, Math.min(48, viewHeight * 0.046));
    const node = this.lowerHudNode;
    node.setSiblingIndex(this.node.children.length - 1);
    node.getComponent(UITransform)!.setContentSize(width, barH + 115);
    node.setPosition(0, barY, 0);
    const g = node.getComponent(Graphics)!;
    g.clear();
    // 认可度条
    g.fillColor = new Color(252, 247, 238, 255);
    g.strokeColor = new Color(38, 34, 30, 255);
    g.lineWidth = 3;
    g.roundRect(-width / 2, -barH / 2, width, barH, 12);
    g.fill(); g.stroke();
    const colors = [new Color(111, 76, 225, 255), new Color(78, 174, 74, 255), new Color(245, 199, 52, 255), new Color(231, 61, 47, 255)];
    const ratios = [.18, .31, .20, .31]; let x = -width / 2 + 4;
    ratios.forEach((ratio, index) => { const w = (width - 8) * ratio; g.fillColor = colors[index]; g.rect(x, -barH / 2 + 4, w, barH - 8); g.fill(); x += w; });
    // 事件条与进度条同宽、左边缘对齐。
    const eventH = 38;
    const eventY = barY - (barH / 2 + 70);
    g.fillColor = new Color(252, 247, 238, 250);
    g.strokeColor = new Color(48, 43, 38, 255);
    g.lineWidth = 2;
    g.roundRect(-width / 2, eventY - barY - eventH / 2, width, eventH, 9);
    g.fill(); g.stroke();
    this.placeHudLabel(node, 'ApprovalValue', -width * .27, barH + 16, 120, 28);
    this.placeHudLabel(node, 'Zone', width * .27, barH + 16, 120, 28);
    this.placeHudLabel(node, 'Scale', 0, -barH / 2 - 18, width, 24);
    this.placeHudLabel(node, 'Event', 0, eventY - barY, width - 22, eventH - 4);
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
    const value = this.lowerHudNode.getChildByName('ApprovalValue')?.getComponent(Label);
    if (value) value.string = `认可度 ${approval}`;
    const label = this.lowerHudNode.getChildByName('Zone')?.getComponent(Label);
    if (label) {
      const map: Record<string, string> = { hunt: '猎杀', good: '良好', ok: '勉强', danger: '危险' };
      label.string = `当前：${map[zone] ?? zone}`;
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
   *  按钮高度加高一档以容纳图标 + 两行文字（视觉规范§3 道具按钮 160×80 比例方向）。 */
  private layoutPropButtons(viewWidth: number, viewHeight: number): void {
    if (!this.propButtons || this.propButtonNodes.length === 0) return;
    const horizontalPadding = Math.max(28, viewWidth * 0.04);
    const gap = Math.max(12, viewWidth * 0.016);
    const totalW = Math.min(viewWidth - horizontalPadding * 2, 920);
    const btnW = (totalW - gap * (this.propButtonNodes.length - 1)) / this.propButtonNodes.length;
    const btnH = Math.min(132, Math.max(104, viewHeight * 0.075));
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
