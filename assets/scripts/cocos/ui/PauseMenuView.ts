import { Color, Graphics, Label, Node, UITransform } from 'cc';
import { UiPainter } from './UiPainter';
import { UiTokens } from './UiTokens';

export interface PauseMenuOptions {
  parent: Node;
  layer: number;
  viewWidth: number;
  viewHeight: number;
  automatic: boolean;
  soundEnabled: () => boolean;
  hapticsEnabled: () => boolean;
  reducedMotion: () => boolean;
  toggleSound: () => void;
  toggleHaptics: () => void;
  toggleReducedMotion: () => void;
  resume: () => void;
  retry: () => void;
  returnHome: () => void;
}

/** 暂停面板：设置与离局动作集中在这里，正常游玩只保留一个小暂停键。 */
export class PauseMenuView {
  private root: Node | null = null;

  show(options: PauseMenuOptions): Node {
    this.destroy();
    const root = new Node('PauseMenu');
    root.layer = options.layer;
    root.parent = options.parent;
    root.addComponent(UITransform).setContentSize(options.viewWidth, options.viewHeight);
    root.setPosition(0, 0, 0);

    const scrim = new Node('PauseScrim');
    scrim.layer = options.layer;
    scrim.parent = root;
    scrim.addComponent(UITransform).setContentSize(options.viewWidth, options.viewHeight);
    const sg = scrim.addComponent(Graphics);
    sg.fillColor = new Color(40, 34, 29, 150);
    sg.rect(-options.viewWidth / 2, -options.viewHeight / 2, options.viewWidth, options.viewHeight);
    sg.fill();
    // 吞掉面板外触摸，避免暂停时点穿到底层道具。
    scrim.on(Node.EventType.TOUCH_START, () => {});
    scrim.on(Node.EventType.TOUCH_END, () => {});

    const panel = new Node('PausePanel');
    panel.layer = options.layer;
    panel.parent = root;
    const w = Math.min(options.viewWidth * 0.82, 420);
    const h = Math.min(options.viewHeight * 0.48, 470);
    panel.addComponent(UITransform).setContentSize(w, h);
    panel.setPosition(0, 4, 0);
    const g = panel.addComponent(Graphics);
    g.fillColor = new Color(54, 48, 42, 36);
    g.roundRect(-w / 2 + 5, -h / 2 - 10, w - 10, h, 28);
    g.fill();
    g.fillColor = new Color(255, 252, 246, 255);
    g.strokeColor = new Color(211, 196, 177, 255);
    g.lineWidth = 2;
    g.roundRect(-w / 2, -h / 2, w, h, 28);
    g.fill(); g.stroke();

    const title = this.label(panel, 'PauseTitle', 0, h * 0.34, w - 42, 48);
    UiPainter.label(title, Math.min(32, w * 0.09), UiTokens.color.inkDeep, true);
    title.string = options.automatic ? '已自动暂停' : '工作暂停中';
    const subtitle = this.label(panel, 'PauseSubtitle', 0, h * 0.22, w - 54, 34);
    UiPainter.label(subtitle, UiTokens.type.caption, UiTokens.color.muted);
    subtitle.string = options.automatic ? '回到游戏后，点继续再开工' : '倒计时和任务队列都已停住';

    const toggleY = h * 0.075;
    const toggleW = (w - 78) / 3;
    const toggleStep = toggleW + 8;
    const sound = this.toggle(panel, 'PauseSound', -toggleStep, toggleY, toggleW, 52, '音效', options.soundEnabled, options.toggleSound);
    const haptics = this.toggle(panel, 'PauseHaptics', 0, toggleY, toggleW, 52, '震动', options.hapticsEnabled, options.toggleHaptics);
    const motion = this.toggle(panel, 'PauseMotion', toggleStep, toggleY, toggleW, 52, '动态效果', () => !options.reducedMotion(), options.toggleReducedMotion);
    sound.setSiblingIndex(panel.children.length - 1);
    haptics.setSiblingIndex(panel.children.length - 1);
    motion.setSiblingIndex(panel.children.length - 1);

    this.button(panel, 'PauseResume', 0, -h * 0.095, w - 54, 64, '继续游戏', 'primary', options.resume);
    const smallW = (w - 70) / 2;
    this.button(panel, 'PauseRetry', -smallW / 2 - 8, -h * 0.30, smallW, 52, '重新开始', 'secondary', options.retry);
    this.button(panel, 'PauseHome', smallW / 2 + 8, -h * 0.30, smallW, 52, '返回主页', 'secondary', options.returnHome);

    root.setSiblingIndex(options.parent.children.length - 1);
    this.root = root;
    return root;
  }

  hide(): void {
    if (this.root?.isValid) this.root.active = false;
  }

  destroy(): void {
    if (this.root?.isValid) this.root.destroy();
    this.root = null;
  }

  private toggle(
    parent: Node,
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    text: string,
    enabled: () => boolean,
    onToggle: () => void,
  ): Node {
    const node = new Node(name);
    node.layer = parent.layer;
    node.parent = parent;
    node.addComponent(UITransform).setContentSize(w, h);
    node.setPosition(x, y, 0);
    const g = node.addComponent(Graphics);
    const label = this.label(node, `${name}Label`, 8, 0, w - 34, h - 8);
    UiPainter.label(label, UiTokens.type.caption, UiTokens.color.inkDeep, true);
    label.string = text;
    const paint = (pressed = false) => {
      const on = enabled();
      const accent = on ? UiTokens.color.blue : UiTokens.color.muted;
      g.clear();
      g.fillColor = pressed ? new Color(229, 221, 208, 255) : UiTokens.color.paperMuted;
      g.strokeColor = new Color(accent.r, accent.g, accent.b, on ? 210 : 100);
      g.lineWidth = on ? 2 : 1;
      g.roundRect(-w / 2, -h / 2, w, h, h / 2);
      g.fill(); g.stroke();
      g.fillColor = new Color(accent.r, accent.g, accent.b, on ? 255 : 105);
      g.circle(-w / 2 + 18, 0, on ? 5 : 4);
      g.fill();
      label.color = on ? UiTokens.color.inkDeep : UiTokens.color.muted;
      node.setScale(pressed ? 0.97 : 1, pressed ? 0.97 : 1, 1);
    };
    paint();
    node.on(Node.EventType.TOUCH_START, () => paint(true));
    node.on(Node.EventType.TOUCH_CANCEL, () => paint(false));
    node.on(Node.EventType.TOUCH_END, () => { onToggle(); paint(false); });
    return node;
  }

  private button(
    parent: Node,
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    text: string,
    variant: 'primary' | 'secondary',
    tap: () => void,
  ): Node {
    const node = new Node(name);
    node.layer = parent.layer;
    node.parent = parent;
    node.addComponent(UITransform).setContentSize(w, h + 8);
    node.setPosition(x, y, 0);
    const g = node.addComponent(Graphics);
    const label = this.label(node, `${name}Label`, 0, 3, w - 24, h - 8);
    UiPainter.label(label, variant === 'primary' ? 23 : 19, variant === 'primary' ? Color.WHITE : UiTokens.color.inkDeep, true);
    label.string = text;
    const paint = (pressed = false) => {
      g.clear();
      const face = variant === 'primary' ? UiTokens.color.blue : UiTokens.color.paperMuted;
      g.fillColor = new Color(54, 48, 42, pressed ? 22 : 40);
      g.roundRect(-w / 2 + 4, -h / 2 - (pressed ? 1 : 6), w - 8, h, 16);
      g.fill();
      g.fillColor = face;
      g.strokeColor = variant === 'primary' ? new Color(78, 112, 140, 255) : new Color(188, 171, 151, 255);
      g.lineWidth = 2;
      g.roundRect(-w / 2, -h / 2 + (pressed ? -2 : 1), w, h - 5, 16);
      g.fill(); g.stroke();
      label.node.setPosition(0, pressed ? -2 : 3, 0);
    };
    paint();
    node.on(Node.EventType.TOUCH_START, () => paint(true));
    node.on(Node.EventType.TOUCH_CANCEL, () => paint(false));
    node.on(Node.EventType.TOUCH_END, () => { paint(false); tap(); });
    return node;
  }

  private label(parent: Node, name: string, x: number, y: number, w: number, h: number): Label {
    const node = new Node(name);
    node.layer = parent.layer;
    node.parent = parent;
    node.addComponent(UITransform).setContentSize(w, h);
    node.setPosition(x, y, 0);
    const label = node.addComponent(Label);
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    label.overflow = Label.Overflow.SHRINK;
    return label;
  }
}
