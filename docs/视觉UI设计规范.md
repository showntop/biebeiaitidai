# 《别让AI替代你》视觉 / UI 设计规范稿（v1）

> 先锁整套视觉语言，再批量产素材。本文是**法律**（色板/字体/尺寸/布局以本文件为准）；
> 配套的「风格设定图(Style Tile)」只作调性参考，不 override 本文件。
> 颜色全部取自代码真值：`assets/config/cards.json` + `GameRunner.ts` + `balance.json`，不是估算。

---

## 0. 图文分工（为什么不能只靠一张图）

| 产出 | 承担 | 说明 |
|---|---|---|
| **本规范稿（文字）** | 法律：色板/字体/字号/组件尺寸/主界面布局/间距 | AI 画不准，必须文字定 |
| **风格设定图（1 张）** | 调性：扁平卡通味道、组件长相、配色观感 | 见 §8，刻意不含主界面整图（防幻觉） |
| **主界面布局** | 本文件 §5 线框 + Cocos `Game.scene`（已实现） | 不靠 AI 出整图，代码拼 |

> 教训：让 AI 出"包含主界面+所有元素的整图"会触发它自由发挥成另一个游戏（实测出过"打工人拯救计划"）。主界面永远由代码拼，AI 只出零件 + 一张 style tile。

---

## 1. 色板（取自代码）

### 1.1 卡牌类别色（互不重复，全部避开"返工红"）
| 类别 | 用途 | RGB | HEX |
|---|---|---|---|
| 蓝 routine | 常规 权重2 | 80,160,255 | `#50A0FF` |
| 橙 report | 汇报 权重4 | 255,160,60 | `#FFA03C` |
| 紫 key | 关键 权重5 | 180,100,255 | `#B464FF` |
| 青 proposal | 提案 权重7 | 60,200,220 | `#3CC8DC` |
| 琥珀 urgent | 紧急 权重10 | 255,180,40 | `#FFB428` |
| 灰 meeting/document | 摸鱼 权重0 | 120,120,120 | `#787878` |
| 黑 boss | Boss临检 | 40,40,40 | `#282828` |

### 1.2 状态色（与类别色正交）
| 状态 | 色 | HEX | 备注 |
|---|---|---|---|
| 返工 rework | **红（场上唯一卡片红）** | `#DC3C3C` | 改需求命中后的红章 |
| 插队 inserted | 灰斜纹 | `#787878` + 斜线纹理 | 加需求插入的杂活卡 |
| 活跃白卡 | 饱和类别色（见 1.1） | — | 描边亮一档 |

### 1.3 认可度分区色（UI 层，认可度条用）
| 分区 | 范围 | HEX |
|---|---|---|
| 猎杀 hunt | 0~18 | `#6450FF`（紫） |
| 良好 good | 19~49 | `#50B450`（绿） |
| 勉强 ok | 50~69 | `#C8C850`（黄） |
| 危险 danger | 70~100 | `#DC3C3C`（红） |

### 1.4 功能色（特效/状态反馈）
| 用途 | HEX |
|---|---|
| Perfect / 复活 金 | `#FFD700` |
| 拍马屁冻结 蓝 | `#5096FF` |
| 猎杀 紫 | `#6450FF` |

> 铁律：**红只给"返工卡"和"危险区UI"**（不同层，可同值），场上绝不出现"活的红色威胁卡"。

### 1.5 环境色（背景/桌面/墙面，非功能区）

> 与 §1.1~§1.4 的"功能色"是两套体系：**功能色（卡牌/认可度条/道具）负责辨识速度，必须高饱和强对比，不可动**；**环境色只负责氛围衬底**，可以偏灰、偏暖，条件是够暗/够低饱和以让功能色跳出来。此小节用于把"背景换成偏灰暖色调"的诉求落成可执行色值，不与 §1.1~§1.4 冲突。

| 用途 | RGB | HEX | 备注 |
|---|---|---|---|
| 主背景（办公室墙面/氛围底色） | 235,225,210 | `#EBE1D2` | 偏灰暖米色，替代纯白/纯灰底 |
| 桌面/木质台面 | 168,124,88 | `#A87C58` | 暖棕木色，机器人工位桌面 |
| 显示器外壳/深色结构件 | 60,58,55 | `#3C3A37` | 偏暖深灰（非纯黑），传送带显示器边框、椅背等 |
| 卡片/面板底色（认可度条、事件日志、道具区容器） | 250,245,235 | `#FAF5EB` | 暖白，与功能色描边对比留足 |

- **只用于非功能区**：墙面、地板、桌面、显示器外壳、面板容器底色。**不要**用来替换卡牌类别色、认可度条分区色、道具按钮主色——那些必须保持 §1.1/§1.3 的高饱和值不变。
- **对比度要求**：环境色明度必须明显低于/暗于其上叠加的功能色块，保证卡牌、按钮、认可度条在暖灰背景上依然第一眼跳出来（可用背景亮度差 ≥30% 作为验收标准）。
- 出图 prompt（§8）如需带背景/桌面元素，可在 prompt 里追加：「背景/桌面/墙面用偏灰的暖色调（米色/浅棕），营造温和办公室氛围，但卡牌/按钮/进度条颜色必须保持高饱和鲜艳，不受背景低饱和影响」。

---

## 2. 字体规范

### 2.1 字体选型（已锁，微信小游戏商用免费）
| 用途 | 中文字体 | 备注 |
|---|---|---|
| **标题/战报梗** | **站酷快乐体**（已锁） | 圆润搞笑，强喜感，免费商用 |
| **正文/UI/数值** | 思源黑体 Regular / Medium（Source Han Sans） | 开源，可读性高 |
| **英文/数字** | 同字族拉丁部分，或 Roboto | 与中文配套 |

> 微信小游戏打包需确保字体子集化（只打包用到的字），控制包体。

### 2.2 字号层级（基于 1080×1920 竖屏设计稿）
| 层级 | 用途 | 字号 | 字重 |
|---|---|---|---|
| H1 | 战报大标题 / 结算"满星" | 56 | Heavy |
| H2 | 页面标题（选关/结算） | 40 | Heavy |
| 数值大 | 认可度值 / 倒计时 | 36 | Bold |
| 数值中 | 卡牌权重 +N/-N | 24 | Bold |
| 正文 | 按钮标签 / 提示 | 20 | Regular/Medium |
| 辅助 | 小提示 / 注释 | 14 | Regular |

---

## 3. 组件规范

| 组件 | 结构 | 尺寸（设计稿） | 备注 |
|---|---|---|---|
| **卡牌** | 圆角矩形 + 类别色描边(4px) + 居中符号 + 权重数字(Label 叠加) | 160×200，圆角 16 | 6 格占传送带；空槽 `---` |
| **纸团弹药台** | 桌面纸团堆 + 右侧用途/状态行(CD秒/充能%/×次数) | 160×80，圆角 12 | 4 堆底部；未解锁纸团变灰变瘪，就绪描边发亮 |
| **认可度条** | 横条 0~100 + 分区色分段 + 当前值数字 | 宽 80%×高 40 | 顶部分区色随认可度变 |
| **计时器** | 倒计时秒 + 阶段/结果后缀 | 同数值大 | 顶部 |
| **扫描指示器** | 高亮当前蓄力挡位 + 随 scanPos 放大 | 跟随挡位 | 蓄力时显示 |
| **结算面板** | 居中：星级 + 战报梗 + 数据 + [下一关/重试/复活] | 60% 宽 | 默认隐藏 |
| **选关行** | 第N关 标题 ★★★ [锁] | 行高 36 | 未解锁灰 |

---

## 4. 插画/图标风格（锁定）

- **方向**：扁平卡通矢量（flat cartoon vector），粗黑干净描边，极简平涂色，**无渐变、无写实、无3D**。
- **线宽**：统一粗描边（3~4px @1024），轮廓清晰。
- **角色**：圆头机器人同事（见生产清单资产0），**圆屏脸 = 表情载体**（头形是圆形，但脸的位置仍是一块圆形屏幕/智能显示器，保留"AI 的脸 = 屏幕脸"的主题符号）。
- **图标**：极简单线+平涂符号，不要写实细节。
- **命中特效**：漫画式星爆/光晕，可有半透明，不参与类别色体系。

---

## 5. 主界面布局（线框，权威 · 据参考图 v4）

> 竖屏 1080×1920。**结构**：传送带(=AI显示器·任务流)在**上方**，AI角色在传送带**下方居中**面朝它（背对玩家），认可度条再往下，事件日志压薄放认可度条下方，**纸团弹药台下沉到最底部**（60s 内高频长按/划扔的核心交互区，占最靠拇指的黄金位置，比事件日志优先拿"最底"）。顶部HUD只放 设置/标题/计时器。

> **v3 调整**（对照实测出图反馈修的）：① AI 角色区从 15% 压缩到 ~11%，角色本体做得更小/更Q（Q版比例，头身比更夸张），空间让给下方；② **道具按钮和事件日志顺序互换**——事件日志只是被动展示、不需要点按，往上收；道具按钮是高频交互控件，下沉贴底，且加高一档（14%→更好点按）；③ 事件日志从 20% 压到 ~6%，做成一条薄 strip。
>
> **v4 修正**：① 道具按钮从 16% 减回 12%（v3 给得太高，导致按钮变成"高瘦柱子"，与 §3 的 160×80 宽矮比例不符），省出的 4% 给底部安全区；② AI 头形从"屏幕头(矩形)"改为"圆头(圆屏脸)"，呼应 Q 版可爱方向，但保留"脸=屏幕"的主题符号。

```
┌──────────────────────────────┐ 1080
│ ⚙设置       别让AI替代你      │ 顶部HUD (0~8%)
│            第2关·试用期  57s⏱ │ 设置(左上) 标题+关(中) 计时器(右上)
├──────────────────────────────┤
│处理→[卡][卡][卡][卡][卡][卡]←入口│ 传送带 = AI显示器·任务流 (10~37%)
│                              │  6卡横排，左=处理区 右=入口；扫描指示器跟蓄力
│           ◆ AI 角色（小/Q）    │  圆头机器人（背影），面朝上方传送带 (37~48%)
├──────────────────────────────┤
│ 认可度 ▓▓▓▓░░░░░░░░ 危险!     │ 认可度条 (50~60%)
│ 0    43 ↑目标50   70    100  │  分段:猎杀/良好/勉强/危险 + 目标线 + 阶段"试用期×1.0"
├──────────────────────────────┤
│ 事件日志：改需求命中紧急 -10… │ 事件/战报薄条 (62~68%，单行)
├──────────────────────────────┤
│[白纸团×5][紫纸团×6][咖啡团×2][粉便签]│ 纸团弹药台横排4堆 (72~84%，宽矮比例贴底)
│                              │ 底部安全区 (84~100%，home indicator + 拇指留白)
└──────────────────────────────┘ 1920
```

- **分区**（自上而下）：顶部HUD → 传送带(任务流) → AI角色 → 认可度条 → 事件日志(薄) → 纸团弹药台(贴底) → 安全区。
- **传送带即"AI的显示器"**，AI 坐其下方面朝它处理任务（工作站位）——背对玩家，不露脸。
- **AI 角色区做小**：占屏高 ~11%（原 15%），角色本体用 Q 版比例（大头小身），**头形为圆形（圆屏脸）**，把视觉重心和空间让给下方信息/操作区。
- 认可度条带**目标线**和**四段分区色**（猎杀紫/良好绿/勉强黄/危险红，见 §1.3）+ 阶段倍率标签（如"试用期 ×1.0"）。
- **事件日志变薄**：单行文字+小图标，占屏高 ~6%（原 20%），不需要多行滚动区。
- **纸团弹药台贴底、宽矮比例**：占屏高 ~12%，按 §3 的 160×80(2:1) 比例横排。每格左侧画纸团堆，右侧显示**作用/剩N次**（对齐代码 `PropSystem.uses`），作为 60 秒内最高频的长按划扔区。
- 角色分层 sprite（见 §4.1）；bg-office 仅环境。
- 主界面不靠 AI 出整图，由 Cocos 按此线框拼（`GameRunner` + `Game.scene`）。

> **已定**（与代码一致）：标题 = 「别让AI替代你」；底部弹药台 = **4 个横排纸团堆**（白纸团=加需求 / 紫纸团=改需求 / 咖啡团=丢锅 / 粉便签=拍马屁，粉便签第 4 格）。

### 4.1 角色美术架构（方案A · 场景内转头，圆头机器人）

角色分三层 sprite，保证一致性的同时把表情做便宜：

| 层 | 资产 | 说明 |
|---|---|---|
| **背影（默认态）** | `char-back` | 机器人从背后（圆头背面+机身），90% 时间显示这个 |
| **转头基准** | `char-turn-base` | 同一机器人转头 3/4 侧，圆屏脸朝向玩家（中性脸） |
| **圆屏脸 ×12** | `char-face-{expression}` | 12 个小"圆屏脸"贴图（emoji 级），叠在 `char-turn-base` 的圆形屏幕区域 |

- 一致性只需管 **2 个身体帧**（背影 + 转头）是同一个机器人；12 个表情是独立的小屏幕脸，互不影响、甚至可代码画。
- 事件触发：默认 `char-back` → 切 `char-turn-base` + 叠对应 `char-face` → 到时回落 `char-back`。
- 这样方案A 的"跨帧一致性"难题被屏幕头拆解成"2 身体帧一致 + 12 张小脸"，可控。

---

## 6. 栅格 / 间距

- **基础栅格**：8pt（所有间距是 8 的倍数：8/16/24/32）。
- **外边距**：左右 32px。
- **组件间距**：同区 16，跨区 32。
- **安全区**：顶部/底部留出系统状态栏与 home indicator。
- **v3 调整**：道具按钮区下沉贴底后，与安全区/home indicator 之间只留 **16px**（原跨区 32），其余组件间距不变；事件日志薄条与认可度条之间跨区间距降为 **24px**（比常规跨区 32 略紧凑，呼应它被压薄的定位）。

---

## 7. 与生产的关系（顺序）

1. **本规范稿**（先定法律）← 你现在看这个
2. **风格设定图**（§8，1 张，验调性）
3. **逐资产生产**（按《美术资源制作清单》资产 0~6，照本规范配色/尺寸）

> 资产清单里的配色/尺寸若与本规范冲突，**以本规范为准**，回头改清单。

---

## 8. 风格设定图（Style Tile）生成 prompt

> 一张图，含：角色 + 道具 + 卡牌样本 + 色板 + 字样。**刻意不含主界面整图**（防幻觉）。

- **工具**：GPT-image / Nano / 即梦
- **参考图**：风格参考 = `style-lock/` 卡牌样张
- **尺寸**：1536×1536
- **提示词**：
```
Flat cartoon vector game art, bold clean outlines, minimal flat color, no gradients,
casual WeChat mini-game art direction, office comedy theme, high readability.

A DESIGN STYLE TILE (a flat reference board, NOT a playable game screen), with these sections
laid out cleanly on one board:
- top-left: a cute screen-headed robot office coworker, front view, full body, blue lanyard.
- top-right: four round-cornered square prop button icons in a row: a crumpled paper, a rewind
  arrow, a flying pot, a pink heart.
- middle: three sample game cards side by side — rounded rectangles with a blue border, an amber
  border, and a cyan border, each with one simple symbol; plus one red "REWORK" stamp tilted
  over a card.
- a horizontal color palette strip of 8 swatches: blue, orange, purple, cyan, amber, gray, red, gold.
- bottom: a typography sample showing the bold rounded text "别让AI替代你".

This is a flat design reference board only. STRICTLY: no fake game systems, no coins, no currency,
no stamina, no building upgrades, no departments, no extra characters, no playable UI, no
photorealism, no 3D. Just the listed reference elements on a clean board.
```

> 这张图只为锁定"调性一致"，**字体/尺寸/色值以本规范 §1~§3 为准**（AI 的色和字会偏差）。

### 8.1 主界面参考图（AI 锁死出图）

> **用途**：把主界面的视觉调性"看一眼"，作为做美术的依据参考。
> **防幻觉要诀**：① 把屏幕每个区域该有什么**逐条写死**，不留空给 AI 发挥；② 把它上次乱编的（金币/大楼/部门/体力/商店）**逐条禁掉**。
> **定位**：这是"调性参考"，**不是法律**——元素位置/尺寸/色值仍以本规范 §1~§5 + Cocos 为准。建议出 3~4 张挑最贴的，忽略零星多余细节。

> **v2 改进点**（对照实测出图 v1 的问题修的）：① 6 张卡牌颜色改成**规范 §1.1 六个类别色的具体 HEX**，不重复、不缺色；② 每张卡牌符号按类别语义写死（不再是随手编的文件/邮件图标）；③ 认可度条按 §1.3 **四段色**（紫/绿/黄/红）写死，不再简化成三段；④ 传送带明确提示"嵌在电脑显示器边框里"，呼应"AI显示器"标签；⑤ 补一条 negative prompt："界面文字必须全部是中文，不得出现任何英文单词"，避免英文版走样。
>
> **v3 修正**：v2 曾误写成"机器人面朝镜头"，与 §4.1"背影为默认态、面朝传送带"相悖，已改回**背对玩家、面朝显示器**（露脸转头态只在特定事件触发时用，不进这张主参考图）。同时按新线框(§5 v3)调整了各区块占比与顺序：角色区变小做Q版，事件日志变薄并上移，道具按钮下沉到最底部。
>
> **v4 补充**：新增环境色要求（见 §1.5）——背景/桌面/显示器外壳用偏灰暖色调（米色`#EBE1D2`/木棕`#A87C58`），营造更耐看的办公室氛围；但卡牌/认可度条/道具按钮等**功能色必须保持 §1.1/§1.3 原高饱和值不变**，不受环境色影响。

**即梦 / Jimeng（CN，推荐——负面词用中文最清楚）**，尺寸 1080×1920：
```
扁平卡通矢量游戏 UI 设计稿，粗黑干净描边，极简平涂色，无渐变，微信休闲小游戏美术风格，办公喜剧主题。竖屏 9:16。界面所有文字必须是中文，不得出现任何英文单词。背景/桌面/墙面/显示器外壳用偏灰的暖色调（米色/浅棕木色），营造温和办公室氛围；但卡牌、认可度条、道具按钮的颜色必须保持下文指定的高饱和鲜艳色值，不受背景低饱和影响，绝不能被背景带灰。

这是游戏《别让AI替代你》的【唯一一张主游戏界面】，从上到下【只】包含以下元素，不得多画任何东西：

顶部(0~8%)：
- 左上角一个【设置】齿轮图标
- 中间标题"别让AI替代你"，下面小字"第2关·试用期"
- 右上角一个倒计时"57s"

中上部(10~37%)：
- 画面里有一台【电脑显示器】，显示器屏幕内是一条横向【传送带】(标签"AI显示器·任务流")，左端"处理→"、右端"←入口"
- 传送带上正好 6 张圆角矩形【卡牌】横排，从左到右颜色和符号严格如下，不得替换或重复：
  1. 蓝色(#50A0FF)，符号=一个简单的文档图标（常规）
  2. 橙色(#FFA03C)，符号=一个文件夹图标（汇报）
  3. 紫色(#B464FF)，符号=一个靶心图标（关键）
  4. 青色(#3CC8DC)，符号=一个灯泡图标（提案）
  5. 琥珀色(#FFB428)，符号=一个闹钟图标（紧急）
  6. 灰色(#787878)，符号=一个咖啡杯图标（摸鱼）

中部(37~48%，占比小)：
- 一个**小号、Q版比例**（大头小身、矮胖可爱）的**圆头**机器人同事坐着，头形是**圆形**（不是矩形/方块），头脸位置是一块**圆形屏幕**（圆屏脸，保留"AI 的脸 = 屏幕脸"的设定）；【背对玩家】(只看到圆头背面/后脑勺和椅背)，面朝上方的显示器传送带，双手放在桌面/键盘位置（不要露脸、不要转头看镜头；这个角色只占整张图一小块，不要画得太大占满中段）

中下部(50~60%)：
- 一根横向【认可度条】(0-100)，从左到右严格分四段：紫色(#6450FF，0-18，标"猎杀")、绿色(#50B450，19-49，标"良好")、黄色(#C8C850，50-69，标"勉强")、红色(#DC3C3C，70-100，标"危险!")；当前值43用一个悬浮气泡标在紫绿交界附近
- 条旁小字"阶段:试用期 伤害×1.0"

下部(62~68%，窄条)：
- 一条【事件日志】薄横条，只有单行高度，显示一行"改需求命中紧急 -10"，配一个小图标

底部(72~84%，贴底，宽矮比例)：
- 横排 4 个圆角方形【纸团弹药台】：蓝白纸团"加需求 ×5"、紫纸团"改需求 ×6"、咖啡纸团"甩锅 ×2"、粉便签"拍马屁"；每格左侧必须是纸团堆，不再使用大号功能图标；弹药台呈**宽矮比例**（宽>高，约2:1），**不要**画成高瘦的柱状；这一排位于全图**最下方**，但高度适中（约占屏高12%），下方留出底部安全区留白

严禁出现除上述外的任何元素：不要标题界面、不要编其它游戏名(只能是"别让AI替代你")、不要金币/钻石/货币、不要体力条/爱心生命、不要写字楼/部门/组织架构、不要建筑升级、不要商店、不要多余角色、不要多张界面拼图、不要英文文字、不要上述列表以外的文字。就一张干净的游戏主界面，扁平卡通风格。
```

**GPT-image / Nano（EN，注意：即使用英文提示词，画面里的 UI 文案本身仍须是中文）**，尺寸 1080×1920：
```
Flat cartoon vector game UI mockup, bold clean outlines, minimal flat color, no gradients,
casual WeChat mini-game art direction, office comedy theme. Portrait 9:16.
Background/desk/wall/monitor casing should use a muted warm-gray palette (beige/light warm wood
tone) for a cozy office atmosphere; but all FUNCTIONAL colors (cards, approval meter, skill
buttons) must stay at the exact saturated HEX values specified below — they must NOT be muted or
tinted by the background.
IMPORTANT: all on-screen UI text/labels must be rendered in Chinese characters, not English —
English below is only instruction language, not what should appear in the image.

This is the SINGLE main game screen for "别让AI替代你". Layout top-to-bottom — EXACTLY these
elements, nothing else:

TOP (0-8%): a SETTINGS gear icon top-left; centered Chinese title "别让AI替代你" with Chinese
subtitle "第2关·试用期"; a TIMER "57s" top-right.

UPPER-MID (10-37%): a computer MONITOR frame; inside its screen is a horizontal CONVEYOR BELT
labeled in Chinese "AI显示器·任务流", Chinese "处理→" on the left end, "←入口" on the right end.
Exactly 6 rounded CARDS in a row on the belt, colors and symbols fixed left-to-right, do not
substitute or repeat:
  1. blue #50A0FF, symbol = a simple document icon (routine task)
  2. orange #FFA03C, symbol = a folder icon (report task)
  3. purple #B464FF, symbol = a bullseye/target icon (key task)
  4. cyan #3CC8DC, symbol = a light-bulb icon (proposal task)
  5. amber #FFB428, symbol = an alarm-clock icon (urgent task)
  6. gray #787878, symbol = a coffee-cup icon (idle/slack-off task)

MID (37-48%, small proportion): a SMALL, CHIBI/Q-style proportioned (big head, short chubby body)
robot coworker with a ROUND head (head shape is a circle, NOT a rectangle/box); the face area on
the head is a circular screen (round-screen-face — keep the "AI's face = a screen" theme, but the
screen is round). Seen from BEHIND (back view only — back of the round head and chair back
visible), facing UP toward the monitor/conveyor above, hands resting on the desk/keyboard. Do NOT
show its face or have it turn toward the camera. Keep this character small — it should occupy only
a small portion of the screen, not dominate the middle section.

LOWER-MID (50-60%): a horizontal APPROVAL METER (0-100) split into exactly 4 colored segments
left-to-right: purple #6450FF (0-18, labeled in Chinese "猎杀"), green #50B450 (19-49, labeled
"良好"), yellow #C8C850 (50-69, labeled "勉强"), red #DC3C3C (70-100, labeled "危险!"); current
value 43 shown as a small floating bubble near the purple/green boundary. Small Chinese text
beside it: "阶段:试用期 伤害×1.0".

LOWER (62-68%, thin strip): a single-line-height EVENTS LOG strip with a small icon, showing one
line of Chinese text "改需求命中紧急 -10". Keep this strip thin/compact.

BOTTOM (72-84%, near the screen edge, wide-and-short proportion): a row of 4 round-cornered PAPER
AMMO PILES with Chinese labels: blue-white "白纸团 加需求×5", purple "紫纸团 改需求×6", coffee-stained "咖啡团 甩锅×2", pink sticky-note "粉便签 拍马屁".
Buttons must be WIDE-AND-SHORT (width > height, roughly 2:1 ratio) — do NOT render them as tall
narrow pillars. This row sits at the bottom of the screen but with moderate height (~12% of screen
height), leaving a small safe-area margin below it.

STRICTLY FORBIDDEN: no English words anywhere in the image, no title screen, no other game name,
no coins/gems/currency, no stamina/hearts, no office building, no departments, no building
upgrades, no shop, no extra characters, no multiple screens, no text other than listed. ONE clean
game screen, flat cartoon.
```

---

## 9. 决策记录（已锁）

- [x] **竖屏 1080×1920**（微信小游戏，单手操作）。
- [x] **标题字体：站酷快乐体**（圆润搞笑）。
- [x] **表情方案A：场景内转头**（AI 角色分层 sprite：背影 + 转头基准 + 屏幕脸×12，见 §4.1）。
- [ ] 风格设定图出了发我，我对着本规范验调性。
