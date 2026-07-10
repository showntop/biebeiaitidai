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

- **工具**：即梦 / GPT-image
- **参考图**：风格参考 = 【紧急任务卡样张】
- **尺寸**：1024×1024
- **提示词模板**（`{色}`/`{符号}` 见下表）：
```
Flat cartoon vector game asset, bold clean outlines, minimal flat color, no gradients,
casual WeChat mini-game art direction, high readability.

A game card icon: a rounded-corner rectangle card with a {色} border, centered minimal flat
symbol of {符号}, no text in image. Plain solid CHROMA-KEY GREEN background (pure flat #00FF00
greenscreen, evenly lit, no gradient, no texture), for clean background removal via color-key.
```

> **v2 修正**：符号改成 `视觉UI设计规范.md` §8.1 实测已锁定、辨识度验证过的版本（文档/文件夹/靶心/灯泡/闹钟/咖啡杯），与出图参考图保持一致。
>
> **v3 修正**：背景从"Transparent background"改为**绿幕 `#00FF00` + 色键抠图**（原因见文档开头「抠图/透明底统一策略」）——直接要求 AI 出透明底不可靠，绿幕更稳。已核对卡牌8色都不接近绿色，抠图安全。

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

- **工具**：即梦 / GPT-image
- **参考图**：风格参考 = 【道具样张(丢锅)】
- **尺寸**：1024×1024（圆角方按钮底 + 符号居中）

> **v2 修正**：① 补上遗漏的 `no gradients`（原提示词是清单里唯一没写"无渐变"的资产，和 §4 铁律不符）；② 背景从"Transparent background"改为**绿幕 `#00FF00` + 色键抠图**（原因见文档开头「抠图/透明底统一策略」），已核对道具4色（蓝/紫/红/粉）都不接近绿色，抠图安全。

**prop-add-demand（加需求）**
```
Flat cartoon vector game asset, bold clean outlines, minimal flat color, no gradients, casual
WeChat mini-game style. A round-cornered square skill button icon, centered symbol: a crumpled
paper document being inserted from the side with motion lines. Plain solid CHROMA-KEY GREEN
background (pure flat #00FF00 greenscreen), no text.
```
**prop-change-demand（改需求）**
```
...centered symbol: a circular rewind/flip arrow around a document (meaning "redo/rework")...
```
**prop-throw-pot（丢锅）**
```
...centered symbol: a flying cooking pot with motion speed lines...
```
**prop-kiss-up（拍马屁）**
```
...centered symbol: a pink heart with a lipstick mark...
```
（每条前面都带同一句 `Flat cartoon vector game asset, bold clean outlines, minimal flat color, no gradients, casual WeChat mini-game style. A round-cornered square skill button icon,` + 结尾 `Plain solid CHROMA-KEY GREEN background (pure flat #00FF00 greenscreen), no text.`）

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

- **工具**：即梦 / GPT-image
- **参考图**：风格参考 = 【紧急任务卡样张】；机位/比例参考 = 主界面标准图 `image.5c840a7f91.png`
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

SCENE (top to bottom): a plain flat SOLID warm-beige wall (approx #EBE1D2) filling the entire
upper 2/3 of the image — the WALL itself must be completely EMPTY: no windows, no framed pictures,
no bookshelf, no wall plants, no other desks/chairs/people, no glass partitions, nothing hanging
or mounted on the wall. Centered in the upper-middle area: a LARGE flat monitor on a simple stand
— the monitor should be BIG, occupying roughly 70-80% of the image width and a large portion of
the upper area (this screen area will later have a conveyor-belt UI overlaid on top, so keep the
screen face itself plain/blank, a flat dark-gray or #3C3A37 rectangle with a thin lighter bezel,
no content drawn on it). Below the monitor: a simple flat rectangular wooden desk slab (approx
#A87C58, plain, no drawers, no legs detail beyond simple flat shapes).

On the DESKTOP surface (not the wall), it's OK to add 1-2 small flat-cartoon desk props for
office-comedy flavor — e.g. a small coffee mug, a tiny potted plant, or a desk calendar — kept
small, off to one side, and not overlapping the center/keyboard area. Keep these minimal and
flat-colored, no gradients.

DO NOT draw any chair or keyboard at all — NO chair, NO keyboard, not even an empty/unused one.
Both the chair AND the keyboard are already part of a SEPARATE character sprite layer (drawn
together with the robot in a different asset, hands resting on the keyboard) and will be
composited on top of this background later. If a chair or keyboard is drawn here too, it will
visually overlap and duplicate with the character sprite's own chair/keyboard. Leave the desk
surface itself and the space in front of/under the desk empty and open aside from the 1-2 small
desk props mentioned above.

Leave the area between the monitor and the desk open/uncluttered for later sprite overlays
(conveyor belt, character+chair+keyboard sprite). Portrait 9:16 orientation. No text, no UI, no
characters, no people, no chair, no keyboard, no gradients, no shadows, no perspective distortion.
```

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
