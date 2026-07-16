import { Color, Graphics, Label, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { UiPainter, type KeycapState } from './UiPainter';
import { UiTokens, alphaColor } from './UiTokens';

export interface PropButtonRenderState {
  base: Readonly<Color>;
  state: KeycapState;
  action: string;
  status: string;
  count: string;
  icon: SpriteFrame | null;
  background?: SpriteFrame | null;
}

/**
 * 道具按钮组件：负责完整组件结构和六种状态，不接触玩法系统。
 * GameRunner 只把 uses/cd/unlocked 翻译成 PropButtonRenderState。
 */
export class PropButtonView {
  private readonly countLabel: Label;
  private readonly statusLabel: Label;
  private readonly glyphNode: Node;
  private readonly glyph: Graphics;
  private glyphSize = 0;
  private lastRenderSignature = '';

  constructor(
    private readonly button: Node,
    private readonly background: Node,
    private readonly iconSprite: Sprite,
    private readonly actionLabel: Label,
  ) {
    this.countLabel = this.ensureLabel(background, 'CountText');
    this.statusLabel = this.ensureLabel(background, 'StatusText');
    this.glyphNode = button.getChildByName('PropGlyph') ?? new Node('PropGlyph');
    this.glyphNode.layer = button.layer;
    if (!this.glyphNode.parent) this.glyphNode.parent = button;
    if (!this.glyphNode.getComponent(UITransform)) this.glyphNode.addComponent(UITransform);
    this.glyph = this.glyphNode.getComponent(Graphics) ?? this.glyphNode.addComponent(Graphics);
  }

  layout(x: number, width: number, height: number): void {
    this.lastRenderSignature = '';
    this.button.getComponent(UITransform)?.setContentSize(width, height);
    this.button.setPosition(x, 0, 0);
    this.background.getComponent(UITransform)?.setContentSize(width, height);
    this.background.setPosition(x, 0, 0);
    const bgAsset = this.background.getChildByName('PropBgAsset');
    bgAsset?.getComponent(UITransform)?.setContentSize(width, height);
    bgAsset?.setPosition(0, 0, 0);

    const iconSize = Math.min(width * 0.43, height * 0.48);
    this.iconSprite.node.getComponent(UITransform)?.setContentSize(iconSize, iconSize);
    this.iconSprite.node.setPosition(0, height * 0.18, 0);
    this.glyphSize = iconSize;
    this.glyphNode.getComponent(UITransform)?.setContentSize(iconSize, iconSize);
    this.glyphNode.setPosition(0, height * 0.18, 0);

    this.actionLabel.node.getComponent(UITransform)?.setContentSize(width * 0.86, 34);
    this.actionLabel.node.setPosition(0, -height * 0.25, 0);
    UiPainter.label(this.actionLabel, Math.min(20, Math.max(15, width * 0.15)), UiTokens.color.inkDeep, true);

    this.countLabel.node.getComponent(UITransform)?.setContentSize(width * 0.72, 22);
    this.countLabel.node.setPosition(0, -height * 0.02, 0);
    this.statusLabel.node.getComponent(UITransform)?.setContentSize(width * 0.78, 22);
    this.statusLabel.node.setPosition(0, height * 0.40, 0);
  }

  render(value: PropButtonRenderState): void {
    const signature = [
      value.state,
      value.action,
      value.status,
      value.count,
      `${value.base.r},${value.base.g},${value.base.b},${value.base.a}`,
      value.icon?.uuid ?? '',
      value.background?.uuid ?? '',
    ].join('|');
    if (signature === this.lastRenderSignature) return;
    this.lastRenderSignature = signature;
    const ut = this.background.getComponent(UITransform);
    const g = this.background.getComponent(Graphics);
    const bgSprite = this.background.getChildByName('PropBgAsset')?.getComponent(Sprite)
      ?? this.background.getComponent(Sprite);
    const disabled = value.state === 'locked' || value.state === 'depleted';

    if (bgSprite && value.background) {
      if (g) g.clear();
      bgSprite.spriteFrame = value.background;
      bgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
      bgSprite.enabled = true;
      bgSprite.color = value.state === 'depleted' ? alphaColor(Color.WHITE, 150) : Color.WHITE;
      this.iconSprite.enabled = false;
      this.glyphNode.active = false;
      this.actionLabel.enabled = false;
    } else {
      if (bgSprite) bgSprite.enabled = false;
      if (ut && g) UiPainter.keycap(g, ut.width, ut.height, value.base, value.state);
      // 锁定/用尽不换皮：同一键帽降饱和 + 半透明图标，保持世界观一致。
      // 原始 PNG 是深灰色，Sprite 乘色无法将它提亮成品牌蓝；按钮上改画同形语义线稿。
      // 拖拽中的实体仍保留原素材，按钮符号则与入口页三步图标使用同一蓝色语言。
      this.iconSprite.enabled = false;
      this.glyphNode.active = !!value.icon;
      this.paintGlyph(value.action, value.state);
      this.actionLabel.enabled = true;
    }

    this.actionLabel.string = value.action;
    this.actionLabel.color = disabled ? UiTokens.color.muted : UiTokens.color.inkDeep;
    this.countLabel.string = disabled && value.status ? value.status : value.count;
    UiPainter.label(this.countLabel, UiTokens.type.micro, disabled ? UiTokens.color.muted : alphaColor(UiTokens.color.blue, 220), true);
    const statusBakedIntoAsset = !!value.background && value.state === 'locked';
    this.statusLabel.node.active = !statusBakedIntoAsset && value.status.length > 0 && value.status !== '就绪';
    this.statusLabel.string = value.status;
    UiPainter.label(
      this.statusLabel,
      UiTokens.type.micro,
      disabled ? UiTokens.color.muted : alphaColor(UiTokens.color.ink, 200),
      false,
    );
  }

  private paintGlyph(action: string, state: KeycapState): void {
    const g = this.glyph;
    const s = this.glyphSize;
    const disabled = state === 'locked' || state === 'depleted' || state === 'cooldown';
    const charging = state === 'charging';
    const color = charging ? UiTokens.color.gold : disabled ? UiTokens.color.muted : UiTokens.environment.startBlueDark;
    const a = disabled ? 120 : 255;
    const r = s * 0.42;
    g.clear();
    g.strokeColor = alphaColor(color, a);
    g.fillColor = alphaColor(color, a);
    g.lineWidth = Math.max(3.5, s * 0.10);
    g.lineCap = Graphics.LineCap.ROUND;
    g.lineJoin = Graphics.LineJoin.ROUND;

    if (action === '加需求') {
      g.roundRect(-r * 0.72, -r, r * 1.30, r * 1.78, r * 0.13);
      g.stroke();
      g.moveTo(r * 0.12, r * 0.78);
      g.lineTo(r * 0.58, r * 0.34);
      g.lineTo(r * 0.58, r * 0.78);
      g.stroke();
      g.moveTo(-r * 0.40, -r * 0.25);
      g.lineTo(r * 0.20, -r * 0.25);
      g.moveTo(-r * 0.10, -r * 0.55);
      g.lineTo(-r * 0.10, r * 0.05);
      g.stroke();
      return;
    }
    if (action === '改需求') {
      g.arc(0, 0, r * 0.76, Math.PI * 0.14, Math.PI * 1.05, false);
      g.stroke();
      g.moveTo(-r * 0.76, r * 0.10);
      g.lineTo(-r * 0.78, -r * 0.38);
      g.lineTo(-r * 0.34, -r * 0.24);
      g.stroke();
      g.arc(0, 0, r * 0.76, Math.PI * 1.14, Math.PI * 2.05, false);
      g.stroke();
      g.moveTo(r * 0.76, -r * 0.10);
      g.lineTo(r * 0.78, r * 0.38);
      g.lineTo(r * 0.34, r * 0.24);
      g.stroke();
      return;
    }
    if (action === '甩锅') {
      g.roundRect(-r * 0.78, -r * 0.58, r * 1.56, r * 1.12, r * 0.18);
      g.stroke();
      g.moveTo(-r, r * 0.48);
      g.lineTo(r, r * 0.48);
      g.moveTo(-r * 0.50, r * 0.78);
      g.lineTo(r * 0.50, r * 0.78);
      g.stroke();
      return;
    }
    // 拍马屁：圆润心形，和入口页的友好蓝线稿统一。
    g.moveTo(0, -r * 0.78);
    g.bezierCurveTo(-r * 1.12, -r * 0.12, -r * 0.98, r * 0.82, -r * 0.36, r * 0.82);
    g.bezierCurveTo(-r * 0.04, r * 0.82, 0, r * 0.52, 0, r * 0.52);
    g.bezierCurveTo(0, r * 0.52, r * 0.04, r * 0.82, r * 0.36, r * 0.82);
    g.bezierCurveTo(r * 0.98, r * 0.82, r * 1.12, -r * 0.12, 0, -r * 0.78);
    g.stroke();
  }

  press(down: boolean): void {
    this.button.setScale(down ? 0.96 : 1, down ? 0.92 : 1, 1);
  }

  private ensureLabel(parent: Node, name: string): Label {
    const node = parent.getChildByName(name) ?? new Node(name);
    if (!node.parent) node.parent = parent;
    if (!node.getComponent(UITransform)) node.addComponent(UITransform);
    const label = node.getComponent(Label) ?? node.addComponent(Label);
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    label.enableWrapText = false;
    return label;
  }
}
