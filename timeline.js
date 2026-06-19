// timeline.js — 时间线渲染 + 筛选
(function () {
  var all = [],
    filtered = [];
  var chatId = new URLSearchParams(location.search).get("chat") || "";

  // SVG 图标引用（依赖 HTML 中的 <svg sprite>）
  function icon(name) {
    return (
      '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><use href="#icon-' +
      name +
      '"/></svg>'
    );
  }

  function api() {
    // 新窗口（window.open）→ window.opener
    if (window.opener && window.opener.EventChronicle)
      return window.opener.EventChronicle;
    // iframe（ST 内嵌）→ window.parent
    if (
      window.parent &&
      window.parent !== window &&
      window.parent.EventChronicle
    )
      return window.parent.EventChronicle;
    return window.EventChronicle || null;
  }

  window.refresh = function () {
    var a = api();
    if (!a) {
      document.getElementById("ec_container").innerHTML =
        '<div class="empty">' + icon("cloud_off") + "<p>扩展未连接</p></div>";
      return;
    }
    // 按当前聊天 ID 筛选事件，无 chatId 时回退到全部
    if (chatId) {
      all = a.getEvents(chatId) || [];
    } else {
      all = a.getAllEvents() || [];
    }
    var locs = new Set();
    all.forEach(function (e) {
      if (e.location) locs.add(e.location);
    });
    var sel = document.getElementById("flt_loc");
    sel.innerHTML = '<option value="">所有地点</option>';
    locs.forEach(function (l) {
      var o = document.createElement("option");
      o.value = l;
      o.textContent = l;
      sel.appendChild(o);
    });
    window.apply();
  };

  window.apply = function () {
    var locF = document.getElementById("flt_loc").value;
    var impF = parseInt(document.getElementById("flt_imp").value, 10) || 0;
    var search = (
      document.getElementById("flt_search").value || ""
    ).toLowerCase();
    filtered = all.filter(function (e) {
      if (locF && e.location !== locF) return false;
      if (impF && (e.importance || 5) < impF) return false;
      if (search) {
        var s = [
          e.title,
          e.summary,
          (e.tags || []).join(" "),
          (e.participants || []).join(" "),
          e.location,
        ]
          .join(" ")
          .toLowerCase();
        if (s.indexOf(search) === -1) return false;
      }
      return true;
    });
    filtered.sort(function (a, b) {
      return (b.timestamp || 0) - (a.timestamp || 0);
    });
    document.getElementById("ec_count").textContent =
      filtered.length + " / " + all.length + " 个事件";
    render(filtered);
  };

  function render(events) {
    var c = document.getElementById("ec_container");
    if (!events.length) {
      c.innerHTML =
        '<div class="empty">' +
        icon("hourglass_empty") +
        "<p>暂无事件。开始聊天以构建编年史</p></div>";
      return;
    }
    var h = '<div class="timeline">';
    events.forEach(function (e) {
      h += card(e);
    });
    h += '<div class="timeline-end"></div>';
    h += "</div>";
    c.innerHTML = h;
  }

  function card(e) {
    var stars = "";
    var imp = e.importance || 5;
    for (var i = 1; i <= 10; i++) {
      stars +=
        i <= imp
          ? '<span class="star">★</span>'
          : '<span class="star-empty">☆</span>';
    }
    var tags = (e.tags || [])
      .map(function (t) {
        return '<span class="tag">' + esc(t) + "</span>";
      })
      .join("");
    var time = "";
    if (e.timestamp) {
      try {
        time = new Date(e.timestamp * 1000).toLocaleString();
      } catch (_) {}
    }

    return (
      '<div class="event-item">' +
      '<div class="event-node"></div>' +
      '<div class="event-card">' +
      '<div class="event-head">' +
      "<div>" +
      '<div class="event-title">' +
      esc(e.title || "未命名") +
      "</div>" +
      (time
        ? '<div class="event-meta">' +
          icon("schedule") +
          " " +
          esc(time) +
          "</div>"
        : "") +
      "</div>" +
      '<div class="event-stars">' +
      stars +
      "</div>" +
      "</div>" +
      '<div class="event-summary">' +
      esc(e.summary || "") +
      "</div>" +
      '<div class="event-foot">' +
      '<div class="event-meta">' +
      ((e.participants || []).length
        ? icon("group") + " <span>" + esc(e.participants.join(", ")) + "</span>"
        : "") +
      (e.location
        ? icon("location_on") + " <span>" + esc(e.location) + "</span>"
        : "") +
      "</div>" +
      '<div class="event-actions">' +
      (e.source
        ? '<button class="btn btn-ghost" onclick="toggleSource(\'' + attr(e.id) + '\')">' +
          icon("auto_stories") + " 来源消息 (" + e.source.count + ")</button>"
        : "") +
      '<button class="btn btn-ghost" onclick="edit(\'' +
      attr(e.id) +
      "')\">" +
      icon("edit") +
      " 编辑</button>" +
      '<button class="btn btn-danger" onclick="del(\'' +
      attr(e.id) +
      "')\">" +
      icon("delete") +
      " 删除</button>" +
      "</div>" +
      "</div>" +
      (tags ? '<div class="event-tags">' + tags + "</div>" : "") +
      '<div id="src_' + attr(e.id) + '" class="event-source" style="display:none;"></div>' +
      "</div>" +
      "</div>"
    );
  }

  window.toggleSource = function (eventId) {
    var el = document.getElementById("src_" + eventId);
    if (!el) return;
    if (el.style.display !== "none") {
      el.style.display = "none";
      return;
    }

    var ev = filtered.find(function (e) {
      return e.id === eventId;
    });
    if (!ev || !ev.source) return;

    var msgs;
    var a = api();
    if (a && a.getMessagesByRange) {
      msgs = a.getMessagesByRange(ev.source.range[0], ev.source.range[1]);
    }

    if (!msgs || !msgs.length) {
      el.innerHTML = ev.source.preview
        ? '<div class="source-msg source-fallback"><div class="source-text">' +
          esc(ev.source.preview) +
          '...</div><div class="source-hint">来源消息不可用，仅显示预览</div></div>'
        : '<div class="source-msg source-fallback"><div class="source-text" style="color:#888;">来源消息不可用</div></div>';
    } else {
      el.innerHTML = msgs
        .map(function (m) {
          return (
            '<div class="source-msg ' +
            (m.is_user ? "source-user" : "source-char") +
            '">' +
            '<div class="source-name">' +
            esc(m.name) +
            "</div>" +
            '<div class="source-text">' +
            esc(m.mes) +
            "</div></div>"
          );
        })
        .join("");
    }
    el.style.display = "block";
  };

  window.doExport = function () {
    var a = api();
    if (!a) return;
    var mem = a.exportMemory(null, { highlightThreshold: 6 });
    if (mem) {
      navigator.clipboard
        .writeText(mem)
        .then(function () {
          alert("记忆 Prompt 已复制到剪贴板！");
        })
        .catch(function () {
          alert(mem);
        });
    } else alert("暂无事件可导出。");
  };

  function esc(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }
  function attr(s) {
    return String(s || "")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.addEventListener("DOMContentLoaded", function () {
    window.refresh();
    setTimeout(window.refresh, 2000);
  });
})();
