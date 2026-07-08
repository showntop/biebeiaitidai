# 《别让AI替代你》—— 核心规则层（M0 地基）

> 纯 TypeScript 实现的**数值判定层**，零 Cocos 依赖，可在 Node 下独立单测。
> 对应 `docs/` 三份策划文档，落地开发计划 §2 的系统架构与 M0 验收要求。

## 为什么是这一层先做（维护性命门）

本项目头号风险是**数值平衡**（开发计划 §5）。把规则抽成可独立测试的纯逻辑层，换来：

- **策划改数值 = 改 `assets/config/*.json`**，不碰代码、不开 Cocos 编辑器。
- **规则可千局模拟**：Node 里 2 秒跑上千局，客观验证"猎杀可达吗 / Boss保底真救你吗 / 危机期会不会骤死"——M4 调数值的依据。
- **判定层/表现层物理隔离**：表现层（Cocos）只订阅事件、不回写判定，重做美术或升级 Cocos 都不动规则。

## 目录结构

```
assets/
  scripts/
    core/                 ← 纯 TS，零 cc 依赖（强制纪律，见下）
      types.ts            领域类型 + 全系统事件契约（discriminated union）
      EventBus.ts         类型安全发布订阅
      config.ts           JSON 数值表强类型加载 + 分区/阶段查表
      systems/
        ApprovalSystem.ts 认可度分区/增减来源/Boss只加不减/双路径胜负
      (待补) ConveyorSystem PropSystem AIActorSystem LevelSystem Game.ts
    cocos/                ← 薄适配层（后续阶段）：import cc，订阅 core 事件驱动节点
  config/                 ← 策划改这里：数值表（Excel/CSV 导出为 JSON）
    cards.json props.json balance.json level-default.json
tests/                    ← Vitest：断言文档里的每条规则
```

## 分层纪律（必须守住）

1. **`core/` 目录禁止 `import cc`**——这是判定层/表现层隔离的物理保证。建议后续加 lint 规则（如 `eslint-plugin-import` no-restricted-paths）自动拦截。
2. **所有平衡常量来自 `config/*.json`**，core 代码不硬编码权重/CD/阈值/分区边界。
3. **表现层只订阅事件、不回写判定**（开发计划 §2 关键原则）。

## 运行

```bash
npm install
npm test            # 全部规则单测（50 项，排除 sim）
npm run test:watch  # 监听
npm run typecheck   # 全量类型检查
npm run sim         # 贪婪 bot 千局模拟，输出胜负/星级/峰值分布（平衡诊断）
```

## 当前状态

**核心规则层已全部实现，50 项单测 + 类型检查全绿：**

| 系统 | 职责（对应策划文档） |
|---|---|
| types / EventBus / rng / config | 领域类型+事件契约、类型安全事件总线、可注入确定性 RNG、数据驱动配置 |
| ApprovalSystem | 认可度分区、增减来源、Boss 只加不减结算、猎杀线维持2秒/生存式双路径胜负、冻结暂停 |
| ConveyorSystem | 队列模型、按阶段分布生成、挡位左移结算、Boss 临检结算+分级预警 Tell、道具变更(插入/污染/清空) |
| PropSystem | 4 道具 CD/能量槏、蓄力扫描命中、Perfect 可变奖励池、连击(纯演出)、Boss 资源保底§5.4②、取消手势 |
| AIActorSystem | 事件→表情(优先级+时长)，纯表现不回写数值 |
| LevelSystem | 关卡数据 + §6.2 星级评价 |
| Game | 总装：事件接线、tick 主循环、输入 API、冻结编排、统计结算 |

**确定性千局模拟（`npm run sim`）已产出第一条平衡证据：**
- 什么都不做的"玩家" → 999/1000 负（不出手必输，符合预期）。
- 贪婪 bot（主动拒结算/危险区拍马屁/堆积丢锅） → 743 生存胜 / 257 负 / **0 猎杀**，平均峰值认可度 87.6。
- 结论：游戏可玩可赢，但默认数值偏紧（M4 调优范畴）；**猎杀路径实战 0/1000，实测印证了设计文档自己留的 M4 诫语**——猎杀线 15 在当前减分预算下偏难。现在调平衡 = 改 `config/*.json` + 重跑 `npm run sim`，2 秒出结果，无需编辑器。

**下一步：**
1. 接入 Cocos 表现层：用编辑器建工程后，在 `assets/scripts/cocos/` 写薄组件订阅 core 事件驱动节点/UI/动效。
2. 用 `npm run sim` 做 M4 数值调优（首关通过率、猎杀达成率、危机骤死等量化验收，见开发计划 M4 行）。
3. M1 手感验证：`蓄力扫描-松手`在大盘用户上的 30 秒上手率（开发计划§5 风险表已记代价须知）。

## 接入 Cocos（后续）

当用 Cocos Creator 3.8.x 在本目录新建/打开工程后，编辑器会生成
`project.json / settings / library / temp` 及各资源 `.meta`，
与 `assets/scripts/core` 源码不冲突。之后在 `assets/scripts/cocos/` 写薄组件，
订阅 core 事件驱动节点即可。core 无需任何改动。
