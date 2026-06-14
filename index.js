// index.js — Event Chronicle SillyTavern Extension
// =============================================================================
// ST 集成层：对标 Chronicle 插件的完整事件流。
//
// SDK 纯函数通过 ec-bridge.js 间接消费（ec-bridge 导入 SDK bundle）。
// 本文件负责：生命周期、事件绑定、Prompt 注入、UI 集成、Wand 菜单。
// =============================================================================

import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, setExtensionPrompt, extension_prompt_roles } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import * as ecBridge from './ec-bridge.js';

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  autoExtractionEnabled: true,
  extractTriggerCount: 10,
  mergeTriggerCount: 5,
  extractionCooldown: 30,
  overrideMaxTokens: 2048,
  batchSliceSize: 12,
  highlightThreshold: 7,
  llmOverride: { model: '', temperature: 0, maxTokens: 2048 },
};

// ---------------------------------------------------------------------------
// State (对标 Chronicle)
// ---------------------------------------------------------------------------

let sdkReady = false;
/** @type {number|null} Last chat array index processed */
let lastProcessedMessageId = null;
/** @type {number} Timestamp of last extraction (cooldown) */
let lastExtractionTime = 0;
/** @type {boolean} API call mutex lock */
let inApiCall = false;

// ---------------------------------------------------------------------------
// LLM 桥接（复用 ST 后端 API）
// ---------------------------------------------------------------------------

async function llmCall(prompt) {
  const startTime = performance.now();
  const settings = getSettings();
  const ctx = getContext();
  const maxTokens = settings.overrideMaxTokens || 2048;

  console.log(`[Event Chronicle] 📤 LLM Call — ${new Date().toISOString()}`, {
    promptLength: prompt.length,
    estimatedTokens: Math.ceil(prompt.length / 3.5),
    maxTokens: maxTokens,
  });

  // 对齐 Chronicle 扩展的完整 payload
  const payload = {
    type: 'quiet',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
    include_reasoning: false,
    user_name: ctx?.name1 || '',
    char_name: ctx?.name2 || '',
    group_names: [],
    enable_web_search: false,
    request_images: false,
    request_image_resolution: '',
    request_image_aspect_ratio: '',
    custom_prompt_post_processing: '',
    custom_url: '',
    custom_include_body: '',
    custom_exclude_body: '',
    custom_include_headers: '',
  };

  // 从 ST 全局读取 chat_completion_source 和 model
  if (typeof oai_settings !== 'undefined') {
    payload.chat_completion_source = oai_settings.chat_completion_source;
    payload.model = oai_settings.chat_completion_source === 'custom'
      ? (oai_settings.custom_model || oai_settings.openai_model)
      : oai_settings.openai_model;
    payload.custom_url = oai_settings.custom_url || '';
    payload.custom_include_body = oai_settings.custom_include_body || '';
    payload.custom_exclude_body = oai_settings.custom_exclude_body || '';
    payload.custom_include_headers = oai_settings.custom_include_headers || '';
  }

  console.log(`[Event Chronicle] 模型: ${payload.model}, chat_completion_source: ${payload.chat_completion_source}`);

  const response = await fetch('/api/backends/chat-completions/generate', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify(payload),
  });

  const elapsed = (performance.now() - startTime).toFixed(0);

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Event Chronicle] ❌ LLM Call 失败 — ${elapsed}ms, HTTP ${response.status}`, {
      errorBody: text.slice(0, 300),
    });
    throw new Error('API 错误 ' + response.status + ': ' + text.slice(0, 300));
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '';

  console.log(`[Event Chronicle] 📥 LLM Call 完成 — ${elapsed}ms`, {
    responseLength: content.length,
    responsePreview: content.slice(0, 200),
  });

  return content;
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function ensureSettings() {
  if (!extension_settings['event-chronicle'] || Object.keys(extension_settings['event-chronicle']).length === 0) {
    extension_settings['event-chronicle'] = { ...DEFAULT_SETTINGS };
    saveSettingsDebounced();
  }
  return extension_settings['event-chronicle'];
}

function getSettings() {
  return extension_settings['event-chronicle'] || DEFAULT_SETTINGS;
}

function getChatId() {
  try {
    const ctx = getContext();
    if (ctx && ctx.chatId) return String(ctx.chatId);
  } catch (e) { /* ignore */ }
  return 'default';
}

// ---------------------------------------------------------------------------
// Prompt 注入（对标 Chronicle updateChroniclePrompt）
// ---------------------------------------------------------------------------

function updateChroniclePrompt() {
  const settings = getSettings();
  const events = ecBridge.getEvents(getChatId());
  const promptText = buildMemoryPrompt(events, settings);

  console.log(`[Event Chronicle] 🔄 更新 Prompt 注入 — ${events.length} 个事件${promptText ? ', ' + promptText.length + ' 字符' : ', 空'}`);

  setExtensionPrompt(
    'event-chronicle',                    // key
    promptText,                           // value (空字符串 = 移除注入)
    0,                                    // position = IN_PROMPT
    0,                                    // depth = 0
    false,                                // scan = false
    extension_prompt_roles.SYSTEM,        // role = SYSTEM
  );
}

function buildMemoryPrompt(events, settings) {
  if (!events || !events.length) return '';
  const threshold = settings.highlightThreshold || 7;

  // 按重要性排序 + 截断
  const sorted = [...events]
    .filter(e => (e.importance || 0) >= 1)
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 20);

  if (!sorted.length) return '';

  const lines = ['[Event Chronicle — Key Events]'];
  for (const e of sorted) {
    const dateStr = e.timestamp ? new Date(e.timestamp * 1000).toISOString().split('T')[0] : '????-??-??';
    lines.push(`- [${dateStr}] ${e.title}`);
  }

  const result = lines.join('\n');
  console.log(`[Event Chronicle] Prompt 注入: ${sorted.length} 个事件, ${result.length} 字符`);
  return result;
}

// ---------------------------------------------------------------------------
// 自动提取（对标 Chronicle processAutoExtraction）
// ---------------------------------------------------------------------------

async function onCharacterMessageRendered() {
  console.log(`[Event Chronicle] 📨 CHARACTER_MESSAGE_RENDERED 触发`);

  if (!sdkReady) {
    console.log('[Event Chronicle] ⏭ 跳过 — 扩展未就绪');
    return;
  }
  if (!getSettings().autoExtractionEnabled) {
    console.log('[Event Chronicle] ⏭ 跳过 — 自动提取已禁用');
    return;
  }
  if (inApiCall) {
    console.log('[Event Chronicle] ⏭ 跳过 — API 调用进行中');
    return;
  }

  // Group chat 检查
  try {
    if (typeof is_group_generating !== 'undefined' && is_group_generating) {
      console.log('[Event Chronicle] ⏭ 跳过 — group chat 生成中');
      return;
    }
  } catch (e) { /* ignore */ }

  const context = getContext();
  if (!context || !context.chat || !context.chat.length) {
    console.log('[Event Chronicle] ⏭ 跳过 — 无聊天数据');
    return;
  }

  // 冷却检查
  const now = Date.now();
  const cooldownMs = (getSettings().extractionCooldown || 30) * 1000;
  if (now - lastExtractionTime < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - (now - lastExtractionTime)) / 1000);
    console.log(`[Event Chronicle] ⏭ 跳过 — 冷却中 (${remaining}s 剩余)`);
    return;
  }

  // 未处理消息计数
  const chat = context.chat;
  const threshold = getSettings().extractTriggerCount || 10;
  let unprocessedCount = chat.length;

  // lastProcessedMessageId 存储的是 chat 数组索引
  if (lastProcessedMessageId != null && typeof lastProcessedMessageId === 'number' && lastProcessedMessageId >= 0) {
    unprocessedCount = chat.length - 1 - lastProcessedMessageId;
  }

  console.log(`[Event Chronicle] 未处理消息: ${unprocessedCount}/${chat.length}, 阈值: ${threshold}`);

  if (unprocessedCount < threshold) {
    console.log(`[Event Chronicle] ⏭ 跳过 — 未达阈值 (${unprocessedCount} < ${threshold})`);
    return;
  }

  // 取最近 N 条消息
  const messagesToCheck = chat.slice(-threshold);
  const lastMessage = messagesToCheck[messagesToCheck.length - 1];
  const lastMsgIndex = chat.indexOf(lastMessage);

  console.log(`[Event Chronicle] 🔍 自动提取 — 分析最近 ${messagesToCheck.length} 条消息 (索引 ${chat.length - threshold}–${chat.length - 1})`);

  lastExtractionTime = now;

  try {
    inApiCall = true;

    const result = await ecBridge.processMessages(messagesToCheck, {
      eventId: getChatId(),
      context: { name1: context.name1, name2: context.name2 },
      autoMerge: true,
      mergeThreshold: getSettings().mergeTriggerCount || 5,
    });

    // API 成功 — 更新追踪标记
    if (lastMsgIndex >= 0) {
      lastProcessedMessageId = lastMsgIndex;
      console.log(`[Event Chronicle] 📍 更新追踪标记: lastProcessedMessageId=${lastProcessedMessageId} (消息 ${lastMsgIndex + 1}/${chat.length})`);
    }

    if (result.events.length) {
      console.log(`[Event Chronicle] ✅ 自动提取完成 — ${result.events.length} 个新事件`);
      if (typeof toastr !== 'undefined') {
        toastr.info(`📜 记录 ${result.events.length} 个新事件`, 'Event Chronicle');
      }
    } else {
      console.log('[Event Chronicle] ✅ 自动提取完成 — 无新事件');
    }

    if (result.merged) {
      console.log('[Event Chronicle] 🔄 自动合并已完成');
    }

    saveSettingsDebounced();
    updateChroniclePrompt();

  } catch (err) {
    // API 失败 — 不更新追踪标记（下次重试）
    console.error('[Event Chronicle] ❌ 自动提取失败 (下次重试):', err.message || err);
    if (typeof toastr !== 'undefined') {
      toastr.warning('Event Chronicle: 提取失败 (API 错误)，将重试', 'Event Chronicle');
    }
  } finally {
    inApiCall = false;
  }
}

// ---------------------------------------------------------------------------
// 聊天切换（对标 Chronicle onChatChanged）
// ---------------------------------------------------------------------------

function onChatChanged() {
  console.log(`[Event Chronicle] 🔄 聊天切换 — chatId="${getChatId()}"`);
  // 重置状态
  lastProcessedMessageId = null;
  lastExtractionTime = 0;
  // 更新 Prompt 注入（为新聊天加载其事件）
  updateChroniclePrompt();
  console.log('[Event Chronicle] ✅ 聊天切换完成');
}

function onMessageChanged() {
  console.log('[Event Chronicle] 🔄 消息变更 — 重置追踪标记');
  lastProcessedMessageId = null;
}

// ---------------------------------------------------------------------------
// 手动提取 (Wand 菜单)
// ---------------------------------------------------------------------------

async function manualExtract() {
  if (inApiCall) {
    if (typeof toastr !== 'undefined') toastr.warning('提取进行中，请等待', 'Event Chronicle');
    return;
  }
  const context = getContext();
  if (!context || !context.chat || !context.chat.length) {
    if (typeof toastr !== 'undefined') toastr.warning('未找到聊天消息', 'Event Chronicle');
    return;
  }

  try {
    inApiCall = true;
    const settings = getSettings();
    const messagesToCheck = context.chat.slice(-(settings.extractTriggerCount * 2));
    console.log(`[Event Chronicle] 🔍 手动提取 — ${messagesToCheck.length} 条消息`);

    const result = await ecBridge.processMessages(messagesToCheck, {
      eventId: getChatId(),
      context: { name1: context.name1, name2: context.name2 },
      autoMerge: true,
      mergeThreshold: settings.mergeTriggerCount || 5,
    });

    if (result.events.length) {
      console.log(`[Event Chronicle] ✅ 手动提取完成 — ${result.events.length} 个新事件`);
      if (typeof toastr !== 'undefined') toastr.info(`📜 记录 ${result.events.length} 个新事件`, 'Event Chronicle');
    } else {
      console.log('[Event Chronicle] ✅ 手动提取完成 — 无新事件');
      if (typeof toastr !== 'undefined') toastr.info('未发现新事件', 'Event Chronicle');
    }

    saveSettingsDebounced();
    updateChroniclePrompt();
  } catch (err) {
    console.error('[Event Chronicle] ❌ 手动提取失败:', err.message || err);
    if (typeof toastr !== 'undefined') toastr.error('提取失败: ' + (err.message || err), 'Event Chronicle');
  } finally {
    inApiCall = false;
  }
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function injectSettingsUI() {
  const target = document.getElementById('extensions_settings');
  if (!target) { setTimeout(injectSettingsUI, 1000); return; }
  if (document.getElementById('ec_settings')) return;

  const settings = getSettings();

  const div = document.createElement('div');
  div.id = 'ec_settings';
  div.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>📜 Event Chronicle · 事件编年史</b>
        <span id="ec_status_badge" style="font-size:0.8em;color:#888;margin-left:8px;"></span>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <p style="color:#999;font-size:0.9em;">从角色扮演对话中自动提取结构化事件，构建时间线，注入长期记忆。</p>

        <h4>自动提取</h4>
        <div style="display:flex;gap:12px;">
          <div style="flex:1;">
            <label for="ec_extract_trigger">每 N 条消息触发提取</label>
            <input id="ec_extract_trigger" name="extractTriggerCount" type="number" min="3" max="100" value="${settings.extractTriggerCount}" class="text_pole">
            <small style="color:#888;">未处理消息数达到后自动提取事件</small>
          </div>
          <div style="flex:1;">
            <label for="ec_merge_trigger">每 N 条新事件触发整理</label>
            <input id="ec_merge_trigger" name="mergeTriggerCount" type="number" min="2" max="50" value="${settings.mergeTriggerCount}" class="text_pole">
            <small style="color:#888;">新事件累计达到后自动合并去重</small>
          </div>
        </div>
        <div style="margin-top:8px;">
          <label for="ec_cooldown">冷却时间: <span id="ec_cooldown_val">${settings.extractionCooldown}</span>s</label>
          <input id="ec_cooldown" name="extractionCooldown" type="range" min="10" max="120" step="5" value="${settings.extractionCooldown}" oninput="document.getElementById('ec_cooldown_val').textContent=this.value">
          <small style="color:#888;">两次自动提取之间的最小间隔</small>
        </div>

        <h4>模型设置 <small style="color:#888;">（可选，留空则复用 ST 配置）</small></h4>
        <div style="display:flex;gap:12px;">
          <div style="flex:1;"><label for="ec_llm_model">模型名称</label>
          <input id="ec_llm_model" name="llmOverride.model" type="text" placeholder="例如 gpt-4o-mini" value="${settings.llmOverride?.model || ''}" class="text_pole"></div>
          <div style="flex:1;"><label for="ec_llm_temperature">生成温度</label>
          <input id="ec_llm_temperature" name="llmOverride.temperature" type="number" min="0" max="2" value="${settings.llmOverride?.temperature || 0}" step="0.1" class="text_pole"></div>
        </div>
        <div><label for="ec_max_tokens">最大输出 Token</label>
        <input id="ec_max_tokens" name="overrideMaxTokens" type="number" min="256" max="16384" value="${settings.overrideMaxTokens}" class="text_pole">
        <small style="color:#888;">事件提取需要足够长度输出完整 JSON</small></div>

        <h4>一键批量生成</h4>
        <p style="color:#ffaa00;font-size:0.85em;">⚠ 将从整个聊天历史生成事件，消耗大量 Token。</p>
        <div style="display:flex;gap:12px;">
          <div style="flex:1;"><label for="ec_batch_slice">每批消息数</label>
          <input id="ec_batch_slice" name="batchSliceSize" type="number" min="2" max="20" value="${settings.batchSliceSize}" class="text_pole"></div>
        </div>
        <div style="margin:8px 0;">
          <button id="ec_batch_start" class="menu_button">▶ 开始批量生成</button>
          <button id="ec_batch_resume" class="menu_button" style="display:none;">↻ 继续上次进度</button>
        </div>
        <div id="ec_batch_progress" style="display:none;">
          <div style="width:100%;height:6px;background:#2a2a2a;border-radius:3px;margin-top:6px;"><div id="ec_batch_fill" style="height:100%;background:#4a6cf7;border-radius:3px;width:0;"></div></div>
          <div id="ec_batch_text" style="font-size:0.8em;color:#999;margin-top:4px;"></div>
        </div>
      </div>
    </div>`;
  target.appendChild(div);
  bindSettingsEvents();
  setupStatusIndicator();
}

function bindSettingsEvents() {
  // 设置变更 → 保存
  const inputs = document.querySelectorAll('#ec_settings input, #ec_settings select');
  inputs.forEach(input => {
    input.addEventListener('change', () => {
      const settings = getSettings();
      const name = input.name;
      if (!name) return;
      let value = input.value;
      if (input.type === 'number' || input.type === 'range') value = Number(value);

      // 处理嵌套属性 (llmOverride.model)
      if (name.includes('.')) {
        const [parent, child] = name.split('.');
        if (!settings[parent]) settings[parent] = {};
        settings[parent][child] = value;
      } else {
        settings[name] = value;
      }
      saveSettingsDebounced();
      console.log(`[Event Chronicle] 设置变更: ${name}=${value}`);
    });
  });

  // 批量生成按钮
  const btn = document.getElementById('ec_batch_start');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const ctx = getContext();
    const msgs = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
    console.log(`[Event Chronicle] 批量生成 — ${msgs.length} 条消息`);
    if (!msgs.length) { alert('未找到聊天消息。请先打开一个聊天对话。'); return; }

    const sliceSize = parseInt(document.getElementById('ec_batch_slice')?.value || '12', 10);
    if (!confirm(`⚠ 将处理 ${msgs.length} 条消息（每批 ${sliceSize} 条），预计消耗大量 Token。继续？`)) return;

    document.getElementById('ec_batch_start').style.display = 'none';
    document.getElementById('ec_batch_progress').style.display = 'block';

    ecBridge.startBatchGeneration({
      chatId: getChatId(),
      messages: msgs,
      context: { name1: ctx.name1, name2: ctx.name2 },
      sliceSize: sliceSize,
      onProgress(p) {
        const fill = document.getElementById('ec_batch_fill');
        const text = document.getElementById('ec_batch_text');
        if (fill) fill.style.width = Math.round(p.current / p.total * 100) + '%';
        if (text) text.textContent = `Chunk ${p.chunk || 1} · ${p.current}/${p.total} · ${p.eventsFound} 个事件`;
      },
      onComplete(r) {
        const text = document.getElementById('ec_batch_text');
        if (text) text.textContent = `完成！共 ${r.finalCount || r.totalEvents} 个事件。`;
        updateChroniclePrompt();
        saveSettingsDebounced();
        setTimeout(() => {
          const startBtn = document.getElementById('ec_batch_start');
          const progress = document.getElementById('ec_batch_progress');
          if (startBtn) startBtn.style.display = '';
          if (progress) progress.style.display = 'none';
        }, 5000);
      },
      onError(e) {
        alert('批量生成错误: ' + (e.message || e));
        const startBtn = document.getElementById('ec_batch_start');
        if (startBtn) startBtn.style.display = '';
      },
    });
  });
}

function setupStatusIndicator() {
  const updateBadge = () => {
    const b = document.getElementById('ec_status_badge');
    if (!b) return;
    if (!sdkReady) { b.textContent = '⚪ 待配置'; b.style.color = '#888'; return; }
    const events = ecBridge.getEvents(getChatId());
    b.textContent = `🟢 ${events.length} 个事件`;
    b.style.color = '#4caf50';
  };
  updateBadge();
  setInterval(updateBadge, 15000);
}

// ---------------------------------------------------------------------------
// Wand 菜单
// ---------------------------------------------------------------------------

function setupWandMenu() {
  if ($('#ec_wand_container').length) return;
  const menu = $('#extensionsMenu');
  if (!menu.length) { setTimeout(setupWandMenu, 1000); return; }

  menu.append(`
    <div id="ec_wand_container">
      <div id="ecExtensionMenuItem" class="list-group-item flex-container flexGap5" style="cursor:pointer;">
        <div class="extensionsMenuExtensionButton" style="color:#ffd700;">📜</div>
        <span>Event Chronicle</span>
      </div>
      <div id="ec_wand_buttons" style="display:none;padding:8px 12px;">
        <button id="ec_btn_extract" class="menu_button" style="display:block;width:100%;margin-bottom:4px;">🔍 手动提取事件</button>
        <button id="ec_btn_timeline" class="menu_button" style="display:block;width:100%;">📋 时间线浏览器</button>
      </div>
    </div>
  `);

  $('#ecExtensionMenuItem').on('click', () => $('#ec_wand_buttons').toggle());
  $('#ec_btn_extract').on('click', (e) => { e.stopPropagation(); manualExtract(); });
  $('#ec_btn_timeline').on('click', (e) => {
    e.stopPropagation();
    const url = '/scripts/extensions/third-party/Event-Chronicle/timeline.html';
    window.open(url, '_blank');
  });
}

// ---------------------------------------------------------------------------
// Public API（供 settings/timeline 访问）
// ---------------------------------------------------------------------------

const API = {
  isReady: () => sdkReady,
  getSettings,
  getEvents: (id) => ecBridge.getEvents(id || getChatId()),
  getAllEvents: () => ecBridge.getAllEvents(),
  updateEvent: (id, ev) => { const r = ecBridge.updateEvent(id, ev); saveSettingsDebounced(); return r; },
  deleteEvent: (id, evId) => { const r = ecBridge.deleteEvent(id, evId); saveSettingsDebounced(); return r; },
  exportMemory: (id, opts) => ecBridge.getMemory(id || getChatId(), opts),
  startBatchGeneration: (opts) => ecBridge.startBatchGeneration({ ...opts, chatId: opts.chatId || getChatId(), context: opts.context || {} }),
  getBatchProgress: (id) => ecBridge.getBatchProgress(id || getChatId()),
  getCurrentChatId: getChatId,
  manualExtract,
};
globalThis.EventChronicle = API;

// ---------------------------------------------------------------------------
// Init（ST 通过 hooks.activate 调用）
// ---------------------------------------------------------------------------

export async function init() {
  console.log('[Event Chronicle] ═══════════════════════════════════════');
  console.log('[Event Chronicle] 🚀 扩展初始化开始');
  console.log('[Event Chronicle] ═══════════════════════════════════════');

  // 1. 注入 LLM 通道（ST 后端 API → ec-bridge）
  ecBridge.setGenerateRaw(llmCall);
  console.log('[Event Chronicle] ✅ LLM 通道已注入');

  // 2. 注入设置 UI
  injectSettingsUI();
  console.log('[Event Chronicle] ✅ 设置 UI 已注入');

  // 3. 初始化设置 + 存储后端
  ensureSettings();
  ecBridge.setExtSettings(extension_settings);
  console.log('[Event Chronicle] ✅ 设置 + 存储已初始化');

  // 4. 注册事件钩子（对标 Chronicle 模式）
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

  // 消息变更 → 重置追踪（可选但推荐）
  try {
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onMessageChanged);
    if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, onMessageChanged);
  } catch (e) { /* ST 版本可能不支持 */ }

  console.log('[Event Chronicle] ✅ 事件钩子已注册');
  console.log('[Event Chronicle]    - CHARACTER_MESSAGE_RENDERED → 自动提取');
  console.log('[Event Chronicle]    - CHAT_CHANGED → 重置状态');
  console.log('[Event Chronicle]    - MESSAGE_DELETED/UPDATED → 重置追踪');

  // 5. Wand 菜单
  setupWandMenu();
  console.log('[Event Chronicle] ✅ Wand 菜单已设置');

  // 6. 初始 Prompt 注入
  updateChroniclePrompt();

  sdkReady = true;
  console.log('[Event Chronicle] ═══════════════════════════════════════');
  console.log(`[Event Chronicle] ✅ 扩展就绪 — 自动提取: ${getSettings().autoExtractionEnabled ? '启用' : '禁用'}, 提取间隔: ${getSettings().extractTriggerCount} 条消息, 冷却: ${getSettings().extractionCooldown}s`);
  console.log('[Event Chronicle] ═══════════════════════════════════════');
}
