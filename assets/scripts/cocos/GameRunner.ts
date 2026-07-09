import { _decorator, Component, Node, Label, Color, UITransform, input, Input, EventKeyboard } from 'cc';
import { Game } from '../core/Game';
import { getLevel, BalanceConfig } from '../core/config';
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

  private session!: Session;
  private game!: Game;
  private readonly dt = 0.05; // 逻辑固定步进
  private accumulator = 0;
  private slotNodes: Node[] = [];
  private scanPos = 0;
  private reported = false; // 本局是否已结算展示（防止重复 finishLevel）
  private uiState: 'select' | 'playing' | 'result' = 'select';
  private levelSelectRoot: Node | null = null;
  private fx: FxLayer | null = null;

  private static readonly PROP_LABELS = ['加需求', '改需求', '丢锅', '拍马屁'];
  private static readonly PROP_TYPES: PropType[] = [PT.AddDemand, PT.ChangeDemand, PT.ThrowPot, PT.KissUp];

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
  }

  onDestroy(): void {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    this.fx?.dispose();
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
    // 结算页：R 重试 / N 下一关 / B 返回选关
    if (this.game.over) {
      if (e.keyCode === 82) this.onRetry(); // R
      else if (e.keyCode === 78) this.onNext(); // N
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
    this.refreshLockState();
    // 动效层：每局重新订阅新 EventBus
    this.fx?.dispose();
    this.fx = new FxLayer(this.game.bus, this.node, this.slotNodes, this.approvalLabel);
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
      this.reportLabel.string = `${stars}\n${meme}\n\n${head}\n段位：${rank} · 入职第${day}天\n[N]下一关 [R]重试 [B]返回选关`;
      this.reportLabel.node.active = true;
    }
    if (this.nextBtn) this.nextBtn.active = this.session.hasNext;
    if (this.retryBtn) this.retryBtn.active = true;
  }

  private hideReport(): void {
    if (this.reportLabel) this.reportLabel.node.active = false;
    if (this.nextBtn) this.nextBtn.active = false;
    if (this.retryBtn) this.retryBtn.active = false;
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
    this.propButtons.children.forEach((btn: Node, i: number) => {
      const label = btn.getComponent(Label);
      if (label) label.string = GameRunner.PROP_LABELS[i] ?? '';
      // 诊断：Cocos 3.x 触摸命中需要 UITransform 包围盒；纯 Node/小 Label 点不到
      const ut = btn.getComponent(UITransform);
      if (!ut) {
        // eslint-disable-next-line no-console
        console.warn(`[GameRunner] 道具按钮[${GameRunner.PROP_LABELS[i]}] 没有 UITransform，触摸命中区为 0 → 点不到。给该节点加 UITransform 并设 Width/Height（如 160×80），建议再加 Sprite 背景 + Button 组件。`);
      } else if (ut.width <= 1 || ut.height <= 1) {
        // eslint-disable-next-line no-console
        console.warn(`[GameRunner] 道具按钮[${GameRunner.PROP_LABELS[i]}] UITransform 尺寸 ${ut.width}×${ut.height} 过小，几乎点不到。设成 160×80 左右。`);
      }
      const type = GameRunner.PROP_TYPES[i];
      btn.on(Node.EventType.TOUCH_START, () => this.onPropDown(type));
      btn.on(Node.EventType.TOUCH_END, () => this.onPropUp(type));
      btn.on(Node.EventType.TOUCH_CANCEL, () => this.onPropCancel(type));
    });
  }

  private bindFlowButtons(): void {
    this.nextBtn?.on(Node.EventType.TOUCH_END, () => this.onNext());
    this.retryBtn?.on(Node.EventType.TOUCH_END, () => this.onRetry());
  }

  private onPropDown(prop: PropType): void {
    if (prop === PT.KissUp) this.game.useKissUp();
    else this.game.beginCharge(prop);
  }
  private onPropUp(prop: PropType): void {
    if (prop !== PT.KissUp) this.game.release(prop);
  }
  private onPropCancel(prop: PropType): void {
    if (prop !== PT.KissUp) this.game.cancel(prop);
  }

  /** 按 §1.2 解锁状态置灰未解锁道具按钮（锁定道具 beginCharge 也会被 core 拒绝，这里是视觉提示）。 */
  private refreshLockState(): void {
    if (!this.propButtons) return;
    this.propButtons.children.forEach((btn: Node, i: number) => {
      const type = GameRunner.PROP_TYPES[i];
      const unlocked = this.game.prop.isUnlocked(type);
      const label = btn.getComponent(Label);
      if (label) label.color = unlocked ? Color.WHITE : new Color(120, 120, 120, 160);
    });
  }

  /* ---------- 渲染 ---------- */

  private render(): void {
    const snap = this.game.getSnapshot();

    if (this.levelLabel) {
      this.levelLabel.string = `${this.session.currentTitle()} | ${this.session.rankLabel} | 入职第${this.session.daysEmployed}天`;
    }
    if (this.approvalLabel) this.approvalLabel.string = `认可度: ${Math.round(snap.approval)}`;
    if (this.zoneLabel) {
      this.zoneLabel.string = snap.zone.toUpperCase();
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
      this.timerLabel.string = this.game.over
        ? `${remain.toFixed(1)}s | ${this.game.result}`
        : `${remain.toFixed(1)}s`;
    }

    const cards = this.game.conveyor.cards;
    for (let i = 0; i < this.slotNodes.length; i++) this.renderSlot(this.slotNodes[i], cards[i] ?? null);

    if (this.scanIndicator) {
      const charging = this.game.prop.chargingProp !== null;
      this.scanIndicator.active = charging;
      if (charging) {
        const idx = Math.min(this.slotNodes.length - 1, Math.floor(this.scanPos * this.slotNodes.length));
        const target = this.slotNodes[idx];
        if (target) this.scanIndicator.setPosition(target.position.x, target.position.y, 0);
      }
    }
  }

  private renderSlot(node: Node, card: Card | null): void {
    const label = node.getComponent(Label);
    if (!label) return;
    if (!card) {
      label.string = '---';
      return;
    }
    let text = '';
    let color = Color.WHITE;
    switch (card.state) {
      case 'active-white':
        text = `${card.category}\n+${card.weight}`;
        color = new Color(80, 160, 255);
        break;
      case 'rework':
        text = `返工\n-${card.weight}`;
        color = new Color(220, 60, 60);
        break;
      case 'inserted':
        text = '杂活\n+0';
        color = new Color(150, 150, 150);
        break;
      case 'idle':
        text = `${card.category}\n摸鱼`;
        color = new Color(120, 120, 120);
        break;
      case 'boss':
        text = 'BOSS\n临检!';
        color = new Color(40, 40, 40);
        break;
    }
    label.string = text;
    label.color = color;
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
