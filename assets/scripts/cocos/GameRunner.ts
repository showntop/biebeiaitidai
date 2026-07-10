import { _decorator, Component, Node, Label, Color, UITransform, tween, Vec3, input, Input, EventKeyboard, Sprite, SpriteFrame, resources, Texture2D, view, Graphics } from 'cc';
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

  private session!: Session;
  private game!: Game;
  private readonly dt = 0.05; // 逻辑固定步进
  private accumulator = 0;
  private slotNodes: Node[] = [];
  private propButtonNodes: Node[] = [];
  private propButtonBackgrounds: Node[] = [];
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
    if (this.bgFillNode) this.bgFillNode.active = v;
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
    // 缓存场景里的 4 个真实按钮。后续会在 Props 下加入背景节点，不能再直接遍历 children。
    this.propButtonNodes = this.propButtons.children.filter((child: Node) => /^Prop\d+$/.test(child.name));
    this.propButtonNodes.forEach((btn: Node, i: number) => {
      const label = btn.getComponent(Label);
      if (label) {
        label.string = GameRunner.PROP_LABELS[i] ?? '';
        label.fontSize = 24;
        label.lineHeight = 28;
        label.overflow = Label.Overflow.SHRINK; // 兜底：万一还超宽，自动缩小字号而非重叠
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
   *  - CD 类：显示剩余冷却秒（就绪时"就绪"）
   *  - 能量类：显示充能百分比（就绪时"就绪"）
   *  - 始终显示剩余次数 ×N
   *  - 颜色：未解锁灰 / 用尽红 / 就绪白 / 充能中暗
   *  core 的 beginCharge 在未解锁/CD 未转/能量未满/用尽时本就会拒绝，这里只是把状态可视化给玩家。
   */
  private renderPropHUD(): void {
    if (!this.propButtons) return;
    this.propButtonNodes.forEach((btn: Node, i: number) => {
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
      // 禁用态仍需可读；用更亮的中灰表达“不可用”，避免灰字压在深底上近乎消失。
      if (!unlocked) label.color = new Color(175, 175, 175, 230);
      else if (st.uses <= 0) label.color = new Color(180, 80, 80);
      else if (st.ready) label.color = Color.WHITE;
      else label.color = new Color(150, 150, 150);
      this.drawPropButtonBackground(i, unlocked, st.uses > 0, st.ready);
    });
  }

  /** 道具按钮底板：把文字从角色/桌面背景中分离出来，同时让禁用、冷却、就绪状态一眼可辨。 */
  private drawPropButtonBackground(index: number, unlocked: boolean, hasUses: boolean, ready: boolean): void {
    const bg = this.propButtonBackgrounds[index];
    if (!bg) return;
    const ut = bg.getComponent(UITransform);
    const g = bg.getComponent(Graphics);
    if (!ut || !g) return;

    const w = ut.width;
    const h = ut.height;
    const fill = !unlocked
      ? new Color(45, 45, 45, 220)
      : !hasUses
        ? new Color(85, 35, 35, 235)
        : ready
          ? new Color(45, 78, 112, 245)
          : new Color(48, 48, 48, 235);
    const stroke = ready && unlocked && hasUses
      ? new Color(120, 205, 255, 255)
      : new Color(115, 115, 115, 220);

    g.clear();
    g.fillColor = fill;
    g.strokeColor = stroke;
    g.lineWidth = 3;
    g.roundRect(-w / 2, -h / 2, w, h, 14);
    g.fill();
    g.stroke();
  }

  /* ---------- 渲染 ---------- */

  private render(): void {
    const snap = this.game.getSnapshot();

    if (this.levelLabel) {
      // currentTitle() 本身已包含"入职第N天"（见各 level-*.json 的 title 字段），
      // 不再重复拼接 daysEmployed，避免出现"入职第1天 | 实习生 | 入职第1天"这种重复文案。
      this.levelLabel.string = `${this.session.currentTitle()} | ${this.session.rankLabel}`;
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
      if (!sprite) {
        sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      }
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
    const statInsetX = Math.min(visSize.width * 0.34, screenWidthPx * 0.36);
    this.layoutHudLabel(this.levelLabel, 0, hudTopY, Math.min(screenWidthPx * 0.72, 680), 44, 26);
    this.layoutHudLabel(this.approvalLabel, -statInsetX, hudBottomY, screenWidthPx * 0.28, 40, 22);
    this.layoutHudLabel(this.timerLabel, 0, hudBottomY, screenWidthPx * 0.22, 40, 22);
    this.layoutHudLabel(this.zoneLabel, statInsetX, hudBottomY, screenWidthPx * 0.28, 40, 22);

    // Belt（传送带卡槽）放在标题和状态行之间，卡牌始终限制在显示器内。
    if (this.beltNode) {
      const beltY = (hudTopY + hudBottomY) / 2;
      this.beltNode.setPosition(this.beltNode.position.x, beltY, 0);
      let beltUt = this.beltNode.getComponent(UITransform);
      if (!beltUt) beltUt = this.beltNode.addComponent(UITransform);
      // 6 个卡槽横排，整体宽度不超过屏幕内屏可用宽度
      const beltW = Math.min(screenWidthPx * 0.92, visSize.width * 0.9);
      const beltH = Math.max(92, Math.min((screenTopY - screenBottomY) * 0.42, 150));
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
    }

    this.layoutPropButtons(visSize.width, visSize.height);
  }

  /** 把 Belt 下的 6 个卡槽横向等距重新排布到指定区域内（居中）。 */
  private layoutBeltSlots(totalW: number, slotH: number): void {
    if (!this.beltNode || this.slotNodes.length === 0) return;
    const n = this.slotNodes.length;
    const gap = 8;
    const slotW = (totalW - gap * (n - 1)) / n;
    const startX = -totalW / 2 + slotW / 2;
    this.slotNodes.forEach((slot: Node, i: number) => {
      let ut = slot.getComponent(UITransform);
      if (!ut) ut = slot.addComponent(UITransform);
      ut.setContentSize(slotW, slotH);
      const label = slot.getComponent(Label);
      if (label) {
        label.fontSize = Math.min(24, slotW * 0.24);
        label.lineHeight = Math.min(30, slotH * 0.28);
        label.overflow = Label.Overflow.SHRINK;
      }
      slot.setPosition(startX + i * (slotW + gap), slot.position.y, 0);
    });
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

  /** 底部独立操作区：4 个宽矮按钮固定贴屏幕最底部（标准手游拇指热区），并为微信 home indicator 留足安全距离。 */
  private layoutPropButtons(viewWidth: number, viewHeight: number): void {
    if (!this.propButtons || this.propButtonNodes.length === 0) return;
    const horizontalPadding = Math.max(32, viewWidth * 0.045);
    const gap = Math.max(12, viewWidth * 0.016);
    const totalW = Math.min(viewWidth - horizontalPadding * 2, 920);
    const btnW = (totalW - gap * (this.propButtonNodes.length - 1)) / this.propButtonNodes.length;
    const btnH = Math.min(112, Math.max(88, viewHeight * 0.055));
    const startX = -totalW / 2 + btnW / 2;
    // 固定贴底部，留安全距离避开 home indicator
    const y = -viewHeight / 2 + Math.max(150, viewHeight * 0.105);
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
        label.fontSize = Math.min(24, btnW * 0.14);
        label.lineHeight = Math.min(28, btnH * 0.27);
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
