// 最小连通性测试：只验证能否连上底层长连接，不做任何业务处理。
// 用途：分别在「开飞连 / 关飞连」两种网络下各跑一次，对比结果，验证长连接是否受飞连限制。
//
// 用法：
//   node conn_test.mjs                 # 默认最多等 15 秒
//   node conn_test.mjs --timeout 30    # 自定义超时（秒）
const URL = "wss://im-ap.dongqiudi.com/redpacket";
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TIMEOUT_MS = Number(getArg("--timeout", 15)) * 1000;

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

const t0 = Date.now();
const since = () => `${Date.now() - t0}ms`;
let opened = false;
let firstMsgAt = 0;
let msgCount = 0;

log(`[START] 尝试连接 ${URL}（超时 ${TIMEOUT_MS / 1000}s）`);

let ws;
try {
  ws = new WebSocket(URL);
} catch (e) {
  log(`[FAIL] 创建连接即异常：${e.message}`);
  finish(2);
}

const timer = setTimeout(() => {
  if (!opened) {
    log(`[FAIL] ${TIMEOUT_MS / 1000}s 内未能建立连接（可能被拒连/网络不可达/需要飞连）`);
    finish(1);
  } else {
    log(`[DONE] 连接成功；${TIMEOUT_MS / 1000}s 内共收到 ${msgCount} 条消息`);
    finish(0);
  }
}, TIMEOUT_MS);

ws.addEventListener("open", () => {
  opened = true;
  log(`[OPEN] ✅ 连接已建立，用时 ${since()}。等待服务端推送数据…`);
});

ws.addEventListener("message", (e) => {
  msgCount++;
  if (!firstMsgAt) {
    firstMsgAt = Date.now();
    const size = typeof e.data === "string" ? e.data.length : "(binary)";
    log(`[MSG] ✅ 收到第一条消息，用时 ${since()}，长度 ${size} 字节`);
  }
});

ws.addEventListener("error", (e) => {
  log(`[ERROR] ❌ ${e.message || e.type || e}`);
});

ws.addEventListener("close", (e) => {
  log(`[CLOSE] 连接关闭 code=${e.code} reason=${e.reason || "(无)"}`);
  if (!opened) {
    log(`[FAIL] ❌ 连接从未成功建立 —— 大概率被网络/白名单限制（需飞连）`);
    finish(1);
  }
});

function finish(code) {
  clearTimeout(timer);
  console.log("\n========== 测试结论 ==========");
  console.log(`连接是否建立：${opened ? "✅ 是" : "❌ 否"}`);
  console.log(`收到消息条数：${msgCount}${firstMsgAt ? `（首条用时 ${firstMsgAt - t0}ms）` : ""}`);
  console.log(`判定：${opened ? "当前网络可连通底层长连接" : "当前网络无法连通底层长连接"}`);
  try { ws && ws.close(); } catch {}
  process.exit(code);
}
