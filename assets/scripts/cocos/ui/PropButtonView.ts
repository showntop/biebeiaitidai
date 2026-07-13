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

  constructor(
    private readonly button: Node,
    private readonly background: Node,
    private readonly iconSprite: Sprite,
    private readonly actionLabel: Label,
  ) {
    this.countLabel = this.ensureLabel(background, 'CountText');
    this.statusLabel = this.ensureLabel(background, 'StatusText');
  }

  layout(x: number, width: number, height: number): void {
    this.button.getComponent(UITransform)?.setContentSize(width, height);
    this.button.setPosition(x, 0, 0);
    this.background.getComponent(UITransform)?.setContentSize(width, height);
    this.background.setPosition(x, 0, 0);
    const bgAsset = this.background.getChildByName('PropBgAsset');
    bgAsset?.getComponent(UITransform)?.setContentSize(width, height);
    bgAsset?.setPosition(0, 0, 0);

    const iconSize = Math.min(width * 0.34, height * 0.56);
    this.iconSprite.node.getComponent(UITransform)?.setContentSize(iconSize, iconSize);
    this.iconSprite.node.setPosition(-width * 0.31, height * 0.02, 0);

    this.actionLabel.node.getComponent(UITransform)?.setContentSize(width * 0.58, 34);
    this.actionLabel.node.setPosition(width * 0.16, height * 0.12, 0);
    UiPainter.label(this.actionLabel, Math.min(UiTokens.type.action, width * 0.17), UiTokens.color.inkDeep, true);

    this.countLabel.node.getComponent(UITransform)?.setContentSize(width * 0.58, 24);
    this.countLabel.node.setPosition(width * 0.16, -height * 0.22, 0);
    this.statusLabel.node.getComponent(UITransform)?.setContentSize(width * 0.46, 22);
    this.statusLabel.node.setPosition(width * 0.18, height * 0.34, 0);
  }

  render(value: PropButtonRenderState): void {
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
      this.actionLabel.enabled = false;
    } else {
      if (bgSprite) bgSprite.enabled = false;
      if (ut && g) UiPainter.keycap(g, ut.width, ut.height, value.base, value.state);
      // 锁定/用尽不换皮：同一键帽降饱和 + 半透明图标，保持世界观一致。
      this.iconSprite.spriteFrame = value.icon;
      this.iconSprite.enabled = !!value.icon;
      this.iconSprite.color = disabled ? alphaColor(Color.WHITE, 110) : Color.WHITE;
      this.actionLabel.enabled = true;
    }

    this.actionLabel.string = value.action;
    this.actionLabel.color = disabled ? UiTokens.color.muted : UiTokens.color.inkDeep;
    this.countLabel.string = value.count;
    UiPainter.label(this.countLabel, UiTokens.type.micro, disabled ? UiTokens.color.muted : alphaColor(UiTokens.color.ink, 225), true);
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
