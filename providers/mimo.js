/**
 * 小米 MiMo AI Studio（aistudio.xiaomimimo.com）Provider
 * 适配 Cuckoo Code —— 与 zhipu.js 功能对齐
 *
 * ===== 真机实证（mimo.log 2026-10-02，已跑通并据此精修）=====
 * 站点：纯 SPA + hash 路由（#/chat、#/chat/<32hex>），登录态在 cookie。
 *
 * 聊天端点（POST，同源）：
 *   /open-apis/bot/chat?xiaomichatbot_ph=...        ← 主用
 *   /fastchat/open-apis/bot/chat?...                ← 变体
 *
 * 真机帧结构（SSE，标准 id: 控制行 + data: JSON）：
 *   id:5dbd64202b4f2b4500dc72c8eb15e8e0        ← ⚠ 事件 ID 控制行，绝不可当正文
 *   data: {"type":"text","content":"<think>\u0000The user hasn't"}
 *   data: {"type":"text","content":" asked"}   ← 正文为增量；思考用 <think> 内联在正文流
 *   data: [DONE]
 *   首帧另有 {"code":0,"msg":"成功","data":{...conversationId...}} 的会话元信息帧。
 *
 * 会话列表端点（POST，同源）：
 *   /open-apis/chat/conversation/list
 *   → {"code":0,"msg":"成功","data":{"total":N,"pageNum":N,"dataList":[...]}}
 *     列表数组字段是 data.dataList（不是 list/items/conversations）
 *
 * 其它同前缀接口（**必须排除**，否则会被误判成聊天回合）：
 *   /open-apis/chat/conversation/save、/chat/conversation/genTitle、
 *   /chat/dialog/metrics/save、/fastchat/... 同名变体
 *
 * ===== 因上述实证而做出的三处关键修正 =====
 * 1) handleLine 显式识别并丢弃 SSE 控制行（id: / retry: / 注释 / event:），
 *    旧版把 `id:<sessionId>` 当正文拼接 —— 真机表现为正文被 sessionId 反复穿插。
 * 2) splitInlineThink：从正文流内联的 <think>…</think> 拆出思考，剔除 \u0000 填充，
 *    流式期间闭合标签未到也正确处理（未闭合则其后全部算思考）。
 * 3) urlLooksLikeChat 锁定实证端点 + 排除元数据接口，避免"路径含 chat"造成多余回合。
 *
 * ===== 通用能力（保留，用于站点改版或跨域接口）=====
 * hook 拦 fetch / XHR / WebSocket / EventSource 四条通道；判定为
 * "请求体像聊天" / "URL 像聊天" / "响应是流"（响应驱动兜底，不透明端点也能接管）；
 * 泛化字段链解析正文与思考；[mimo-net]/[mimo-body]/[frame#N] 全量诊断。
 * 页面归属门控：hook 在每个页面自注入，但只在 *.xiaomimimo.com 页面生效。
 *
 * 功能与 zhipu.js 对齐：
 * - harness 流式输出：dispatchStream(think, text, finished)，80ms 节流、finished 绕过节流
 * - 暂停：getStopFn() —— abort 在途请求 + 本地立即收尾（status='stopped'）
 * - 发送：triggerSend() 原生 Enter 优先，回退点击发送键
 * - 附件上传：getAttachProbeSource()（隐藏 file input 优先）+ 上传生命周期标记
 * - 对话列表：getSessionListFn()（接口缓存 → 重放原请求形态 → hash 锚点 → data 属性）
 * - 【渲染进程自注入】自定义 Provider 不在官方 hook 白名单内，本文件在 preload 环境
 *   自行用 webFrame.executeJavaScript 注入主世界（早于页面脚本），导入即用
 */
module.exports = {
  id: 'mimo',
  name: '小米 MiMo',
  homeUrl: 'https://aistudio.xiaomimimo.com/#/chat',
  sessionUrlBase: 'https://aistudio.xiaomimimo.com/#/chat',

  // 回复获取走网络拦截模式（必须）
  useIntercept: true,

  // 输入框选择器（findInput 自定义实现优先，此处作兜底）
  inputSelectors: ['textarea', '[contenteditable="true"]', 'div[role="textbox"]'],

  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找可见输入框：优先可见 textarea，其次 contenteditable / role=textbox
  findInput() {
    const cands = [];
    try { cands.push(...document.querySelectorAll('textarea')); } catch (_) { /* ignore */ }
    try { cands.push(...document.querySelectorAll('[contenteditable="true"], div[role="textbox"]')); } catch (_) { /* ignore */ }
    for (const el of cands) {
      if (el.offsetWidth > 0 && el.offsetHeight > 0 && !el.disabled) return el;
    }
    return null;
  },

  // 查找发送按钮：aria-label / title / 文本含"发送"，回退输入框附近的按钮
  findSendButton() {
    const sels = [
      'button[aria-label*="发送"]', 'button[aria-label*="send" i]',
      '[role="button"][aria-label*="发送"]', 'button[title*="发送"]',
    ];
    for (const sel of sels) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { el = null; }
      if (el && el.offsetWidth > 0) return el;
    }
    try {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const t = String(b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '');
        if (/发送|send/i.test(t) && b.offsetWidth > 0) return b;
      }
    } catch (_) { /* ignore */ }
    return null;
  },

  /**
   * 发送前向输入框追加一条工具格式提醒。
   * mimo 对会话级 system prompt 记忆很差，只有每轮发送都提醒才会遵守"禁止 XML invoke"。
   * 追加内容不进 harness 对话流（harness 气泡显示用户原始输入），只在 AI 网页输入框里可见。
   * 幂等：同一轮内已含 [系统提示] 则不重复追加；站点每次发送后清空输入框，不累积。
   */
  _appendReminder(input) {
    var REMINDER = '\n\n[系统提示] 调用工具只能使用 cuckoo 代码块（三个反引号 + cuckoo 围栏），禁止 XML invoke 或 JSON 格式，代码块外不要有任何文字。';
    try {
      if (!input) return;
      var tag = String(input.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        var cur = String(input.value || '');
        if (cur.indexOf('[系统提示]') !== -1) return;
        var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!desc || !desc.set) return;
        desc.set.call(input, cur + REMINDER);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
        var txt = String(input.innerText || input.textContent || '');
        if (txt.indexOf('[系统提示]') !== -1) return;
        input.focus();
        try {
          var sel = window.getSelection();
          var range = document.createRange();
          range.selectNodeContents(input);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (_) { /* ignore */ }
        var dt = new DataTransfer();
        dt.setData('text/plain', REMINDER);
        input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      }
    } catch (_) { /* 追加失败不阻断发送 */ }
  },

  /**
   * 发送触发：SPA 普遍免疫合成点击，优先经主进程注入原生 Enter（isTrusted=true），
   * 失败再回退点击发送按钮。
   */
  async triggerSend(input) {
    try { this._appendReminder(input); } catch (_) { /* 追加失败不阻断发送 */ }
    try {
      if (window.electronAPI && typeof window.electronAPI.sendEnterToChat === 'function') {
        await window.electronAPI.sendEnterToChat();
        console.log('[Cuckoo Code] MiMo：已请求原生 Enter 发送（sendInputEvent）');
        return true;
      }
    } catch (_) { /* 回退通用逻辑 */ }
    const btn = this.findSendButton();
    if (btn) {
      try { btn.click(); console.log('[Cuckoo Code] MiMo：已点击发送按钮'); return true; } catch (_) { /* ignore */ }
    }
    return false;
  },

  // 首页/聊天页判断（hash 路由，路径恒为 /）
  homeUrlPattern: /^https:\/\/aistudio\.xiaomimimo\.com\/?(#\/.*)?$/i,

  // 从 URL 提取会话 ID：hash 路由 #/chat/<id> 优先，其次查询参数
  extractSessionId(url) {
    if (!url) return null;
    const s = String(url);
    const m = s.match(/#\/(?:chat|conversation|c)\/([A-Za-z0-9_-]{6,})/i) ||
      s.match(/[?&](?:id|chatId|sessionId|session_id|conversationId)=([^&#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  },

  matchesUrl(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname;
      return /(^|\.)xiaomimimo\.com$/i.test(host);
    } catch (_) {
      return false;
    }
  },

  // ========== 侧栏「对话」列表 ==========
  /**
   * 优先用 hook 缓存的接口数据（__cuckooMimoSessions__），其次 hash 锚点
   * （#/chat/<id>），再退 data 属性；全空时 dump 线索供收敛。
   * 被序列化注入主世界执行，必须自包含。
   */
  getSessionListFn() {
    return function mimoSessionList(doc, win, base) {
      try {
        var out = [];
        var seen = {};
        var MAX = 100;
        // hash 路由会话 id：#/chat/<id>；兼容 query 形态
        var CID_RE = /#\/(?:chat|conversation|c)\/([A-Za-z0-9_-]{6,})|[?&#](?:id|chatId|sessionId|session_id|conversationId)=([A-Za-z0-9_-]{6,})/i;
        var curM = String((win.location && win.location.href) || '').match(CID_RE);
        var CURRENT = curM ? (curM[1] || curM[2]) : '';

        function titleOf(el) {
          var t = String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
          return t.slice(0, 80);
        }
        function isActive(el) {
          try {
            var cls = (typeof el.className === 'string') ? el.className : '';
            if (/active|selected|current|checked/i.test(cls)) return true;
            if (el.getAttribute && el.getAttribute('aria-current') === 'page') return true;
          } catch (e) { /* ignore */ }
          return false;
        }
        function push(cid, title, active, realHref) {
          if (!cid || !title) return;
          if (seen[cid]) return;
          seen[cid] = 1;
          out.push({
            title: title,
            href: realHref || ('https://aistudio.xiaomimimo.com/#/chat/' + cid),
            active: !!active || (String(cid) === CURRENT),
          });
        }
        var lastDiagAt = 0;
        function diag() {
          var now = Date.now();
          if (now - lastDiagAt < 30000) return;
          lastDiagAt = now;
          try {
            var anchors = doc.querySelectorAll('a[href]');
            var sample = [];
            for (var i = 0; i < anchors.length && sample.length < 20; i++) {
              var h = String(anchors[i].href || '');
              if (!h) continue;
              sample.push('A:' + h.replace(/[A-Za-z0-9_-]{20,}/g, '<ID>').slice(0, 100) + '|' + titleOf(anchors[i]).slice(0, 18));
            }
            var boxes = doc.querySelectorAll('aside,nav,[class*="sidebar"],[class*="sider"],[class*="history"],[class*="conversation"],[class*="session"],[class*="list"]');
            var box = '';
            for (var k = 0; k < boxes.length && box.length < 1200; k++) {
              var h2 = String(boxes[k].outerHTML || '').replace(/\s+/g, ' ');
              if (h2) box += '[c' + k + '] ' + h2.slice(0, 600) + ' || ';
            }
            console.log('[mimo-sessions] 未抓到会话 | anchors=' + anchors.length + ' containers=' + boxes.length +
              ' apiCache=' + (!!win.__cuckooMimoSessions__));
            if (sample.length) console.log('[mimo-sessions][anchors] ' + sample.join(' || '));
            if (box) console.log('[mimo-sessions][dom] ' + box.slice(0, 1500));
          } catch (e) { /* ignore */ }
        }
        function done() {
          if (!out.length) diag();
          return out.slice(0, MAX);
        }

        var cache = win.__cuckooMimoSessions__;

        // ---- 策略 -1（主动重放）：沿用原方法重放已捕获的列表端点 ----
        // 必须沿用原 HTTP 方法（zhipu 实测端点是 POST-only，用 GET 重放必然失败）。
        // 本函数被序列化注入，不能引用闭包外函数，故解析内联自足。
        var req = win.__cuckooMimoListReq__;
        var replayUrl = (req && req.url) || win.__cuckooMimoListUrl__;
        var replayMethod = (req && req.method) || 'POST';
        var replayBody = (req && req.body) || '';
        // 实机日志（mimo.log）：站点列表请求带 pageNum=2，响应为
        // {"total":1,"pageNum":2,"dataList":[]} —— 有总数却拿到空列表。
        // 重放时把分页参数归一到首页，否则缓存永远是空的。
        try {
          if (replayUrl) {
            var U = win.URL || URL;
            var u2 = new U(replayUrl);
            var pageKeys = ['pageNum', 'page', 'pageNo', 'pageIndex', 'current'];
            for (var pi = 0; pi < pageKeys.length; pi++) {
              if (u2.searchParams.has(pageKeys[pi])) u2.searchParams.set(pageKeys[pi], '1');
            }
            var offKeys = ['offset', 'start', 'from', 'skip'];
            for (var oi = 0; oi < offKeys.length; oi++) {
              if (u2.searchParams.has(offKeys[oi])) u2.searchParams.set(offKeys[oi], '0');
            }
            replayUrl = u2.toString();
          }
        } catch (e) { /* 归一失败则用原 URL */ }
        if (!cache && replayUrl && !win.__cuckooMimoReplaying__) {
          win.__cuckooMimoReplaying__ = true;
          try {
            var init = { credentials: 'include', method: replayMethod };
            if (replayBody && replayMethod !== 'GET') {
              init.headers = { 'Content-Type': 'application/json' };
              init.body = replayBody;
            }
            win.fetch(replayUrl, init).then(function (resp) {
              try { return resp.text(); } catch (e) { return ''; }
            }).then(function (txt) {
              win.__cuckooMimoReplaying__ = false;
              if (!txt) return;
              try {
                var data = JSON.parse(txt);
                var arr = null;
                (function walk(d, depth) {
                  if (!d || depth > 3 || arr) return;
                  if (Array.isArray(d)) { arr = d; return; }
                  if (Array.isArray(d.dataList)) { arr = d.dataList; return; }   // 实机字段名
                  if (Array.isArray(d.list)) { arr = d.list; return; }
                  if (Array.isArray(d.items)) { arr = d.items; return; }
                  if (Array.isArray(d.conversations)) { arr = d.conversations; return; }
                  if (Array.isArray(d.sessions)) { arr = d.sessions; return; }
                  if (Array.isArray(d.chats)) { arr = d.chats; return; }
                  if (Array.isArray(d.result)) { arr = d.result; return; }
                  if (d.data) walk(d.data, depth + 1);
                  if (d.result && typeof d.result === 'object') walk(d.result, depth + 1);
                })(data, 0);
                if (!arr) return;
                var list = [];
                for (var i = 0; i < arr.length; i++) {
                  var it = arr[i] || {};
                  // 与会话缓存同一优先级：conversationId（32位hex，路由用）优先于 id（数据库主键）
                  var cid = '';
                  var cidCands = [it.conversationId, it.conversation_id, it.sessionId, it.session_id,
                    it.chatId, it.chat_id, it.sessionKey, it.uuid, it.id];
                  for (var ci = 0; ci < cidCands.length; ci++) {
                    var cv = cidCands[ci];
                    if (cv === undefined || cv === null || cv === '') continue;
                    var sv = String(cv);
                    if (/^[0-9a-f]{16,}$/i.test(sv)) { cid = sv; break; }
                    if (!cid) cid = sv;
                  }
                  var title = it.title || it.name || it.summary || it.subject || '';
                  if (!cid || !title) continue;
                  list.push({ cid: String(cid), title: String(title).slice(0, 80) });
                }
                if (list.length) win.__cuckooMimoSessions__ = { at: Date.now(), key: 'replay', list: list };
              } catch (e) { /* ignore */ }
            }).catch(function () { win.__cuckooMimoReplaying__ = false; });
          } catch (e) { win.__cuckooMimoReplaying__ = false; }
        }

        // ---- 策略 0：接口缓存 ----
        if (cache && Array.isArray(cache.list) && cache.list.length) {
          for (var s = 0; s < cache.list.length && out.length < MAX; s++) {
            push(cache.list[s].cid, cache.list[s].title, false);
          }
          if (out.length) {
            console.log('[mimo-sessions] 来自接口缓存: ' + out.length + ' 条');
            return done();
          }
        }

        // ---- 策略 1：hash 锚点（#/chat/<id>）----
        var anchors = doc.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length && out.length < MAX; i++) {
          var a = anchors[i];
          var href = a.href || (a.getAttribute && a.getAttribute('href')) || '';
          if (!href) continue;
          var m = String(href).match(CID_RE);
          if (!m) continue;
          var cid = m[1] || m[2];
          if (!cid) continue;
          push(cid, titleOf(a), isActive(a), href);
        }
        if (out.length) return done();

        // ---- 策略 2：data 属性带会话 id ----
        var attrEls = doc.querySelectorAll('[data-id],[data-chat-id],[data-conversation-id],[data-session-id],[data-key]');
        for (var j = 0; j < attrEls.length && out.length < MAX; j++) {
          var el = attrEls[j];
          var attrs = el.attributes || [];
          for (var q = 0; q < attrs.length; q++) {
            var v = String(attrs[q].value || '');
            var mv = v.match(CID_RE) || (/^[A-Za-z0-9_-]{8,}$/.test(v) && /id/i.test(attrs[q].name) ? [null, v] : null);
            if (mv && (mv[1] || mv[2])) { push(mv[1] || mv[2], titleOf(el), isActive(el)); break; }
          }
        }
        return done();
      } catch (e) { return []; }
    };
  },

  // ========== harness「暂停」：停止生成 ==========
  /**
   * 与 zhipu 同构：先 abort 在途请求（真正掐断流），再本地收尾（界面立即停住）。
   * 不做 DOM 点击——SPA 的停止键结构未知，且本地中止已能立刻停住界面。
   * 必须自包含。
   */
  getStopFn() {
    return function mimoStopLocator(doc, win) {
      var out = { found: false, cands: [], aborted: 0, streaming: false, api: 'none' };
      try {
        out.streaming = !!win.__cuckooMimoStreaming__;

        // ① 先标记（只标记不停手）：确保接下来无论谁触发收尾，都记为 stopped
        try {
          if (typeof win.__cuckooMimoMarkStop__ === 'function') out.cands.push('mark=' + win.__cuckooMimoMarkStop__());
        } catch (e) { /* ignore */ }

        // ② 点站点自己的停止键 —— 这是关键。
        // bundle 实证站点 stopGen 实现：
        //   abortController.abort();
        //   setConversation(t, { abortController:null, showStoppedHint:true })
        // 即"停手 + 清理自身状态（按钮复位、显示已停止本次回答）"。
        // 只 abort 网络不走这段清理，站点界面会一直显示生成中。
        // 停止键文案取自站点 i18n：chat.message.stop_generation = "停止生成"。
        var STOP_EXACT = /^(停止生成|停止|Stop)$/i;
        var STOP_LOOSE = /停止生成|停止|stop\s*generating/i;
        var best = null;
        try {
          var all = doc.querySelectorAll('button,[role="button"],div,span,a');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var txt = (el.textContent || '').trim();
            var aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
            if (!txt && !aria) continue;
            if (!STOP_LOOSE.test(txt + ' ' + aria)) continue;
            var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r || r.width === 0 || r.height === 0) continue;
            // 取面积最小的匹配元素：叶子节点才是按钮本体，避免点到整条工具条
            var area = r.width * r.height;
            if (!best || area < best.area) {
              best = { el: el, area: area, r: r, sig: (txt || aria).slice(0, 40), exact: STOP_EXACT.test(txt) };
            }
          }
        } catch (e) { /* ignore */ }

        if (best) {
          out.found = true;
          out.cands.push('stop-btn:' + best.sig + '@' + Math.round(best.r.left + best.r.width / 2) + ',' + Math.round(best.r.top + best.r.height / 2));
          try {
            best.el.click();
            out.api = 'clicked-site-stop';
            console.log('[mimo-stop] 已点击站点停止键: ' + best.sig);
          } catch (e) { out.api = 'click-error:' + (e && e.message); }
        }

        // ③ 兜底：没找到停止键（或点击无效）时，abort 在途请求
        try {
          if (typeof win.__cuckooMimoAbortFetch__ === 'function') {
            var n = win.__cuckooMimoAbortFetch__();
            out.cands.push('abortFetch=' + n);
            if (out.api === 'none') out.api = 'aborted-' + n;
          }
        } catch (e) { if (out.api === 'none') out.api = 'error:' + (e && e.message); }

        // ④ 本地收尾：派发 stopped，让 harness 立刻收尾回合
        try {
          if (typeof win.__cuckooMimoAbort__ === 'function') out.aborted = win.__cuckooMimoAbort__();
        } catch (e) { /* ignore */ }

        console.log('[mimo-stop] streaming=' + out.streaming + ' api=' + out.api +
          ' 停止键=' + (best ? '命中' : '未命中') + ' 本地中止=' + out.aborted);
        return out;
      } catch (e) {
        return { found: false, error: String(e && e.message) };
      }
    };
  },

  // ========== harness 附件上传：上传入口探测 ==========
  /**
   * 返回探测函数源码（核心 CDP 通道按 (src)(document, window, fileInfo) 注入）。
   * 隐藏 input[type=file] 优先（CDP 可直接命中），否则按关键词/图标/位置打分。
   * 候选与输入区元素清单打日志，便于按真实 DOM 收敛。必须自包含。
   */
  getAttachProbeSource() {
    return '(' + function mimoAttachProbe(doc, win, fileInfo) {
      try {
        var vh = win.innerHeight || 800;
        var vw = win.innerWidth || 1200;
        var KEY = /(attach|upload|paperclip|file|image|图片|文件|上传|附件|相册|加号)/i;
        var picked = [];
        var all = [];

        function visible(el) {
          try {
            var r = el.getBoundingClientRect();
            if (!r || r.width === 0 || r.height === 0) return null;
            if (r.left < 0 || r.top < 0 || r.left > vw || r.top > vh) return null;
            return r;
          } catch (e) { return null; }
        }
        function own(el) {
          try { return !!(el.closest && el.closest('[class*="cuckoo-"]')); } catch (e) { return false; }
        }
        // 多轮探测策略（主进程最多探测 3 轮）：
        //   第 1 轮 → 隐藏 file input 直接注入（最确定，无需菜单）
        //   失败后 → 官方上传键 data-track-id="file_bar_upload_btn"（走站点自身流程）
        //   再失败 → 关键词启发式
        // 没有这个切换的话，每轮都会返回同一目标 —— 单条路径失败就空转满 3 轮。
        var triedInput = false;
        try { triedInput = !!win.__cuckooAttachTriedInput__; } catch (e) { /* ignore */ }

        // 隐藏 file input：优先返回（CDP 能直接对它注入，不要求可见）。
        // 实机证据（站点 bundle 原文）：上传组件渲染的就是
        //   jsx("input", { type:"file", accept:a, style:{...s, display:"none"} })
        // 注意它的 getBoundingClientRect() 是 0,0 —— 坐标没有意义，
        // 故打上标记并置 isFileInput，让主进程跳过点击、直接按标记注入。
        try {
          var fi = !triedInput && doc.querySelector('input[type=file]');
          if (fi) {
            try { win.__cuckooAttachTriedInput__ = true; } catch (e) { /* ignore */ }
            try { fi.setAttribute('data-cuckoo-attach-input', '1'); } catch (e) { /* ignore */ }
            var fr = fi.getBoundingClientRect ? fi.getBoundingClientRect() : null;
            // 顺带给出可见触发器的坐标（若存在），作为主进程回退点击时的目标
            var trig = null;
            var p = fi.parentElement;
            for (var d = 0; d < 6 && p; d++) {
              var pr = (p.getBoundingClientRect ? p.getBoundingClientRect() : null);
              if (pr && pr.width > 0 && pr.height > 0 && pr.width <= 160 && pr.height <= 80) { trig = pr; break; }
              p = p.parentElement;
            }
            var tx = trig ? Math.round(trig.left + trig.width / 2) : (fr ? Math.round(fr.left + fr.width / 2) : 0);
            var ty = trig ? Math.round(trig.top + trig.height / 2) : (fr ? Math.round(fr.top + fr.height / 2) : 0);
            console.log('[mimo-attach] 命中隐藏 file input (触发器坐标 ' + tx + ',' + ty + ')');
            return { found: true, x: tx, y: ty, isFileInput: true, tag: trig ? 'file-input-trigger' : 'input[type=file]' };
          }
        } catch (e) { /* ignore */ }

        // 站点自有标记（bundle 实证，最可靠的选择器）：
        //   data-track-id="file_bar_upload_btn"  —— 输入区附件/上传键
        // 站点广泛用 data-track-id 标记按钮（msg_copy_btn / msg_edit_btn 等同批），
        // 这是官方埋点属性，比类名（Tailwind 语义类）和坐标启发式都稳。
        try {
          var btn = doc.querySelector('[data-track-id="file_bar_upload_btn"]');
          if (btn) {
            var br = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
            if (br && br.width > 0 && br.height > 0) {
              var bx = Math.round(br.left + br.width / 2);
              var by = Math.round(br.top + br.height / 2);
              console.log('[mimo-attach] 命中 file_bar_upload_btn @' + bx + ',' + by);
              return { found: true, x: bx, y: by, tag: 'file_bar_upload_btn', round2: triedInput };
            }
          }
        } catch (e) { /* ignore */ }

        var cands = doc.querySelectorAll('button,[role="button"],span,div,i,svg,label');
        for (var i = 0; i < cands.length; i++) {
          var el = cands[i];
          if (own(el)) continue;
          var r = visible(el);
          if (!r) continue;
          if (r.top < vh * 0.55) continue;
          if (r.width > 90 || r.height > 90) continue;
          var cls = (typeof el.className === 'string') ? el.className : '';
          if (/cuckoo/i.test(cls)) continue;
          var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
          var title = (el.getAttribute && el.getAttribute('title')) || '';
          var sig = cls + ' ' + aria + ' ' + title;
          var cx = Math.round(r.left + r.width / 2);
          var cy = Math.round(r.top + r.height / 2);
          all.push(cx + ',' + cy + ' ' + el.tagName + '.' + cls.slice(0, 34) + '|' + aria.slice(0, 16));
          var score = 0;
          if (KEY.test(sig)) score += 100;
          if (/icon|btn|tool|operate|action|item/i.test(cls)) score += 10;
          try { if (el.querySelector && el.querySelector('svg,i,img')) score += 8; } catch (e) { /* ignore */ }
          if (r.left < vw * 0.5) score += 10;
          if (r.top > vh * 0.8) score += 6;
          if (/send|submit|发送/i.test(sig)) score -= 60;
          if (score > 0) picked.push({ score: score, x: cx, y: cy, sig: (el.tagName + '.' + cls).slice(0, 50) });
        }
        picked.sort(function (a, b) { return b.score - a.score; });
        console.log('[mimo-attach] 候选(前10): ' + picked.slice(0, 10).map(function (p) {
          return p.score + '@' + p.x + ',' + p.y + ' ' + p.sig;
        }).join(' || '));
        console.log('[mimo-attach] 输入区元素(前20): ' + all.slice(0, 20).join(' || '));
        if (!picked.length) return { found: false, reason: 'no-candidate' };
        return {
          found: true, x: picked[0].x, y: picked[0].y, tag: picked[0].sig,
          candidates: picked.slice(0, 6).map(function (p) { return p.score + ':' + p.sig; }),
        };
      } catch (e) {
        return { found: false, reason: 'error:' + (e && e.message) };
      }
    }.toString() + ')';
  },

  // ========== 网络拦截模式：主世界注入 hook（探测优先） ==========
  /**
   * 探测优先的拦截器：不写死聊天端点，而是拦截 fetch / XHR / WebSocket，
   * 自行判定"聊天请求"并按泛化字段链解析增量。所有接口记入 [mimo-net] 日志。
   * 必须自包含：只用浏览器全局。
   */
  getHookSource() {
    return '(' + function mimoHookInstaller() {
      var MARKER = '__cuckooMimoHookInstalled__';
      if (window[MARKER]) return;

      // ---------- 页面归属门控（最关键的一道闸）----------
      // 各自定义 provider 的 hook 会在**每个页面**自注入（preload require 时执行），
      // 因此必须按"当前页面是谁"决定是否生效：
      //   - 在别站页面（如 chatglm.cn / qianwen.com）完全停用，绝不接管别站流量；
      //   - 在本站页面则全量启用，且**不按请求域名过滤** —— AI Studio 的聊天接口
      //     可能位于其它域名，按请求域名过滤会漏检真实聊天流。
      // 实机证据（zhipu.log 2026-10-02）：旧版 mimo hook 曾在 chatglm.cn 页面上打印
      // 「[mimo-hook] [frame#1] {"conversation_id":...}」并接管其 assistant/stream 请求，
      // 导致同一回合重复派发。
      try {
        var pageHost = String((window.location && window.location.hostname) || '');
        if (!/(^|\.)xiaomimimo\.com$/i.test(pageHost)) {
          console.log('[mimo-hook] 非本站页面（' + pageHost + '），跳过注入');
          return;
        }
      } catch (e) { return; }
      window[MARKER] = true;   // 门控通过后才置位：非本站页面视为"未安装"

      function log() {
        try {
          var a = Array.prototype.slice.call(arguments);
          a.unshift('[mimo-hook]');
          console.log.apply(console, a);
        } catch (e) { /* ignore */ }
      }

      // ---------- 派发 ----------
      var lastStreamAt = 0;
      function dispatchStream(think, text, finished) {
        var now = Date.now();
        // finished 必须绕过节流，否则末帧被吞 → 思考块停在"思考中…"、流式光标不消失
        if (!finished && now - lastStreamAt < 80) return;
        lastStreamAt = now;
        try {
          window.dispatchEvent(new CustomEvent('cuckoo-ai-stream', {
            detail: { think: think || '', text: text || '', finished: !!finished },
          }));
        } catch (e) { /* ignore */ }
      }
      function dispatch(text, status) {
        try {
          window.dispatchEvent(new CustomEvent('cuckoo-ai-response', {
            detail: {
              text: text || '',
              finished: true,
              status: status || 'finished',
              tokenUsage: null,
            },
          }));
        } catch (e) { /* ignore */ }
      }

      // ---------- 在途回合登记（暂停用） ----------
      var ACTIVE = [];
      function trackState(st) {
        ACTIVE.push(st);
        try { window.__cuckooMimoStreaming__ = true; } catch (e) { /* ignore */ }
        return st;
      }
      function untrackState(st) {
        var i = ACTIVE.indexOf(st);
        if (i >= 0) ACTIVE.splice(i, 1);
        if (!ACTIVE.length) { try { window.__cuckooMimoStreaming__ = false; } catch (e) { /* ignore */ } }
      }
      function finishTurn(st) {
        if (!st || st.dispatched) return;
        st.dispatched = true;
        untrackState(st);
        var hasContent = !!(st.text && st.text.length) || !!(st.think && st.think.length);
        // 响应驱动（strictJson）的流可能只是无关 SSE：没解析出内容就整轮丢弃，
        // 不派发任何事件，避免污染对话（实机教训：心跳流只有 [DONE] 时曾派发空正文）。
        if (st.strictJson && !hasContent) {
          log('响应驱动的流无内容，忽略（非聊天流）');
          return;
        }
        log('回合' + (st.aborted ? '中止' : '结束') + '：正文=' + (st.text || '').length + ' 思考=' + (st.think || '').length);
        // 先补 finished 流帧（绕过节流）：harness 据此收尾思考块与流式光标
        dispatchStream(st.think, st.text, true);
        // 请求驱动（已确认为聊天）时空正文也要收尾，否则 harness 一直停在生成态
        if (hasContent || !st.strictJson) {
          dispatch(st.text, st.aborted ? 'stopped' : 'finished');
        }
      }
      var inflightCtl = [];
      try {
        // 只标记不停手：供 getStopFn 在"点击站点停止键"之前调用。
        // 顺序至关重要——若先 abort 网络，站点会立刻重渲染把停止键移除，
        // 我们就没机会走站点自己的清理（showStoppedHint / abortController 置空）；
        // 而且流被中断时若尚未标记，收尾会误报成 finished，
        // 使 observer 去解析半截正文（可能执行被截断的工具调用）。
        window.__cuckooMimoMarkStop__ = function () {
          var n = 0;
          for (var i = 0; i < ACTIVE.length; i++) {
            ACTIVE[i].aborted = true;
            n++;
          }
          log('已标记停止：' + n + ' 个在途回合');
          return n;
        };
        window.__cuckooMimoAbort__ = function () {
          var n = 0;
          var copy = ACTIVE.slice();
          for (var i = 0; i < copy.length; i++) {
            copy[i].aborted = true;
            finishTurn(copy[i]);
            n++;
          }
          log('本地中止：已收尾 ' + n + ' 个在途回合');
          return n;
        };
        window.__cuckooMimoAbortFetch__ = function () {
          var n = 0;
          var copy = inflightCtl.slice();
          for (var i = 0; i < copy.length; i++) {
            try { copy[i].abort(); n++; } catch (e) { /* ignore */ }
          }
          inflightCtl = [];
          log('已 abort 在途请求 ' + n + ' 个');
          return n;
        };
      } catch (e) { /* ignore */ }

      // ---------- 网络记录器（诊断：发现聊天/列表/上传端点） ----------
      var netSeen = {};
      function logNet(method, url, status, extra) {
        try {
          var u = new URL(url, document.baseURI);
          if (!/(^|\.)xiaomimimo\.com$/i.test(u.hostname)) return;
          var key = String(method || 'GET').toUpperCase() + ' ' + u.pathname + ' -> ' + status + (extra ? ' ' + extra : '');
          if (netSeen[key]) return;
          if (Object.keys(netSeen).length > 80) return;
          netSeen[key] = 1;
          console.log('[mimo-net] ' + key);
        } catch (e) { /* ignore */ }
      }
      // 取响应内容类型（首跑时一眼看出哪个端点是流）
      function ctOf(resp) {
        try { return String((resp && resp.headers && resp.headers.get && resp.headers.get('content-type')) || '').slice(0, 60); } catch (e) { return ''; }
      }

      // ---------- 发现型诊断：每个接口首次出现的请求体片段 ----------
      // 站点端点未知，若判定启发式漏掉真实聊天请求，这里仍会把请求体写进日志，
      // 供据实收敛（千问正是靠 [qianwen-net] 日志暴露了真实端点）。
      var bodySeen = {};
      var bodyLoggedCount = 0;
      var bodyBigLoggedCount = 0;
      var NOISE_RE = /(track|report|log|analytic|stat|metric|beacon|telemetry|ping|heartbeat|feedback|config|version|poll)/i;
      function logBodyOnce(method, url, body) {
        try {
          var u = new URL(url, document.baseURI);
          if (!/(^|\.)xiaomimimo\.com$/i.test(u.hostname)) return;
          var key = String(method || 'GET').toUpperCase() + ' ' + u.pathname;
          if (bodySeen[key]) return;
          var s = '';
          try { s = (typeof body === 'string') ? body : String(body || ''); } catch (e) { s = ''; }
          // 大请求体（聊天请求必然很大）不受常规上限约束：
          // 富 SPA 在聊天前可能已刷满 25 条噪声端点，把关键请求挤掉就白跑一趟。
          var isBig = s.length > 300;
          var noisy = NOISE_RE.test(u.pathname);
          if (isBig) {
            if (bodyBigLoggedCount >= 12) return;
            bodyBigLoggedCount++;
          } else {
            if (noisy) return;                       // 噪声端点直接不记
            if (bodyLoggedCount >= 25) return;
            bodyLoggedCount++;
          }
          bodySeen[key] = 1;
          console.log('[mimo-body]' + (isBig ? '[大]' : '') + ' ' + key + ' :: ' + s.slice(0, 300));
        } catch (e) { /* ignore */ }
      }

      // ---------- 附件上传生命周期（供 CDP 通道判断"附件就绪再发送"） ----------
      function isUploadUrl(url) {
        try {
          var u = new URL(url, document.baseURI);
          return /(^|\.)xiaomimimo\.com$/i.test(u.hostname) && /upload|attach|file|oss/i.test(u.pathname);
        } catch (e) { return /upload/i.test(String(url)); }
      }
      function markUpload(state, status) {
        try {
          window.__cuckooMimoUpload__ = { at: Date.now(), state: state, status: (status == null ? null : status) };
          log('[mimo-upload] ' + state + (status == null ? '' : ' -> ' + status));
        } catch (e) { /* ignore */ }
      }

      // ---------- 会话列表接口探针 ----------
      // 判定改为"顺序无关"：路径同时含会话词与列表词即视为列表接口。
      // 教训来自千问实测：其列表端点是 /api/v2/session/page/list —— 中间夹了 page，
      // 原先要求 session 紧邻 list 的正则整条漏掉（日志实证「发现列表接口: 0 条」）。
      var SESSION_WORD_RE = /(session|conversation|chat|history)/i;
      var LIST_WORD_RE = /(list|history|recent|records|page)/i;
      var CHAT_PATH_RE = /(\/chat|\/completion|\/generate|\/infer|\/stream)/i;
      function isListUrl(u) {
        try {
          var path = u.pathname || '';
          if (!SESSION_WORD_RE.test(path)) return false;
          if (!LIST_WORD_RE.test(path)) return false;
          // 排除聊天流本身（/api/v1/chat、/api/v2/chat 等）
          if (/\/(chat|completion|generate|infer)$/i.test(path)) return false;
          return true;
        } catch (e) { return false; }
      }
      var seenListUrls = {};
      var dumpedList = {};
      // 记录列表请求的完整形态（URL + 方法 + 请求体）：重放时必须沿用原方法，
      // 否则对 POST-only 端点用 GET 重放必然失败（zhipu 实测端点即 POST）。
      function tapListApi(url, method, body) {
        try {
          var u = new URL(url, document.baseURI);
          if (!/(^|\.)xiaomimimo\.com$/i.test(u.hostname)) return null;
          if (!isListUrl(u)) return null;
          try {
            var bodyStr = '';
            try { bodyStr = (typeof body === 'string') ? body : (body ? String(body) : ''); } catch (e) { bodyStr = ''; }
            window.__cuckooMimoListReq__ = { url: u.href, method: String(method || 'POST').toUpperCase(), body: bodyStr.slice(0, 2000) };
            window.__cuckooMimoListUrl__ = u.href;   // 兼容旧字段
          } catch (e) { /* ignore */ }
          var key = u.pathname;
          if (seenListUrls[key]) return key;
          seenListUrls[key] = 1;
          console.log('[mimo-sessions] 发现列表接口: ' + u.pathname);
          return key;
        } catch (e) { return null; }
      }
      function findListArray(data, depth) {
        if (!data || depth > 3) return null;
        if (Array.isArray(data)) return data;
        // 实机实证字段名（mimo.log 2026-10-02）：
        //   POST /open-apis/chat/conversation/list
        //   {"code":0,"msg":"成功","data":{"total":1,"pageNum":2,"dataList":[...]}}
        // 列表数组在 data.dataList —— 旧版找 list/items/conversations 全部落空，
        // 日志实证「响应结构未识别」。
        if (Array.isArray(data.dataList)) return data.dataList;
        if (Array.isArray(data.list)) return data.list;
        if (Array.isArray(data.items)) return data.items;
        if (Array.isArray(data.conversations)) return data.conversations;
        if (Array.isArray(data.sessions)) return data.sessions;
        if (Array.isArray(data.chats)) return data.chats;
        if (Array.isArray(data.result)) return data.result;
        if (data.data) return findListArray(data.data, depth + 1);
        if (data.result && typeof data.result === 'object') return findListArray(data.result, depth + 1);
        return null;
      }
      function rememberListJson(key, text) {
        try {
          var data = JSON.parse(text);
          var arr = findListArray(data, 0);
          if (!Array.isArray(arr)) {
            if (!dumpedList[key]) {
              dumpedList[key] = 1;
              console.log('[mimo-sessions][' + key + '] 响应结构未识别: ' + String(text).slice(0, 1200));
            }
            return;
          }
          var list = [];
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i] || {};
            // 会话 id 取值（实机实证，务必按此优先级）：
            // 真机列表项同时带 {"id":8490398,"conversationId":"7f74640fff392adf2e374640a79e336d"}；
            // 前者是数据库主键，后者才是路由用的会话 hash —— 截图地址栏证实
            // 会话 URL 形如 #/chat/<32位 hex>。旧版把 it.id 排在最前，
            // 会取到 8490398，点会话跳到错误地址。
            var cid = '';
            var cidCands = [it.conversationId, it.conversation_id, it.sessionId, it.session_id,
              it.chatId, it.chat_id, it.sessionKey, it.uuid, it.id];
            for (var ci = 0; ci < cidCands.length; ci++) {
              var cv = cidCands[ci];
              if (cv === undefined || cv === null || cv === '') continue;
              var sv = String(cv);
              if (/^[0-9a-f]{16,}$/i.test(sv)) { cid = sv; break; }   // 形如会话 hash，最可信
              if (!cid) cid = sv;                                     // 兜底：第一个非空值
            }
            var title = it.title || it.name || it.summary || it.subject || '';
            if (!cid || !title) continue;
            list.push({ cid: String(cid), title: String(title).slice(0, 80) });
          }
          if (!list.length) {
            if (!dumpedList[key]) {
              dumpedList[key] = 1;
              console.log('[mimo-sessions][' + key + '] 数组 ' + arr.length + ' 项但无可识别字段, 首项: ' + JSON.stringify(arr[0] || {}).slice(0, 600));
            }
            return;
          }
          window.__cuckooMimoSessions__ = { at: Date.now(), key: key, list: list };
          console.log('[mimo-sessions] 列表已缓存: ' + list.length + ' 条 (key=' + key + ')');
        } catch (e) { /* ignore */ }
      }

      // ---------- 泛化解析：正文 / 思考 ----------
      // 站点帧结构未知，按常见字段链逐层探测（越靠前越优先）
      function pickString(obj, keys) {
        if (!obj || typeof obj !== 'object') return '';
        for (var i = 0; i < keys.length; i++) {
          var v = obj[keys[i]];
          if (typeof v === 'string' && v) return v;
        }
        return '';
      }
      function pickText(obj) {
        if (!obj || typeof obj !== 'object') return '';
        // ---- 真机型：按 type 分类 ----
        // 实机帧：{"type":"text","content":"..."} 是正文；
        // 无 type 的 {"content":"14764498"} 是消息 ID 帧，旧版把它的 content 当正文拼接。
        // 采用**黑名单**而非白名单：站点若改版出 type:"markdown" 之类新类型，
        // 白名单会整条丢弃（丢内容比多显示更糟），黑名单只拒明确的非内容类型。
        var type = String(obj.type || obj.event || '').toLowerCase();
        var NON_CONTENT = /^(think|thinking|reasoning|search|tool|tool_call|tool_calls|function|finish|finished|done|end|stop|error|status|meta|metadata|usage|ref|reference|suggest|title|id|ping|heartbeat|delta)$/;
        if (type && NON_CONTENT.test(type)) return '';
        var direct = pickString(obj, ['text', 'content', 'answer', 'output', 'value', 'message', 'delta']);
        if (direct) {
          // 无 type 的纯数字短串按元数据（消息 ID）丢弃
          if (!type && /^\d{4,20}$/.test(direct.trim())) return '';
          return direct;
        }
        if (obj.choices && obj.choices[0]) {
          var c = obj.choices[0];
          if (c.delta) {
            var d = pickString(c.delta, ['content', 'text']);
            if (d) return d;
          }
          var m = pickString(c, ['text', 'content']);
          if (m) return m;
        }
        if (obj.data) {
          if (typeof obj.data === 'string') return obj.data;
          var dd = pickString(obj.data, ['text', 'content', 'answer', 'output', 'delta']);
          if (dd) return dd;
          if (Array.isArray(obj.data.messages)) {
            for (var i = obj.data.messages.length - 1; i >= 0; i--) {
              var msg = obj.data.messages[i];
              var mc = msg && pickString(msg, ['content', 'text']);
              if (mc) return mc;
            }
          }
        }
        if (obj.result) {
          var r = pickString(obj.result, ['text', 'content', 'answer', 'output']);
          if (r) return r;
        }
        return '';
      }
      function pickThink(obj) {
        if (!obj || typeof obj !== 'object') return '';
        var paths = [obj.reasoning_content, obj.reasoning, obj.thinking_content, obj.think, obj.think_text];
        if (obj.choices && obj.choices[0] && obj.choices[0].delta) {
          paths.push(obj.choices[0].delta.reasoning_content, obj.choices[0].delta.reasoning);
        }
        if (obj.data && typeof obj.data === 'object') {
          paths.push(obj.data.reasoning_content, obj.data.reasoning, obj.data.think, obj.data.thinking_content);
        }
        for (var i = 0; i < paths.length; i++) {
          if (typeof paths[i] === 'string' && paths[i]) return paths[i];
        }
        return '';
      }
      // 增量合并：兼容"增量帧"与"全量帧"
      function smartAppend(prev, frag) {
        if (!frag) return prev || '';
        if (!prev) return frag;
        if (frag === prev) return prev;
        // 全量帧：更长且以旧内容开头
        if (frag.length > prev.length && frag.indexOf(prev) === 0) return frag;
        // 重复片段：忽略
        var n = frag.length;
        if (n && prev.slice(-n) === frag) return prev;
        return prev + frag;
      }

      /**
       * 内联思考标签拆分（实机实证）。
       * 真机帧：{"type":"text","content":"<think>\u0000The user hasn't"} / {"content":" asked"} …
       * 模型把思考直接写在正文流里，用 <think>…</think> 包裹；harness 需要思考与正文分离。
       * 流式期间闭合标签可能尚未到达 —— 此时 <think> 之后全部算思考，正文暂空。
       * 对"累积全文"反复调用是幂等的（每一步都基于完整累积重新拆分）。
       */
      function splitInlineThink(raw) {
        var out = { think: '', text: raw || '' };
        if (!raw) return out;
        var s = String(raw);
        // 兼容 <think> /  thinking / <thinking> 与其中的 \u0000 填充
        var re = /<(think|thinking|reasoning)>([\s\S]*?)(?:<\/(?:think|thinking|reasoning)>|$)/i;
        var m = s.match(re);
        if (!m) return out;
        out.think = String(m[2] || '').replace(/\u0000/g, '');
        out.text = s.replace(re, '');
        // 双侧可能的残留标签与填充字符
        out.text = out.text.replace(/<\/?(?:think|thinking|reasoning)>/gi, '').replace(/\u0000/g, '');
        out.think = out.think.replace(/<\/?(?:think|thinking|reasoning)>/gi, '');
        return out;
      }

      // ---------- 站点归属判定（至关重要）----------
      // 三个自定义 provider 的 hook 会在同一页面共存（各自在 preload 自注入）。
      // 若不校验域名，本 hook 的"请求体像聊天"判定会把**其它站点**（如智谱/千问）
      // 的聊天流也接管，造成同一回合重复派发。
      // 实机证据（zhipu.log 2026-10-02）：mimo hook 曾在 chatglm.cn 页面上打印
      // 「[mimo-hook] [frame#1] {"conversation_id":...}」并接管其 assistant/stream 请求。
      function isOwnSite(url) {
        try {
          var u = new URL(url, document.baseURI);
          return /(^|\.)xiaomimimo\.com$/i.test(u.hostname);
        } catch (e) {
          return /xiaomimimo\.com/i.test(String(url));
        }
      }

      // ---------- 判定"是否聊天请求" ----------
      // 站点端点未知：用请求体特征 + 响应流特征双重判定，避免写死路径
      function bodyLooksLikeChat(body) {
        if (!body) return false;
        var s = '';
        try { s = (typeof body === 'string') ? body : String(body); } catch (e) { return false; }
        if (s.length > 200000) s = s.slice(0, 200000);
        return /"(messages|prompt|query|question|text|content|input)"\s*:/.test(s);
      }
      function isStreamLike(resp) {
        try {
          var ct = '';
          try { ct = String((resp.headers && resp.headers.get && resp.headers.get('content-type')) || ''); } catch (e) { ct = ''; }
          return /event-stream|stream|chunked|text\/plain/i.test(ct);
        } catch (e) { return false; }
      }
      // 元数据/管理类路径：永不是聊天回合（权威排除，不受请求体特征影响）。
      // 实机实证这些接口均为 application/json 且 body 为空，旧版按"路径含 chat"误判，
      // 产生 7 次「回合结束：正文=0 思考=0」空回合。
      var CHAT_META_EXCLUDE_RE = /(conversation|metrics|genTitle|\/save\b|\/list\b|config|user\/|title|feedback|history|delete|share)/i;
      var KNOWN_CHAT_PATH_RE = /\/open-apis\/bot\/chat\b|\/fastchat\/open-apis\/bot\/chat\b/i;
      function isMetadataPath(url) {
        try {
          var u = new URL(url, document.baseURI);
          if (!/(^|\.)xiaomimimo\.com$/i.test(u.hostname)) return false;
          var path = u.pathname || '';
          if (KNOWN_CHAT_PATH_RE.test(path)) return false;
          return CHAT_META_EXCLUDE_RE.test(path);
        } catch (e) { return false; }
      }
      function urlLooksLikeChat(url) {
        try {
          var u = new URL(url, document.baseURI);
          if (!/(^|\.)xiaomimimo\.com$/i.test(u.hostname)) return false;
          if (isListUrl(u)) return false;
          var path = u.pathname || '';
          if (KNOWN_CHAT_PATH_RE.test(path)) return true;
          if (CHAT_META_EXCLUDE_RE.test(path)) return false;
          return CHAT_PATH_RE.test(path) || /(completion|generate|infer|stream)/i.test(path);
        } catch (e) { return false; }
      }

      // ---------- 流解析（SSE / NDJSON / 纯文本，泛化） ----------
      function createLineDecoder() {
        var buffer = '';
        return {
          push: function (text) {
            buffer += text;
            var lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            return lines;
          },
          finish: function () {
            var lines = [];
            if (buffer) { lines.push(buffer); buffer = ''; }
            return lines;
          },
        };
      }
      var diagFrames = 0;
      function handleLine(line, st) {
        if (st.dispatched) return;
        if (!line) return;
        var s = String(line).replace(/^\uFEFF/, '');
        if (!s.trim()) return;
        // ---- SSE 协议字段处理（实机教训）----
        // 真机流是标准 SSE：每条事件前带 `id:<sessionId>` 行。
        // 旧版不认识 id: 字段，把它当正文拼接 → 正文被 sessionId 反复穿插
        // （实机截图：`The user hasn't id:5dbd... asked id:5dbd... anything`）。
        // 故此处显式识别并丢弃全部非内容控制行。
        if (/^\s*:/.test(s)) return;                       // SSE 注释行
        var mEv = s.match(/^\s*event\s*:\s*(.*)$/i);
        if (mEv) { st.eventType = mEv[1].trim(); return; }
        if (/^\s*id\s*:/i.test(s)) return;                 // 事件 ID —— 丢弃
        if (/^\s*retry\s*:/i.test(s)) return;              // 重连间隔 —— 丢弃
        var mData = s.match(/^\s*data\s*:\s?([\s\S]*)$/i);
        if (mData) s = mData[1].trim();
        else if (/^\s*(event|id|retry)\s*$/i.test(s)) return;
        if (!s) return;
        if (s === '[DONE]' || s === 'DONE') { st.finished = true; finishTurn(st); return; }
        var obj = null;
        try { obj = JSON.parse(s); } catch (e) { obj = null; }
        if (!obj) {
          // 看起来是 JSON 却解析失败 → 极可能是分片（多行 SSE / 半截帧），
          // 绝不能当正文拼接，否则 JSON 碎片会污染答案。
          var looksJson = s.charAt(0) === '{' || s.charAt(0) === '[';
          if (looksJson) return;
          // 非 JSON 文本：严格模式（响应驱动兜底）下不接收，避免误吃无关 SSE；
          // 请求驱动（已判定为聊天）时按正文增量处理。
          if (st.strictJson) return;
          if (st.eventType && /error|fail/i.test(st.eventType)) { st.error = s; return; }
          // 必须累加到 st.raw（与 JSON 帧同一通道）而不是直接写 st.text：
          // st.text 是由 st.raw 派生的（splitInlineThink），若此处直接写 st.text，
          // 混合流（部分 JSON 帧 + 部分裸文本行）下的裸文本会被下一次 JSON 帧覆盖丢失。
          st.raw = smartAppend(st.raw || '', s);
          var partsRaw = splitInlineThink(st.raw);
          st.think = st.thinkField || partsRaw.think;
          st.text = partsRaw.text;
          dispatchStream(st.think, st.text, false);
          return;
        }
        // 诊断：前 40 帧结构打日志（定位正文/思考字段与结束帧类型）
        // 实机曾因上限 12 而看不到流尾，无法确认结束帧形态，故提高到 40。
        if (diagFrames < 40) {
          diagFrames++;
          try {
            var brief = obj;
            if (obj && typeof obj.content === 'string' && obj.content.length > 120) {
              brief = {};
              for (var bk in obj) { if (Object.prototype.hasOwnProperty.call(obj, bk)) brief[bk] = obj[bk]; }
              brief.content = obj.content.slice(0, 120) + '…(' + obj.content.length + ')';
            }
            log('[frame#' + diagFrames + '] ' + JSON.stringify(brief).slice(0, 600));
          } catch (e) { /* ignore */ }
        }
        // 会话 id 学习（便于列表与导航）
        try {
          var sid = obj.session_id || obj.sessionId || obj.conversation_id || obj.conversationId || obj.chat_id || obj.chatId ||
            (obj.data && (obj.data.session_id || obj.data.sessionId || obj.data.conversation_id));
          if (sid) window.__cuckooMimoSessionId__ = String(sid);
        } catch (e) { /* ignore */ }
        // 结束信号：顶层状态/事件名
        var status = String(obj.status || obj.state || obj.event || obj.type || '').toLowerCase();
        if (status === 'finish' || status === 'finished' || status === 'completed' || status === 'done' || status === 'end' || status === 'message_stop') {
          st.sawFinish = true;
        }
        var th = pickThink(obj);
        if (th) st.thinkField = smartAppend(st.thinkField || '', th);
        var tx = pickText(obj);
        if (tx) st.raw = smartAppend(st.raw || '', tx);
        // 思考/正文分离：显式 reasoning 字段优先，否则从正文流内联的 <think> 标签拆出
        if (st.raw || st.thinkField) {
          var parts = splitInlineThink(st.raw || '');
          st.think = st.thinkField || parts.think;
          st.text = parts.text;
        }
        if (st.text || st.think) dispatchStream(st.think, st.text, false);
        if (st.sawFinish) finishTurn(st);
      }

      // 通用流泵：读取响应体并逐行解析
      function pumpStream(resp, st, onDone) {
        try {
          if (!resp || !resp.body) { onDone && onDone(); return; }
          var reader = resp.body.getReader();
          var dec = new TextDecoder();
          var decoder = createLineDecoder();
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) {
                var tail = decoder.finish();
                for (var i = 0; i < tail.length; i++) {
                  try { handleLine(tail[i], st); } catch (e) { log('handleLine 异常: ' + (e && e.message)); }
                }
                finishTurn(st);
                onDone && onDone();
                return;
              }
              var lines = decoder.push(dec.decode(r.value, { stream: true }));
              for (var k = 0; k < lines.length; k++) {
                try { handleLine(lines[k], st); } catch (e) { log('handleLine 异常: ' + (e && e.message)); }
              }
              return pump();
            }).catch(function (err) {
              var isAbort = st.aborted || (err && (err.name === 'AbortError' || /abort/i.test(err.message || '')));
              if (isAbort) { log('流已被中止（harness 暂停）'); finishTurn(st); }
              else { log('流读取异常，兜底派发: ' + (err && err.message)); finishTurn(st); }
              onDone && onDone();
            });
          }
          pump();
        } catch (e) {
          log('流泵异常: ' + (e && e.message));
          finishTurn(st);
          onDone && onDone();
        }
      }

      // ---------- fetch 拦截 ----------
      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function (input, init) {
          var url = (typeof input === 'string') ? input : ((input && input.url) || '');
          var method = (init && init.method) || (input && input.method) || 'GET';

          // 非聊天请求：记录接口 + 列表/上传探针，不改动原语义
          var listKey = tapListApi(url, (init && init.method) || (input && input.method) || 'GET', init && init.body);
          var isUp = isUploadUrl(url);
          logBodyOnce(method, url, init && init.body);
          // 元数据路径权威排除：真机这些接口 body 为空、返回 application/json，
          // 若仅靠请求体特征判断会把它们当成聊天回合（产生空回合）。
          var chatCandidate = !isMetadataPath(url) &&
            (bodyLooksLikeChat(init && init.body) || urlLooksLikeChat(url));

          if (!chatCandidate) {
            if (isUp) markUpload('start');
            try {
              var pr = origFetch.apply(this, arguments);
              if (pr && typeof pr.then === 'function') {
                pr.then(function (resp) {
                  logNet(method, url, resp && resp.status, ctOf(resp));
                  if (isUp) markUpload(resp && resp.ok ? 'ok' : 'fail', resp && resp.status);
                  if (listKey && resp) {
                    try { resp.clone().text().then(function (t) { if (t) rememberListJson(listKey, t); }).catch(function () {}); } catch (e) { /* ignore */ }
                  }
                  // 响应驱动兜底：POST + 流式响应 → 即便 URL/请求体不像聊天也接管解析。
                  // 治的是"聊天端点不透明"（如 /api/gateway）导致整条漏检。
                  // 严格模式只认 JSON 帧，避免误吃无关 SSE 造成垃圾正文。
                  try {
                    if (String(method).toUpperCase() === 'POST' && resp && isStreamLike(resp) && resp.clone) {
                      var st2 = trackState({ text: '', think: '', finished: false, dispatched: false, aborted: false, eventType: '', sawFinish: false, strictJson: true });
                      log('响应驱动接管流: ' + String(url).slice(0, 120));
                      pumpStream(resp.clone(), st2);
                    }
                  } catch (e) { /* ignore */ }
                  return resp;
                }).catch(function (e) {
                  logNet(method, url, 'ERR:' + (e && e.message));
                  if (isUp) markUpload('error');
                });
              }
              return pr;
            } catch (e) { /* fallthrough */ }
            return origFetch.apply(this, arguments);
          }

          // 聊天请求：拦截并解析流
          var st = trackState({ text: '', think: '', finished: false, dispatched: false, aborted: false, eventType: '', sawFinish: false });
          var ctl = null;
          try { ctl = new AbortController(); inflightCtl.push(ctl); } catch (e) { ctl = null; }
          log('疑似聊天请求: ' + method + ' ' + String(url).slice(0, 120));
          try {
            var p = origFetch.apply(this, [input, Object.assign({}, init || {}, ctl ? { signal: ctl.signal } : {})]);
            p.then(function (resp) {
              try {
                if (ctl) { var ci = inflightCtl.indexOf(ctl); if (ci >= 0) inflightCtl.splice(ci, 1); }
                logNet(method, url, resp && resp.status, isStreamLike(resp) ? '(stream)' : ctOf(resp));
                if (!resp || !resp.body) { finishTurn(st); return; }
                // 恒走流泵：即便 content-type 不标 stream（chunked JSON 等），
                // 按块读取同样正确——能增量就是流式，不能增量则在结束时整段解析一次。
                // 原先按 content-type 二分会把 chunked JSON 退化成"等整个响应读完"。
                pumpStream(resp.clone(), st);
              } catch (e) { log('响应处理异常: ' + (e && e.message)); finishTurn(st); }
            }).catch(function (err) {
              if (ctl) { var ci2 = inflightCtl.indexOf(ctl); if (ci2 >= 0) inflightCtl.splice(ci2, 1); }
              var isAbort = st.aborted || (err && (err.name === 'AbortError' || /abort/i.test(err.message || '')));
              log(isAbort ? '请求已中止（harness 暂停）' : ('请求失败: ' + (err && err.message)));
              finishTurn(st);
            });
            return p;
          } catch (e) { /* fallthrough */ }
          finishTurn(st);
          return origFetch.apply(this, arguments);
        };
      }

      // ---------- XHR 拦截（兜底通道） ----------
      try {
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__mimoUrl = url;
          this.__mimoMethod = method;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          var xhr = this;
          var url = xhr.__mimoUrl;
          var listKey = tapListApi(url, xhr.__mimoMethod, body);
          var isUp = isUploadUrl(url);
          logBodyOnce(xhr.__mimoMethod, url, body);
          if (isUp) markUpload('start');
          try {
            xhr.addEventListener('readystatechange', function () {
              try {
                if (xhr.readyState === 4) {
                  logNet(xhr.__mimoMethod, url, xhr.status);
                  if (isUp) markUpload(xhr.status >= 200 && xhr.status < 300 ? 'ok' : 'fail', xhr.status);
                  if (listKey) {
                    var t = '';
                    try { t = xhr.responseText || ''; } catch (e) { /* ignore */ }
                    if (t) rememberListJson(listKey, t);
                  }
                }
              } catch (e) { /* ignore */ }
            });
          } catch (e) { /* ignore */ }

          var chatCandidate = !isMetadataPath(url) && (bodyLooksLikeChat(body) || urlLooksLikeChat(url));
          if (chatCandidate) {
            var st = trackState({ text: '', think: '', finished: false, dispatched: false, aborted: false, eventType: '', sawFinish: false, offset: 0, decoder: null });
            log('疑似聊天请求(XHR): ' + xhr.__mimoMethod + ' ' + String(url).slice(0, 120));
            xhr.addEventListener('readystatechange', function () {
              try {
                if (xhr.readyState < 3) return;
                var txt = '';
                try { txt = xhr.responseText || ''; } catch (e) { txt = ''; }
                if (!txt) return;
                var chunk = txt.slice(st.offset);
                st.offset = txt.length;
                if (chunk) {
                  if (!st.decoder) st.decoder = createLineDecoder();
                  var lines = st.decoder.push(chunk);
                  for (var i = 0; i < lines.length; i++) handleLine(lines[i], st);
                }
                if (xhr.readyState === 4) {
                  if (st.decoder) {
                    var tail = st.decoder.finish();
                    for (var k = 0; k < tail.length; k++) handleLine(tail[k], st);
                  }
                  finishTurn(st);
                }
              } catch (e) { /* ignore */ }
            });
          }
          return origSend.apply(this, arguments);
        };
      } catch (e) { /* ignore */ }

      // ---------- WebSocket 拦截（部分 Studio 走 WS 推流） ----------
      try {
        var OrigWS = window.WebSocket;
        if (typeof OrigWS === 'function') {
          var PatchedWS = function (url, protocols) {
            var ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
            try {
              logNet('WS', String(url), 'open');
              var st = null;
              ws.addEventListener('message', function (ev) {
                try {
                  var data = ev && ev.data;
                  if (typeof data !== 'string' || !data) return;
                  // WS 推流：首帧建立状态，后续按行解析
                  if (!st) st = trackState({ text: '', think: '', finished: false, dispatched: false, aborted: false, eventType: '', sawFinish: false });
                  var lines = data.split(/\r?\n/);
                  for (var i = 0; i < lines.length; i++) {
                    try { handleLine(lines[i], st); } catch (e) { /* ignore */ }
                  }
                } catch (e) { /* ignore */ }
              });
              ws.addEventListener('close', function () {
                try { if (st) finishTurn(st); } catch (e) { /* ignore */ }
              });
            } catch (e) { /* ignore */ }
            return ws;
          };
          PatchedWS.prototype = OrigWS.prototype;
          try {
            PatchedWS.CONNECTING = OrigWS.CONNECTING;
            PatchedWS.OPEN = OrigWS.OPEN;
            PatchedWS.CLOSING = OrigWS.CLOSING;
            PatchedWS.CLOSED = OrigWS.CLOSED;
          } catch (e) { /* ignore */ }
          window.WebSocket = PatchedWS;
        }
      } catch (e) { /* ignore */ }

      // ---------- EventSource 拦截（SSE 的标准 API，此前遗漏的通道）----------
      // fetch/XHR/WS 之外，部分站点直接用 new EventSource(url) 收 SSE。
      // EventSource 的 message 事件已剥离 "data:" 前缀，handleLine 对其无副作用。
      try {
        var OrigES = window.EventSource;
        if (typeof OrigES === 'function') {
          var PatchedES = function (url, config) {
            var es = (config === undefined) ? new OrigES(url) : new OrigES(url, config);
            try {
              if (isOwnSite(url)) {
                log('EventSource 连接: ' + String(url).slice(0, 120));
                var esState = null;
                es.addEventListener('message', function (ev) {
                  try {
                    if (!esState) {
                      esState = trackState({ text: '', think: '', finished: false, dispatched: false, aborted: false, eventType: '', sawFinish: false });
                    }
                    var lines = String((ev && ev.data) || '').split(/\r?\n/);
                    for (var i = 0; i < lines.length; i++) {
                      try { handleLine(lines[i], esState); } catch (e) { /* ignore */ }
                    }
                  } catch (e) { /* ignore */ }
                });
                es.addEventListener('error', function () {
                  try { if (esState) finishTurn(esState); } catch (e) { /* ignore */ }
                });
              }
            } catch (e) { /* ignore */ }
            return es;
          };
          PatchedES.prototype = OrigES.prototype;
          try {
            PatchedES.CONNECTING = OrigES.CONNECTING;
            PatchedES.OPEN = OrigES.OPEN;
            PatchedES.CLOSED = OrigES.CLOSED;
          } catch (e) { /* ignore */ }
          window.EventSource = PatchedES;
        }
      } catch (e) { /* ignore */ }

      // ---------- 一次性 DOM 侦察（首跑自动回答"真实 DOM 长什么样"）----------
      // 站点是需登录的 SPA，外部无法观测其 DOM；浏览器自动化依赖扩展登录（不可用）。
      // 但 hook 本来就跑在页面里 —— 让它把输入区/附件键/侧栏的真实结构写进 mimo.log，
      // 用户打开一次站点即可拿到全部选择器证据，无需任何外部工具。
      // 输出严格限流（每类上限几条），避免污染日志。
      function domRecon() {
        try {
          var R = '[mimo-dom]';
          var desc = function (el, label) {
            try {
              var r = el.getBoundingClientRect();
              var cls = (typeof el.className === 'string') ? el.className : '';
              var aria = '';
              try { aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || ''; } catch (e2) { aria = ''; }
              var track = '';
              try { track = (el.getAttribute && el.getAttribute('data-track-id')) || ''; } catch (e2) { track = ''; }
              return label + ' <' + el.tagName.toLowerCase() + '> cls=' + cls.slice(0, 70) +
                ' aria=' + aria.slice(0, 22) + ' track=' + track +
                ' rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
                ' txt=' + (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22);
            } catch (e2) { return label + ' [desc-err]'; }
          };
          var vh = window.innerHeight || 800;
          var hasComposer = false;

          // 1) 隐藏 file input（附件直注的目标）
          var fis = document.querySelectorAll('input[type=file]');
          console.log(R + ' file-input 数量=' + fis.length);
          for (var i = 0; i < Math.min(fis.length, 4); i++) {
            var fi = fis[i];
            var ftype = ''; try { ftype = fi.getAttribute('accept') || ''; } catch (e2) { /* ignore */ }
            console.log(R + ' ' + desc(fi, 'file-input#' + i) + ' accept=' + ftype);
          }

          // 2) 输入框
          var boxes = document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""]');
          console.log(R + ' 输入框数量=' + boxes.length);
          for (var j = 0; j < Math.min(boxes.length, 3); j++) {
            hasComposer = true;
            console.log(R + ' ' + desc(boxes[j], 'input#' + j) +
              ' placeholder=' + String(boxes[j].getAttribute && (boxes[j].getAttribute('placeholder') || '')).slice(0, 30));
          }

          // 3) 视口下半部分的按钮/可点元素（含站点埋点属性者优先）
          var cands = document.querySelectorAll('button,[role="button"],[data-track-id]');
          var n = 0;
          for (var k = 0; k < cands.length && n < 25; k++) {
            var el = cands[k];
            var r = el.getBoundingClientRect();
            if (!r || !r.width || !r.height) continue;
            if (r.top < vh * 0.6) continue;
            console.log(R + ' ' + desc(el, 'toolbar#' + n));
            n++;
          }
          console.log(R + ' 底部可点元素=' + n + ' (上限25)');

          // 4) 侧栏会话条目（DOM 兜底用）
          var sides = document.querySelectorAll('[href*="#/chat/"],[data-track-id*="history"],aside [role="button"],aside li');
          var m = 0;
          for (var q = 0; q < sides.length && m < 12; q++) {
            var it = sides[q];
            var ir = it.getBoundingClientRect();
            if (!ir || !ir.width || !ir.height) continue;
            var href = ''; try { href = (it.getAttribute && it.getAttribute('href')) || ''; } catch (e2) { /* ignore */ }
            console.log(R + ' ' + desc(it, 'side#' + m) + ' href=' + String(href).slice(0, 48));
            m++;
          }
          console.log(R + ' 侧栏候选=' + m + ' (上限12)');
          return hasComposer;
        } catch (e) {
          console.log('[mimo-dom] 侦察异常: ' + (e && e.message));
          return true;   // 异常不再重试，避免刷日志
        }
      }
      // SPA 渲染晚于 preload：先等首屏，找不到输入区再补两次（有上限，不循环刷屏）
      (function scheduleRecon() {
        var tries = 0;
        var run = function () {
          tries++;
          var done = domRecon();
          console.log('[mimo-dom] 第' + tries + '次侦察 url=' + String(location.href).slice(0, 120) + ' 输入区=' + (done ? '有' : '无'));
          if (done || tries >= 3) return;
          setTimeout(run, 8000);
        };
        setTimeout(run, 5000);
      })();

      console.log('[mimo-hook] 已安装（探测优先：fetch/XHR/WS/EventSource 全通道 + 泛化解析）');
    }.toString() + ')();';
  },
};

// ========== 渲染进程自注入（自定义 Provider 不在官方 hook 白名单内） ==========
// 在 preload 环境（loader require 本文件时，早于页面脚本）把 hook 注入主世界。
// 不依赖任何官方修改，导入即用；hook 内部有 MARKER 防重。
(function () {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return; // 主进程/校验环境
    if (typeof require !== 'function') return;
    var electron = require('electron');
    if (!electron || !electron.webFrame || typeof electron.webFrame.executeJavaScript !== 'function') return;
    electron.webFrame.executeJavaScript(module.exports.getHookSource())
      .then(function () {
        console.log('[Cuckoo Code] MiMo：主世界拦截器已自行注入（探测优先）');
      })
      .catch(function (err) {
        console.error('[Cuckoo Code] MiMo：主世界拦截器注入失败', err && err.message);
      });
  } catch (e) { /* 非 preload 环境静默跳过 */ }
})();
