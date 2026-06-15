# 📜 Event Chronicle — SillyTavern 扩展

从 AI 角色扮演对话中自动提取结构化事件，构建可视编年史时间线，注入长期记忆

---

## 安装

在 ST 扩展管理中 → **Install from Git URL** → 输入：

```
https://github.com/janfeise/st-event-chronicle
```

安装位置：`{ST目录}/scripts/extensions/third-party/st-event-chronicle/`

无需额外配置，克隆即用

---

## 数据存放位置

```
数据存放于：data/default-user/settings.json
          → extension_settings.event-chronicle._events
```

数据随 ST 的 `settings.json` 自动保存，**没有独立数据文件**。切换对话时事件按 chatId 隔离

---

## 功能

- **自动事件提取** — 每 N 条消息自动调用 LLM 提取事件
- **长期记忆注入** — AI 生成回复前注入编年史，避免遗忘早期情节
- **自动合并去重** — 累计 M 条新事件自动整理，去重保序
- **时间线浏览** — Wand 菜单打开独立窗口，按地点分组、搜索、筛选
- **事件编辑** — 修改标题/摘要/重要性/参与者/地点/标签，即时持久化
- **一键批量生成** — 从聊天历史增量生成事件，切片处理避免超上下文

## 配置

在 ST 扩展设置面板中调整：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| 提取阈值 | 10 条消息 | 累计未处理消息数达到后自动提取 |
| 整理阈值 | 5 个事件 | 累计新事件数达到后自动合并去重 |
| 最大 Token | 2048 | 事件提取输出长度上限 |
| 模型设置 | 自动复用 ST | 可选覆盖：来源 (openai/claude/custom)、模型名、自定义 URL |
| 批量切片 | 5 条/批 | 批量生成时每批发送的消息数 |

> 如果 API 调用失败 (400)，检查 ST 的 API 设置是否已配置。或在 EC 插件设置面板中手动指定 `chat_completion_source` 和 `model`

## 预览

**时间线浏览器** — Wand 菜单 → 📋 时间线浏览器：

```
┌─────────────────────────────────────────┐
│ 📅 初遇神秘商人              ★★★★★★★☆☆☆ │
│ 冒险者在酒馆遇到一位兜售古地图的商人...  │
│ 👤 战士, 法师  📍 酒馆                   │
│ 🏷️ 发现 · 商人 · 任务                    │
│                        [ 编辑 ] [ 删除 ] │
└─────────────────────────────────────────┘
```

## 注意事项

- 事件提取和合并消耗 API Token
- 批量生成前会弹出 Token 消耗提醒
- 模型设置变更后刷新页面生效

## 更多

- [主项目](https://github.com/janfeise/Event-Chronicle)
- [开发文档](../docs/st-extension-dev.md)
- [主项目 README](../README.md)
