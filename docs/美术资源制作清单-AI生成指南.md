# 美术资源制作清单（执行版·照抄）

> 每个资产给：**工具 / 参考图 / 完整提示词(直接复制) / 尺寸**。
> 默认工具 **GPT-image**（Nano Banana 用同样提示词；即梦可贴英文或翻中文）。
> 顺序：**先做【资产0 角色锚】→ 再做【资产1 表情】（用角色锚当参考）→ 其余顺序随意**。

## 可用的参考图（在 `assets/art/style-lock/`）

| 用途 | 文件 |
|---|---|
| 风格参考（卡牌/道具/叠层/背景/特效/角色锚都用它锁调性） | `Flat_cartoon_vector_game_asset_...16-57-26.png`（紧急任务卡那张） |
| 道具样式参考 | `Flat_cartoon_vector_game_asset_...16-57-27.png`（丢锅那张） |
| 特效样式参考 | `Flat_cartoon_vector_game_effec_...16-57-28.png`（撞击爆发那张） |
| 角色参考（表情专用） | 你自己生成的【资产0 角色锚】 |

> 用法：GPT-image / Nano 上传参考图作"风格/角色参考"输入；即梦用「风格参考图」「角色参考图」功能上传。

---

## 卡牌/按钮 = 代码画底 + 纯图标（架构级优化，务必先看）

> **起因**：实测发现卡牌(资产2)、道具按钮(资产3)当前都是 AI 把「圆角矩形边框 + 填充底 + 居中图标」整张烤死成一张图（每张 150~600KB）。这有三个硬伤：① AI 出图的圆角半径/边框粗细/内边距**不可能像素级一致**，8 张卡牌排在一起会参差不齐；② 换主题色 / 调圆角必须重新出图；③ 体积大、复用性差（同图标没法用于不同尺寸的技能栏/通知）。

**新原则（推荐，从此为准）：卡牌和按钮的「背景框」由 Cocos 代码用 `Graphics` 组件运行时绘制，美术资产只出「纯图标」（透明底、无卡片、无边框、无填充）。**

分层结构：
```
卡牌节点 = Graphics(代码画圆角矩形底：fillColor 填充 + borderColor 描边)
         + Sprite(图标子节点，居中，只有这一层是美术图)
         + Label(权重数字，代码叠加)
```

**收益**：
- **几何 100% 一致**：圆角半径、边框粗细、图标内边距全由常量控制，8 张卡天生对齐。
- **换肤零成本**：改一行颜色常量即可，不重新出图。
- **图标资产极简**：AI 只画「纯符号」，提示词简单、出错率低（不用再纠结卡片比例/圆角）。
- **体积/复用**：纯图标 ~50KB，且同图标可用于任意尺寸场景。

**代码实现示意**（GameRunner 接入时按此模式）：
```typescript
// 卡牌配置：背景色由代码持有，icon 只是纯符号 SpriteFrame
const CARD_STYLE = {
  routine:  { border: '#50A0FF', fill: '#F5F0E8', icon: 'card-doc-blue-a' },
  urgent:   { border: '#FFB428', fill: '#F5F0E8', icon: 'card-alarm' },
  proposal: { border: '#3CC8DC', fill: '#F5F0E8', icon: 'card-idea' },
  meeting:  { border: '#787878', fill: '#F5F0E8', icon: 'card-coffee' },
  // ...
};

function drawCardBg(g: Graphics, style: CardStyle, w: number, h: number): void {
  const r = 16;                       // 圆角半径（全局统一）
  g.clear();
  g.roundRect(-w / 2, -h / 2, w, h, r);
  g.fillColor = new Color().fromHEX(style.fill);
  g.fill();
  g.lineWidth = 4;                    // 边框粗细（全局统一）
  g.strokeColor = new Color().fromHEX(style.border);
  g.roundRect(-w / 2, -h / 2, w, h, r);
  g.stroke();
}
```

> **例外**：本策略针对「规则形状底 + 图标」类资产（卡牌、技能按钮、事件日志图标）。角色/背景/特效等**不规则/整图**资产不适用，仍按各自章节走。

---

## 免费开源图标库（可替代 AI 出图标，优先考虑）

> 卡牌/道具的图标本质都是「文档/文件夹/靶心/灯泡/闹钟/咖啡杯/锅/爱心」这类**通用扁平符号**，开源图标库里现成一大把，比 AI 出图**更规整、风格更统一、零版权风险、SVG 可无损缩放**。除非需要很特定的原创符号，否则优先用开源图标。

**推荐来源（均可商用，注意各自 license）**：

| 图标库 | 授权 | 风格 | 地址 | 适配度 |
|---|---|---|---|---|
| **Lucide** | ISC（可商用免署名） | 描边线性、统一 24px 网格 | lucide.dev | ★★★★★ 最推荐，风格最统一 |
| **Tabler Icons** | MIT | 描边线性、4000+ 图标 | tabler.io/icons | ★★★★★ 数量多 |
| **Material Symbols** | Apache 2.0 | 可切描边/填充/圆角 | fonts.google.com/icons | ★★★★ 谷歌出品 |
| **Phosphor** | MIT | 多种粗细/填充风格 | phosphoricons.com | ★★★★ 风格多样 |
| **Iconify** | 各图标原 license | 聚合上百套，一站搜 | icon-sets.iconify.design | ★★★★ 搜索神器 |
| **Remix Icon** | Apache 2.0 | 线性+填充双版本 | remixicon.com | ★★★★ 国产、中文友好 |
| **Font Awesome Free** | CC BY 4.0（需署名）| 经典图标集 | fontawesome.com | ★★★ 免费版需署名 |

**本作图标 → 开源图标对应建议**（以 Lucide 为例，其它库同名或近似）：

| 卡牌/道具 | 含义 | Lucide 图标名 |
|---|---|---|
| card-routine | 常规文档 | `file-text` |
| card-report / card-document | 汇报/文档 | `folder` / `files` |
| card-key | 关键/靶心 | `target` |
| card-proposal | 提案/灯泡 | `lightbulb` |
| card-urgent | 紧急/闹钟 | `alarm-clock` |
| card-meeting | 会议/咖啡 | `coffee` |
| card-boss | 老板/审查 | `search` / `user-round-search` |
| prop-add-demand | 加需求 | `file-plus` |
| prop-change-demand | 改需求 | `refresh-cw` / `undo-2` |
| prop-throw-pot | 丢锅 | `cooking-pot` |
| prop-kiss-up | 拍马屁 | `heart` |
| icon-event-log | 事件日志 | `clipboard-list` |

**用法（两条路）**：
1. **下载 SVG → 转 PNG**：从图标库下载 SVG，用统一颜色（如白色/深灰），命令行批量转 PNG 后放入 `assets/resources/art/cards|props/`：
   ```bash
   # 需要 rsvg-convert（brew install librsvg）或 ImageMagick
   rsvg-convert -w 256 -h 256 file-text.svg -o card-routine.png
   ```
   图标本身即透明底，无需抠图。配合上面「代码画底」策略，卡牌背景色/边框都由代码上色，图标只需**单色**即可。
2. **Iconify 一站搜**：在 icon-sets.iconify.design 搜关键词（如 "coffee"），可直接导出指定颜色/尺寸的 PNG/SVG，最省事。

> **决策建议**：卡牌/道具/日志图标这 16 个通用符号，**建议直接用 Lucide 或 Tabler**（风格统一、省时省钱），只把「角色/背景/特效」交给 AI 出图。图标统一用单色，颜色和卡片框都交给代码，视觉最协调。

---

## 抠图 / 透明底统一策略（全量 review 后新增，务必先看）

> 起因：资产0（角色）实测发现"transparent/light-gray background"这类写法在 AI 出图时不可靠（容易输出棋盘格占位图、或干脆忽略变成实色底），改用绿幕色键后效果显著变好。这里把这个经验推广到全部资产，并纠正一处关键冲突。

**原则 A（纯不透明前景 → 统一用绿幕）**：只要资产本身**不需要局部半透明**（角色、卡牌、道具、事件日志图标、大部分特效），统一要求 AI 在**纯绿 `#00FF00` 背景**上出图，再用色键抠图，比"transparent background"这句话可靠得多。
已核对本作全部锁定色板（卡牌8色 / 环境色 / 道具色），**没有一个颜色落在绿色附近**（最接近的青色卡牌边框、粉色拍马屁心，跟纯绿的 RGB 距离都远超色键常用的 12% 容差），所以绿幕对本作所有资产都安全，不会误抠自己的颜色。

**原则 B（需要局部半透明/发光 → 绝对不能用绿幕）**：色键抠图只能把"匹配色"的像素变**全透明**，没法保留**局部半透明**的 alpha 值——比如"60%透明度的红章"画在绿幕上，抠掉绿色后剩下的红色是被绿色污染过的混合色，不是纯净的60%透明红。凡是描述里出现"semi-transparent / glow / 渐隐"的资产（叠层印章、发光特效），**改用以下两种方案之一**，不再让 AI 生成半透明效果：
  - **方案①（推荐，最稳）**：生成时做成**纯不透明**平涂图，"半透明感"完全交给 **Cocos 运行时 `node.opacity`** 实现——业界标准做法，从根源上避免了半透明+抠图的矛盾。
  - **方案②（发光类特效专用）**：生成时用**纯黑背景**（不是绿幕），入 Cocos 后把该 Sprite 的**混合模式设为 Additive（叠加）**——黑色在叠加模式下天然"不贡献颜色"，不需要真 alpha 也能呈现发光效果，且能保留发光的柔和渐隐。

**原则 C（背景 bg-office 例外）**：背景本身是最底层的完整不透明场景，**不需要任何透明底**，直接用，不用抠图。

| 资产 | 是否需要局部半透明 | 抠图/合成策略 |
|---|---|---|
| 0a/0b 角色、1 表情 | 否 | 绿幕 `#00FF00` + 色键（已锁定） |
| 2 卡牌 ×8 | 否 | 绿幕 `#00FF00` + 色键（本次改） |
| 3 道具 ×4 | 否 | 绿幕 `#00FF00` + 色键（本次改） |
| 4 状态叠层 ×2（返工章/杂活纹） | **是**（原描述是"semi-transparent"） | 改成**纯不透明**出图 + Cocos `opacity` 运行时实现半透明（方案①） |
| 4.5 事件日志图标 | 否 | 绿幕 `#00FF00` + 色键（本次改） |
| 5 背景 bg-office | 不适用 | 无需抠图，整图直接用（原则C） |
| 6 特效：fx-hit / fx-combo-star | 否（硬边缘图形） | 绿幕 `#00FF00` + 色键 |
| 6 特效：fx-perfect-glow | **是**（柔和发光渐隐） | 纯黑背景 + Cocos Additive 混合模式（方案②） |

---

## 资产 0｜角色（方案A：背影 + 转头基准）— 必做最先

> 方案A = 场景内转头。需要 **2 个身体帧**（同一机器人）：**背影(默认) + 转头基准(圆屏脸可见)**。
> 12 表情只需画"圆屏脸"叠在转头基准上（见资产1），不用重画身体。
> 一致性只管这 2 个身体帧是同一个机器人。
>
> **v2 修正**（对齐 `视觉UI设计规范.md` §4/§4.1/§8.1 v4 实测锁定的样子）：头形从"矩形屏幕头"改为**圆头（球形头）+ 圆形屏幕脸**，见下方已更新的提示词。
>
> **v3 修正**（重要，纠正姿势错误）：v2 的 0a/0b prompt 仍写的是 `standing pose`（站姿、全身直立），与主界面定稿 §5/§8.1 描述的**"坐在椅子上，双手放桌面/键盘，Q版小号比例"**不符——之前实测出图（`image.bcbcfa4b09.png`）就是按站姿画的站立角色，不能直接用作主界面角色锚。现已改为**坐姿 + 椅子 + Q版比例**，见下方提示词。
>
> **v4 修正**（重要，纠正"背影像正脸"和"工卡带反"两个问题）：v3 实测出图（`image.72e38bae50.png`）暴露两个问题：① 背面板被 AI 画成对称圆盘+4颗对称螺丝，**视觉上酷似一张脸**（两颗螺丝像眼睛），分不清是脸还是后脑勺；② 躯干正面的 V 形挂绳+工卡完整可见，但**从背后视角这是不可能看到的**（工卡挂在胸前，背后只应看到脖子上一小段绳子）。现已在 prompt 里明确禁止"对称圆点/螺丝/任何像脸的图案"，并明确挂绳只在后颈露出一小段、看不到工卡本体。
>
> **v5 修正**：v4 把背面板写成"dark solid-color"，导致 AI 把整个头画成深色/黑色头壳。实际应该是**白色头壳**（和躯干同色系的白色塑料），只有正面的圆形屏幕区域是深色的（用来显示表情），背面就是纯白无特征。
>
> **v6 修正**（重要，纠正"整体转向"问题）：v5 实测出图（`image.f204d2ee97.png`）问题很大——0b prompt 写的是"整个角色转成 3/4 侧视角"，AI 把**身体、椅子、键盘全部一起转了**，变成完全不同构图/视角的图，跟 0a 的背视角构图对不上，没法当"同一姿势只是头转过来"的转头基准用。已改为**只转头，身体/手/键盘/椅子的位置和角度必须和 0a 保持一致（依然是背视角坐姿构图）**，效果类似猫头鹰回头看——身体不动，头扭过来露脸。
>
> **v6.1 修正**（转头可读性）：v6 实测出图"看不出在转头"——AI 画成了正脸朝前的正面肖像，跟转头动作没区别。要让"转"可读，头部必须是**3/4 侧脸角度（扭转约45-60°）**，能同时看到**大部分脸 + 一小条后脑勺白色弧线**，且脖子要有扭转折痕、挂绳因转头而歪斜绷紧——这些扭转线索才是"转头"区别于"正面肖像"的关键。
>
> **v7 修正**：v6 实测出图（`image.072eff7718.png`）转头姿势对了，但**"屏幕感"没出来**——深色圆+两点+一条线看起来就是普通卡通脸，看不出这是一块嵌入头壳的显示屏。已在 0b/资产1 prompt 里补充屏幕专属视觉线索：**浅色内嵌边框(bezel)** + **细微发光/高光边缘**，让屏幕轮廓从头壳里"跳出来"，一眼识别为显示屏而非普通脸。
>
> **v8 修正**（抠图问题）：0a/0b 原来用"light-gray background"（浅灰底），但机器人主体是**白色塑料**，白色主体 + 浅灰背景对比度太低，`rembg`/remove.bg 这类自动抠图工具容易在边缘留灰边或啃掉白色高光细节。已改为**高饱和抠像色背景（纯绿 `#00FF00`）**，跟白色/浅色机器人形成强对比，抠图更干净（原理同影视绿幕）。

### 资产 0a｜背影 char-back（默认态，90% 时间显示，坐姿）
- **工具**：GPT-image / Nano / 即梦
- **参考图**：风格参考 = 【紧急任务卡样张】
- **尺寸**：1024×1024
- **提示词**：
```
Flat cartoon vector game asset, bold clean outlines, minimal flat color, no gradients,
no photorealism, casual WeChat mini-game art direction, high readability.

A SINGLE character illustration only: BACK VIEW (seen from behind), centered. Subject: a cute
office robot coworker in CHIBI/Q-style proportions (big round head, short chubby body), SITTING
in an office chair (chair back visible behind/around the torso), hands resting on a desk/keyboard
in front, seen from behind.

Head (back of a round/spherical head): the head shell is WHITE (same white plastic as the torso,
NOT dark/black). The back of the head is a plain white solid-color surface with NO visible
features at all — NO dots, NO screws, NO symmetric marks, NO eyes, NO screen, NOTHING that could
resemble a face. It should read unambiguously as the BLANK WHITE BACK of the head, not a face.
A small antenna sticks up from the top-back of the round head.

Torso (seen from behind): plain white rounded plastic back panel, no chest badge visible (the
badge hangs on the FRONT and is hidden from this back view) — only a thin blue lanyard strap
visible going around/behind the neck, NOT a full V-shaped strap with a badge hanging in front.

Plain solid CHROMA-KEY GREEN background (pure flat green, like #00FF00 greenscreen, evenly lit, no
gradient, no texture) — chosen specifically for clean background removal later, since the
character is white/light-colored and needs strong contrast against the background. STRICTLY:
no text, no title, no logo, no watermark, no UI, no interface, no buttons, no panels, no game
mockup, no scene, no background environment, no other characters, no multiple views, NOT
standing/full-body-standing pose, NO face-like pattern on the head, NO dark/black head. One
sitting character from behind on a plain green background only.
```

### 资产 0b｜转头基准 char-turn-base（圆屏脸中性，坐姿）
- **工具**：GPT-image（用 0a 当角色参考，让它转头露脸）
- **参考图**：**角色参考 = 资产 0a 背影**；风格参考 = 样张
- **尺寸**：1024×1024
- **提示词**：
```
Edit this image: keep the ENTIRE composition, camera angle, and body pose EXACTLY as in the
reference image — same office chair (still seen from behind at the same angle), same body
position, same arms/hands resting on the same keyboard in the same position, same desk, same
camera framing/zoom. Do NOT rotate the body, chair, keyboard, or camera view. Do NOT change this
into a front-view or three-quarter-view of the whole scene.

The ONLY change: the ROUND HEAD turns on its neck to look back toward the viewer/camera — like an
owl turning its head — while the shoulders and body stay in the exact same back-facing position.

CRITICAL — the head must read as TURNED, not as a straight front-facing portrait:
- Show the head at a THREE-QUARTER ANGLE (turned roughly 45-60 degrees toward the viewer), NOT a
  dead-on full-front face. We should see MOST of the face/screen but ALSO a sliver of the BACK of
  the head on one side (a crescent of white head-shell behind/beside the screen) — this partial-
  back-of-head visible is what makes the "turn" readable.
- The neck should show a visible TWIST: wrinkles/crease lines on the neck where it rotates, and
  the blue lanyard strap should be pulled/diagonal on the turned side (not hanging straight down)
  — this sells the torsion.
- One ear/antenna base or side of the head may be slightly more visible on the turning side.

Because the head has turned, we now see the front of the head: the white round head has a
circular DARK screen embedded in the center of the face — this must clearly read as a
SCREEN/DISPLAY, not a plain cartoon face. Give it screen-specific visual cues: a slightly raised
light-gray/silver BEZEL ring (like a smart-watch or round monitor rim) framing the dark screen,
and a subtle glowing/backlit edge highlight around the inner rim of the screen (soft cyan or
white glow line) to suggest it is an actively lit display. The screen shows a neutral flat
emoticon face (two dot eyes, a calm straight-line mouth) rendered as if glowing on the display.

Everything else — body angle, chair, keyboard, desk, framing — must remain identical to the
reference image, including the plain solid CHROMA-KEY GREEN background (#00FF00 greenscreen, for
clean background removal). Flat cartoon vector, no text, no UI.
```

> **为什么是圆头机器人**：本作对手就是 AI，头=屏幕+天线一眼读出"AI"；圆头比矩形头更 Q 更讨喜，同时保留"脸=屏幕"的主题符号。方案A 的"跨帧一致"被拆成"2 身体帧一致 + 12 张小圆屏脸"，可控（脸甚至能代码画）。
>
> **备选方向**（把 0a/0b 的 Subject 描述整体替换即可，流程不变）：仿生人同事（AI 伪装成人，眼神/电路纹 tell）/ 全息投影 AI（半透明青蓝、扫描线）。

---

## 资产 1｜圆屏脸 ×12（叠在资产 0b 转头基准的圆形屏幕区域）

> 身体完全复用资产 0b，**只换圆屏幕里的脸**。每张是小贴图（512 即可），叠在 0b 的圆屏位置。
> 懒人路线：12 张脸甚至可以不生图，直接在 Cocos 用代码画 emoji（:) :O :D 等）到圆形屏幕 sprite 上。

- **工具**：GPT-image（用 0b 当参考，只改圆屏脸）；即梦「角色参考图」= 资产 0b
- **参考图**：**角色参考 = 资产 0b【转头基准】**
- **尺寸**：512×512（只画圆屏脸）
- **提示词模板**（把 `{表情}` 换成下表的英文）：
```
Edit this image: keep EVERYTHING identical (same robot body, same pose, same background, same
art style, same round head shape, same bezel ring and glowing screen edge), ONLY change what is
displayed on the robot's circular DISPLAY SCREEN to {表情}. Keep the screen looking like an
actively lit display (bezel ring + subtle glow edge preserved), not a plain flat cartoon face.
Nothing else changes. No text outside the screen.
```

| 文件名 | {表情} 填这个 |
|---|---|
| `char-slight-frown` | a mild annoyed frown, slight scowl |
| `char-surprised` | eyes wide open, mouth open in surprise, raised eyebrows |
| `char-bewildered` | confused and bewildered, looking around blankly |
| `char-combo-face` | a smug grinning face, cocky smile |
| `char-confident` | a calm confident smile, relaxed |
| `char-sweat` | nervous, a big sweat drop on the forehead |
| `char-panic` | terrified panic, wide eyes, mouth open screaming |
| `char-busy-pretend` | fake busy, stiffly straightening posture, forced focus |
| `char-shy` | blushing cheeks, shy pleased smile, looking down |
| `char-idle-look` | bored, sipping from a coffee mug, glancing away |
| `char-tense` | tense and stiff, slightly trembling, forced smile |
| `char-called-in` | defeated, hugging a cardboard box, sad |

---

## 资产 2｜卡牌 ×8（权重数字由代码叠加，不要画进图）

> **⚠️ v4 架构级修正（强烈推荐先看文档开头两节）**：卡牌**不再整张出图**。卡片的「圆角矩形边框 + 填充底」改由 **Cocos `Graphics` 代码运行时绘制**（见开头「卡牌/按钮 = 代码画底 + 纯图标」），美术层**只需一个纯图标**（透明底、单色、无卡片框）。
> - **首选：直接用开源图标**（见开头「免费开源图标库」）——文档/文件夹/靶心/灯泡/闹钟/咖啡杯这些都是通用符号，Lucide/Tabler 现成、更规整、零版权风险，**无需 AI 出图**。对应图标名见开头对照表。
> - **次选：AI 只画纯图标**（若要原创风格），用下方"纯图标版"提示词，不要再画卡片框和背景色。
> - `{色}`（边框色）现在是**代码常量**（`CARD_STYLE.border`），不进图片。

**纯图标版提示词**（AI 出原创图标时用；`{符号}` 见下表）：
```
Flat cartoon vector ICON only, bold clean outlines, minimal flat single-color, no gradients,
casual WeChat mini-game art direction, high readability.

A centered minimal flat symbol of {符号}, ONLY the icon itself — NO card, NO rounded rectangle,
NO border frame, NO background panel. Single solid color icon. Plain solid CHROMA-KEY GREEN
background (pure flat #00FF00 greenscreen, evenly lit, no gradient), for clean color-key removal.
No text.
```

> **v2 修正**：符号改成 `视觉UI设计规范.md` §8.1 实测已锁定、辨识度验证过的版本（文档/文件夹/靶心/灯泡/闹钟/咖啡杯），与出图参考图保持一致。
>
> **v3 修正**：背景从"Transparent background"改为**绿幕 `#00FF00` + 色键抠图**（原因见文档开头「抠图/透明底统一策略」）——直接要求 AI 出透明底不可靠，绿幕更稳。已核对卡牌8色都不接近绿色，抠图安全。
>
> **v4 修正**：卡片框改代码画，只出纯图标（首选开源图标）。原"整卡出图"提示词已废弃。

| 文件名 | {色} | {符号} |
|---|---|---|
| `card-routine` | blue #50A0FF | a simple document/paper icon（常规） |
| `card-report` | orange #FFA03C | a folder icon（汇报） |
| `card-key` | purple #B464FF | a bullseye/target icon（关键） |
| `card-proposal` | cyan #3CC8DC | a light-bulb icon（提案） |
| `card-urgent` | amber #FFB428 | an alarm-clock icon（紧急） |
| `card-meeting` | gray #787878 | a coffee-cup icon（会议/摸鱼） |
| `card-document` | gray #787878 | a folder / document page（与 report 图标区分：用纸张叠放而非单文件夹） |
| `card-boss` | dark black #282828 border | a magnifying glass / angry boss silhouette |

---

## 资产 3｜道具 ×4

> **⚠️ v3 架构级修正（同资产2）**：道具按钮**不再整张出图**。「圆角方按钮底」改由 **Cocos `Graphics` 代码绘制**，美术层**只需纯图标**（透明底、单色、无按钮框）。
> - **首选：开源图标**（见开头「免费开源图标库」）——加需求=`file-plus`、改需求=`refresh-cw`、丢锅=`cooking-pot`、拍马屁=`heart`，Lucide/Tabler 现成，无需 AI。
> - **次选：AI 只画纯图标**，用下方"纯图标版"提示词，不要再画按钮底。

- **工具**：开源图标库（首选）/ 即梦 / GPT-image
- **参考图**：风格参考 = 【道具样张(丢锅)】
- **尺寸**：256×256（纯图标）

> **v2 修正**：① 补上遗漏的 `no gradients`（原提示词是清单里唯一没写"无渐变"的资产，和 §4 铁律不符）；② 背景从"Transparent background"改为**绿幕 `#00FF00` + 色键抠图**（原因见文档开头「抠图/透明底统一策略」），已核对道具4色（蓝/紫/红/粉）都不接近绿色，抠图安全。
>
> **v3 修正**：按钮底改代码画，只出纯图标（首选开源图标）。

**纯图标版提示词**（AI 出原创图标时用；`{符号}` 换成下表英文）：
```
Flat cartoon vector ICON only, bold clean outlines, minimal flat single-color, no gradients,
casual WeChat mini-game style. A centered symbol of {符号}, ONLY the icon itself — NO button,
NO rounded square, NO frame, NO background panel. Single solid color. Plain solid CHROMA-KEY
GREEN background (pure flat #00FF00 greenscreen), no text.
```

| 文件名 | {符号} | 开源图标(Lucide) |
|---|---|---|
| `prop-add-demand`（加需求） | a crumpled paper document being inserted from the side with motion lines | `file-plus` |
| `prop-change-demand`（改需求） | a circular rewind/flip arrow around a document (meaning "redo/rework") | `refresh-cw` / `undo-2` |
| `prop-throw-pot`（丢锅） | a flying cooking pot with motion speed lines | `cooking-pot` |
| `prop-kiss-up`（拍马屁） | a pink heart with a lipstick mark | `heart` |

---

## 资产 4｜状态叠层 ×2（叠在任意卡牌上的覆盖图）

- **工具**：即梦 / GPT-image
- **参考图**：风格参考 = 【紧急任务卡样张】
- **尺寸**：1024×1024

> **v2 修正**（重要，纠正抠图冲突）：原提示词要求"semi-transparent + transparent background"——这两者叠加是矛盾的：色键/自动抠图只能把背景变**全透明**，没法保留图案本身的**局部半透明度**（比如60%透明的红章，抠图后颜色会被背景污染，不是纯净的半透明红）。已改为**纯不透明**出图（绿幕背景+色键抠图），"半透明质感"完全交给 **Cocos 运行时用 `node.opacity`**（如 `70`）实现——这是业界标准做法，从根源上避免冲突，且效果比出图自带的假半透明更可控。

**overlay-rework（返工红章）**
```
Flat cartoon vector stamp overlay reading "REWORK", tilted, bold outline, flat OPAQUE red color
(fully solid, NOT transparent/translucent — transparency will be handled later in-engine), rubber-
stamp texture look but flat-colored. Plain solid CHROMA-KEY GREEN background (pure flat #00FF00
greenscreen), no other elements, no text besides "REWORK".
```
**overlay-inserted（杂活灰斜纹）**
```
Flat cartoon vector overlay: gray diagonal hatch stripes patch with a small blank tag in the
corner, flat OPAQUE gray color (fully solid, NOT transparent/translucent — transparency will be
handled later in-engine). Plain solid CHROMA-KEY GREEN background (pure flat #00FF00 greenscreen),
no text content.
```
> 入 Cocos 后：`overlay-rework` 挂到返工卡上时设 `node.opacity = 180` 左右（模拟半透明红章）；`overlay-inserted` 设 `node.opacity = 160` 左右（模拟半透明灰斜纹），具体数值美术验收时可调。

---

## 资产 4.5｜事件日志图标 icon-event-log ×1（新增，对齐出图参考）

> 出图参考图里事件日志条前面配了一个小图标，清单原来漏了这个资产，补上。
>
> **v2 修正**：背景从"Transparent background"改为**绿幕 `#00FF00` + 色键抠图**（原因见文档开头「抠图/透明底统一策略」）；灰色图标和绿色差异明显，抠图安全。

- **工具**：即梦 / GPT-image
- **参考图**：风格参考 = 【紧急任务卡样张】
- **尺寸**：512×512
- **提示词**：
```
Flat cartoon vector game icon, bold clean outlines, minimal flat color, no gradients, casual
WeChat mini-game style. A simple flat icon of a clipboard/list with a few horizontal lines
(representing an events log), gray or dark-gray color. Plain solid CHROMA-KEY GREEN background
(pure flat #00FF00 greenscreen), no text.
```

---

## 资产 5｜背景 bg-office ×1（仅环境，不含角色）

> 角色是独立 sprite 层（资产0），**背景只画办公环境**——空工位+显示器朝外，AI 不烤进背景，留出角色站位与传送带叠放区。
>
> **v2 修正**：补充桌面细节（键盘/显示器支架），并对齐 `视觉UI设计规范.md` §1.5 新增的**环境色**（暖米色墙面 `#EBE1D2` / 暖棕木桌面 `#A87C58` / 暖深灰显示器外壳 `#3C3A37`），与出图参考图保持一致；环境色只用于背景本身，不影响后续叠加的卡牌/UI功能色。
>
> **v3 修正**（重要，纠正多处方向性错误）：v2 实测出图（`image.98c321942d.png`）对照主界面标准图（`image.5c840a7f91.png`）后发现问题很大：① **机位/透视完全不对**——出图用了带消失点的斜角室内设计透视，标准图是**正面无透视的平视构图**，两者对不上会导致背景和角色/传送带叠加层错位；② **显示器比例完全不对**——出图是个小台式机屏幕，标准图的显示器是**占画面上半部大半宽度的巨大屏幕**（要嵌传送带进去）；③ **椅子风格不对**——出图是带网布纹理的写实椅子，标准图是**扁平色块+粗黑描边**的极简椅子；④ **环境过于复杂**——出图加了玻璃隔断/书架/绿植/装饰画/远处工位/窗户，标准图背景就是**一块空墙**，什么多余家具都没有；⑤ **带渐变/阴影**——出图桌面下有投影、地板有反光渐变，**违反"无渐变"铁律**。已重写 prompt，逐条钉死这些约束。
>
> **v4 修正**（架构性错误，重要）：v3 实测出图（`image.0d9987c3ff.png`）背景里画了一张空椅子——但**椅子已经是资产0（角色0a/0b）的一部分**（0a/0b prompt 里明确写了"SITTING in an office chair, chair back visible"，椅子是烤进角色 sprite 里的，跟机器人是同一张图）。背景层再单独画一张椅子会导致拼合时**两把椅子重叠穿模**。已从背景 prompt 里彻底删除椅子，背景层只保留**墙 + 显示器 + 桌子**，椅子完全交给角色 sprite 层负责，两层各管各的，不重复。
>
> **v5 修正**：① **键盘同理也要删**——v4 漏删了键盘，键盘同样已经烤进角色0a/0b（"hands resting on a desk/keyboard"，机器人的手和键盘是同一张 sprite），背景层不该再画一份，否则和角色自带的键盘重叠穿模；② **桌面小摆件不该被禁**——v3 为了清空"墙面"上的多余家具（书架/绿植/装饰画等），矫枉过正连带把"桌面上可以有的小道具"也写进了禁用清单，其实之前讨论过办公喜剧的桌面彩蛋（马克杯/绿植盆栽/日历/便签等）是可以保留的，只要不影响机位对齐、不喧宾夺主。已把禁用范围收窄到"墙面"，桌面允许放 1-2 个小摆件。
>
> **v6 修正**（架构性根因，重要）：v5 出图（`bg-office.png` 1088×1920）像素级实测发现**显示器和桌面之间的间距只有图片高度的 6.9%**（屏幕底 y=52.3%、桌面线 y=59.3%），而角色 sprite（`char-back.png` 1024×1024）从头顶到键盘前沿的距离占角色高度的 52.6%——在角色显示尺寸为屏宽 56%（609px）时，头到键盘距离 320px，是背景留出的 133px 间距的 **2.4 倍**，导致角色头顶超出屏幕底部 187px、深深穿入显示器屏幕区域。**无论怎么调代码偏移量都无法解决**这个几何不兼容。已重写 prompt：显示器屏幕**只占图片高度的 10%~30%**（而非原来的 20%~52%），桌面线保持在 ~55%，屏幕底到桌面的间距增大到 **25%**（原图仅 6.9%），给角色 sprite 留出充足的垂直空间。
>
> **v6.1 修正**（v6 出图 `image.png` 768×1376 实测发现两个问题）：① **显示器支架没连到桌面**——prompt 说"stand connecting monitor to desk"，但 AI 画了一小段支架就停了，从支架底到桌面之间留了 27.5% 的空墙，显示器像飘在空中。② 根本原因是 prompt 逻辑写反了——不需要在背景里"留空给角色"，角色是叠在前景的 sprite，背景只需保证显示器足够高（屏幕底 ~30%），角色坐到桌面（~55%）时头顶自然在屏幕下方。**显示器支架必须从屏幕底部一路延伸到桌面表面，中间不留空墙。**
>
> **v6.2 修正**（v6.1 出图 `image.png` 实测：屏幕 20%~44%，间距仅 6.3%，又回到原点）：AI 反复无视"compact"、"8%~30%"等文字描述，把显示器画大画低。根因是 prompt 里"70-80% of image width"和"compact"自相矛盾——70%屏宽很大，AI 选了遵从宽度指令画大屏。已改为：① 显示器宽度降到 50-60%（而非 70-80%）；② 删掉所有"large/big"相关措辞；③ 用"upper fifth of the image"等分数描述替代百分比（AI 对"upper fifth"的遵从度高于"8%"）；④ 明确"the monitor is SMALL, the stand+wall below it is the TALL dominant element"。
>
> **v7 修正**（换思路，v6 三次出图全部比例不对）：AI 从零生成始终无法控制显示器尺寸/位置比例。改为两条路并行：
> - **方案A（AI 提取）**：拿已有 UI 设计稿 `docs/UI.png`（768×1376，已有所需的显示器+桌面布局）当输入，用 AI 图像编辑提取其中的显示器和桌面、清除其他 UI 元素、补全支架，输出干净背景。优势：布局比例已有，AI 只做清理不重新构图。
> - **方案B（代码生成，推荐）**：用 Python 按精确比例直接画一张背景图（纯色块矩形：米色墙+深灰屏幕+灰色支架+棕色桌面），零 AI 依赖，比例 100% 可控。flat vector 风格本身就是色块，程序画的矩形和 AI 画的没有本质区别。脚本：`python3 scripts/generate-bg.ts`

### 方案A：从 UI.png 提取（AI 图像编辑）

- **工具**：GPT-image（edit 模式）/ Nano Banana（图像编辑）
- **输入图**：`docs/UI.png`
- **尺寸**：1080×1920（如果工具支持指定输出尺寸）
- **提示词**：
```
Edit this image: extract ONLY the monitor (the dark rectangular screen with its bezel/frame)
and the desk (the brown/wooden horizontal surface) from this UI mockup. Remove ALL other
elements — remove every dark bar, gray panel, colored button, text, icon, banner, and UI
widget that is NOT the monitor or the desk.

Rebuild the result as a CLEAN game background:
- The monitor stays in its current position (upper portion of the image), but add a proper
  monitor STAND: a thin vertical neck going from the bottom-center of the monitor ALL THE WAY
  DOWN to the desk surface (no gap, no floating). The stand is flat dark-gray (#3C3A37).
- The desk stays at its current position (lower-middle), as a simple flat brown slab (#A87C58).
- Everything else is flat solid warm-beige wall (#EBE1D2), completely empty — no windows, no
  pictures, no furniture, no UI elements, no text.
- The monitor screen face is plain blank dark-gray (#3C3A37), no content on it.

Style: flat cartoon vector, bold clean outlines (3-4px), minimal flat color blocks, ABSOLUTELY
NO gradients, no shadows, no texture. Simple icon-like rendering. Portrait 9:16. No text, no
UI, no characters, no chair, no keyboard.
```

### 方案B：代码生成（推荐，零 AI 依赖）

```bash
python3 scripts/generate-bg.ts
```

脚本按精确比例生成 `assets/resources/art/bg/bg-office.png`，比例与 `GameRunner.ts` 常量完全一致，无需验收。

### 方案C（推荐）：方案B 骨架 + AI 美化

方案B 的图比例精确但太朴素（纯色块）。先跑方案B 得到骨架图，再让 AI 在保持比例不变的前提下做"风格化美化"——加上光影、描边、细节、质感。AI 图像编辑比从零生成可靠得多，因为布局已经锁死，AI 不会把显示器画大。

- **工具**：GPT-image（edit 模式）/ Nano Banana
- **输入**：`assets/resources/art/bg/bg-office.png`（方案B 生成）
- **提示词**：
```
Edit this image to add visual richness and polish while keeping EXACTLY the same layout and
proportions — do NOT move, resize, or restructure any element. The dark-gray monitor screen
must stay at the same position and same size, the thin monitor stand must stay exactly as
is connecting the monitor to the desk, and the brown desk must stay at the same height.

Add these refinements ONLY (no structural changes):
- The wall: add subtle flat cartoon shading — a very faint warm gradient from slightly
  lighter at top to slightly darker at bottom (still within the warm-beige palette, still
  no harsh gradients), and a few soft round edge shadows where the monitor stand meets the
  wall (subtle, flat-cartoon style).
- The monitor bezel: add a soft inner highlight along the top edge of the bezel (suggests
  a matte plastic material). The screen face stays blank dark-gray.
- The monitor stand neck: add a slightly lighter thin highlight stripe down one side
  (subtle cylindrical shading, flat style).
- The desk surface: add a few horizontal wood-grain lines (very subtle, low-contrast,
  same brown family color, no real wood texture) running across the desk, and a slightly
  darker thin shadow line right under the monitor stand base where it meets the desk
  (suggests the stand is sitting on the desk casting a small shadow).
- The small potted plant on the left: make the leaves a richer green and add a couple
  of leaf shapes (stays small but looks like a real plant, not a green square).
- The mug on the right: add a small handle visible and a thin rim line at the top.
- Add bold clean dark outlines (3-4px) around all shapes — the monitor, stand, desk, plant
  pot, mug — to make everything look like clean flat vector illustration.

Style: FLAT cartoon vector, bold clean outlines, minimal flat color blocks, NO realistic
shading, NO photorealism, NO soft gradients, NO textures beyond the simple wood-grain
lines. Casual WeChat mini-game art. Portrait 9:16.
```

- **工具**：即梦 / GPT-image
- **参考图**：风格参考 = 【紧急任务卡样张】
- **尺寸**：1080×1920（**竖屏 9:16**）
- **提示词**：
```
Flat cartoon vector game background, bold clean outlines (uniform 3-4px), minimal FLAT color
blocks ONLY, ABSOLUTELY NO gradients, no soft shadows, no reflections, no realistic shading,
no texture/fabric patterns. Casual WeChat mini-game art direction. Simple, minimal, ICON-LIKE
rendering — this must look like a flat vector illustration, NOT a realistic interior-design
render, NOT isometric, NOT 3D.

CAMERA/PERSPECTIVE: a completely FRONTAL, FLAT, ORTHOGRAPHIC view — looking straight at the wall
head-on, NO perspective vanishing lines, NO diagonal/isometric angle, NO visible ceiling or side
walls converging to a point. Everything is drawn as flat frontal shapes stacked top-to-bottom,
like a 2D game screen mockup, not a 3D room render.

SCENE (top to bottom, STRICT vertical proportions — these are critical for compositing):

1. Wall above monitor (top ~8% of image): plain flat SOLID warm-beige wall (approx #EBE1D2).

2. Monitor (the next ~20% of image height, i.e. roughly y=8% to y=28%): a SMALL flat monitor
   centered on the wall. The monitor width is about 50-60% of image width (NOT 70-80%, NOT
   large). The monitor HEIGHT is less than one quarter of the image height. The screen face is
   a plain/blank flat dark-gray (#3C3A37) rectangle with a thin lighter bezel — NO content on
   screen. The monitor is SMALL and positioned HIGH UP near the top of the image. Think of a
   compact desktop monitor, NOT a large TV or giant display.

3. Monitor stand + wall (the TALL middle section, roughly y=28% to y=55%, about one quarter of
   the image height): this is the DOMINANT vertical element of the image. A simple thin monitor
   stand — a flat dark-gray (#3C3A37) vertical neck about 5% of image width thick, going ALL
   THE WAY DOWN from the monitor bottom-center to the desk surface, ending in a flat base foot
   resting on the desk. The stand MUST physically connect the monitor to the desk with NO gap.
   On either side of the thin stand, the warm-beige wall (#EBE1D2) is visible. This tall
   wall+stand section is where a character sprite will be composited in front later — it must
   be tall and open.

4. Desk (y=~55% to ~68%): a simple flat rectangular wooden desk slab (approx #A87C58, plain, no
   drawers). The monitor stand base sits ON this desk. 1-2 small desk props OK (mug, plant),
   kept small and off to one side.

5. Below desk (y=~68% to bottom): open warm-beige area, empty, for bottom UI buttons.

DO NOT draw any chair or keyboard at all — NO chair, NO keyboard, not even an empty/unused one.
Both the chair AND the keyboard are already part of a SEPARATE character sprite layer (drawn
together with the robot in a different asset) and will be composited on top of this background
later.

The WALL must be completely EMPTY: no windows, no framed pictures, no bookshelf, no wall plants,
no glass partitions, nothing hanging or mounted. Portrait 9:16 orientation. No text, no UI, no
characters, no people, no gradients, no shadows, no perspective distortion.
```

> **v6.2 比例验收方法**：出图后运行 `python3 scripts/measure-bg.ts [图片路径]`。期望值：屏幕区域 y≈8%~28%，桌面线 y≈55%，屏幕底到桌面间距 ≥25%。关键检查：① 间距 ≥20%（否则角色穿模）；② 支架从屏幕底部连到桌面（无空墙）。两个条件都满足才能用。

---

## 资产 6｜特效（可选，代码已能跑，做了更好看）

- **工具**：即梦 / GPT-image
- **参考图**：风格参考 = 【特效样张(撞击爆发)】
- **尺寸**：1024×1024

> **v2 修正**（重要，两种特效抠图方式不同，别混用）：
> - `fx-hit` / `fx-combo-star` 是**硬边缘图形**（星爆/星星，色块边界清晰），改用**绿幕 `#00FF00` + 色键抠图**（比"transparent background"更可靠）。
> - `fx-perfect-glow` 是**柔和发光渐隐**（glow 光晕本质就是半透明渐变），**不能用色键**（会把渐隐的边缘切成硬边，光晕质感全无）。改为**纯黑背景**出图，入 Cocos 后把该 Sprite 的**混合模式设为 Additive（叠加）**——黑色在叠加模式下不贡献颜色，天然实现"融进场景"的发光效果，还能保留渐隐质感。

**fx-hit（命中星爆）**：`...a comic impact star-burst, amber and cyan shards, plain solid CHROMA-KEY GREEN background (pure flat #00FF00 greenscreen), no text.`
**fx-perfect-glow（Perfect光晕）**：`...a radiant golden glow ring, sparkle, plain solid BLACK background (pure flat black, for later Additive blend mode in-engine — do NOT use green/chroma-key here, the glow's soft fade needs a black backdrop, not a color-key backdrop), no text.`
**fx-combo-star（连击星）**：`...a yellow combo star with small sparkles, plain solid CHROMA-KEY GREEN background (pure flat #00FF00 greenscreen), no text.`
（前面都带 `Flat cartoon vector game effect, bold outline, minimal flat color,`）

---

## 做完后（每张都过一遍）

1. **去背景**（按文档开头「抠图/透明底统一策略」分三类）：
   - **绿幕资产（0a/0b/1 角色表情、2 卡牌、3 道具、4.5 事件日志图标、6 的 fx-hit/fx-combo-star）**：出图时都已改用**纯绿 `#00FF00`** 背景，用**颜色键控**去背，不依赖 `rembg`：
     ```bash
     # ImageMagick 颜色键控示例（把接近#00FF00的像素变透明，容差可调）
     magick 输入.png -fuzz 12% -transparent "#00FF00" 输出.png
     ```
     去背后检查边缘是否有残留绿边（尤其角色头部发光屏幕的青色/白色高光边缘，容易被误判成背景色），若有可降低 `-fuzz` 容差或手动补涂。
   - **纯不透明叠层（4 状态叠层：overlay-rework / overlay-inserted）**：同样用绿幕+色键去背，得到的是**完全不透明**的图（红章/灰斜纹本身不带透明度）。半透明效果**不要在图片里做**，入 Cocos 后用 `node.opacity` 调（返工章 ≈180，杂活纹 ≈160，具体数值美术验收时调）。
   - **发光特效（6 的 fx-perfect-glow）**：出图用的是**纯黑背景**，**不要用色键去背**（会切坏渐隐边缘）。直接把黑底图整张导入 Cocos，把该 Sprite 的**混合模式设为 Additive（叠加）**，黑色像素在叠加模式下自动"隐形"，无需额外抠图步骤。
   - **背景资产（5 bg-office）**：整图本身就是不透明场景底图，**不需要抠图**，直接用。
   - **通用原则**：主体颜色（白/浅色）与背景颜色反差越大，色键抠图越干净——本作全部锁定色板都已核对过和绿色/黑色没有冲突，若后续新增资产用到接近绿色或纯黑的颜色，需换用蓝幕等其他抠像色。
2. **裁白边**：ImageMagick `mogrify -trim +repose *.png`。
3. **改名**：按上面的文件名（card-routine / char-surprised / prop-throw-pot ...）。
4. **入 Cocos**：放进 `assets/art/{cards,props,char,bg,fx}/`，建 SpriteFrame，GameRunner 用 Sprite 替换 Label；`overlay-*` 用时设 `node.opacity`；`fx-perfect-glow` 用时设 Sprite 的 `Blend Function` 为 Additive。
