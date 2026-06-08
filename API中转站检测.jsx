import { useState } from "react";

// ─── 常量 ────────────────────────────────────────────────────────────────────

const CHECKS = [
  { id: "tls",          label: "HTTPS / 域名" },
  { id: "connectivity", label: "连通性 & 延迟" },
  { id: "response",     label: "响应合法性" },
  { id: "streaming",    label: "流式输出 (SSE)" },
  { id: "models",       label: "模型列表" },
];

const STATUS = {
  idle:    { color: "#3a3a3a", icon: "·" },
  running: { color: "#f0a500", icon: "⟳" },
  pass:    { color: "#22c55e", icon: "✓" },
  warn:    { color: "#f59e0b", icon: "⚠" },
  fail:    { color: "#ef4444", icon: "✗" },
};

const TIMEOUT_MS = 8000; // 每个请求最长等待时间

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function fetchWithTimeout(url, opts = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

function makeHeaders(apiType, apiKey) {
  if (apiType === "anthropic") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
  if (apiType === "openai")    return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  return { "Content-Type": "application/json" }; // gemini 用 query param
}

// ─── 各项检测逻辑（全部并行） ──────────────────────────────────────────────────

async function checkTls(baseUrl) {
  if (!baseUrl.startsWith("https://")) return { status: "fail", detail: "非 HTTPS，流量明文暴露，强烈不建议使用" };
  const OFFICIAL = ["openai.com", "anthropic.com", "googleapis.com"];
  try {
    const host = new URL(baseUrl).hostname;
    const isOfficial = OFFICIAL.some(d => host === d || host.endsWith("." + d));
    return isOfficial
      ? { status: "pass", detail: `官方域名 ${host}` }
      : { status: "warn", detail: `第三方域名 ${host}，请核查证书颁发机构` };
  } catch {
    return { status: "fail", detail: "URL 格式错误，无法解析域名" };
  }
}

async function checkConnectivity(baseUrl, apiType, apiKey) {
  const url = apiType === "gemini"
    ? `${baseUrl}/v1beta/models?key=${apiKey}`
    : `${baseUrl}/v1/models`;
  const headers = makeHeaders(apiType, apiKey);
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, { headers });
    const ms = Date.now() - t0;
    // 401/403 = 可达但 key 权限问题，仍算连通
    if (res.ok || res.status === 401 || res.status === 403) {
      const level = ms < 600 ? "pass" : ms < 1800 ? "warn" : "fail";
      const tag = ms < 600 ? "快" : ms < 1800 ? "偏慢" : "过慢";
      return { status: level, detail: `HTTP ${res.status}，延迟 ${ms}ms（${tag}）` };
    }
    return { status: "fail", detail: `HTTP ${res.status}，服务器返回错误` };
  } catch (e) {
    if (e.name === "AbortError") return { status: "fail", detail: `超时（>${TIMEOUT_MS / 1000}s），服务器无响应` };
    return { status: "fail", detail: `无法连接：${e.message}` };
  }
}

async function checkResponse(baseUrl, apiType, apiKey) {
  const PROBE = "RELAY_TEST_OK";
  const prompt = `Reply with ONLY the word "${PROBE}", no punctuation, no explanation.`;
  try {
    let res, body, content;
    if (apiType === "openai") {
      res = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: makeHeaders(apiType, apiKey),
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 10 }),
      });
      body = await res.json();
      content = body?.choices?.[0]?.message?.content?.trim() ?? "";
      if (!body?.choices) return { status: "fail", detail: `响应结构异常（缺少 choices），可能是假冒中转` };
    } else if (apiType === "anthropic") {
      res = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: makeHeaders(apiType, apiKey),
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 10, messages: [{ role: "user", content: prompt }] }),
      });
      body = await res.json();
      content = body?.content?.[0]?.text?.trim() ?? "";
      if (!body?.content) return { status: "fail", detail: `响应结构异常（缺少 content），可能是假冒中转` };
    } else {
      res = await fetchWithTimeout(`${baseUrl}/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: makeHeaders(apiType, apiKey),
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      body = await res.json();
      content = body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
      if (!body?.candidates) return { status: "fail", detail: `响应结构异常（缺少 candidates），可能是假冒中转` };
    }
    if (content.includes(PROBE)) return { status: "pass", detail: "响应结构标准，内容未被篡改" };
    // 有内容但不匹配探针词 → 可能被过滤/替换，也可能模型自由发挥
    return { status: "warn", detail: `结构合法，内容：「${content.slice(0, 80)}」` };
  } catch (e) {
    if (e.name === "AbortError") return { status: "fail", detail: `请求超时（>${TIMEOUT_MS / 1000}s）` };
    return { status: "fail", detail: `请求失败：${e.message}` };
  }
}

async function checkStreaming(baseUrl, apiType, apiKey) {
  if (apiType === "gemini") return { status: "warn", detail: "Gemini 流式接口格式不同，跳过此项" };
  try {
    let res;
    if (apiType === "openai") {
      res = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: makeHeaders(apiType, apiKey),
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: true }),
      });
    } else {
      res = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: makeHeaders(apiType, apiKey),
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("event-stream")) return { status: "pass", detail: "SSE 流式正常（Content-Type: text/event-stream）" };
    // 200 但不是流 → 中转可能缓存了整个响应才返回
    if (res.ok) return { status: "warn", detail: `服务器返回 200 但非流式（Content-Type: ${ct || "未知"}）` };
    return { status: "fail", detail: `HTTP ${res.status}，流式请求被拒绝` };
  } catch (e) {
    if (e.name === "AbortError") return { status: "fail", detail: "流式请求超时" };
    return { status: "fail", detail: `流式测试失败：${e.message}` };
  }
}

async function checkModels(baseUrl, apiType, apiKey) {
  if (apiType === "gemini") {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/v1beta/models?key=${apiKey}`, { headers: makeHeaders(apiType, apiKey) });
      const body = await res.json();
      const list = (body?.models ?? []).map(m => m.name?.replace("models/", "")).slice(0, 6);
      if (list.length) return { status: "pass", detail: list.join(" · ") };
      return { status: "warn", detail: "模型列表为空或格式不符" };
    } catch (e) {
      return { status: "warn", detail: `Gemini 模型列表获取失败：${e.message}` };
    }
  }
  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/models`, { headers: makeHeaders(apiType, apiKey) });
    const body = await res.json();
    const list = (body?.data ?? []).map(m => m.id).slice(0, 6);
    if (list.length) return { status: "pass", detail: list.join(" · ") };
    if (res.status === 401) return { status: "warn", detail: "Key 无权限读取模型列表（Key 可能正确，只是受限）" };
    return { status: "warn", detail: "模型列表为空，中转可能屏蔽了此端点" };
  } catch (e) {
    if (e.name === "AbortError") return { status: "fail", detail: "模型列表请求超时" };
    return { status: "fail", detail: `获取失败：${e.message}` };
  }
}

// ─── 主检测入口（并行跑所有项） ────────────────────────────────────────────────

async function runAllChecks(config, onUpdate) {
  const { baseUrl, apiKey, apiType } = config;
  const url = baseUrl.replace(/\/$/, "");

  // 先把所有项置为 running
  const initState = Object.fromEntries(CHECKS.map(c => [c.id, { status: "running", detail: "检测中..." }]));
  onUpdate(initState);

  // 并行执行全部检测
  const runners = {
    tls:          () => checkTls(url),
    connectivity: () => checkConnectivity(url, apiType, apiKey),
    response:     () => checkResponse(url, apiType, apiKey),
    streaming:    () => checkStreaming(url, apiType, apiKey),
    models:       () => checkModels(url, apiType, apiKey),
  };

  const entries = Object.entries(runners);
  const promises = entries.map(([id, fn]) =>
    fn().then(result => ({ id, result }))
  );

  // 哪个先完成就先更新
  const current = { ...initState };
  await Promise.all(
    promises.map(p =>
      p.then(({ id, result }) => {
        current[id] = result;
        onUpdate({ ...current });
      })
    )
  );
}

// ─── UI ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [apiType, setApiType] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);

  const canRun = baseUrl.trim() && apiKey.trim() && !running;

  const start = async () => {
    if (!canRun) return;
    setResults(null);
    setRunning(true);
    await runAllChecks({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), apiType }, setResults);
    setRunning(false);
  };

  const onKey = (e) => { if (e.key === "Enter") start(); };

  // 汇总评分
  const verdict = (() => {
    if (!results) return null;
    const vals = Object.values(results);
    if (vals.some(r => r.status === "running")) return null;
    const fails = vals.filter(r => r.status === "fail").length;
    const warns = vals.filter(r => r.status === "warn").length;
    const passes = vals.filter(r => r.status === "pass").length;
    if (fails >= 2) return { emoji: "🔴", label: "高风险", color: "#ef4444", desc: "存在多项严重问题，强烈不建议使用" };
    if (fails === 1) return { emoji: "🟠", label: "中风险", color: "#f59e0b", desc: "存在问题，请谨慎评估后使用" };
    if (warns >= 2)  return { emoji: "🟡", label: "低风险", color: "#eab308", desc: "有若干警告，建议人工核查后使用" };
    return { emoji: "🟢", label: "安全", color: "#22c55e", desc: "各项通过，中转站状态良好", passes };
  })();

  const inputStyle = {
    width: "100%", background: "#0a0a0a", border: "1px solid #252525",
    borderRadius: 6, padding: "10px 12px", color: "#e8e8e8",
    fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none",
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#0d0d0d", color: "#e8e8e8",
      fontFamily: "'JetBrains Mono','Fira Code',monospace",
      padding: "36px 20px", display: "flex", flexDirection: "column", alignItems: "center",
    }}>
      <div style={{ width: "100%", maxWidth: 600 }}>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 10, letterSpacing: 5, color: "#444", marginBottom: 6 }}>AI RELAY CHECKER</div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: -0.5 }}>中转站检测器</div>
          <div style={{ fontSize: 12, color: "#555", marginTop: 5 }}>
            连通性 · TLS · 响应完整性 · 流式 · 模型列表 — 并行检测，秒出结果
          </div>
        </div>

        {/* 配置区 */}
        <div style={{ background: "#131313", border: "1px solid #1e1e1e", borderRadius: 10, padding: 22, marginBottom: 16 }}>
          {/* API 类型 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#444", marginBottom: 8, letterSpacing: 3 }}>API 类型</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { id: "openai",    label: "OpenAI" },
                { id: "anthropic", label: "Anthropic" },
                { id: "gemini",    label: "Gemini" },
              ].map(t => (
                <button key={t.id} onClick={() => setApiType(t.id)} style={{
                  padding: "5px 14px", borderRadius: 5, border: "1px solid",
                  borderColor: apiType === t.id ? "#f0a500" : "#222",
                  background: apiType === t.id ? "#f0a50012" : "transparent",
                  color: apiType === t.id ? "#f0a500" : "#555",
                  cursor: "pointer", fontSize: 12, fontFamily: "inherit", transition: "all .15s",
                }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Base URL */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#444", marginBottom: 6, letterSpacing: 3 }}>BASE URL</div>
            <input
              value={baseUrl} onChange={e => setBaseUrl(e.target.value)} onKeyDown={onKey}
              placeholder="https://your-relay.example.com"
              style={inputStyle}
            />
          </div>

          {/* API Key */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 10, color: "#444", marginBottom: 6, letterSpacing: 3 }}>API KEY</div>
            <input
              type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} onKeyDown={onKey}
              placeholder={apiType === "gemini" ? "AIza..." : "sk-..."}
              style={inputStyle}
            />
          </div>

          {/* 检测按钮 */}
          <button onClick={start} disabled={!canRun} style={{
            width: "100%", padding: "11px", borderRadius: 7, border: "none",
            background: canRun ? "#f0a500" : "#1a1a1a",
            color: canRun ? "#000" : "#333",
            fontFamily: "inherit", fontSize: 13, fontWeight: 700,
            cursor: canRun ? "pointer" : "not-allowed", letterSpacing: 0.5, transition: "all .15s",
          }}>
            {running ? "⟳  检测中（并行，请稍候）…" : "开始检测  →"}
          </button>
        </div>

        {/* 结果区 */}
        {results && (
          <div style={{ background: "#131313", border: "1px solid #1e1e1e", borderRadius: 10, padding: 22, marginBottom: 16 }}>
            {CHECKS.map(({ id, label }, i) => {
              const r = results[id];
              if (!r) return null;
              const s = STATUS[r.status];
              const isLast = i === CHECKS.length - 1;
              return (
                <div key={id} style={{
                  display: "flex", alignItems: "flex-start", gap: 12,
                  paddingBottom: isLast ? 0 : 13, marginBottom: isLast ? 0 : 13,
                  borderBottom: isLast ? "none" : "1px solid #1a1a1a",
                }}>
                  {/* 图标 */}
                  <div style={{
                    color: s.color, fontSize: r.status === "running" ? 14 : 15,
                    lineHeight: "20px", flexShrink: 0, width: 16, textAlign: "center",
                    animation: r.status === "running" ? "spin 1s linear infinite" : "none",
                  }}>
                    {s.icon}
                  </div>
                  {/* 内容 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: s.color, marginBottom: 2, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 11, color: "#4a4a4a", lineHeight: 1.6, wordBreak: "break-all" }}>{r.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 综合评级 */}
        {verdict && (
          <div style={{
            background: "#131313", border: `1px solid ${verdict.color}30`,
            borderRadius: 10, padding: "18px 22px",
            display: "flex", alignItems: "center", gap: 16,
          }}>
            <div style={{ fontSize: 30, lineHeight: 1 }}>{verdict.emoji}</div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, color: verdict.color }}>{verdict.label}</div>
              <div style={{ fontSize: 12, color: "#555", marginTop: 3 }}>{verdict.desc}</div>
            </div>
          </div>
        )}

        {/* 免责说明 */}
        <div style={{ fontSize: 10, color: "#2a2a2a", textAlign: "center", marginTop: 22, lineHeight: 1.8 }}>
          API Key 仅在浏览器本地使用，不经过任何第三方服务器<br/>
          超时阈值 {TIMEOUT_MS / 1000}s · 仅发送最小化探针请求，消耗极少 token
        </div>

      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
