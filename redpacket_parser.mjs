// 懂球帝实时赛事事件 WebSocket 解析器
// 作用：连接推送服务，把"信封 + 业务内容"拆解并归一化成统一事件结构，
//       同时输出人类可读摘要，并落地 JSONL（每行一个结构化事件）。
//
// 用法：
//   node redpacket_parser.mjs                 # 持续运行，Ctrl+C 结束
//   node redpacket_parser.mjs --seconds 120   # 运行 120 秒后自动退出
//   node redpacket_parser.mjs --out events.jsonl
import fs from "node:fs";

const URL = "wss://im-ap.dongqiudi.com/redpacket";

// ---- 命令行参数 ----
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const RUN_SECONDS = Number(getArg("--seconds", 0)); // 0 = 不限时
const OUT_FILE = getArg("--out", "events.jsonl");

// ---- 语义映射表 ----
const PUSH_CARD_MEANING = {
  corners: "角球",
  yellow_cards: "黄牌",
  red_cards: "红牌",
  goal: "进球",
  penalty: "点球",
};
const CMP_TYPE_MEANING = { soccer: "足球", bkb: "篮球" };
const TARGET_TEAM_MEANING = { 0: "无", 1: "主队(A)", 2: "客队(B)" };

function pickScore(a, b) {
  // 比分字段为空字符串时视为无
  if ((a === "" || a == null) && (b === "" || b == null)) return null;
  return { A: a ?? "", B: b ?? "" };
}

// 把一条 content 业务对象归一化成统一事件结构
function normalizeMatch(env, c) {
  const pushCard = Object.prototype.hasOwnProperty.call(c, "push_card")
    ? String(c.push_card)
    : null;
  return {
    event_time: env.timestamp,                     // 推送时间(秒)
    push_msg_id: env.msg_id,                        // 外层去重 id
    msg_type: env.msg_type,
    match_id: c.match_id,
    cmp_type: c.cmp_type,                           // soccer / bkb
    cmp_type_cn: CMP_TYPE_MEANING[c.cmp_type] || c.cmp_type,
    match_title: c.match_title,
    status: c.status,                               // Playing 等
    minute: { period: c.minute_period, playing_time: c.playing_time },
    score: {
      full: pickScore(c.fs_A, c.fs_B),
      half: pickScore(c.hts_A, c.hts_B),
      extra: pickScore(c.ets_A, c.ets_B),
      penalty: pickScore(c.ps_A, c.ps_B),
    },
    stats: {
      corners: pickScore(c.corners_A, c.corners_B),
      yellow: pickScore(c.yc_A, c.yc_B),
      red: pickScore(c.rc_A, c.rc_B),
    },
    push_card: pushCard,                            // 触发卡片类型
    push_card_cn: pushCard ? PUSH_CARD_MEANING[pushCard] || pushCard : null,
    target_team: c.target_team,
    target_team_cn: TARGET_TEAM_MEANING[c.target_team] ?? String(c.target_team),
    raw: c,                                         // 保留原始内容便于回溯
  };
}

// 归一化赔率变化事件（兼容两种盘口：大小球/让球盘、独赢盘）
function normalizeOdds(env, c) {
  let odds, odds_kind;
  if (c.home != null || c.away != null || c.draw != null) {
    // 独赢/让球盘：主胜/客胜/平
    odds_kind = "1x2";
    odds = { home: c.home, away: c.away, draw: c.draw, draw_num: c.draw_num };
  } else {
    // 大小球 + 让球盘
    odds_kind = "ou_hdp";
    odds = { over: c.over, under: c.under, hdp: c.hdp, hdp_num: c.hdp_num };
  }
  return {
    event_time: env.timestamp,
    push_msg_id: env.msg_id,
    msg_type: env.msg_type,
    match_id: c.match_id,
    odds_kind,
    odds,
    raw: c,
  };
}

// 生成一行人类可读摘要
function summarize(ev) {
  if (ev.msg_type === "match_odds_change") {
    if (ev.odds_kind === "1x2") {
      return `[赔率/独赢] match ${ev.match_id} 主${ev.odds.home}/平(${ev.odds.draw})/客${ev.odds.away}`;
    }
    return `[赔率/大小] match ${ev.match_id} 让球${ev.odds.hdp} 大${ev.odds.over}/小${ev.odds.under}`;
  }
  const sc = ev.score.full ? `${ev.score.full.A}-${ev.score.full.B}` : "-";
  const base = `[比分] ${ev.cmp_type_cn} ${ev.match_title || ""} ${sc} (${ev.minute.period || ""} ${ev.minute.playing_time ?? ""})`;
  if (ev.push_card) {
    return `★[卡片:${ev.push_card_cn}] ${ev.match_title || ""} 触发方=${ev.target_team_cn} 比分${sc} 角球${fmt(ev.stats.corners)} 黄${fmt(ev.stats.yellow)} 红${fmt(ev.stats.red)}`;
  }
  return base;
}
function fmt(s) {
  return s ? `${s.A}-${s.B}` : "-";
}

// ---- 主逻辑 ----
const out = fs.createWriteStream(OUT_FILE, { flags: "a" });
let total = 0, parsed = 0, pushCardCount = 0;
const ws = new WebSocket(URL);

ws.addEventListener("open", () => console.log(`[OPEN] ${URL} → 写入 ${OUT_FILE}`));

ws.addEventListener("message", (e) => {
  total++;
  let obj;
  try { obj = JSON.parse(e.data); } catch { return; }
  const env = {
    msg_id: obj.msg_id,
    timestamp: obj.timestamp,
    msg_type: obj?.data?.msg_type || "unknown",
  };
  const content = obj?.data?.content;
  if (!Array.isArray(content)) return;

  for (const c of content) {
    let ev;
    if (env.msg_type === "match_odds_change") ev = normalizeOdds(env, c);
    else if (env.msg_type === "sd_match_score_change") ev = normalizeMatch(env, c);
    else continue; // super_topic / expert_live 等暂不结构化
    parsed++;
    if (ev.push_card) pushCardCount++;
    out.write(JSON.stringify(ev) + "\n");
    // 带 push_card 的事件高亮打印，普通比分/赔率也打印摘要
    if (ev.push_card || env.msg_type !== "sd_match_score_change" || true) {
      console.log(summarize(ev));
    }
  }
});

ws.addEventListener("close", (e) => {
  console.log(`\n[CLOSE] code=${e.code} 共收 ${total} 条, 结构化 ${parsed} 个事件, 其中 push_card ${pushCardCount} 个`);
  out.end();
  process.exit(0);
});
ws.addEventListener("error", (e) => console.log(`[ERROR] ${e.message || e}`));

if (RUN_SECONDS > 0) {
  setTimeout(() => ws.close(), RUN_SECONDS * 1000);
}
process.on("SIGINT", () => ws.close());
