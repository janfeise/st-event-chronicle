// timeline.js — 时间线渲染 + 筛选
(function() {
  var all = [], filtered = [];

  function api() {
    // 新窗口（window.open）→ window.opener
    if (window.opener && window.opener.EventChronicle) return window.opener.EventChronicle;
    // iframe（ST 内嵌）→ window.parent
    if (window.parent && window.parent !== window && window.parent.EventChronicle) return window.parent.EventChronicle;
    return window.EventChronicle || null;
  }

  window.refresh = function() {
    var a = api();
    if (!a) { document.getElementById('ec_container').innerHTML = '<div class="ec-empty"><p>扩展未连接</p></div>'; return; }
    all = a.getAllEvents() || [];
    var locs = new Set(); all.forEach(function(e) { if (e.location) locs.add(e.location); });
    var sel = document.getElementById('flt_loc');
    sel.innerHTML = '<option value="">所有地点</option>';
    locs.forEach(function(l) { var o = document.createElement('option'); o.value = l; o.textContent = l; sel.appendChild(o); });
    window.apply();
  };

  window.apply = function() {
    var locF = document.getElementById('flt_loc').value;
    var impF = parseInt(document.getElementById('flt_imp').value, 10) || 0;
    var search = (document.getElementById('flt_search').value || '').toLowerCase();
    filtered = all.filter(function(e) {
      if (locF && e.location !== locF) return false;
      if (impF && (e.importance || 5) < impF) return false;
      if (search) {
        var s = [e.title, e.summary, (e.tags||[]).join(' '), (e.participants||[]).join(' '), e.location].join(' ').toLowerCase();
        if (s.indexOf(search) === -1) return false;
      }
      return true;
    });
    filtered.sort(function(a, b) { return (a.id||'').localeCompare(b.id||''); });
    document.getElementById('ec_count').textContent = filtered.length + ' / ' + all.length + ' 个事件';
    render(filtered);
  };

  function render(events) {
    var c = document.getElementById('ec_container');
    if (!events.length) { c.innerHTML = '<div class="ec-empty"><p>暂无事件。开始聊天以构建编年史。</p></div>'; return; }
    var groups = new Map();
    events.forEach(function(e) { var k = e.location || '未归类'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
    var h = '';
    groups.forEach(function(evts, name) {
      h += '<div class="ec-group-header"><h3>📍 ' + esc(name) + '</h3><span class="ec-badge">' + evts.length + ' 个事件</span></div>';
      evts.forEach(function(e) { h += card(e); });
    });
    c.innerHTML = h;
  }

  function card(e) {
    var stars = ''; for (var i = 1; i <= 10; i++) stars += i <= (e.importance||5) ? '<span class="ec-star-filled">★</span>' : '<span class="ec-star-empty">☆</span>';
    var tags = (e.tags||[]).map(function(t) { return '<span class="ec-tag">' + esc(t) + '</span>'; }).join('');
    var time = ''; var m = (e.id||'').match(/evt_(\d+)/); if (m) { try { time = new Date(parseInt(m[1])).toLocaleString(); } catch(_){} }
    return '<div class="ec-event-card">' +
      (time ? '<div class="ec-event-time">📅 ' + esc(time) + '</div>' : '') +
      '<div style="display:flex;justify-content:space-between;"><span class="ec-event-title">' + esc(e.title||'未命名') + '</span><span class="ec-event-stars">' + stars + '</span></div>' +
      '<div class="ec-event-summary">' + esc(e.summary||'') + '</div>' +
      '<div class="ec-event-meta">' + ((e.participants||[]).length ? '<span>👤 ' + esc(e.participants.join(', ')) + '</span>' : '') + (e.location ? '<span>📍 ' + esc(e.location) + '</span>' : '') + '</div>' +
      (tags ? '<div>' + tags + '</div>' : '') +
      '<div class="ec-event-actions"><button class="ec-btn ec-btn-secondary" onclick="edit(\'' + attr(e.id) + '\')">✏️ 编辑</button><button class="ec-btn ec-btn-danger" onclick="del(\'' + attr(e.id) + '\')">🗑 删除</button></div></div>';
  }

  window.doExport = function() {
    var a = api(); if (!a) return;
    var mem = a.exportMemory(null, { highlightThreshold: 6 });
    if (mem) { navigator.clipboard.writeText(mem).then(function() { alert('记忆 Prompt 已复制到剪贴板！'); }).catch(function() { alert(mem); }); }
    else alert('暂无事件可导出。');
  };

  function esc(s) { if (!s) return ''; var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  function attr(s) { return String(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  window.addEventListener('DOMContentLoaded', function() { window.refresh(); setTimeout(window.refresh, 2000); });
})();
