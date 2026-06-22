// timeline.js — 时间线渲染 + 筛选
(function () {
  var all = [],
    filtered = [];
  var chatId = new URLSearchParams(location.search).get("chat") || "";

  // i18n
  function tr(key) {
    var a = api();
    if (a && a.translate) return a.translate(key);
    return key;
  }

  /** 手动翻译页面静态 data-i18n 元素（popup 窗口无 ST MutationObserver） */
  function localizeDOM() {
    var elements = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var key = el.getAttribute('data-i18n');
      if (!key) continue;
      // [attr]key 形式
      if (key.charAt(0) === '[') {
        var end = key.indexOf(']');
        if (end > 0) {
          var attr = key.substring(1, end);
          var realKey = key.substring(end + 1);
          el.setAttribute(attr, tr(realKey));
        }
      } else {
        el.textContent = tr(key);
      }
    }
    // 页面标题
    document.title = 'Visual Memory · 可视记忆';
  }

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
        '<div class="empty">' + icon("cloud_off") + '<p>' + tr("ec.timeline.notConnected") + '</p></div>';
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
    sel.innerHTML = '<option value="">' + tr("ec.timeline.allLocations") + '</option>';
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
      filtered.length + " / " + all.length + " " + tr("ec.timeline.events");
    render(filtered);
  };

  function render(events) {
    var c = document.getElementById("ec_container");
    if (!events.length) {
      c.innerHTML =
        '<div class="empty">' +
        icon("hourglass_empty") +
        '<p>' + tr("ec.timeline.emptyState") + '</p></div>';
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
    var srcBtn = e.source
      ? '<button class="source-toggle" onclick="toggleSource(\'' +
        attr(e.id) +
        "')\">" +
        icon("auto_stories") +
        " " + tr("ec.timeline.sourceMessages").replace("${0}", e.source.count) +
        "</button>"
      : "";

    return (
      '<div class="event-item">' +
      '<div class="event-node"></div>' +
      '<div class="event-card">' +
      '<div class="event-head">' +
      "<div>" +
      '<div class="event-title">' +
      esc(e.title || tr("ec.timeline.untitled")) +
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
      srcBtn +
      "</div>" +
      '<div class="event-actions">' +
      '<button class="btn btn-ghost" onclick="edit(\'' +
      attr(e.id) +
      "')\">" +
      icon("edit") +
      " " + tr("ec.timeline.edit") + "</button>" +
      '<button class="btn btn-danger" onclick="del(\'' +
      attr(e.id) +
      "')\">" +
      icon("delete") +
      " " + tr("ec.timeline.delete") + "</button>" +
      "</div>" +
      "</div>" +
      (tags ? '<div class="event-tags">' + tags + "</div>" : "") +
      '<div id="src_' +
      attr(e.id) +
      '" class="event-source"></div>' +
      "</div>" +
      "</div>"
    );
  }

  function formatTime(sendDate) {
    if (!sendDate) return "";
    try {
      return new Date(sendDate).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  }

  function avatarLetter(name) {
    if (!name) return "?";
    return name.charAt(0).toUpperCase();
  }

  window.toggleSource = function (eventId) {
    var el = document.getElementById("src_" + eventId);
    if (!el) return;

    // 切换展开/折叠
    if (el.classList.contains("open")) {
      el.classList.remove("open");
      return;
    }

    // 首次展开时渲染内容
    if (!el.dataset.loaded) {
      var ev = filtered.find(function (e) {
        return e.id === eventId;
      });
      if (!ev || !ev.source) return;

      var msgs;
      var a = api();
      if (a && a.getMessagesByRange) {
        msgs = a.getMessagesByRange(ev.source.range[0], ev.source.range[1]);
      }

      var h = "";
      if (!msgs || !msgs.length) {
        // 降级显示
        h =
          '<div class="source-fallback">' +
          (ev.source.preview
            ? '<div class="source-text">' +
              esc(ev.source.preview) +
              "...</div>" +
              '<div class="source-hint">' + tr("ec.timeline.sourceUnavailableHint") + '</div>'
            : '<div class="source-text">' + tr("ec.timeline.sourceUnavailable") + '</div>') +
          "</div>";
      } else {
        h =
          '<div class="source-header">' +
          icon("auto_stories") +
          " " + tr("ec.timeline.sourceConversation").replace("${0}", msgs.length) +
          "</div>" +
          '<div class="source-list">';
        h += msgs
          .map(function (m) {
            var cls = m.is_user ? "source-user" : "source-char";
            var time = formatTime(m.send_date);
            return (
              '<div class="source-msg ' +
              cls +
              '">' +
              '<div class="source-avatar">' +
              avatarLetter(m.name) +
              "</div>" +
              '<div class="source-bubble">' +
              '<div class="source-name">' +
              esc(m.name) +
              "</div>" +
              '<div class="source-text">' +
              esc(m.mes) +
              "</div>" +
              (time ? '<div class="source-time">' + esc(time) + "</div>" : "") +
              "</div></div>"
            );
          })
          .join("");
        h += "</div>";
      }
      el.innerHTML = h;
      el.dataset.loaded = "1";
    }

    el.classList.add("open");
  };

  window.doExport = function () {
    var a = api();
    if (!a) return;
    var mem = a.exportMemory(null, { highlightThreshold: 6 });
    if (mem) {
      navigator.clipboard
        .writeText(mem)
        .then(function () {
          alert(tr("ec.export.copied"));
        })
        .catch(function () {
          alert(mem);
        });
    } else alert(tr("ec.export.noEvents"));
  };

  // ========== 主题切换 ==========
  window.toggleTheme = function () {
    var root = document.documentElement;
    var current = root.getAttribute("data-theme") || "dark";
    var next = current === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("ec-theme", next);
    updateThemeIcon(next);
  };

  function updateThemeIcon(theme) {
    var btn = document.getElementById("theme_toggle");
    if (!btn) return;
    var use = btn.querySelector("use");
    if (use) {
      use.setAttribute(
        "href",
        theme === "dark" ? "#icon-dark_mode" : "#icon-light_mode",
      );
    }
  }

  function initTheme() {
    var saved = localStorage.getItem("ec-theme");
    var theme =
      saved ||
      (window.matchMedia("(prefers-color-scheme: light)").matches
        ? "dark"
        : "light");
    document.documentElement.setAttribute("data-theme", theme);
    updateThemeIcon(theme);
  }

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
    initTheme();
    localizeDOM();
    window.refresh();
    setTimeout(window.refresh, 2000);

    // 事件委托：点击 source-text 切换截断/展开
    document.addEventListener("click", function (e) {
      var text = e.target.closest(".source-text");
      if (text) text.classList.toggle("expanded");
    });
  });
})();
