# SP v2.1 实施报告

**分支：** `feature/sp-v21`  
**Worktree：** `/Users/evan/Developer/meme-radar/.worktrees/sp-v21`  
**基线：** `490894f`（main）  
**验收：** `npm test` → **244 pass / 0 fail**；改动过的 `.mjs` 均已 `node --check` 通过。

## 做了什么

### SP-01 双预算与预留 ticket
- 新增 `src/request-budget.mjs`：AUDIT/DISCOVERY/OUTCOME/LIVE 双上限（请求次数 + pacing 权重）、预留/消费/释放、缓存不计费、AUTH 只记物理次数。
- 账本可持久化到 `state/request-budget.json`（无 Key）；坏账本保守等待一个 W；时钟回退不放大预算。
- `GmgnClient.runNow` / `audit` / `observe` 接入 ticket 计费。

### SP-02 公平 lane 与 DEEP/OBSERVE
- 新增 `src/audit-scheduler.mjs`：MANUAL / DISCOVERY / RECHECK / RISK、资格表、modeCursor 轮换、`migrateWatchEntry` + `hashSpread`。
- `Scanner` 在 `throughputEnabled` 时用 `selectFairTasks`，并保留 min(2,M) 深审保护包络。

### SP-03 轻采样观察
- `GmgnClient.observe`：仅 token info，白名单返回字段。
- `WatchPool` 独立 `lastObservation` / `observationHistory` / `observationCount` / `nextObservationAt` / `modeCursor`；失败不抹行情、不改 `riskLatched` / `checkCount` / `nextCheckAt`。

### SP-04 逐币发布与 Nansen 旁路
- `RadarState.commitCandidate` / `attachSupplement`（按 `reviewId` 幂等）。
- `WatchPool.attachSupplement` 原位补证，不增加深审次数。
- 新增 `src/supplement-queue.mjs`：独立队列、最多 1 并发、窗口限流、TTL；cycle 不 await Nansen。
- `SecondaryValidator.validate({ deadline })` 贯穿 fetch 与 body 读取。

### SP-05 混合负载与验收
- 旧 schema 混合 fixture（manual / risk / X_REVIEW / 初筛退回 / 掉榜 / WAIT / 不明 HARD）。
- UI 分开展示深审与轻采样时钟；README 说明 `THROUGHPUT_MODE=1`（**默认关闭**）。

## 测了什么

| 套件 | 覆盖 |
|---|---|
| `test/request-budget.test.mjs` | 包络、预留释放、持久化、坏账本、时钟回退、AUTH |
| `test/audit-scheduler.test.mjs` | lane、资格表、公平轮转、迁移、pause |
| `test/observation.test.mjs` | observe 白名单、失败保留、不洗白风险 |
| `test/sp04-publish.test.mjs` | 逐币提交 race、补证幂等、Nansen 旁路、secondary deadline |
| `test/sp05-mixed-load.test.mjs` | 混合 fixture、预算 race、吞吐 cycle、UI/README |
| 全量 `npm test` | 244 绿（含原有 Nansen/watch/secondary 回归） |

## 未做项（按 brief 明确排除）

- B1-03 判定漏洞、B1-04 收益时点
- B2 / B3、Mass、CoinGlass、只读 Agent
- 不 `git push`、不启动第二真实 scanner、不读真实 Key
- 未改设置弹窗 UI、未改 README 作者信息
- 未声称线上实际提速百分比

## 如何合回主仓库

在主仓库目录执行：

```bash
cd /Users/evan/Developer/meme-radar

# 可选：先看差异
git log main..feature/sp-v21 --oneline
git diff main...feature/sp-v21 --stat

# 合入（任选其一）
git merge feature/sp-v21
# 或
git checkout -b integrate/sp-v21 main && git merge feature/sp-v21

# 验收
npm test

# 启用提速（可选，默认关）
THROUGHPUT_MODE=1 npm start

# 清理 worktree（合入并确认后再做）
git worktree remove .worktrees/sp-v21
```

主会话验收通过后再决定是否 push。Worktree 内已有本地 commit：`SP-01～SP-05: throughput scheduling v2.1`。
