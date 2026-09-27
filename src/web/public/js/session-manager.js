"use strict";
(function () {
  const App = window.SapBuddy;
  const $ = App.$;
  const selected = new Map();
  let rows = [], offset = 0, nextOffset = null, total = 0, loading = false, deleting = false, revision = 0, timer;
  const unavailable = row => row.current || row.path === App.state.currentPath;
  function controls() {
    for (const [key, row] of selected) if (unavailable(row)) selected.delete(key);
    const eligible = rows.filter(row => !unavailable(row));
    const count = eligible.filter(row => selected.has(row.path)).length;
    $("#session-manager-all").checked = eligible.length > 0 && count === eligible.length;
    $("#session-manager-all").indeterminate = count > 0 && count < eligible.length;
    $("#session-manager-all").disabled = loading || deleting || !eligible.length;
    $("#session-manager-delete").disabled = loading || deleting || !selected.size;
    $("#session-manager-delete").textContent = `删除所选（${selected.size}）`;
    const hidden = [...selected.keys()].filter(key => !rows.some(row => row.path === key)).length;
    $("#session-manager-selection").textContent = selected.size ? `已选 ${selected.size} 项，其中 ${hidden} 项不在当前页` : "";
    $("#session-manager-export").disabled = loading || deleting || !selected.size;
    $("#session-manager-clear").disabled = deleting || !selected.size;
    $("#session-manager-from").disabled = deleting;
    $("#session-manager-to").disabled = deleting;
    $("#session-manager-prev").disabled = loading || deleting || offset === 0;
    $("#session-manager-next").disabled = loading || deleting || nextOffset === null;
    $("#session-manager-search").disabled = deleting;
    $("#session-manager-refresh").disabled = loading || deleting;
    document.querySelectorAll('#session-manager-list input').forEach(input => { input.disabled = loading || deleting || unavailable(rows.find(row => row.path === input.value)); });
  }
  function render() {
    const list = $("#session-manager-list");
    list.replaceChildren();
    for (const row of rows) {
      const label = document.createElement("label");
      label.className = "session-manager-row";
      const check = document.createElement("input");
      check.type = "checkbox"; check.value = row.path; check.checked = selected.has(row.path);
      check.setAttribute("aria-label", `选择会话：${row.name}`);
      check.onchange = () => { check.checked ? selected.set(row.path, row) : selected.delete(row.path); controls(); };
      const info = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = row.name + (unavailable(row) ? "（当前会话）" : "");
      const detail = document.createElement("small");
      detail.textContent = `${new Date(row.modified).toLocaleString()} · ${row.messageCount ?? row.count ?? 0} 条消息`;
      info.append(name, detail); label.append(check, info); list.append(label);
    }
    $("#session-manager-status").textContent = total ? `共 ${total} 个会话 · 第 ${Math.floor(offset / 30) + 1} 页` : "没有匹配的会话";
    controls();
  }
  async function load() {
    if (deleting) return;
    const request = ++revision;
    loading = true; controls();
    $("#session-manager-status").textContent = "正在加载…";
    try {
      const query = new URLSearchParams({ limit: "30", offset: String(offset), q: $("#session-manager-search").value.trim() });
      const from = $("#session-manager-from").value;
      const to = $("#session-manager-to").value;
      if (from && to && from > to) throw new Error("起始日期不能晚于结束日期");
      if (from) query.set("from", String(new Date(from + "T00:00:00").getTime()));
      if (to) { const end = new Date(to + "T00:00:00"); end.setDate(end.getDate() + 1); query.set("to", String(end.getTime())); }
      const response = await fetch(`/api/sessions?${query}`);
      const data = await response.json();
      if (request !== revision) return;
      if (!response.ok || !data.success) throw new Error(data.error || "加载失败");
      rows = data.data.sessions; total = data.data.total; nextOffset = data.data.nextOffset;
      loading = false; render();
    } catch (error) {
      if (request !== revision) return;
      rows = []; nextOffset = null;
      $("#session-manager-list").replaceChildren();
      $("#session-manager-status").textContent = `加载失败：${error.message}`;
    } finally { if (request === revision) { loading = false; controls(); } }
  }
  App.loadSessionManager = load;
  $("#session-manager-search").oninput = () => { clearTimeout(timer); offset = 0; ++revision; loading = true; controls(); timer = setTimeout(load, 250); };
  $("#session-manager-from").onchange = $("#session-manager-to").onchange = () => { offset = 0; load(); };
  $("#session-manager-clear").onclick = () => { selected.clear(); render(); };
  $("#session-manager-refresh").onclick = load;
  $("#session-manager-prev").onclick = () => { offset = Math.max(0, offset - 30); load(); };
  $("#session-manager-next").onclick = () => { if (nextOffset !== null) { offset = nextOffset; load(); } };
  $("#session-manager-all").onchange = event => {
    rows.filter(row => !unavailable(row)).forEach(row => event.target.checked ? selected.set(row.path, row) : selected.delete(row.path));
    render();
  };
  $("#session-manager-delete").onclick = async () => {
    if (loading || deleting || !selected.size) return;
    const targets = [...selected.values()].filter(row => !unavailable(row));
    deleting = true; controls();
    try {
      if (!await App.confirm({ title: "批量删除会话", message: `确定删除选中的 ${targets.length} 个会话？删除后无法恢复。`, confirmText: "删除", danger: true })) return;
      let removed = 0;
      const failed = [];
      for (const row of targets) {
        try {
          if (unavailable(row)) throw new Error("当前会话不可删除");
          const response = await fetch("/api/session/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: row.path }) });
          const data = await response.json();
          if (!response.ok || !data.success) throw new Error(data.error || "删除失败");
          removed++; selected.delete(row.path);
        } catch (error) { failed.push(`${row.name}：${error.message}`); }
        $("#session-manager-status").textContent = `已处理 ${removed + failed.length}/${targets.length}`;
      }
      deleting = false;
      offset = 0;
      await load();
      await App.refreshSessions(true);
      $("#session-manager-status").textContent = `已删除 ${removed} 个会话` + (failed.length ? `；${failed.length} 个失败：${failed.join("；")}` : "");
    } finally { deleting = false; controls(); }
  };
  $("#session-manager-export").onclick = async () => {
    if (loading || deleting || !selected.size) return;
    deleting = true; controls();
    try {
      const response = await fetch("/api/session/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [...selected.keys()] }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "导出失败");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `SapBuddy-sessions-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      App.showToast(`已导出 ${data.sessions.length} 个会话`);
    } catch (error) { App.showToast(error.message, true); }
    finally { deleting = false; controls(); }
  };
})();
