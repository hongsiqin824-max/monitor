# 懂球帝实时赛事事件监测与通知服务

实时接入懂球帝赛事推送（WebSocket），**按比赛聚合事件时间线**，并对**进球 / 角球 / 红牌**三类关键事件**实时产生通知**。可本地运行，也可在服务器上 7×24 常驻。

---

## 这个项目能做什么

- **实时监测**：长连接 `wss://im-ap.dongqiudi.com/redpacket`，持续接收比分、角球、红黄牌、赔率等事件流。
- **按比赛聚合**：以 `match_id` 为单位，把零散事件整理成"每场比赛的时间线"。
- **关键事件通知**：只在真正发生 **进球 / 角球 / 红牌** 时产出一条通知（自动过滤计时刷新、赔率跳动等噪声）。
- **精准去重 & 不漏报**：把三类事件当作单调递增计数，服务端数值抖动也不会重复告警；通知计数严格 +1，无跳号。
- **双保险检测**：服务端 `push_card` 信号 + 本地状态 diff，二者互为兜底。
- **结构化输出**：每条通知以 JSONL 落盘（`notifications.jsonl`），含比赛、事件类型、哪队、比赛内时间、新旧数值、来源，便于入库/二次消费。
- **生产可用**：内置断线自动重连 + 数据静默看门狗 + 优雅退出，配套 pm2 / systemd 守护配置。

## 一条通知长什么样

```
🔔[进球] 哥伦杯 1/4决赛 | A队(50000347) 1→2 | 比分2-0 | 1H 41 | 来源:diff
```
对应 JSONL：
```json
{"match_id":54622319,"match_title":"哥伦杯 1/4决赛","event_type":"goal","event_cn":"进球",
 "team":"A","team_id":50000347,"minute":"1H 41","detail":{"from":1,"to":2,"score":"2-0"},
 "source":"diff","push_time":1792000000}
```

## 快速开始

需要 Node.js 18+（已验证 v24）。**网络前提见下方"网络可达性"。**

```bash
# 持续运行（Ctrl+C 结束并打印各场时间线）
node match_timeline.mjs

# 只跑固定时长
node match_timeline.mjs --seconds 300

# 指定输出文件
node match_timeline.mjs --out notifications.jsonl
```

服务器常驻（pm2）：
```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 logs match-timeline
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `match_timeline.mjs` | **主服务**：聚合时间线 + 三类事件通知 + 断线重连/看门狗/优雅退出 |
| `redpacket_parser.mjs` | 通用事件解析器：把原始推送三层拆解并归一化为结构化事件 |
| `ecosystem.config.cjs` | pm2 守护进程配置（跨平台） |
| `match-timeline.service` | systemd 守护配置（Linux 生产） |
| `notifications.jsonl` | 结构化通知输出（运行时生成） |
| `events.jsonl` | 解析器的全量事件输出（运行时生成） |
| `00_项目管理/` | 进度快照 / 会话交接 / 工作日志（内部续接与追溯用） |

## 网络可达性

`wss://im-ap.dongqiudi.com/redpacket` 这条**底层长连接对普通公网开放**，经实测**不依赖飞连、不依赖公司网络 / 源 IP 白名单**：

- 本机在公司网外、以及无飞连时均可直连；
- **普通公网服务器可直接连通**，可 7×24 常驻部署。

> 实测记录（2026-10-15）：在 GitHub Actions 的公网 runner（出口 IP `52.242.244.195`，微软 Azure，非公司网、非飞连）上运行 `conn_test.mjs`，连接成功并持续收到推送数据。验证脚本见 `conn_test.mjs`，CI 配置见 `.github/workflows/conn-test.yml`。

> 注：域名下的「可视化界面」（浏览器页面）可能受公司网络限制，但本项目**直接对接底层长连接**，不走该界面，故不受此限制。

## 后续规划

- [ ] `team_id → 队名` 映射（目前通知只显示 team_id）
- [ ] Webhook 推送（飞书 / 企业微信）
- [ ] 红牌通知的真实样本验证
- [x] 落实生产网络授权（已实测：公网可直连，无需白名单/飞连）

---

## 维护说明（改动请同步到这里）

> 每次有功能/行为变更，请在此追加一行，保持本 README 与实际代码一致。

### 变更记录
- 2026-10-14：初版。实现实时监测、按比赛聚合、进球/角球/红牌通知、去重修复、断线重连与 pm2/systemd 守护配置。
- 2026-10-15：实测底层长连接对普通公网开放（GitHub Actions 公网 runner 验证通过），更正"网络可达性"说明——不再依赖飞连/公司网白名单，可直接部署公网服务器；新增 `conn_test.mjs` 连通性测试脚本与 `.github/workflows/conn-test.yml`。
