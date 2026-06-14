// editor.js — 事件编辑 + 删除
(function() {
  var curId = null;

  function api() {
    if (window.opener && window.opener.EventChronicle) return window.opener.EventChronicle;
    if (window.parent && window.parent !== window && window.parent.EventChronicle) return window.parent.EventChronicle;
    return window.EventChronicle || null;
  }

  window.edit = function(eventId) {
    var a = api(); if (!a) return;
    var ev = null, all = a.getAllEvents();
    for (var i = 0; i < all.length; i++) { if (all[i].id === eventId) { ev = all[i]; break; } }
    if (!ev) { alert('未找到该事件。'); return; }
    curId = eventId;
    document.getElementById('ec_modal_title').textContent = '编辑: ' + (ev.title || '未命名');
    document.getElementById('ec_edit_title').value = ev.title || '';
    document.getElementById('ec_edit_summary').value = ev.summary || '';
    document.getElementById('ec_edit_imp').value = ev.importance || 5;
    document.getElementById('ec_edit_parts').value = (ev.participants || []).join(', ');
    document.getElementById('ec_edit_loc').value = ev.location || '';
    document.getElementById('ec_edit_tags').value = (ev.tags || []).join(', ');
    document.getElementById('ec_modal').classList.add('active');
  };

  window.closeModal = function() { document.getElementById('ec_modal').classList.remove('active'); curId = null; };

  window.saveEdit = function() {
    var a = api(); if (!a || !curId) return;
    var chatId = null, all = a.getAllEvents();
    for (var i = 0; i < all.length; i++) { if (all[i].id === curId) { chatId = all[i]._chatId; break; } }
    if (!chatId) { alert('无法确定事件所属聊天。'); return; }
    var imp = parseInt(document.getElementById('ec_edit_imp').value, 10) || 5;
    var result = a.updateEvent(chatId, {
      id: curId, title: document.getElementById('ec_edit_title').value.trim(),
      summary: document.getElementById('ec_edit_summary').value.trim(), importance: Math.min(10, Math.max(1, imp)),
      participants: document.getElementById('ec_edit_parts').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
      location: document.getElementById('ec_edit_loc').value.trim(),
      tags: document.getElementById('ec_edit_tags').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
    });
    if (result) { closeModal(); window.refresh(); } else alert('更新失败。');
  };

  window.del = function(eventId) {
    var a = api(); if (!a) return;
    var chatId = null, all = a.getAllEvents(), title = eventId;
    for (var i = 0; i < all.length; i++) { if (all[i].id === eventId) { chatId = all[i]._chatId; title = all[i].title || eventId; break; } }
    if (!chatId) { alert('无法确定事件所属聊天。'); return; }
    if (!confirm('删除事件 "' + title + '"？此操作不可撤销。')) return;
    if (a.deleteEvent(chatId, eventId)) window.refresh(); else alert('删除失败。');
  };

  document.addEventListener('DOMContentLoaded', function() {
    var overlay = document.getElementById('ec_modal');
    if (overlay) { overlay.addEventListener('click', function(e) { if (e.target === overlay) window.closeModal(); }); }
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') window.closeModal(); });
  });
})();
