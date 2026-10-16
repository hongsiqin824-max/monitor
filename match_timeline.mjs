// 懂球帝实时赛事 —— 按 match_id 聚合成"每场比赛时间线"，并对关键事件实时推送通知
// 事件类型：进球(goal) / 角球(corner) / 红牌(red_card)
// 检测方式：进球 = 服务端 type="G" 信号（按唯一 id 去重，仅 status=Playing）；
//          角球/红牌 = 状态 diff + push_card 信号双保险（以 diff 数值变化为准，兼顾去重）
// 说明：只处理足球(soccer)；篮球无角球/红牌，比分高频跳动不在本需求内。
//
// 用法：
//   node match_timeline.mjs                 # 持续运行，Ctrl+C 结束并打印各场时间线
//   node match_timeline.mjs --seconds 300   # 跑 300 秒自动结束
//   node match_timeline.mjs --out notifications.jsonl
import fs from "node:fs";

const URL = "wss://im-ap.dongqiudi.com/redpacket";
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const RUN_SECONDS = Number(getArg("--seconds", 0));
const OUT_FILE = getArg("--out", "notifications.jsonl");
// Forward 进球/红牌 to the 8901 monitor console (loopback when co-deployed), which
// fans out to its page + Feishu. Empty URL disables forwarding (JSONL still kept).
const INGEST_URL = getArg("--ingest-url", process.env.GIF_8901_INGEST_URL || "http://127.0.0.1:8901/api/monitor/events/ingest");
const INGEST_TOKEN = process.env.GIF_8901_INGEST_TOKEN || "";
const ALERT_POST_TYPES = new Set(["goal", "red_card"]);

const EVENT_CN = { goal: "进球", corner: "角球", red_card: "红牌" };
// 服务端信号 → 内部事件类型。
// 进球由 content.type==="G" 标志（实测确认）；push_card 仅在角球/红黄牌时出现，取值 corners/red_cards/yellow_cards。
const PUSH_CARD_MAP = { corners: "corner", red_cards: "red_card" };

// 把比分/统计字段转成整数；空串或非数字返回 null（表示"未知"，不参与 diff）
const toInt = (s) => {
  if (s === "" || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// 每场比赛的聚合状态： match_id → { ...meta, last:{}, timeline:[] }
const matches = new Map();
const out = fs.createWriteStream(OUT_FILE, { flags: "a" });
let totalMsg = 0, notifyCount = 0;

// Fire-and-forget POST of a goal/red-card to 8901. Never throws and never blocks
// detection: a 3s timeout and a swallowed error keep the JSONL path authoritative.
async function postAlert(payload) {
  if (!INGEST_URL) return;
  try {
    const headers = { "Content-Type": "application/json" };
    if (INGEST_TOKEN) headers["X-Monitor-Token"] = INGEST_TOKEN;
    await fetch(INGEST_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.log(`[${new Date().toISOString()}] [ALERT] 推送 8901 失败: ${e.message}`);
  }
}

// 比较某一项统计（A/B 两侧），返回发生"增加"的事件列表
function diffStat(eventType, prev, cur) {
  const events = [];
  for (const side of ["A", "B"]) {
    const p = prev?.[side], c = cur[side];
    if (p != null && c != null && c > p) {
      events.push({ event_type: eventType, team: side, from: p, to: c });
    }
  }
  return events;
}

function handleMatch(env, c) {
  if (c.cmp_type !== "soccer") return; // 只关心足球
  const id = c.match_id;
  const cur = {
    fs: { A: toInt(c.fs_A), B: toInt(c.fs_B) },
    corners: { A: toInt(c.corners_A), B: toInt(c.corners_B) },
    rc: { A: toInt(c.rc_A), B: toInt(c.rc_B) },
  };
  const minute = `${c.minute_period || ""} ${c.playing_time ?? ""}`.trim();

  let st = matches.get(id);
  if (!st) {
    // 首次见到该场比赛：仅建档登记基线，不推送（避免把"初始快照"误报成事件）
    st = {
      match_id: id, match_title: c.match_title, cmp_type: c.cmp_type,
      team_A_id: c.team_A_id, team_B_id: c.team_B_id,
      last: cur, timeline: [], sig: new Set(),   // sig: 已兜底通知过的 事件|队 键（角球/红牌）
      goals: new Set(),                          // 已报过的进球唯一 id（type="G" 去重）
    };
    matches.set(id, st);
    return;
  }

  // ① 角球/红牌：状态 diff 检测（基线单调不减，天然去重；进球不再用 diff，改用下方 type="G" 信号）
  const detected = [
    ...diffStat("corner", st.last.corners, cur.corners),
    ...diffStat("red_card", st.last.rc, cur.rc),
  ];
  // diff 一旦真实推进，清掉对应 sig 标记，使后续新一轮同类事件仍可被兜底
  for (const d of detected) st.sig.delete(`${d.event_type}|${d.team}`);

  // ② 进球：服务端 type==="G" 信号，按唯一 id 去重，只处理进行中的比赛。
  //    实测每粒进球带稳定唯一 id、正常只推一次；偶有对已结束比赛的补发，故用 id 去重 + status 过滤。
  if (c.type === "G" && c.status === "Playing") {
    const goalId = String(c.id ?? "").replace(/"/g, "");
    if (goalId && !st.goals.has(goalId)) {
      st.goals.add(goalId);
      const side = c.target_team === 2 ? "B" : c.target_team === 1 ? "A" : "?";
      detected.push({ event_type: "goal", team: side, from: null, to: null, source: "signal", event_id: goalId });
    }
  }

  // ③ 角球/红牌 push_card 信号兜底：仅当 diff 没抓到(例如数值未知)且该 事件|队 尚未兜底过时，补一条
  const signaled = c.push_card ? PUSH_CARD_MAP[String(c.push_card)] : null;
  if (signaled && !detected.some((e) => e.event_type === signaled)) {
    const side = c.target_team === 2 ? "B" : c.target_team === 1 ? "A" : "?";
    const sigKey = `${signaled}|${side}`;
    if (!st.sig.has(sigKey)) {
      st.sig.add(sigKey);
      detected.push({ event_type: signaled, team: side, from: null, to: null, source: "push_card" });
    }
  }

  for (const d of detected) {
    const notif = {
      match_id: id,
      match_title: st.match_title,
      cmp_type: st.cmp_type,
      event_type: d.event_type,
      event_cn: EVENT_CN[d.event_type],
      team: d.team,                                   // A / B / ?
      team_id: d.team === "A" ? st.team_A_id : d.team === "B" ? st.team_B_id : null,
      minute,                                          // 比赛内时间，如 "2H 68"
      detail: {
        from: d.from, to: d.to,
        score: `${cur.fs.A ?? "-"}-${cur.fs.B ?? "-"}`,
        corners: `${cur.corners.A ?? "-"}-${cur.corners.B ?? "-"}`,
      },
      source: d.source || "diff",                     // 来源：diff(角球/红牌比分) / signal(进球type=G) / push_card(角球红牌信号)
      push_time: env.timestamp,
    };
    st.timeline.push(notif);
    out.write(JSON.stringify(notif) + "\n");
    notifyCount++;
    const teamTxt = d.team === "?" ? "?" : `${d.team}队(${notif.team_id})`;
    const fromTo = d.from != null ? ` ${d.from}→${d.to}` : "";
    console.log(`🔔[${notif.event_cn}] ${st.match_title} | ${teamTxt}${fromTo} | 比分${notif.detail.score} | ${minute} | 来源:${notif.source}`);
    // Forward only goal/red-card to 8901 (8901 filters again by capturable match).
    if (ALERT_POST_TYPES.has(d.event_type)) {
      postAlert({
        match_id: id,
        event_type: d.event_type,
        team: d.team,
        team_id: notif.team_id,
        from: d.from,
        to: d.to,
        score: notif.detail.score,
        minute,
        match_title: st.match_title,
        source: notif.source,
        dedup_key: `${id}|${d.event_type}|${d.team}|${d.event_id ?? d.to}`,
      });
    }
  }

  // ③ 更新基线：只增不减（进球/角球/红牌为单调递增计数；忽略服务端瞬时回落的脏数据）
  for (const k of ["fs", "corners", "rc"])
    for (const s of ["A", "B"])
      if (cur[k][s] != null && (st.last[k][s] == null || cur[k][s] > st.last[k][s]))
        st.last[k][s] = cur[k][s];
}

// ============ 连接管理：断线自动重连 + 静默看门狗 ============
const RECONNECT_MIN_MS = 1000;      // 首次重连延迟
const RECONNECT_MAX_MS = 30000;     // 最大重连延迟（指数退避上限）
const STALE_TIMEOUT_MS = 30000;     // 心跳：超过此时长没收到任何消息即判定掉线
const WATCHDOG_TICK_MS = 5000;      // 看门狗检查间隔

let ws = null;
let reconnectDelay = RECONNECT_MIN_MS;
let lastMsgAt = Date.now();
let shuttingDown = false;
let watchdog = null;
const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

function scheduleReconnect(reason) {
  if (shuttingDown) return;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  const delay = reconnectDelay;
  log(`[RECONNECT] ${reason}，${delay}ms 后重连…`);
  setTimeout(connect, delay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS); // 指数退避
}

function connect() {
  if (shuttingDown) return;
  log(`[CONNECT] 连接 ${URL}`);
  lastMsgAt = Date.now();
  let sock;
  try { sock = new WebSocket(URL); } catch (e) { return scheduleReconnect(`创建连接异常:${e.message}`); }
  ws = sock;

  sock.addEventListener("open", () => {
    reconnectDelay = RECONNECT_MIN_MS; // 连接成功后重置退避
    lastMsgAt = Date.now();
    log(`[OPEN] 已连接，通知写入 ${OUT_FILE}（基线保留，不会重复告警）`);
  });

  sock.addEventListener("message", (e) => {
    lastMsgAt = Date.now();
    totalMsg++;
    let obj; try { obj = JSON.parse(e.data); } catch { return; }
    if (obj?.data?.msg_type !== "sd_match_score_change") return;
    const env = { msg_id: obj.msg_id, timestamp: obj.timestamp };
    const content = obj?.data?.content;
    if (Array.isArray(content)) for (const c of content) handleMatch(env, c);
  });

  sock.addEventListener("error", (e) => log(`[ERROR] ${e.message || e}`));
  sock.addEventListener("close", (e) => {
    if (shuttingDown) return;
    scheduleReconnect(`连接关闭(code=${e.code})`);
  });
}

// 看门狗：数据流本应每秒都有消息，静默超时即强制重连（防止"假死"连接）
watchdog = setInterval(() => {
  if (shuttingDown || !ws) return;
  if (Date.now() - lastMsgAt > STALE_TIMEOUT_MS) {
    log(`[WATCHDOG] ${STALE_TIMEOUT_MS}ms 无数据，判定掉线`);
    scheduleReconnect("数据静默超时");
  }
}, WATCHDOG_TICK_MS);

function printTimelines() {
  console.log(`\n========== 各场比赛时间线 ==========`);
  for (const st of matches.values()) {
    if (st.timeline.length === 0) continue;
    console.log(`\n● ${st.match_title} (match ${st.match_id})`);
    for (const ev of st.timeline)
      console.log(`   ${ev.minute}  ${ev.event_cn}  ${ev.team}队  比分${ev.detail.score}  [${ev.source}]`);
  }
  console.log(`\n[STATS] 共收 ${totalMsg} 条消息，建档 ${matches.size} 场，产生通知 ${notifyCount} 条`);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[SHUTDOWN] 收到 ${signal}，优雅退出…`);
  if (watchdog) clearInterval(watchdog);
  if (ws) { try { ws.close(); } catch {} }
  printTimelines();
  out.end(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000); // 兜底：2s 内强制退出
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// 守护进程下不应因未捕获异常而静默挂死
process.on("uncaughtException", (e) => log(`[UNCAUGHT] ${e.stack || e}`));
process.on("unhandledRejection", (e) => log(`[UNHANDLED] ${e}`));

if (RUN_SECONDS > 0) setTimeout(() => shutdown(`定时${RUN_SECONDS}s`), RUN_SECONDS * 1000);

connect(); // 启动
