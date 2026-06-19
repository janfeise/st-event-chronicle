// index.js — Event Chronicle SillyTavern Extension
// =============================================================================
// ST 集成层：对标 Chronicle 插件的完整事件流。
//
// SDK 纯函数通过 ec-bridge.js 间接消费（ec-bridge 导入 SDK bundle）。
// 本文件负责：生命周期、事件绑定、Prompt 注入、UI 集成、Wand 菜单。
// =============================================================================

import {
  eventSource,
  event_types,
  saveSettingsDebounced,
  getRequestHeaders,
  setExtensionPrompt,
  extension_prompt_roles,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
  saveMetadataDebounced,
} from "../../../extensions.js";
import * as ecBridge from "./ec-bridge.js";

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
  llmOverride: {
    chat_completion_source: "",
    model: "",
    custom_model: "",
    custom_url: "",
    temperature: 0,
    maxTokens: 2048,
  },
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
let cachedOaiSettings = null; // init() 时从 ST 后端拉取并缓存

// ---------------------------------------------------------------------------
// LLM 桥接（复用 ST 后端 API）
// ---------------------------------------------------------------------------

async function loadOaiSettings() {
  try {
    const res = await fetch("/api/settings/get", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.oai_settings) {
      cachedOaiSettings = data.oai_settings;
      console.log(
        "[Event Chronicle] ✅ 已缓存 ST API 设置 — source=" +
          cachedOaiSettings.chat_completion_source +
          ", model=" +
          (cachedOaiSettings.chat_completion_source === "custom"
            ? cachedOaiSettings.custom_model
            : cachedOaiSettings.openai_model),
      );
    } else {
      console.warn(
        "[Event Chronicle] ⚠ ST 后端返回的 settings 中没有 oai_settings，将使用 EC 自身覆盖设置",
      );
    }
  } catch (err) {
    console.warn(
      "[Event Chronicle] ⚠ 无法从 ST 后端读取 oai_settings:",
      err.message,
      "— 将使用 EC 自身覆盖设置",
    );
  }
}

// ---------------------------------------------------------------------------

async function llmCall(prompt) {
  // 防御：ec-bridge 应传字符串，旧版可能传 { prompt, quietToLoud }
  const promptText = typeof prompt === "string" ? prompt : prompt?.prompt || "";
  if (!promptText) {
    console.error(
      "[Event Chronicle] ❌ llmCall 收到空 prompt:",
      typeof prompt,
      JSON.stringify(prompt).slice(0, 200),
    );
    throw new Error("Empty prompt — check ec-bridge callLLM()");
  }

  const startTime = performance.now();
  const settings = getSettings();
  const ctx = getContext();
  const maxTokens = settings.overrideMaxTokens || 2048;

  console.log(`[Event Chronicle] 📤 LLM Call — ${new Date().toISOString()}`, {
    promptLength: promptText.length,
    estimatedTokens: Math.ceil(promptText.length / 3.5),
    maxTokens: maxTokens,
  });

  // 对齐 Chronicle 扩展的完整 payload
  const payload = {
    type: "quiet",
    messages: [{ role: "user", content: promptText }],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
    include_reasoning: false,
    user_name: ctx?.name1 || "",
    char_name: ctx?.name2 || "",
    group_names: [],
    enable_web_search: false,
    request_images: false,
    request_image_resolution: "",
    request_image_aspect_ratio: "",
    custom_prompt_post_processing: "",
    custom_url: "",
    custom_include_body: "",
    custom_exclude_body: "",
    custom_include_headers: "",
  };

  // 优先从缓存读取（init 时通过 /api/settings/get 获取），其次读全局变量
  const oai =
    cachedOaiSettings ||
    (typeof oai_settings !== "undefined" ? oai_settings : null);

  if (oai) {
    payload.chat_completion_source = oai.chat_completion_source;
    payload.model =
      oai.chat_completion_source === "custom"
        ? oai.custom_model || oai.openai_model
        : oai.openai_model;
    payload.custom_url = oai.custom_url || "";
    payload.custom_include_body = oai.custom_include_body || "";
    payload.custom_exclude_body = oai.custom_exclude_body || "";
    payload.custom_include_headers = oai.custom_include_headers || "";
  }

  // 回退：如果缓存和全局都没有，使用 EC 自身设置覆盖
  const ecOverride = extension_settings?.["event-chronicle"]?.llmOverride;
  if (ecOverride) {
    if (!payload.chat_completion_source && ecOverride.chat_completion_source) {
      payload.chat_completion_source = ecOverride.chat_completion_source;
    }
    if (!payload.model && ecOverride.model) {
      payload.model = ecOverride.model;
    }
    if (!payload.custom_url && ecOverride.custom_url) {
      payload.custom_url = ecOverride.custom_url;
    }
    if (
      ecOverride.chat_completion_source === "custom" &&
      ecOverride.custom_model &&
      !payload.model
    ) {
      payload.model = ecOverride.custom_model;
    }
  }

  // 最终校验
  if (!payload.chat_completion_source || !payload.model) {
    const msg =
      "[Event Chronicle] [ERROR] 无法确定 API 配置：chat_completion_source=" +
      payload.chat_completion_source +
      ", model=" +
      payload.model +
      "。请在 ST 的 API 设置中配置，或在 Event Chronicle 设置面板中覆盖。";
    console.error(msg);
    throw new Error(msg);
  }

  const response = await fetch("/api/backends/chat-completions/generate", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify(payload),
  });

  const elapsed = (performance.now() - startTime).toFixed(0);

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `[Event Chronicle] ❌ LLM Call 失败 — ${elapsed}ms, HTTP ${response.status}`,
      {
        errorBody: text.slice(0, 300),
      },
    );
    throw new Error("API 错误 " + response.status + ": " + text.slice(0, 300));
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";

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
  if (
    !extension_settings["event-chronicle"] ||
    Object.keys(extension_settings["event-chronicle"]).length === 0
  ) {
    extension_settings["event-chronicle"] = { ...DEFAULT_SETTINGS };
    saveSettingsDebounced();
  }
  return extension_settings["event-chronicle"];
}

function getSettings() {
  return extension_settings["event-chronicle"] || DEFAULT_SETTINGS;
}

function getChatId() {
  try {
    const ctx = getContext();
    if (ctx && ctx.chatId) return String(ctx.chatId);
  } catch (e) {
    /* ignore */
  }
  return "default";
}

// ---------------------------------------------------------------------------
// Metadata 注入 (per-chat 业务数据)
// ---------------------------------------------------------------------------

function injectMetadata() {
  try {
    const ctx = getContext();
    if (ctx && ctx.chatMetadata) {
      ecBridge.setMetadata(ctx.chatMetadata, () => saveMetadataDebounced());
    } else {
      console.warn(
        "[Event Chronicle] ⚠ chatMetadata 不可用，跳过 metadata 注入",
      );
    }
  } catch (e) {
    console.warn("[Event Chronicle] ⚠ metadata 注入失败:", e.message);
  }
}

// ---------------------------------------------------------------------------
// 数据迁移：extension_settings → metadata (一次性)
// ---------------------------------------------------------------------------

function migrateToMetadata() {
  const settings = extension_settings["event-chronicle"];
  if (!settings) return;

  const hasLegacyData = settings._events || settings._merge || settings._batch;
  if (!hasLegacyData) return;

  console.log("[Event Chronicle] 🔄 检测到旧数据，执行迁移...");

  try {
    const ctx = getContext();
    if (!ctx || !ctx.chatMetadata) {
      console.warn("[Event Chronicle] ⚠ chatMetadata 不可用，跳过迁移");
      return;
    }

    const chatId = getChatId();
    const md = ctx.chatMetadata;
    if (!md["event-chronicle"]) md["event-chronicle"] = {};

    // 迁移当前聊天的事件
    if (settings._events && settings._events[chatId]) {
      md["event-chronicle"]._events = settings._events[chatId];
      console.log(
        `[Event Chronicle] 📦 迁移事件: ${md["event-chronicle"]._events.length} 个`,
      );
    }
    if (settings._merge && settings._merge[chatId]) {
      md["event-chronicle"]._merge = settings._merge[chatId];
    }
    if (settings._batch && settings._batch[chatId]) {
      md["event-chronicle"]._batch = settings._batch[chatId];
    }

    // 清理 extension_settings 中已迁移的当前聊天数据
    if (settings._events) delete settings._events[chatId];
    if (settings._merge) delete settings._merge[chatId];
    if (settings._batch) delete settings._batch[chatId];

    // 如果所有聊天数据都已迁移，清理整个 _events/_merge/_batch
    if (settings._events && Object.keys(settings._events).length === 0)
      delete settings._events;
    if (settings._merge && Object.keys(settings._merge).length === 0)
      delete settings._merge;
    if (settings._batch && Object.keys(settings._batch).length === 0)
      delete settings._batch;

    saveMetadataDebounced();
    saveSettingsDebounced();
    console.log("[Event Chronicle] ✅ 迁移完成");
  } catch (e) {
    console.error("[Event Chronicle] ❌ 迁移失败:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Prompt 注入（对标 Chronicle updateChroniclePrompt）
// ---------------------------------------------------------------------------

function updateChroniclePrompt() {
  const settings = getSettings();
  const promptText = ecBridge.getMemory({
    highlightThreshold: settings.highlightThreshold || 7,
    title: "Event Chronicle Memory",
  });

  console.log(
    `[Event Chronicle] 🔄 更新 Prompt 注入 — ${promptText ? promptText.length + " 字符" : "空"}`,
  );

  setExtensionPrompt(
    "event-chronicle", // key
    promptText, // value (空字符串 = 移除注入)
    0, // position = IN_PROMPT
    0, // depth = 0
    false, // scan = false
    extension_prompt_roles.SYSTEM, // role = SYSTEM
  );
}

// ---------------------------------------------------------------------------
// 自动提取（对标 Chronicle processAutoExtraction）
// ---------------------------------------------------------------------------

async function onCharacterMessageRendered() {
  console.log(`[Event Chronicle] 📨 CHARACTER_MESSAGE_RENDERED 触发`);

  if (!sdkReady) {
    console.log("[Event Chronicle] ⏭ 跳过 — 扩展未就绪");
    return;
  }
  if (!getSettings().autoExtractionEnabled) {
    console.log("[Event Chronicle] ⏭ 跳过 — 自动提取已禁用");
    return;
  }
  if (inApiCall) {
    console.log("[Event Chronicle] ⏭ 跳过 — API 调用进行中");
    return;
  }

  // Group chat 检查
  try {
    if (typeof is_group_generating !== "undefined" && is_group_generating) {
      console.log("[Event Chronicle] ⏭ 跳过 — group chat 生成中");
      return;
    }
  } catch (e) {
    /* ignore */
  }

  const context = getContext();
  if (!context || !context.chat || !context.chat.length) {
    console.log("[Event Chronicle] ⏭ 跳过 — 无聊天数据");
    return;
  }

  // 冷却检查
  const now = Date.now();
  const cooldownMs = (getSettings().extractionCooldown || 30) * 1000;
  if (now - lastExtractionTime < cooldownMs) {
    const remaining = Math.ceil(
      (cooldownMs - (now - lastExtractionTime)) / 1000,
    );
    console.log(`[Event Chronicle] ⏭ 跳过 — 冷却中 (${remaining}s 剩余)`);
    return;
  }

  // 未处理消息计数
  const chat = context.chat;
  const threshold = getSettings().extractTriggerCount || 10;
  let unprocessedCount = chat.length;

  // lastProcessedMessageId 存储的是 chat 数组索引
  if (
    lastProcessedMessageId != null &&
    typeof lastProcessedMessageId === "number" &&
    lastProcessedMessageId >= 0
  ) {
    unprocessedCount = chat.length - 1 - lastProcessedMessageId;
  }

  console.log(
    `[Event Chronicle] 未处理消息: ${unprocessedCount}/${chat.length}, 阈值: ${threshold}`,
  );

  if (unprocessedCount < threshold) {
    console.log(
      `[Event Chronicle] ⏭ 跳过 — 未达阈值 (${unprocessedCount} < ${threshold})`,
    );
    return;
  }

  // 取最近 N 条消息
  const messagesToCheck = chat.slice(-threshold);
  const lastMessage = messagesToCheck[messagesToCheck.length - 1];
  const lastMsgIndex = chat.indexOf(lastMessage);

  console.log(
    `[Event Chronicle] 🔍 自动提取 — 分析最近 ${messagesToCheck.length} 条消息 (索引 ${chat.length - threshold}–${chat.length - 1})`,
  );

  lastExtractionTime = now;

  try {
    inApiCall = true;

    const result = await ecBridge.processMessages(messagesToCheck, {
      context: { name1: context.name1, name2: context.name2 },
      autoMerge: true,
      mergeThreshold: getSettings().mergeTriggerCount || 5,
      startIndex: chat.length - threshold,
    });

    // API 成功 — 更新追踪标记
    if (lastMsgIndex >= 0) {
      lastProcessedMessageId = lastMsgIndex;
      console.log(
        `[Event Chronicle] 📍 更新追踪标记: lastProcessedMessageId=${lastProcessedMessageId} (消息 ${lastMsgIndex + 1}/${chat.length})`,
      );
    }

    if (result.events.length) {
      console.log(
        `[Event Chronicle] ✅ 自动提取完成 — ${result.events.length} 个新事件`,
      );
      if (typeof toastr !== "undefined") {
        toastr.info(
          `📜 记录 ${result.events.length} 个新事件`,
          "Event Chronicle",
        );
      }
    } else {
      console.log("[Event Chronicle] ✅ 自动提取完成 — 无新事件");
    }

    if (result.merged) {
      console.log("[Event Chronicle] 🔄 自动合并已完成");
    }

    ecBridge.saveAndPersist();
    updateChroniclePrompt();
  } catch (err) {
    // API 失败 — 不更新追踪标记（下次重试）
    console.error(
      "[Event Chronicle] ❌ 自动提取失败 (下次重试):",
      err.message || err,
    );
    if (typeof toastr !== "undefined") {
      toastr.warning(
        "Event Chronicle: 提取失败 (API 错误)，将重试",
        "Event Chronicle",
      );
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
  // 重新注入 metadata（新聊天有新的 metadata）
  injectMetadata();
  // 更新 Prompt 注入（为新聊天加载其事件）
  updateChroniclePrompt();
  console.log("[Event Chronicle] ✅ 聊天切换完成");
}

function onMessageChanged() {
  console.log("[Event Chronicle] 🔄 消息变更 — 重置追踪标记");
  lastProcessedMessageId = null;
}

// ---------------------------------------------------------------------------
// 手动提取 (Wand 菜单)
// ---------------------------------------------------------------------------

async function manualExtract() {
  if (inApiCall) {
    if (typeof toastr !== "undefined")
      toastr.warning("提取进行中，请等待", "Event Chronicle");
    return;
  }
  const context = getContext();
  if (!context || !context.chat || !context.chat.length) {
    if (typeof toastr !== "undefined")
      toastr.warning("未找到聊天消息", "Event Chronicle");
    return;
  }

  try {
    inApiCall = true;
    const settings = getSettings();
    const messagesToCheck = context.chat.slice(
      -(settings.extractTriggerCount * 2),
    );
    console.log(
      `[Event Chronicle] 🔍 手动提取 — ${messagesToCheck.length} 条消息`,
    );

    const result = await ecBridge.processMessages(messagesToCheck, {
      context: { name1: context.name1, name2: context.name2 },
      autoMerge: true,
      mergeThreshold: settings.mergeTriggerCount || 5,
    });

    if (result.events.length) {
      console.log(
        `[Event Chronicle] ✅ 手动提取完成 — ${result.events.length} 个新事件`,
      );
      if (typeof toastr !== "undefined")
        toastr.info(
          `📜 记录 ${result.events.length} 个新事件`,
          "Event Chronicle",
        );
    } else {
      console.log("[Event Chronicle] ✅ 手动提取完成 — 无新事件");
      if (typeof toastr !== "undefined")
        toastr.info("未发现新事件", "Event Chronicle");
    }

    ecBridge.saveAndPersist();
    updateChroniclePrompt();
  } catch (err) {
    console.error("[Event Chronicle] ❌ 手动提取失败:", err.message || err);
    if (typeof toastr !== "undefined")
      toastr.error("提取失败: " + (err.message || err), "Event Chronicle");
  } finally {
    inApiCall = false;
  }
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function injectSettingsUI() {
  const target = document.getElementById("extensions_settings");
  if (!target) {
    setTimeout(injectSettingsUI, 1000);
    return;
  }
  if (document.getElementById("ec_settings")) return;

  const settings = getSettings();

  const div = document.createElement("div");
  div.id = "ec_settings";
  div.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>📜 Visual Memory · 可视记忆</b>
        <span id="ec_status_badge" style="font-size:0.8em;color:#888;margin-left:8px;"></span>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <p class="ec-hint" style="margin-bottom:12px;">自动从对话中提取事件，构建时间线并注入记忆</p>

        <h4>⚙️ 自动提取</h4>
        <div class="ec-field">
          <label for="ec_extract_trigger">触发间隔（消息数）</label>
          <input id="ec_extract_trigger" name="extractTriggerCount" type="number" min="3" max="100" value="${settings.extractTriggerCount}" class="text_pole">
          <small class="ec-hint">累积多少条新消息后自动触发事件提取</small>
        </div>
        <div class="ec-field">
          <label for="ec_merge_trigger">合并阈值（事件数）</label>
          <input id="ec_merge_trigger" name="mergeTriggerCount" type="number" min="2" max="50" value="${settings.mergeTriggerCount}" class="text_pole">
          <small class="ec-hint">累积多少条新事件后自动触发合并去重</small>
        </div>

        <h4>🤖 模型设置 <small class="ec-hint" style="display:inline;border:none;font-weight:normal;">留空则自动复用 ST 的 API 配置</small></h4>
        <div class="ec-field">
          <label for="ec_chat_source">API 来源</label>
          <select id="ec_chat_source" name="llmOverride.chat_completion_source" class="text_pole">
            <option value="" ${!settings.llmOverride?.chat_completion_source ? "selected" : ""}>— 自动（复用 ST 设置）—</option>
            <option value="openai" ${settings.llmOverride?.chat_completion_source === "openai" ? "selected" : ""}>OpenAI</option>
            <option value="claude" ${settings.llmOverride?.chat_completion_source === "claude" ? "selected" : ""}>Claude</option>
            <option value="custom" ${settings.llmOverride?.chat_completion_source === "custom" ? "selected" : ""}>Custom</option>
            <option value="deepseek" ${settings.llmOverride?.chat_completion_source === "deepseek" ? "selected" : ""}>DeepSeek</option>
            <option value="openrouter" ${settings.llmOverride?.chat_completion_source === "openrouter" ? "selected" : ""}>OpenRouter</option>
          </select>
        </div>
        <div class="ec-field">
          <label for="ec_llm_model">模型</label>
          <input id="ec_llm_model" name="llmOverride.model" type="text" placeholder="例如 gpt-4o-mini" value="${settings.llmOverride?.model || ""}" class="text_pole">
        </div>
        <div class="ec-field">
          <label for="ec_llm_custom_model">自定义模型</label>
          <input id="ec_llm_custom_model" name="llmOverride.custom_model" type="text" placeholder="例如 deepseek-ai/DeepSeek-V3" value="${settings.llmOverride?.custom_model || ""}" class="text_pole">
        </div>
        <div class="ec-field">
          <label for="ec_custom_url">自定义 API URL</label>
          <input id="ec_custom_url" name="llmOverride.custom_url" type="text" placeholder="例如 https://api.siliconflow.cn/v1" value="${settings.llmOverride?.custom_url || ""}" class="text_pole">
        </div>
        <div class="ec-field">
          <label for="ec_llm_temperature">温度</label>
          <input id="ec_llm_temperature" name="llmOverride.temperature" type="number" min="0" max="2" value="${settings.llmOverride?.temperature || 0}" step="0.1" class="text_pole">
        </div>
        <div class="ec-field">
          <label for="ec_max_tokens">最大 Token</label>
          <input id="ec_max_tokens" name="overrideMaxTokens" type="number" min="256" max="16384" value="${settings.overrideMaxTokens}" class="text_pole">
          <small class="ec-hint">事件提取需要足够长度输出完整 JSON</small>
        </div>

        <h4>📜 事件生成</h4>
        <p id="ec_batch_status" class="ec-hint" style="margin-bottom:8px;"></p>
        <div class="ec-field">
          <label for="ec_batch_slice">每轮消息数</label>
          <input id="ec_batch_slice" name="batchSliceSize" type="number" min="2" max="20" value="${settings.batchSliceSize}" class="text_pole">
        </div>
        <div style="margin:8px 0;">
          <button id="ec_batch_start" style="width: max-content" class="menu_button">▶ 生成事件</button>
        </div>
        <div id="ec_batch_progress" style="display:none;">
          <div class="ec-progress-bar"><div id="ec_batch_fill" class="ec-progress-fill"></div></div>
          <div id="ec_batch_text" class="ec-progress-text"></div>
        </div>

        <div style="margin:12px 0 4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;">
          <button id="ec_clear_events" style="width:max-content" class="menu_button danger">
            <i class="fa-solid fa-trash-can"></i> 清空所有事件
          </button>
          <small class="ec-hint" style="display:block;margin-top:4px;">删除当前聊天的全部事件，此操作不可撤销</small>
        </div>
      </div>
    </div>`;
  target.appendChild(div);
  bindSettingsEvents();
  setupStatusIndicator();
}

function bindSettingsEvents() {
  // 设置变更 → 保存
  const inputs = document.querySelectorAll(
    "#ec_settings input, #ec_settings select",
  );
  inputs.forEach((input) => {
    input.addEventListener("change", () => {
      const settings = getSettings();
      const name = input.name;
      if (!name) return;
      let value = input.value;
      if (input.type === "number" || input.type === "range")
        value = Number(value);

      // 处理嵌套属性 (llmOverride.model)
      if (name.includes(".")) {
        const [parent, child] = name.split(".");
        if (!settings[parent]) settings[parent] = {};
        settings[parent][child] = value;
      } else {
        settings[name] = value;
      }
      saveSettingsDebounced();
      console.log(`[Event Chronicle] 设置变更: ${name}=${value}`);
    });
  });

  // 清空所有事件按钮
  document.getElementById("ec_clear_events")?.addEventListener("click", () => {
    const events = ecBridge.getEvents();
    if (!events.length) {
      if (typeof toastr !== "undefined")
        toastr.warning("当前没有事件可清空", "Event Chronicle");
      return;
    }
    if (
      !confirm(
        `⚠ 确定要清空当前聊天的全部 ${events.length} 个事件吗？\n\n此操作不可撤销！`,
      )
    )
      return;
    if (!confirm("再次确认：真的要删除所有事件吗？")) return;
    API.clearEvents();
    if (typeof toastr !== "undefined")
      toastr.success(`已清空 ${events.length} 个事件`, "Event Chronicle");
  });

  // 批量生成按钮（增量模式）
  const btn = document.getElementById("ec_batch_start");
  if (!btn) return;
  let batchRunning = false;

  // 初始化状态显示
  updateBatchStatus();

  btn.addEventListener("click", () => {
    if (batchRunning) {
      console.warn("[Event Chronicle] ⚠ 批量生成已在运行中，跳过重复触发");
      return;
    }
    const ctx = getContext();
    const msgs = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
    if (!msgs.length) {
      alert("未找到聊天消息。请先打开一个聊天对话。");
      return;
    }

    // 检查增量状态
    const status = ecBridge.getIncrementalStatus(msgs.length);
    if (!status.hasPending) {
      if (typeof toastr !== "undefined")
        toastr.info("暂无新内容，无需生成", "Event Chronicle");
      return;
    }

    const sliceSize = parseInt(
      document.getElementById("ec_batch_slice")?.value || "12",
      10,
    );
    if (
      !confirm(
        `⚠ 检测到 ${status.pending} 条新消息（每轮 ${sliceSize} 条），预计消耗大量 Token。继续？`,
      )
    )
      return;

    batchRunning = true;
    document.getElementById("ec_batch_start").style.display = "none";
    document.getElementById("ec_batch_progress").style.display = "block";

    ecBridge.startBatchGeneration({
      messages: msgs,
      context: { name1: ctx.name1, name2: ctx.name2 },
      sliceSize,
      onStart(s) {
        const text = document.getElementById("ec_batch_text");
        if (text) text.textContent = `正在处理 ${s.pending} 条新消息...`;
      },
      onProgress(p) {
        const fill = document.getElementById("ec_batch_fill");
        const text = document.getElementById("ec_batch_text");
        if (fill)
          fill.style.width = Math.round((p.current / p.total) * 100) + "%";
        if (text)
          text.textContent = `进度: ${p.current}/${p.total} · ${p.eventsFound} 个事件`;
      },
      onComplete(r) {
        batchRunning = false;
        const text = document.getElementById("ec_batch_text");
        if (r.noNew) {
          if (text) text.textContent = "暂无新消息，无需处理";
        } else {
          if (text)
            text.textContent = `完成！新增 ${r.newEvents} 个事件，共 ${r.finalCount} 个`;
        }
        updateChroniclePrompt();
        ecBridge.saveAndPersist();
        updateBatchStatus();
        setTimeout(() => {
          const startBtn = document.getElementById("ec_batch_start");
          const progress = document.getElementById("ec_batch_progress");
          if (startBtn) startBtn.style.display = "";
          if (progress) progress.style.display = "none";
        }, 3000);
      },
      onError(e) {
        batchRunning = false;
        alert("生成错误: " + (e.message || e));
        const startBtn = document.getElementById("ec_batch_start");
        if (startBtn) startBtn.style.display = "";
      },
    });
  });
}

function updateBatchStatus() {
  try {
    const ctx = getContext();
    const msgs = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
    const status = ecBridge.getIncrementalStatus(msgs.length);
    const el = document.getElementById("ec_batch_status");
    if (!el) return;

    if (msgs.length === 0) {
      el.textContent = "请先打开一个聊天对话";
      el.style.color = "#888";
    } else if (status.pending === 0) {
      el.textContent = `✅ 全部消息已生成事件，暂无新内容`;
      el.style.color = "#4caf50";
    } else {
      el.textContent = `已生成至第 ${status.processed} 条，还剩 ${status.pending} 条待处理`;
      el.style.color = "#ffaa00";
    }
  } catch (e) {
    /* ignore */
  }
}

function setupStatusIndicator() {
  const updateBadge = () => {
    const b = document.getElementById("ec_status_badge");
    if (!b) return;
    if (!sdkReady) {
      b.textContent = "⚪ 待配置";
      b.style.color = "#888";
      return;
    }
    const events = ecBridge.getEvents();
    b.textContent = `🟢 ${events.length} 个事件`;
    b.style.color = "#4caf50";
  };
  updateBadge();
  setInterval(() => {
    updateBadge();
    updateBatchStatus();
  }, 15000);
}

// ---------------------------------------------------------------------------
// Wand 菜单
// ---------------------------------------------------------------------------

function setupWandMenu() {
  if ($("#ec_wand_container").length) return;
  const menu = $("#extensionsMenu");
  if (!menu.length) {
    setTimeout(setupWandMenu, 1000);
    return;
  }

  menu.append(`
    <div id="ec_wand_container">
      <div id="ecExtensionMenuItem" class="list-group-item flex-container flexGap5" style="cursor:pointer;">
        <div class="extensionsMenuExtensionButton" style="color:#ffd700;">📜</div>
        <span>Visual Memory</span>
      </div>
      <div id="ec_wand_buttons" style="display:none;padding:8px 12px;">
        <button id="ec_btn_extract" class="menu_button" style="display:block;width:100%;margin-bottom:4px;">🔍 立即提取事件</button>
        <button id="ec_btn_timeline" class="menu_button" style="display:block;width:100%;">📋 时间线浏览器</button>
      </div>
    </div>
  `);

  $("#ecExtensionMenuItem").on("click", (e) => {
    e.stopPropagation();
    $("#ec_wand_buttons").toggle();
  });
  $("#ec_btn_extract").on("click", (e) => {
    e.stopPropagation();
    manualExtract();
  });
  $("#ec_btn_timeline").on("click", (e) => {
    e.stopPropagation();
    const chatId = encodeURIComponent(getChatId());
    const extDir = new URL(".", import.meta.url).pathname;
    const url = extDir + "timeline.html?chat=" + chatId;
    window.open(url, "_blank");
  });
}

// ---------------------------------------------------------------------------
// Public API（供 settings/timeline 访问）
// ---------------------------------------------------------------------------

const API = {
  isReady: () => sdkReady,
  getSettings,
  getEvents: () => ecBridge.getEvents(),
  getAllEvents: () => ecBridge.getAllEvents(),
  updateEvent: (ev) => {
    const r = ecBridge.updateEvent(ev);
    ecBridge.saveAndPersist();
    return r;
  },
  deleteEvent: (eventId) => {
    const r = ecBridge.deleteEvent(eventId);
    ecBridge.saveAndPersist();
    return r;
  },
  clearEvents: () => {
    ecBridge.clearEvents();
    ecBridge.saveAndPersist();
  },
  getMessagesByRange: (start, end) => {
    const ctx = getContext();
    if (!ctx || !ctx.chat) return [];
    const result = [];
    for (let i = Math.max(0, start); i < Math.min(end, ctx.chat.length); i++) {
      const m = ctx.chat[i];
      result.push({
        name: m.name || '',
        mes: m.mes || '',
        is_user: !!m.is_user,
        send_date: m.send_date || '',
      });
    }
    return result;
  },
  exportMemory: (opts) => ecBridge.getMemory(opts),
  startBatchGeneration: (opts) =>
    ecBridge.startBatchGeneration({ ...opts, context: opts.context || {} }),
  getIncrementalStatus: (total) => ecBridge.getIncrementalStatus(total),
  getBatchProgress: () => ecBridge.getBatchProgress(),
  getCurrentChatId: getChatId,
  manualExtract,
};
globalThis.EventChronicle = API;

// ---------------------------------------------------------------------------
// Init（ST 通过 hooks.activate 调用）
// ---------------------------------------------------------------------------

export async function init() {
  console.log("[Event Chronicle] ═══════════════════════════════════════");
  console.log("[Event Chronicle] 🚀 扩展初始化开始");
  console.log("[Event Chronicle] ═══════════════════════════════════════");

  // 1. 缓存 ST API 配置（解决 oai_settings 全局变量不可用的问题）
  await loadOaiSettings();

  // 2. 注入 LLM 通道（ST 后端 API → ec-bridge）
  ecBridge.setGenerateRaw(llmCall);
  console.log("[Event Chronicle] ✅ LLM 通道已注入");

  // 3. 注入设置 UI
  injectSettingsUI();
  console.log("[Event Chronicle] ✅ 设置 UI 已注入");

  // 4. 初始化设置 + 存储后端
  ensureSettings();
  ecBridge.setExtSettings(extension_settings);
  console.log("[Event Chronicle] ✅ 全局配置存储已初始化 (extension_settings)");

  // 4.5 注入 per-chat metadata 存储
  injectMetadata();
  console.log("[Event Chronicle] ✅ per-chat 业务数据存储已初始化 (metadata)");

  // 4.6 一次性迁移（旧数据从 extension_settings → metadata）
  migrateToMetadata();

  // 5. 注册事件钩子（对标 Chronicle 模式）
  eventSource.on(
    event_types.CHARACTER_MESSAGE_RENDERED,
    onCharacterMessageRendered,
  );
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

  // 消息变更 → 重置追踪（可选但推荐）
  try {
    if (event_types.MESSAGE_DELETED)
      eventSource.on(event_types.MESSAGE_DELETED, onMessageChanged);
    if (event_types.MESSAGE_UPDATED)
      eventSource.on(event_types.MESSAGE_UPDATED, onMessageChanged);
  } catch (e) {
    /* ST 版本可能不支持 */
  }

  console.log("[Event Chronicle] ✅ 事件钩子已注册");
  console.log("[Event Chronicle]    - CHARACTER_MESSAGE_RENDERED → 自动提取");
  console.log("[Event Chronicle]    - CHAT_CHANGED → 重置状态");
  console.log("[Event Chronicle]    - MESSAGE_DELETED/UPDATED → 重置追踪");

  // 6. Wand 菜单
  setupWandMenu();
  console.log("[Event Chronicle] ✅ Wand 菜单已设置");

  // 6. 初始 Prompt 注入
  updateChroniclePrompt();

  sdkReady = true;
  console.log("[Event Chronicle] ═══════════════════════════════════════");
  console.log(
    `[Event Chronicle] ✅ 扩展就绪 — 自动提取: ${getSettings().autoExtractionEnabled ? "启用" : "禁用"}, 提取间隔: ${getSettings().extractTriggerCount} 条消息, 冷却: ${getSettings().extractionCooldown}s`,
  );
  console.log("[Event Chronicle] ═══════════════════════════════════════");
}
