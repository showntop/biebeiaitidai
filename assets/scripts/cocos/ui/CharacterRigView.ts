import { Color, Graphics, Node, Sprite, SpriteFrame, UITransform, UIOpacity } from 'cc';
import { UiTokens } from './UiTokens';

export interface CharacterRigState {
  zone: string;
  phase: string;
  combo: number;
  frozen: boolean;
}

/**
 * 单张角色背影的轻量分层骨架。
 * 根节点留给事件表情 tween，Body 只承担呼吸/紧张等常驻微动，二者互不抢 transform。
 */
export class CharacterRigView {
  private readonly body: Node;
  private readonly shadow: Node;
  private readonly accent: Node;
  private readonly bodySprite: Sprite;
  private readonly shadowOpacity: UIOpacity;
  private readonly accentOpacity: UIOpacity;
  private width = 0;
  private height = 0;
  private time = 0;
  private lastPaintSignature = '';

  constructor(private readonly root: Node, spriteFrame: SpriteFrame) {
    const legacySprite = root.getComponent(Sprite);
    if (legacySprite) legacySprite.enabled = false;

    this.shadow = this.ensureGraphicsNode('CharacterShadow');
    this.shadowOpacity = this.shadow.getComponent(UIOpacity) ?? this.shadow.addComponent(UIOpacity);
    this.body = root.getChildByName('CharacterBody') ?? new Node('CharacterBody');
    if (!this.body.parent) this.body.parent = root;
    this.body.layer = root.layer;
    if (!this.body.getComponent(UITransform)) this.body.addComponent(UITransform);
    this.bodySprite = this.body.getComponent(Sprite) ?? this.body.addComponent(Sprite);
    this.bodySprite.sizeMode = Sprite.SizeMode.CUSTOM;
    this.bodySprite.spriteFrame = spriteFrame;
    this.accent = this.ensureGraphicsNode('CharacterAccent');
    this.accentOpacity = this.accent.getComponent(UIOpacity) ?? this.accent.addComponent(UIOpacity);

    this.shadow.setSiblingIndex(0);
    this.body.setSiblingIndex(1);
    this.accent.setSiblingIndex(2);
  }

  setSpriteFrame(spriteFrame: SpriteFrame): void {
    this.bodySprite.spriteFrame = spriteFrame;
  }

  layout(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.lastPaintSignature = '';
    this.root.getComponent(UITransform)?.setContentSize(width, height);
    this.body.getComponent(UITransform)?.setContentSize(width, height);
    this.body.setPosition(0, 0, 0);
    [this.shadow, this.accent].forEach((node) => {
      node.getComponent(UITransform)?.setContentSize(width * 1.35, height * 1.12);
      node.setPosition(0, 0, 0);
    });
  }

  update(dt: number, state: CharacterRigState): void {
    if (!this.root.active || this.width <= 0 || this.height <= 0) return;
    this.time += Math.max(0, Math.min(dt, 0.05));

    const danger = state.zone === 'danger';
    const hunt = state.zone === 'hunt';
    const crisis = state.phase === 'crisis';
    const comboLift = state.combo >= 5 ? 1 : state.combo >= 3 ? 0.55 : 0;
    const speed = state.frozen ? 0.32 : danger ? 1.75 : crisis ? 1.35 : 1;
    const breath = Math.sin(this.time * Math.PI * 2 * 0.72 * speed);
    const workBeat = crisis && !state.frozen ? Math.sin(this.time * Math.PI * 2 * 3.4) : 0;
    const nerves = danger && !state.frozen ? Math.sin(this.time * Math.PI * 2 * 5.2) : 0;
    const confident = comboLift > 0 && !danger ? Math.max(0, Math.sin(this.time * Math.PI * 2 * 1.7)) : 0;

    const x = nerves * Math.min(1.6, this.width * 0.006);
    const y = breath * Math.min(1.8, this.height * 0.008)
      + workBeat * Math.min(0.8, this.height * 0.003)
      + confident * comboLift * Math.min(2.2, this.height * 0.010);
    const scaleX = 1 + breath * 0.004 + confident * comboLift * 0.008;
    const scaleY = 1 - breath * 0.005 - confident * comboLift * 0.006;
    this.body.setPosition(x, y, 0);
    this.body.setScale(scaleX, scaleY, 1);
    this.body.angle = danger ? nerves * 0.55 : crisis ? workBeat * 0.18 : 0;

    const shadowPulse = 1 - breath * 0.018 - confident * comboLift * 0.025;
    this.shadow.setScale(shadowPulse, 1, 1);
    this.shadowOpacity.opacity = Math.round(state.frozen ? 52 : 70 + Math.max(0, breath) * 12);

    const mode = danger ? 'danger' : hunt ? 'hunt' : crisis ? 'crisis' : comboLift > 0 ? 'combo' : 'calm';
    this.paint(mode);
    const accentPulse = mode === 'danger'
      ? 92 + Math.max(0, nerves) * 105
      : mode === 'hunt' ? 72 + Math.max(0, breath) * 70
        : mode === 'crisis' ? 48 + Math.max(0, workBeat) * 58
          : mode === 'combo' ? 42 + confident * 74
            : 0;
    this.accentOpacity.opacity = Math.round(accentPulse);
  }

  private paint(mode: string): void {
    const signature = `${mode}|${Math.round(this.width)}|${Math.round(this.height)}`;
    if (signature === this.lastPaintSignature) return;
    this.lastPaintSignature = signature;

    const sg = this.shadow.getComponent(Graphics)!;
    sg.clear();
    sg.fillColor = new Color(62, 44, 34, 92);
    sg.ellipse(0, -this.height * 0.43, this.width * 0.42, this.height * 0.055);
    sg.fill();

    const g = this.accent.getComponent(Graphics)!;
    g.clear();
    if (mode === 'calm') return;
    const color = mode === 'danger' ? UiTokens.color.danger
      : mode === 'hunt' ? UiTokens.color.gold
        : mode === 'combo' ? UiTokens.color.good
          : UiTokens.color.orange;
    g.strokeColor = new Color(color.r, color.g, color.b, 220);
    g.fillColor = new Color(color.r, color.g, color.b, 205);
    g.lineWidth = mode === 'danger' ? 3 : 2.2;
    const shoulderY = this.height * 0.10;
    const sideX = this.width * 0.47;
    for (const side of [-1, 1]) {
      g.moveTo(side * sideX, shoulderY + this.height * 0.08);
      g.lineTo(side * (sideX + this.width * 0.10), shoulderY + this.height * 0.13);
      g.moveTo(side * sideX, shoulderY);
      g.lineTo(side * (sideX + this.width * 0.12), shoulderY);
    }
    g.stroke();
    if (mode === 'danger') {
      const sx = this.width * 0.31;
      const sy = this.height * 0.40;
      g.moveTo(sx, sy + 7);
      g.lineTo(sx - 5, sy - 2);
      g.lineTo(sx + 5, sy - 2);
      g.close();
      g.fill();
    } else if (mode === 'hunt' || mode === 'combo') {
      const cy = this.height * 0.43;
      g.circle(-this.width * 0.33, cy, 3.2);
      g.circle(this.width * 0.33, cy + 5, 2.4);
      g.fill();
    }
  }

  private ensureGraphicsNode(name: string): Node {
    const node = this.root.getChildByName(name) ?? new Node(name);
    if (!node.parent) node.parent = this.root;
    node.layer = this.root.layer;
    if (!node.getComponent(UITransform)) node.addComponent(UITransform);
    if (!node.getComponent(Graphics)) node.addComponent(Graphics);
    return node;
  }
}
