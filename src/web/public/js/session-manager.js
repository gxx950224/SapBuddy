"use strict";
(function () {
  const App = window.SapBuddy;
  const $ = App.$;
  const selected = new Set();
  let rows = [], offset = 0, nextOffset = null, total = 0, loading = false, deleting = false, revision = 0, timer;
  const unavailable = row => row.current || row.path === App.state.currentPath;
  function controls() {
    const eligible = rows.filter(row => !unavailable(row));
    const count = eligible.filter(row => selected.has(row.path)).length;
    $("#session-manager-all").checked = eligible.length > 0 && count === eligible.length;
    $("#session-manager-all").indeterminate = count > 0 && count < eligible.length;
    $("#session-manager-all").disabled = loading || deleting || !eligible.length;
    $("#session-manager-delete").disabled = loading || deleting || !selected.size;
    $("#session-manager-delete").textContent = `删除所选（${selected.size}）`;
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
      check.onchange = () => { check.checked ? selected.add(row.path) : selected.delete(row.path); controls(); };
      const info = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = row.name + (unavailable(row) ? "（当前会话）" : "");
      const detail = document.createElement("small");
      detail.textContent = `${new Date(row.modified).toLocaleString()} · ${row.count || 0} 条消息`;
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
      const response = await fetch(`/api/sessions?${query}`);
      const data = await response.json();
      if (request !== revision) return;
      if (!response.ok || !data.success) throw new Error(data.error || "加载失败");
      rows = data.data.sessions; total = data.data.total; nextOffset = data.data.nextOffset;
      selected.clear();
      loading = false; render();
    } catch (error) {
      if (request !== revision) return;
      rows = []; selected.clear(); nextOffset = null;
      $("#session-manager-list").replaceChildren();
      $("#session-manager-status").textContent = `加载失败：${error.message}`;
    } finally { if (request === revision) { loading = false; controls(); } }
  }
  App.loadSessionManager = load;
  $("#session-manager-search").oninput = () => { clearTimeout(timer); offset = 0; selected.clear(); ++revision; loading = true; controls(); timer = setTimeout(load, 250); };
  $("#session-manager-refresh").onclick = load;
  $("#session-manager-prev").onclick = () => { offset = Math.max(0, offset - 30); load(); };
  $("#session-manager-next").onclick = () => { if (nextOffset !== null) { offset = nextOffset; load(); } };
  $("#session-manager-all").onchange = event => {
    rows.filter(row => !unavailable(row)).forEach(row => event.target.checked ? selected.add(row.path) : selected.delete(row.path));
    render();
  };
  $("#session-manager-delete").onclick = async () => {
    if (loading || deleting || !selected.size) return;
    const targets = rows.filter(row => selected.has(row.path) && !unavailable(row));
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
})();
