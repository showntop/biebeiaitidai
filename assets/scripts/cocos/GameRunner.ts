import { _decorator, Component, Node, Label, Color, UITransform, tween, Vec3, input, Input, EventKeyboard, Sprite, SpriteFrame, resources, Texture2D, view } from 'cc';
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
  private bgNode: Node | null = null;
  private charNode: Node | null = null;

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

    // 美术资源自动加载：扫描 resources/art/ 下所有 PNG，按文件名建索引
    // 加载完成后自动建 Bg/Char 节点并接线，编辑器里无需任何手动操作
    this.loadArtAssets();
  }

  /** 扫描 resources/art/ 加载所有图片，按文件名建索引。 */
  private loadArtAssets(): void {
    // eslint-disable-next-line no-console
    console.log('[GameRunner] loadArtAssets: 开始扫描 resources/art/ ...');
    // getDirWithPath 同步拿到 art/ 下所有 Texture2D 的 {path, uuid} 列表（不会丢路径信息）
    const infos = (resources as any).getDirWithPath?.('art', Texture2D) ?? [];
    // eslint-disable-next-line no-console
    console.log(`[GameRunner] getDirWithPath 找到 ${infos.length} 张 Texture2D：`, infos.map((i: any) => i.path));
    if (infos.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[GameRunner] 没找到任何 Texture2D → 请检查 resources/art/ 下是否有 PNG 文件且 .meta 已生成');
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
          // 路径形如 "art/bg/bg-office/texture" —— 末段是子资产名 "texture"，取倒数第二段才是文件名
          const parts = info.path.split('/');
          const name = (parts[parts.length - 2] || '').replace(/_/g, '-');
          this.artSprites.set(name, sf);
          // eslint-disable-next-line no-console
          console.log(`[GameRunner]  loaded: ${name}`);
        }
        if (remaining === 0) {
          // eslint-disable-next-line no-console
          console.log(`[GameRunner] 美术资源已加载 ${this.artSprites.size} 张：`, Array.from(this.artSprites.keys()));
          this.applyBgCharSprites();
        }
      });
    }
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
    this.fx = new FxLayer(this.game.bus, this.node, this.slotNodes, this.approvalLabel);
    // 视觉层：挂背景和（有素材就挂，没有不影响 Label 兜底跑）
    this.applyBgCharSprites();
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
    if (this.bgNode) this.bgNode.active = v;
    if (this.charNode) this.charNode.active = v;
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
    // 统一重排：场景原始间距只有 120px/字号 40，四字中文按钮必然重叠。
    // 不改场景文件（避免动 UUID 引用），运行时按钮数统一重新算间距+字号+尺寸。
    const n = this.propButtons.children.length;
    const btnW = 150, gap = 24;
    const totalW = n * btnW + (n - 1) * gap;
    const startX = -totalW / 2 + btnW / 2;
    this.propButtons.children.forEach((btn: Node, i: number) => {
      const label = btn.getComponent(Label);
      if (label) {
        label.string = GameRunner.PROP_LABELS[i] ?? '';
        label.fontSize = 22; // 40 太大，四字中文在150宽按钮里也会挤，降到22
        label.lineHeight = 24;
        label.overflow = Label.Overflow.SHRINK; // 兜底：万一还超宽，自动缩小字号而非重叠
      }
      let ut = btn.getComponent(UITransform);
      if (!ut) ut = btn.addComponent(UITransform);
      ut.setContentSize(btnW, 80);
      btn.setPosition(startX + i * (btnW + gap), btn.position.y, 0);
      const type = GameRunner.PROP_TYPES[i];
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
    if (!this.propButtons) return;
    const i = GameRunner.PROP_TYPES.indexOf(prop);
    const btn = this.propButtons.children[i];
    if (!btn) return;
    const s = down ? 0.92 : 1;
    tween(btn).to(0.05, { scale: new Vec3(s, s, 1) }).start();
  }

  /**
   * §4.1 道具 HUD：每帧把 PropSystem.getState() 渲染到 4 个道具按钮。
   *  - CD 类：显示剩余冷却秒（就绪时"就绪"）
   *  - 能量类：显示充能百分比（就绪时"就绪"）
   *  - 始终显示剩余次数 ×N
   *  - 颜色：未解锁灰 / 用尽红 / 就绪白 / 充能中暗
   *  core 的 beginCharge 在未解锁/CD 未转/能量未满/用尽时本就会拒绝，这里只是把状态可视化给玩家。
   */
  private renderPropHUD(): void {
    if (!this.propButtons) return;
    this.propButtons.children.forEach((btn: Node, i: number) => {
      const type = GameRunner.PROP_TYPES[i];
      const label = btn.getComponent(Label);
      if (!label) return;
      const st = this.game.prop.getState(type);
      const unlocked = this.game.prop.isUnlocked(type);
      const name = GameRunner.PROP_LABELS[i];
      let line2: string;
      if (!unlocked) line2 = '未解锁';
      else if (st.uses <= 0) line2 = '已用尽';
      else if (st.ready) line2 = '就绪';
      else if (st.acquisition === 'cd') line2 = `${st.cdRemaining.toFixed(1)}s`;
      else line2 = `${Math.round(st.energy * 100)}%`;
      label.string = `${name}\n${line2}\n×${st.uses}`;
      if (!unlocked) label.color = new Color(100, 100, 100, 160);
      else if (st.uses <= 0) label.color = new Color(180, 80, 80);
      else if (st.ready) label.color = Color.WHITE;
      else label.color = new Color(150, 150, 150);
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
        // 蓄力进度可视化：指示器随 scanPos 0→1 放大，给"蓄满了"的直观反馈
        const s = 0.6 + this.scanPos * 0.8;
        this.scanIndicator.setScale(s, s, 1);
      }
    }

    this.renderPropHUD();
  }

  private renderSlot(node: Node, card: Card | null): void {
    const label = node.getComponent(Label);
    let sprite = node.getComponent(Sprite);

    // 有空槽 → 清空
    if (!card) {
      if (label) label.string = '---';
      if (sprite) { sprite.spriteFrame = null; sprite.enabled = false; }
      if (label) label.enabled = true;
      return;
    }

    // 尝试用卡牌图（有素材就用，没有就 Label 兜底）
    const sf = this.cardSfFor(card.category);
    if (sf) {
      if (!sprite) sprite = node.addComponent(Sprite);
      sprite.spriteFrame = sf;
      sprite.enabled = true;
      if (label) label.enabled = false; // 有图就隐藏文字（用 enabled 而非 node.active，避免连 Sprite 一起隐藏）
      return;
    }

    // 无素材 → Label 兜底
    if (sprite) { sprite.spriteFrame = null; sprite.enabled = false; }
    if (label) label.enabled = true;
    if (!label) return;
    let text = '';
    let color = Color.WHITE;
    switch (card.state) {
      case 'active-white':
        text = `${card.category}\n+${card.weight}`;
        color = this.categoryColor(card.category);
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

  /** 卡牌类别 → SpriteFrame 映射（null = 没素材，走 Label 兜底）。 */
  private cardSfFor(cat: Card['category']): SpriteFrame | null {
    // 按文件名约定：card-routine.png → 查 "card-routine"
    return this.artSprites.get(`card-${cat}`) ?? null;
  }

  /** 背景图实测比例常量（用 Python/PIL 逐像素扫描 bg-office.png 得出，1088×1920）：
   *  显示器内屏区域：y ∈ [21.9%, 50.3%]（从图顶算，下同）；显示器左右边界：x ∈ [6.8%, 93.0%]；
   *  显示器支架：y ∈ [50.3%, 62.2%]；桌面起始线：y = 62.2%。
   *  （比例以图片"顶部为0%、底部为100%"计。） */
  private static readonly BG_SCREEN_TOP = 0.219;
  private static readonly BG_SCREEN_BOTTOM = 0.503;
  private static readonly BG_SCREEN_LEFT = 0.068;
  private static readonly BG_SCREEN_RIGHT = 0.930;
  private static readonly BG_DESK_TOP = 0.622;

  /** 角色图实测比例常量（char-back.png，1024×1024，透明底）：
   *  头顶：y=3.9%；手臂/键盘高度带：y ∈ [42%, 49%]；椅子底部：y=93.8%。 */
  private static readonly CHAR_HEAD_TOP = 0.039;
  private static readonly CHAR_HANDS_Y = 0.46;
  // 椅子底部 y=93.8%（备用：后续若需按椅子底部对齐桌面线可参考此值，暂未使用）

  /** 背景竖直方向额外放大系数（overscan/zoom）。
   *  背景图宽高比(1088:1920)与屏幕视口宽高比接近，纯 cover 时缩放比恰好由"高度"决定，
   *  缩放后图片高度正好等于屏幕高度 —— 竖直方向零冗余，此时无论顶部对齐还是底部对齐，
   *  图片位置都完全相同（这是之前"改了底部对齐却毫无变化"的真正原因）。
   *  必须先把图片多放大一点，制造出竖直方向的裁切余量，再底部对齐把多余部分裁在顶部
   *  （裁掉墙面留白），显示器才会真正往上移。数值越大，显示器越靠上（同时左右裁掉更多墙面）。
   *  可按实际效果继续调（1.0=不生效，建议范围 1.05~1.3）。 */
  private static readonly BG_ZOOM = 1.15;

  /** 挂背景 + 角色 Sprite，位置按背景图实测比例动态计算（不再猜固定像素）。
   *  策略：背景先按 "cover"（宽高缩放比取较大值）算出基础缩放，再乘以 BG_ZOOM 制造竖直裁切余量；
   *  缩放后图片的【底部】贴住屏幕底部（桌面/地板贴底），多出的高度全部从顶部裁掉——
   *  即裁掉多余的墙面留白，使显示器自然更靠近屏幕顶部（实测反馈：显示器应再靠上）。
   *  再用上面测出的比例常量反算出显示器/桌面在当前屏幕上的像素位置，把 Belt/Char/Props 对齐上去。 */
  private applyBgCharSprites(): void {
    const LAYER_2D = 1 << 25; // UI_2D
    const visSize = view.getVisibleSize();
    const bgSf = this.artSprites.get('bg-office');
    if (!bgSf) return;

    const texSize = bgSf.originalSize; // 原图像素尺寸，如 1088×1920
    // cover：取宽/高两个缩放比中较大的一个，保证缩放后图片同时 >= 屏幕宽和屏幕高（不露灰边/黑边）
    const coverScale = Math.max(visSize.width / texSize.width, visSize.height / texSize.height);
    const scale = coverScale * GameRunner.BG_ZOOM; // 额外放大，制造竖直裁切余量（否则底部对齐等于无效）
    const bgDisplayH = texSize.height * scale; // 缩放后背景图的显示高度
    // 底部对齐：图片底边贴住屏幕底边，多出的高度全部裁在顶部（裁掉墙面留白，显示器随之上移）
    const bgBottomY = -visSize.height / 2;
    const bgCenterY = bgBottomY + bgDisplayH / 2;
    const bgTopY = bgCenterY + bgDisplayH / 2; // 缩放后图片顶部的世界坐标（可能高于屏幕顶部，属正常裁切）

    if (!this.bgNode) {
      this.bgNode = new Node('Bg');
      this.bgNode.layer = LAYER_2D;
      this.bgNode.parent = this.node;
      const ut = this.bgNode.addComponent(UITransform);
      const sprite = this.bgNode.addComponent(Sprite);
      sprite.sizeMode = Sprite.SizeMode.CUSTOM; // 必须先设，避免被 spriteFrame 赋值时的自动尺寸覆盖
      sprite.spriteFrame = bgSf;
      ut.setContentSize(texSize.width * scale, bgDisplayH); // cover：宽高都按等比缩放后的尺寸
      this.bgNode.setSiblingIndex(0); // 放到最底层
      this.bgNode.active = this.uiState === 'playing';
    }
    this.bgNode.setPosition(0, bgCenterY, 0); // 每次调用都刷新（防止 visSize 变化，比如窗口 resize）

    // 用比例常量反算显示器屏幕区域在当前屏幕坐标系下的像素位置
    // 背景图顶部世界坐标 = bgTopY；某比例 p 处的世界 y = bgTopY - p * bgDisplayH
    const screenTopY = bgTopY - GameRunner.BG_SCREEN_TOP * bgDisplayH;
    const screenBottomY = bgTopY - GameRunner.BG_SCREEN_BOTTOM * bgDisplayH;
    const screenCenterY = (screenTopY + screenBottomY) / 2;
    const screenWidthPx = (GameRunner.BG_SCREEN_RIGHT - GameRunner.BG_SCREEN_LEFT) * visSize.width;
    const deskTopY = bgTopY - GameRunner.BG_DESK_TOP * bgDisplayH;

    // Belt（传送带卡槽）对齐到显示器屏幕纵向居中位置，横向宽度收窄到屏幕内屏宽度的~90%
    if (this.beltNode) {
      this.beltNode.setPosition(this.beltNode.position.x, screenCenterY, 0);
      let beltUt = this.beltNode.getComponent(UITransform);
      if (!beltUt) beltUt = this.beltNode.addComponent(UITransform);
      // 6 个卡槽横排，整体宽度不超过屏幕内屏可用宽度
      const beltW = Math.min(screenWidthPx * 0.92, visSize.width * 0.9);
      this.layoutBeltSlots(beltW);
    }

    // 角色：头顶贴着显示器支架底部一点点（screenBottomY 往下一点），按角色图头顶比例反算 contentSize
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
        this.charNode.setSiblingIndex(1);
        this.charNode.active = this.uiState === 'playing';
      }
      // 角色高度：从"显示器支架底部(screenBottomY)"到"桌面线(deskTopY)"的空间容纳角色的
      // 手部以上部分即可（背影主要露头+肩），按角色图头顶(3.9%)到手部(46%)这段占角色总高的 (46-3.9)%
      // 反过来推：想要"头到手"这段在屏幕上显示 gapH 像素，则角色总高 = gapH / (0.46-0.039)
      const gapH = Math.max(60, screenBottomY - deskTopY - 10); // 支架底部到桌面的可用间隙，留10px边距
      const charDisplayH = gapH / (GameRunner.CHAR_HANDS_Y - GameRunner.CHAR_HEAD_TOP);
      const charDisplayW = charDisplayH; // char-back.png 是 1:1 正方形
      const charUt = this.charNode.getComponent(UITransform)!;
      charUt.setContentSize(charDisplayW, charDisplayH);
      // 角色图片顶部边缘（透明画布边界，非头顶本身）对齐到 screenBottomY 下方一点（紧贴显示器支架底部）
      const charTopEdgeY = screenBottomY - 6;
      this.charNode.setPosition(0, charTopEdgeY - charDisplayH / 2, 0);
    }
  }

  /** 把 Belt 下的 6 个卡槽横向等距重新排布到指定总宽度内（居中）。 */
  private layoutBeltSlots(totalW: number): void {
    if (!this.beltNode || this.slotNodes.length === 0) return;
    const n = this.slotNodes.length;
    const gap = 8;
    const slotW = (totalW - gap * (n - 1)) / n;
    const startX = -totalW / 2 + slotW / 2;
    this.slotNodes.forEach((slot: Node, i: number) => {
      let ut = slot.getComponent(UITransform);
      if (!ut) ut = slot.addComponent(UITransform);
      if (ut.width > slotW) ut.setContentSize(slotW, ut.height); // 只收窄，不强行放大
      slot.setPosition(startX + i * (slotW + gap), slot.position.y, 0);
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
