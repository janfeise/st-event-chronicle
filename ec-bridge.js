// ec-bridge.js — Event Chronicle Browser Adapter
// =============================================================================
// 消费 SDK (ec-sdk.mjs) 的纯函数，提供浏览器特有的 LLM 桥接 + 存储适配。
//
// SDK 提供的纯函数（无需维护，随 SDK 自动升级）:
//   parseEvents, formatMessages, parseInstructions, applyInstructions,
//   formatEvents, applyWindow, exportRawFromEvents,
//   extractPrompt, mergePrompt, memoryPrompt
//
// 本文件维护:
//   LLM 桥接 (callLLM via ST backend API)
//   存储适配:
//     - extension_settings → 全局配置 (插件设置、LLM 配置)
//     - metadata (chat_metadata) → per-chat 业务数据 (事件、合并状态、批量进度)
//   流程编排 (extractEvents/mergeEvents/processMessages)
//   事件去重 (deduplicateEvents/isDuplicateEvent)
//   记忆导出 (exportMemory)
// =============================================================================

import {
  parseEvents,
  formatMessages,
  parseInstructions,
  applyInstructions,
  formatEvents,
  applyWindow,
  exportRawFromEvents,
  extractPrompt,
  mergePrompt,
  memoryPrompt,
} from './lib/ec-sdk.mjs';

// ---------------------------------------------------------------------------
// ID 生成 & 时间戳
// ---------------------------------------------------------------------------

function generateEventId() {
  return 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

function nowTimestamp() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// JSON 解析 — 三层回退 (对标 Chronicle tryParseJsonFromText)
// ---------------------------------------------------------------------------

/**
 * 三层 JSON 解析回退:
 *   Layer 1: 从 ```json ``` 或 ``` ``` 代码块中提取 → 用 SDK parseEvents
 *   Layer 2: 正则匹配最外层 [{...}] JSON 数组
 *   Layer 3: 独立解析所有 {...} 对象，筛选成功项
 *
 * @param {string} text LLM 原始响应
 * @returns {object[]|null}
 */
function tryParseJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const startTime = performance.now();
  let jsonStr = text.trim();

  // Layer 0: 空数组 — LLM 明确表示无事件，合法结果
  if (jsonStr === '[]' || jsonStr === '[ ]') {
    console.log(`[EC:Bridge] JSON Layer 0 (空数组) — 0 个元素 (${(performance.now() - startTime).toFixed(0)}ms)`);
    return [];
  }

  // Layer 1: SDK parseEvents — 处理 markdown 代码块 + JSON.parse
  try {
    const parsed = parseEvents(jsonStr);
    if (Array.isArray(parsed) && parsed.length) {
      console.log(`[EC:Bridge] JSON Layer 1 (SDK parseEvents) — ${parsed.length} 个元素 (${(performance.now() - startTime).toFixed(0)}ms)`);
      return parsed;
    }
  } catch (e) {
    console.log('[EC:Bridge] JSON Layer 1 失败:', e.message.slice(0, 80));
  }

  // Layer 2: 正则匹配最外层 JSON 数组
  const arrayMatch = jsonStr.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed.length) {
        console.log(`[EC:Bridge] JSON Layer 2 (regex array) — ${parsed.length} 个元素 (${(performance.now() - startTime).toFixed(0)}ms)`);
        return parsed;
      }
    } catch (e) {
      console.log('[EC:Bridge] JSON Layer 2 失败:', e.message.slice(0, 80));
    }
  }

  // Layer 3: 独立解析每个 {...} 对象
  try {
    const objectMatches = jsonStr.match(/\{[\s\S]*?\}/g);
    if (objectMatches && objectMatches.length) {
      const events = objectMatches
        .map(s => { try { return JSON.parse(s); } catch (e) { return null; } })
        .filter(Boolean);
      if (events.length) {
        console.log(`[EC:Bridge] JSON Layer 3 (individual objects) — ${events.length} 个有效对象 (${(performance.now() - startTime).toFixed(0)}ms)`);
        return events;
      }
    }
  } catch (e) {
    console.log('[EC:Bridge] JSON Layer 3 失败:', e.message.slice(0, 80));
  }

  console.warn('[EC:Bridge] ❌ 所有 JSON 解析层均失败，原始文本前 300 字符:', text.slice(0, 300));
  return null;
}

// ---------------------------------------------------------------------------
// 事件去重
// ---------------------------------------------------------------------------

function isDuplicateEvent(newEvent, existingEvents) {
  const newTitle = (newEvent.title || '').toLowerCase().trim();
  if (!newTitle) return true;
  for (const existing of existingEvents) {
    const existingTitle = (existing.title || '').toLowerCase().trim();
    if (newTitle === existingTitle) return true;
    if (newTitle.length > 5 && existingTitle.length > 5) {
      if (existingTitle.includes(newTitle) || newTitle.includes(existingTitle))
        return true;
    }
  }
  return false;
}

function deduplicateEvents(events) {
  if (!events || !events.length) return [];
  const seen = new Map();
  const result = [];
  for (const event of events) {
    const title = (event.title || '').toLowerCase().trim();
    if (!title) continue;
    let isDup = false;
    for (const [seenTitle, seenEvent] of seen) {
      if (
        seenTitle === title ||
        (title.length > 5 && seenTitle.length > 5 &&
          (seenTitle.includes(title) || title.includes(seenTitle)))
      ) {
        if ((event.importance || 0) > (seenEvent.importance || 0)) {
          seen.set(title, event);
          const idx = result.findIndex(e => e === seenEvent);
          if (idx >= 0) result[idx] = event;
        }
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      seen.set(title, event);
      result.push(event);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// LLM 通道（由 index.js 注入 ST 后端 API）
// ---------------------------------------------------------------------------

let _generateRaw = null;

export function setGenerateRaw(fn) {
  console.log('[EC:Bridge] LLM 通道注入:', typeof fn === 'function' ? '✅' : '❌');
  _generateRaw = fn;
}

async function callLLM(prompt) {
  if (!_generateRaw) {
    console.error('[EC:Bridge] ❌ FATAL: _generateRaw 为 null/undefined — LLM 通道未被注入！');
    throw new Error('generateRaw 未注入');
  }
  if (typeof _generateRaw !== 'function') {
    console.error(`[EC:Bridge] ❌ FATAL: _generateRaw 类型错误 — 期望 function，实际 ${typeof _generateRaw}`);
    throw new Error('generateRaw 不是函数');
  }
  console.log(`[EC:Bridge] 🔧 诊断: _generateRaw 已注入 (${typeof _generateRaw}), prompt=${prompt.length} 字符`);
  const startTime = performance.now();
  console.log(`[EC:Bridge] 📤 LLM 调用 — prompt: ${prompt.length} 字符, ~${Math.ceil(prompt.length / 3.5)} tokens`);
  try {
    const response = await _generateRaw(prompt);
    const elapsed = (performance.now() - startTime).toFixed(0);
    const respLen = response?.length || 0;
    console.log(`[EC:Bridge] 📥 LLM 响应 — ${elapsed}ms, ${respLen} 字符, 预览: "${(response || '').slice(0, 150)}"`);
    if (!response || !response.trim()) {
      console.warn('[EC:Bridge] ⚠ LLM 返回空响应');
    }
    return response || '';
  } catch (err) {
    const elapsed = (performance.now() - startTime).toFixed(0);
    console.error(`[EC:Bridge] ❌ LLM 调用失败 — ${elapsed}ms:`, err.message || err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 存储适配
//   extension_settings → 全局配置 (插件设置)
//   metadata (chat_metadata) → per-chat 业务数据 (事件、合并状态、批量进度)
// ---------------------------------------------------------------------------

let _extSettings = null;
let _metadata = null;
let _saveMetadataFn = null;

export function setExtSettings(s) {
  _extSettings = s;
  console.log('[EC:Bridge] 存储后端注入: extension_settings (全局配置)');
}

export function setMetadata(md, saveFn) {
  _metadata = md;
  _saveMetadataFn = saveFn;
  console.log('[EC:Bridge] 存储后端注入: metadata (per-chat 业务数据)');
}

/** 确保 extension_settings 命名空间存在 (全局配置) */
function ensureSettingsNS() {
  if (!_extSettings) throw new Error('extension_settings 未注入');
  if (!_extSettings['event-chronicle']) _extSettings['event-chronicle'] = {};
  return _extSettings['event-chronicle'];
}

/** 确保 metadata 命名空间存在 (per-chat 业务数据) */
function ensureMetadataNS() {
  if (!_metadata) throw new Error('metadata 未注入 — 请先调用 setMetadata()');
  if (!_metadata['event-chronicle']) _metadata['event-chronicle'] = {};
  return _metadata['event-chronicle'];
}

/** 持久化 metadata 到聊天文件 */
export function saveAndPersist() {
  if (_saveMetadataFn) _saveMetadataFn();
}

// --- per-chat 业务数据读写 (metadata) ---

function loadEvents() {
  const ns = ensureMetadataNS();
  return ns._events || [];
}

function saveEvents(events) {
  const ns = ensureMetadataNS();
  ns._events = events;
}

function loadMergeState() {
  const ns = ensureMetadataNS();
  return ns._merge || { newEventCount: 0, lastMergeAt: null };
}

function saveMergeState(state) {
  const ns = ensureMetadataNS();
  ns._merge = state;
}

function loadBatchProgress() {
  const ns = ensureMetadataNS();
  return ns._batch || { lastProcessedIndex: 0, totalMessages: 0, completed: false };
}

function saveBatchProgress(progress) {
  const ns = ensureMetadataNS();
  ns._batch = progress;
}

// =============================================================================
// Phase 1: 事件提取
// =============================================================================

/**
 * 从消息中提取事件
 *
 * 流程:
 *   1. 格式化消息 + 已有事件
 *   2. 构建提取 Prompt（使用 SDK extractPrompt 模板）
 *   3. 调用 LLM
 *   4. 三层 JSON 解析（tryParseJsonFromText）
 *   5. 解析失败 → 重试一次（附加严格格式指令）
 *   6. 注入 ID + timestamp
 *   7. 去重 + 验证必需字段
 *
 * @param {object[]} messages ST 消息数组
 * @param {object[]} existingEvents 已有事件
 * @param {object} context ST context { name1, name2 }
 * @param {number} startIndex 消息在 ctx.chat 中的起始索引
 * @returns {Promise<object[]>}
 */
export async function extractEvents(messages, existingEvents, context, startIndex) {
  console.log(`[EC:Bridge] 🔍 Phase 1: 开始事件提取 — ${messages.length} 条消息, ${(existingEvents || []).length} 个已有事件`);

  if (!messages || !messages.length) {
    console.log('[EC:Bridge] ⚠ 无消息，跳过提取');
    return [];
  }

  // 1. 格式化已有事件
  let existingEventsText = '暂无。';
  if (existingEvents && existingEvents.length) {
    existingEventsText = JSON.stringify(existingEvents.map(e => ({
      title: e.title, summary: e.summary, importance: e.importance,
      participants: e.participants, location: e.location, tags: e.tags,
    })), null, 2);
  }

  // 2. 格式化消息 — 使用 SDK formatMessages（适配 ST 数据格式）
  const messagesText = formatMessagesForST(messages, context);
  console.log(`[EC:Bridge] 格式化消息 — ${messagesText.length} 字符`);

  // 3. 构建 Prompt — 使用 SDK extractPrompt 模板
  const prompt = extractPrompt
    .replace('{{existingEvents}}', existingEventsText)
    .replace('{{recentMessages}}', messagesText);
  console.log(`[EC:Bridge] 提取 Prompt — ${prompt.length} 字符`);

  // 4. 调用 LLM
  let response;
  try {
    response = await callLLM(prompt);
  } catch (err) {
    console.error('[EC:Bridge] ❌ Phase 1 API 调用失败:', err.message || err);
    throw err;
  }

  // 5. 三层 JSON 解析
  let parsed = tryParseJsonFromText(response);

  // 6. 解析失败 → 重试一次
  if (!parsed && response && response.trim()) {
    console.warn('[EC:Bridge] ⚠ 首次解析失败，重试（附加严格格式指令）...');
    try {
      const retryResponse = await callLLM(
        prompt + '\n\nIMPORTANT: Return ONLY a valid JSON array. Start with [ and end with ]. No markdown. No explanations.'
      );
      parsed = tryParseJsonFromText(retryResponse);
      if (!parsed) {
        console.warn('[EC:Bridge] ⚠ 重试解析也失败，跳过本轮提取');
        return [];
      }
    } catch (retryErr) {
      console.error('[EC:Bridge] ❌ 重试 API 调用失败:', retryErr.message || retryErr);
      return [];
    }
  }

  if (!parsed || !parsed.length) {
    console.log('[EC:Bridge] 📭 未提取到新事件（LLM 返回空或无有效事件）');
    return [];
  }

  console.log(`[EC:Bridge] 📋 LLM 返回 ${parsed.length} 个候选事件`);

  // 7. 注入 ID + timestamp + source（使用最后一条消息的发送时间，而非提取时间）
  const lastMsg = messages[messages.length - 1];
  const ts = lastMsg?.send_date
    ? Math.floor(new Date(lastMsg.send_date).getTime() / 1000)
    : nowTimestamp();
  const startIdx = startIndex || 0;
  const endIdx = startIdx + messages.length;
  const preview = String(lastMsg?.mes || lastMsg?.content || '').slice(0, 100);
  const eventsWithIds = parsed.map(e => ({
    ...e,
    id: e.id || generateEventId(),
    timestamp: e.timestamp || ts,
    source: e.source || { range: [startIdx, endIdx], count: messages.length, preview },
  }));

  // 8. 验证必需字段
  const validEvents = eventsWithIds.filter(ev => {
    if (!ev || !ev.title || !ev.title.trim()) {
      console.log('[EC:Bridge] ⚠ 跳过无效事件（缺少 title）:', JSON.stringify(ev).slice(0, 100));
      return false;
    }
    ev.title = (ev.title || '').trim();
    ev.summary = (ev.summary || '').trim();
    ev.importance = Math.min(10, Math.max(1, parseInt(ev.importance) || 5));
    ev.participants = Array.isArray(ev.participants) ? ev.participants : [];
    ev.location = (ev.location || '').trim();
    ev.tags = Array.isArray(ev.tags) ? ev.tags.map(t => String(t).trim()).filter(Boolean) : [];
    return true;
  });

  console.log(`[EC:Bridge] ✅ Phase 1 完成 — ${validEvents.length} 个有效事件 (过滤 ${eventsWithIds.length - validEvents.length} 个无效)`);

  if (validEvents.length) {
    console.log('[EC:Bridge] 提取事件:', validEvents.map(e => `"${e.title}" (★${e.importance})`).join(', '));
  }

  return validEvents;
}

// =============================================================================
// Phase 2: 事件合并
// =============================================================================

/**
 * 合并新旧事件（通过 LLM 指令）
 *
 * 流程:
 *   1. applyWindow 窗口约束（SDK 函数）
 *   2. formatEvents 格式化（SDK 函数）
 *   3. 构建合并 Prompt（SDK mergePrompt 模板）
 *   4. 调用 LLM 获取合并指令
 *   5. parseInstructions 解析指令（SDK 函数）
 *   6. applyInstructions 执行指令（SDK 函数）
 *
 * @param {object[]} existing 已有事件
 * @param {object[]} newEvents 新提取的事件
 * @param {number} windowSize 合并窗口大小
 * @returns {Promise<object[]>}
 */
export async function mergeEvents(existing, newEvents, windowSize) {
  console.log(`[EC:Bridge] 🔄 Phase 2: 事件合并 — ${(existing || []).length} 已有 + ${(newEvents || []).length} 新事件`);

  if (!newEvents || !newEvents.length) {
    console.log('[EC:Bridge] ⚠ 无新事件，跳过合并');
    return existing || [];
  }
  if (!existing || !existing.length) {
    console.log('[EC:Bridge] ⚠ 无已有事件，新事件直接入库');
    return newEvents;
  }

  // 1. 窗口约束（SDK 函数）
  const win = applyWindow(existing || [], windowSize || 20);
  console.log(`[EC:Bridge] 合并窗口: ${win.length} 个已有事件 (窗口=${windowSize || 20})`);

  // 2. 格式化（SDK 函数）
  const existingJson = formatEvents(win);
  const newJson = formatEvents(newEvents);

  // 3. 构建 Prompt（SDK 模板）
  const prompt = mergePrompt
    .replace('{{existingEvents}}', existingJson)
    .replace('{{newEvents}}', newJson);
  console.log(`[EC:Bridge] 合并 Prompt — ${prompt.length} 字符`);

  // 4. 调用 LLM
  let instructions;
  try {
    const response = await callLLM(prompt);
    instructions = parseInstructions(response);  // SDK 函数
    console.log(`[EC:Bridge] LLM 返回 ${instructions.length} 条合并指令`);
  } catch (err) {
    console.error('[EC:Bridge] ❌ Phase 2 API 调用失败:', err.message || err);
    console.log('[EC:Bridge] ⚠ 合并失败，安全策略：追加新事件');
    return [...existing, ...newEvents];
  }

  if (!instructions || !instructions.length) {
    console.log('[EC:Bridge] ⚠ 无合并指令，安全策略：追加新事件');
    return [...existing, ...newEvents];
  }

  // 5. 执行指令（SDK 函数）
  let updateCount = 0, deleteCount = 0, addCount = 0;
  for (const inst of instructions) {
    if (inst.action === 'update') updateCount++;
    else if (inst.action === 'delete') deleteCount++;
    else if (inst.action === 'add') addCount++;
  }
  console.log(`[EC:Bridge] 指令统计: ${updateCount} update, ${deleteCount} delete, ${addCount} add`);

  const result = applyInstructions(existing, newEvents, instructions);  // SDK 函数
  console.log(`[EC:Bridge] ✅ Phase 2 完成 — ${existing.length}+${newEvents.length} → ${result.length} 个事件`);
  return result;
}

// =============================================================================
// 记忆导出
// =============================================================================

/**
 * 导出事件为格式化的记忆 Prompt 文本
 * @param {object[]} events
 * @param {object} opts { highlightThreshold }
 * @returns {string}
 */
export function exportMemory(events, opts) {
  opts = opts || {};
  const threshold = opts.highlightThreshold || 7;
  const title = opts.title || 'Event Chronicle Memory';

  if (!events || !events.length) return `# ${title}\n\n_暂无事件记录。_`;

  const lines = [];

  // 概述
  const imps = events.map(e => e.importance || 5);
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`## 概述`);
  lines.push(`${events.length} 个事件 · 重要度范围 ${Math.min(...imps)}–${Math.max(...imps)}`);
  lines.push('');

  // 关键事件
  const keyEvents = events.filter(e => (e.importance || 5) >= threshold);
  if (keyEvents.length) {
    lines.push(`## 关键事件 (重要度 ≥ ${threshold})`);
    lines.push('');
    for (const e of keyEvents) {
      lines.push(`### ${e.title || '未命名'} ${renderStars(e.importance || 5)}`);
      lines.push(e.summary || '');
      lines.push('');
      const meta = [];
      if (e.participants && e.participants.length) meta.push(`参与者: ${e.participants.join(', ')}`);
      if (e.location) meta.push(`地点: ${e.location}`);
      if (e.tags && e.tags.length) meta.push(`标签: ${e.tags.join(', ')}`);
      if (meta.length) lines.push(meta.join(' | '));
      lines.push('');
    }
  }

  // 时间线表格
  lines.push('## 时间线');
  lines.push('');
  lines.push('| # | 事件 | ★ | 参与者 | 地点 |');
  lines.push('|---|------|---|--------|------|');
  events.forEach((e, i) => {
    lines.push(`| ${i + 1} | ${e.title || ''} | ${e.importance || ''} | ${(e.participants || []).join(', ') || '—'} | ${e.location || '—'} |`);
  });
  lines.push('');

  // 用 SDK memoryPrompt 模板包裹
  return memoryPrompt.replace('{{memoryTimeline}}', lines.join('\n'));
}

function renderStars(n) {
  let s = '';
  for (let i = 1; i <= 10; i++) s += i <= n ? '★' : '☆';
  return s;
}

// =============================================================================
// 一站式处理管道
// =============================================================================

/**
 * processMessages — 提取事件 → 条件合并 → 持久化
 *
 * @param {object[]} messages ST 消息数组
 * @param {object} opts {
 *   context, autoMerge, mergeThreshold, mergeWindow
 * }
 * @returns {Promise<{events: object[], merged: boolean, mergedEvents?: object[]}>}
 */
export async function processMessages(messages, opts) {
  console.log('[EC:Bridge] ═══════════════════════════════════════');
  console.log(`[EC:Bridge] 🚀 processMessages — ${messages.length} 条消息`);
  console.log('[EC:Bridge] ═══════════════════════════════════════');

  opts = opts || {};
  const context = opts.context || {};
  const threshold = opts.mergeThreshold || 5;

  // 1. 加载已有事件 (从 metadata)
  const existing = loadEvents();
  console.log(`[EC:Bridge] 📖 已加载 ${existing.length} 个已有事件`);

  // 2. Phase 1: 提取
  const startTime = performance.now();
  const newEvents = await extractEvents(messages, existing, context, opts.startIndex);
  console.log(`[EC:Bridge] ⏱ Phase 1 耗时: ${(performance.now() - startTime).toFixed(0)}ms`);

  if (!newEvents.length) {
    console.log('[EC:Bridge] 📭 无新事件，流程结束');
    console.log('[EC:Bridge] ═══════════════════════════════════════');
    return { events: [], merged: false };
  }

  // 3. 更新合并计数器
  const state = loadMergeState();
  state.newEventCount += newEvents.length;
  console.log(`[EC:Bridge] 合并计数器: ${state.newEventCount}/${threshold}`);

  let merged = false;
  let mergedEvents = null;

  // 4. Phase 2: 条件合并
  if (opts.autoMerge !== false && state.newEventCount >= threshold) {
    console.log('[EC:Bridge] 🔄 达到合并阈值，触发 Phase 2');
    const mergeStart = performance.now();
    mergedEvents = await mergeEvents(existing, newEvents, opts.mergeWindow || 20);
    saveEvents(mergedEvents);
    state.newEventCount = 0;
    state.lastMergeAt = new Date().toISOString();
    merged = true;
    console.log(`[EC:Bridge] ⏱ Phase 2 耗时: ${(performance.now() - mergeStart).toFixed(0)}ms`);
    console.log(`[EC:Bridge] ✅ 合并完成 — ${mergedEvents.length} 个事件已入库`);
  } else {
    const combined = [...existing, ...newEvents];
    saveEvents(combined);
    console.log(`[EC:Bridge] 📝 直接追加 — ${combined.length} 个事件 (${existing.length} 已有 + ${newEvents.length} 新增)`);
  }

  saveMergeState(state);
  console.log(`[EC:Bridge] ⏱ 总耗时: ${(performance.now() - startTime).toFixed(0)}ms`);
  console.log('[EC:Bridge] ═══════════════════════════════════════');
  return { events: newEvents, merged, mergedEvents };
}

// =============================================================================
// 批量生成（增量模式）
// =============================================================================

/**
 * 查询增量处理状态
 * @param {number} totalMessages 当前聊天消息总数
 * @returns {{ processed: number, total: number, pending: number, hasPending: boolean, completed: boolean }}
 */
export function getIncrementalStatus(totalMessages) {
  const progress = loadBatchProgress();
  const processed = progress.lastProcessedIndex || 0;
  const pending = Math.max(0, totalMessages - processed);
  return {
    processed,
    total: totalMessages,
    pending,
    hasPending: pending > 0,
    completed: progress.completed || false,
  };
}

/**
 * 增量批量生成 — 只处理 lastProcessedIndex 之后的新消息
 *
 * @param {object} opts {
 *   messages, context, sliceSize, maxChunks,
 *   onStart, onProgress, onComplete, onError
 * }
 */
export async function startBatchGeneration(opts) {
  const messages = opts.messages || [];
  const context = opts.context || {};
  const sliceSize = opts.sliceSize || 12;
  const maxChunks = opts.maxChunks || 80;

  // 读取上次进度（不重置，增量继续）
  const prevProgress = loadBatchProgress();
  let idx = prevProgress.lastProcessedIndex || 0;

  // 如果上次已处理完全部消息，重置为 0 允许重新全量生成
  if (idx >= messages.length) {
    console.log('[EC:Bridge] 🔄 上次已完成全部处理，从头开始');
    idx = 0;
  }

  const pendingCount = messages.length - idx;

  console.log('[EC:Bridge] ═══════════════════════════════════════');
  console.log(`[EC:Bridge] 🔄 增量生成 — 已处理: ${idx}, 待处理: ${pendingCount}, 总计: ${messages.length}`);
  console.log('[EC:Bridge] ═══════════════════════════════════════');

  // 通知起始状态
  if (opts.onStart) opts.onStart({ processed: idx, total: messages.length, pending: pendingCount });

  // 无新消息
  if (pendingCount <= 0) {
    console.log('[EC:Bridge] 📭 无新消息，跳过处理');
    if (opts.onComplete) opts.onComplete({ newEvents: 0, finalCount: loadEvents().length, noNew: true });
    return;
  }

  let chunkCount = 0;

  const runBatch = async () => {
    try {
      let totalFound = 0;
      while (idx < messages.length && chunkCount < maxChunks) {
        const end = Math.min(idx + sliceSize, messages.length);
        const chunk = messages.slice(idx, end);
        chunkCount++;
        console.log(`[EC:Bridge] 📦 Chunk ${chunkCount} — 消息 ${idx + 1}-${end}/${messages.length}`);

        const result = await processMessages(chunk, {
          context, autoMerge: false, mergeThreshold: 999,
          startIndex: idx,
        });
        totalFound += result.events.length;
        idx = end;
        saveBatchProgress({ lastProcessedIndex: idx, totalMessages: messages.length, completed: false });
        if (opts.onProgress) opts.onProgress({ current: idx, total: messages.length, eventsFound: totalFound, chunk: chunkCount });
      }

      // 最终全局合并
      console.log('[EC:Bridge] 🔄 增量处理完成，触发最终全局合并...');
      const allEvents = loadEvents();
      if (allEvents.length > 1) {
        const merged = await mergeEvents([], allEvents, 50);
        saveEvents(merged);
        console.log(`[EC:Bridge] ✅ 最终合并: ${allEvents.length} → ${merged.length} 个事件`);
      }

      saveBatchProgress({ lastProcessedIndex: messages.length, totalMessages: messages.length, completed: true });
      const finalEvents = loadEvents();
      console.log(`[EC:Bridge] 🎉 增量生成完成 — 新增 ${totalFound} 个事件，共 ${finalEvents.length} 个`);
      if (opts.onComplete) opts.onComplete({ newEvents: totalFound, finalCount: finalEvents.length, noNew: false });
    } catch (err) {
      console.error('[EC:Bridge] ❌ 增量生成失败:', err.message || err);
      saveBatchProgress({ lastProcessedIndex: idx, totalMessages: messages.length, completed: false, error: err.message });
      if (opts.onError) opts.onError(err);
    }
  };

  runBatch();
}

// =============================================================================
// CRUD 操作
// =============================================================================

export function getEvents() {
  const events = loadEvents();
  console.log(`[EC:Bridge] 📖 getEvents — ${events.length} 个事件`);
  return events;
}

/**
 * 获取当前聊天的所有事件。
 * 注意：metadata 是 per-chat 的，无法跨聊天聚合。
 * 如需跨聊天数据，请通过 ST 的聊天文件系统访问。
 */
export function getAllEvents() {
  return getEvents();
}

export function updateEvent(ev) {
  console.log(`[EC:Bridge] ✏️ updateEvent — eventId="${ev.id}"`);
  const events = loadEvents();
  const idx = events.findIndex(e => e.id === ev.id);
  if (idx === -1) { console.warn(`[EC:Bridge] ⚠ 未找到事件: ${ev.id}`); return null; }
  events[idx] = { ...events[idx], ...ev };
  saveEvents(events);
  console.log(`[EC:Bridge] ✅ 事件已更新: "${events[idx].title}"`);
  return events[idx];
}

export function deleteEvent(eventId) {
  console.log(`[EC:Bridge] 🗑 deleteEvent — eventId="${eventId}"`);
  const events = loadEvents();
  const f = events.filter(e => e.id !== eventId);
  if (f.length === events.length) { console.warn(`[EC:Bridge] ⚠ 未找到要删除的事件: ${eventId}`); return false; }
  saveEvents(f);
  console.log(`[EC:Bridge] ✅ 事件已删除 — 剩余 ${f.length} 个`);
  return true;
}

export function clearEvents() {
  const count = loadEvents().length;
  console.log(`[EC:Bridge] 🗑 clearEvents — 清空全部 ${count} 个事件`);
  saveEvents([]);
  saveBatchProgress({ lastProcessedIndex: 0, totalMessages: 0, completed: false });
  console.log('[EC:Bridge] ✅ 所有事件已清空');
}

export function getMemory(opts) {
  return exportMemory(loadEvents(), opts);
}

export function getBatchProgress() {
  return loadBatchProgress();
}

export function resetBatchProgress() {
  console.log('[EC:Bridge] 🔄 重置批量进度');
  saveBatchProgress({ lastProcessedIndex: 0, totalMessages: 0, completed: false });
}

// =============================================================================
// 内部辅助
// =============================================================================

/**
 * ST 格式消息 → Prompt 文本
 */
function formatMessagesForST(messages, context) {
  const maxChars = 200;
  const user = context?.name1 || 'User';
  const char = context?.name2 || 'Character';

  return messages
    .map(m => {
      const role = m.is_user ? user : (m.name || char);
      let text = String(m.mes || '').trim();
      if (text.length > maxChars) text = text.substring(0, maxChars) + '...';
      return `${role}:\n${text}`;
    })
    .join('\n\n');
}
