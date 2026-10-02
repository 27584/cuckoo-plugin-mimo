# 小米 MiMo 插件（Cuckoo Code）

给 [Cuckoo Code](https://github.com/wangyongpeng90/cuckoo-code) 增加 **小米 MiMo Studio（aistudio.xiaomimimo.com）** 平台支持。

## 安装

### 方式一：应用内插件市场

Cuckoo Code 的侧边栏「插件」页会列出 GitHub 上所有带 `cuckoo-plugin` topic 的仓库，
找到本插件点安装即可。

### 方式二：手动

```bash
git clone https://github.com/wangyongpeng90/cuckoo-plugin-mimo.git
```

把 `providers/mimo.js` 放到任意目录，然后在应用的自定义 Provider 处导入该文件。

## ⚠️ 装完需要手动启用

插件**安装后默认不生效** —— 技能、代理、规则、MCP、可执行内容全部不加载。

这是有意设计，不是缺陷：`providers/mimo.js` 会被 `require` 执行，等同于在本机运行第三方代码。
**装一个插件不该顺带执行代码**，启用必须是你的显式动作。

**安装后请到「插件」页的「已安装」处，打开本插件的开关。**

因为本插件含可执行内容，启用时会弹确认框，逐条列出将被执行的东西：

```
· providers/mimo.js（会被 require 执行）
```

确认后小米 MiMo 平台即可使用。

## 平台信息

| 项 | 值 |
|---|---|
| 首页 | https://aistudio.xiaomimimo.com/#/chat |
| 会话 URL | `#/chat/<32 位十六进制 conversationId>` |
| 回复获取 | 网络拦截（`useIntercept: true`），解析 SSE 帧 |
| 发送方式 | 主进程注入原生 Enter（站点 Enter 发送 / Shift+Enter 换行） |
| 暂停 | 优先点击站点「停止生成」键（走站点自身中止逻辑），再本地兜底 |
| 附件上传 | 直接注入隐藏 `input[type=file]`；无则点击官方上传键 |
| 登录 | **站点自身需要登录**，登录态在页面 cookie 内，插件不参与登录 |

## 实现要点

站点是纯 SPA、接口不公开，因此 provider 采用**实证优先**的解析策略（全部依据真机日志与站点
bundle 原文，非猜测）：

- **传输通道**：同时拦截 `fetch` / `XHR` / `WebSocket` / `EventSource`，聊天端点锁定为
  `POST /open-apis/bot/chat`（含 `/fastchat/` 变体）
- **帧结构**：`id:<sessionId>` 是 SSE 控制行（已显式丢弃，避免污染正文）；
  正文为 `{"type":"text","content":"..."}` 增量；思考以 `<think>…</think>` 内联在正文流中，
  由 provider 拆分到独立思考通道
- **会话列表**：`POST /open-apis/chat/conversation/list`，列表数组字段为 `data.dataList`；
  取 `conversationId`（32 位十六进制）而非数据库主键 `id`；重放时把分页参数归一到首页
- **可执行内容的安全性**：hook 只在 `*.xiaomimimo.com` 页面上生效 —— 自定义 provider 的
  hook 会在每个页面自注入，若不校验页面归属会接管其它站点的流量

## 兼容性

- 最低应用版本：`0.8.7`

若你已通过「自定义 Provider」导入过同 id 的 `mimo.js`，**用户配置优先**，插件版本会被跳过
（不会出现两个同名 provider）。此时用哪种方式装都可以，效果一致。

## License

GPL-3.0-only
