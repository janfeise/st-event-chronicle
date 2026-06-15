# Event Chronicle ST Extension — CLAUDE.md

## Build & Sync

```bash
# From parent project:
npm run sync:st        # Build browser SDK + copy to lib/ec-sdk.mjs
npm run sync:st:push   # Sync + commit + git subtree push

# Or push directly from st-extension/:
git push origin main
```

## Architecture

```
index.js (ST 集成层)
  ├── init()           # 生命周期: 缓存 API 配置, 注入 LLM 通道, 注入 UI, 注册钩子
  ├── llmCall()        # LLM 调用: POST /api/backends/chat-completions/generate
  ├── injectSettingsUI # 动态创建设置面板
  └── setupWandMenu()  # Wand 菜单入口
        │
        ▼
ec-bridge.js (适配层)
  ├── extractEvents()  # Phase 1: 格式化 → 构建 prompt → LLM → 解析
  ├── mergeEvents()    # Phase 2: 去重/合并
  ├── processMessages()# 完整流程编排
  └── startBatchGeneration()  # 历史消息批量回填
        │
        ▼
lib/ec-sdk.mjs (SDK 纯函数, 由 npm run sync:st 生成)
  parseEvents, formatMessages, parseInstructions, applyInstructions,
  extractPrompt, mergePrompt, memoryPrompt, ...
```

## Event Hooks

| Hook | 触发 | 行为 |
|---|---|---|
| `CHARACTER_MESSAGE_RENDERED` | 角色回复后 | 累计未处理消息达阈值 → 自动提取事件 |
| `CHAT_CHANGED` | 切换对话 | 重置追踪状态, 重新注入 prompt |
| `MESSAGE_DELETED` / `MESSAGE_UPDATED` | 消息变更 | 重置追踪标记 |

## Storage

```
extension_settings['event-chronicle']
  ├── _events   # { chatId: Event[] }
  ├── _merge    # { chatId: { newEventCount, lastMergeAt } }
  └── _batch    # { chatId: { lastProcessedIndex, completed } }
```

数据随 ST 的 `settings.json` 自动持久化，无独立文件。

## Key Files

| File | Lines | Purpose |
|---|---|---|
| `index.js` | ~700 | ST 生命周期, LLM 桥接, 设置 UI, 公共 API |
| `ec-bridge.js` | ~720 | SDK 适配, 提取/合并流程, 批量生成, CRUD |
| `lib/ec-sdk.mjs` | ~470 | SDK 纯函数 bundle (generated, do not edit) |
| `timeline.html` + `timeline.js` + `editor.js` | — | 独立时间线浏览器窗口 |
| `settings.html` | ~115 | 设置面板模板 (iframe 加载) |
| `manifest.json` | 9 | ST 扩展声明 |

## Testing

```bash
# Validate SDK bundle loads in Node (no browser needed):
node -e "import('./lib/ec-sdk.mjs').then(m => console.log(Object.keys(m)))"

# Or via parent project:
npm run test:browser   # Start server → open in browser
node test/browser/run-tests.mjs  # Headless Playwright
```
