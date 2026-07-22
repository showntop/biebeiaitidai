# 数据事件与首局漏斗

当前实现会把事件先写入本地环形日志，同时安全扇出到正式分析出口：宿主注入 SDK 时优先调用
`track`，否则在微信环境调用 `wx.reportEvent`（兼容旧版 `wx.reportAnalytics`）。任一出口失败都不会
阻断游戏或影响其他出口。日志最多保留 400 条，不记录昵称、openid、输入文本等个人信息。

## 正式平台接入

如使用神策、GrowingIO 或自建 SDK，在游戏启动前注入统一适配器：

```js
globalThis.__BRAATN_ANALYTICS__ = {
  track(eventName, payload) {
    analyticsSdk.track(eventName, payload);
  },
  flush() {
    analyticsSdk.flush?.();
  },
};
```

没有注入适配器时，微信小游戏会使用原生自定义事件接口；需要在微信数据后台建立与下表同名的
事件及字段。浏览器本地预览则自动退化为 `local-only`。当前出口状态可执行：

```js
globalThis.__BRAATN_TELEMETRY_DELIVERY__.status()
```

## 首批事件

| 事件 | 触发时机 | 关键字段 |
| --- | --- | --- |
| `session_start` | 游戏启动 | appVersion、platform、deviceTier |
| `level_start` | 一局创建 | levelIndex、seed、runId |
| `tutorial_shown` | 首关教学出现 | step |
| `prop_hold_started` | 道具按下 | prop |
| `first_drag` | 本局首次有效拖动 | sinceLevelStartMs |
| `first_release` | 本局首次松手投出 | prop、sinceLevelStartMs |
| `first_valid_hit` | 本局首次有效命中 | prop、quality、sinceLevelStartMs |
| `first_perfect` | 本局首次 Perfect | prop、sinceLevelStartMs |
| `invalid_target` | 空位或目标不接受道具 | prop、reason |
| `gesture_cancel` | 真实手势取消 | prop |
| `approval_zone_changed` | 认可度跨区 | from、to |
| `boss_warning` | Boss 进入预警挡位 | tier、slot |
| `revive_used` | 复活成功 | runId |
| `result_type` | 最终结算 | result、stars |
| `fail_reason` | 最终失败 | unhandled-task / boss-inspection / unknown |
| `level_end` | 一局最终结束 | 见局末聚合 |
| `retry / next_level / return_home` | 结算或返回操作 | 继承上一局 runId、levelIndex |

首次失败但仍可复活时不会立刻发 `level_end`；复活成功后继续沿用原 runId，最终只结算一次。

## 局末聚合

`level_end` 同时提供：首击耗时、有效命中率、Perfect 率、取消率、无效目标次数、四种道具使用分布、
FPS P50/P10、认可度峰值/终值、最终结果和星级。P3 起额外记录 `objectiveMet / objectiveLabel`，
P4 起记录即时 `highlight` 以及局末 `highlightCount / highlightIds / highlightTitle`，
P5 起记录 `share_open / share_result / challenge_start`，用于判断战报是否真的带来同局挑战，
用来区分基础通关与专属挑战达成，避免只看三星率猜测玩家卡点。内部首轮目标值见
[`CURRENT_STATE_AND_ROADMAP.md`](./CURRENT_STATE_AND_ROADMAP.md)。

## 本地验收

Web 预览控制台可执行：

```js
globalThis.__BRAATN_TELEMETRY__.dump()
globalThis.__BRAATN_TELEMETRY__.flush()
globalThis.__BRAATN_TELEMETRY__.clear()
```

正式 Web 预览在局末/返回首页时写入 `localStorage.braatn_telemetry_v1`；QA 查询参数使用内存日志，
不会污染真实数据。自动化验收至少断言：`level_start → prop_hold_started → first_drag → first_release → first_valid_hit`。
