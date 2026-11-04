// Group chats (src/server/groups.ts): a 💬 button in the strip opens a messaging window. The boss and employees from any
// office talk in one conversation; @name asks someone to answer, @all / @الكل asks everyone. Live updates arrive on the
// office's websocket as "group", "group_message" and "group_removed". Kept in its own file; index.html only loads it.
(function () {
  const G = { list: [], cur: null, msgs: new Map(), view: "chat", edit: null };
  const SEEN = "po.groups.seen";
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(SEEN) || "{}") || {}; } catch {}
  const saveSeen = () => { try { localStorage.setItem(SEEN, JSON.stringify(seen)); } catch {} };

  // ---- the button and the window ----
  const anchor = document.getElementById("btnInbox");
  const btn = document.createElement("button");
  btn.className = "icon-btn small strip-btn"; btn.id = "btnGroups"; btn.type = "button"; btn.title = t("ui.groups.btnTip");
  btn.innerHTML = '💬<span class="badge" id="groupsBadge" hidden></span>';
  if (anchor) anchor.parentNode.insertBefore(btn, anchor); else document.body.appendChild(btn);

  const modal = document.createElement("div");
  modal.className = "modal"; modal.id = "groupsModal"; modal.hidden = true;
  modal.innerHTML = `<div class="modal-card gr-card">
      <div class="modal-head"><h2>${escapeHtml(t("ui.groups.title"))}</h2>
        <div class="gr-head-actions">
          <button class="btn small ghost" data-g="fromOffices">${escapeHtml(t("ui.groups.fromOffices"))}</button>
          <button class="btn small primary" data-g="new">+ ${escapeHtml(t("ui.groups.newGroup"))}</button>
          <button class="icon-btn" data-g="close">×</button>
        </div></div>
      <div class="gr-body"><div class="gr-list" id="grList"></div><div class="gr-chat" id="grPane"></div></div>
    </div>`;
  document.body.appendChild(modal);
  const $g = (id) => document.getElementById(id);

  const open = () => !modal.hidden;
  async function show() { modal.hidden = false; await loadList(); if (!G.cur && G.list[0]) select(G.list[0].id); else render(); }
  function hide() { modal.hidden = true; }

  // ---- data ----
  async function loadList() { try { G.list = (await api("GET", "/api/groups")).groups || []; } catch (e) { toast(e.message); } render(); }
  async function select(id) {
    G.cur = id; G.view = "chat";
    try { const r = await api("GET", `/api/groups/${encodeURIComponent(id)}`); G.msgs.set(id, r.messages || []); upsert(r); } catch (e) { toast(e.message); }
    markSeen(id); render(); scrollEnd();
  }
  function upsert(s) { const i = G.list.findIndex((g) => g.id === s.id); const { messages, ...sum } = s; if (i >= 0) G.list[i] = sum; else G.list.unshift(sum); }
  const cur = () => G.list.find((g) => g.id === G.cur);
  const unread = (g) => Math.max(0, (g.count || 0) - (seen[g.id] || 0));
  function markSeen(id) { const g = G.list.find((x) => x.id === id); if (g) { seen[id] = g.count || 0; saveSeen(); } badge(); }
  function badge() {
    const n = G.list.reduce((s, g) => s + (g.id === G.cur && open() ? 0 : unread(g)), 0);
    const b = $g("groupsBadge"); if (!b) return;
    b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n);
  }

  // ---- render ----
  const time = (ts) => { try { return new Date(ts).toLocaleTimeString(PO.locale, { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const withMentions = (s) => escapeHtml(s).replace(/(^|\s)(@[^\s@،,.:!?؟]+)/g, '$1<span class="mention">$2</span>');
  function render() { if (!open()) { badge(); return; } renderList(); renderPane(); }
  function renderList() {
    const list = $g("grList");
    if (!list) return;
    list.innerHTML = G.list.length ? G.list.map((g) => {
      const n = unread(g);
      return `<button class="gr-item ${g.id === G.cur ? "on" : ""}" data-gid="${escapeHtml(g.id)}">
          <span class="gr-ava">${escapeHtml((g.name || "?").trim().charAt(0))}</span>
          <span><b>${n && g.id !== G.cur ? `<span class="gr-unread">${n}</span>` : ""}${escapeHtml(g.name)}</b>
          <small>${g.typing?.length ? escapeHtml(t("ui.groups.typing", { names: g.typing.join("، ") })) : g.last ? escapeHtml(`${g.last.name ? g.last.name + ": " : ""}${g.last.text}`) : escapeHtml(t("ui.groups.membersN", { n: g.members.length }))}</small></span>
        </button>`;
    }).join("") : `<div class="gr-empty">${escapeHtml(t("ui.groups.empty"))}</div>`;
    badge();
  }
  function renderPane() {
    const pane = $g("grPane");
    if (G.view === "form") { pane.innerHTML = formHtml(); return; }
    const g = cur();
    if (!g) { pane.innerHTML = `<div class="gr-empty">${escapeHtml(t(G.list.length ? "ui.groups.pick" : "ui.groups.empty"))}</div>`; return; }
    const msgs = G.msgs.get(g.id) || [];
    pane.innerHTML = `<div class="gr-chat-head"><div><b>${escapeHtml(g.name)}</b>
          <small>${escapeHtml(g.members.filter((m) => !m.gone).map((m) => m.name).join("، "))}</small></div>
        <div class="gr-head-actions">${g.paused ? `<span class="gr-paused">${escapeHtml(t("ui.groups.paused"))}</span>` : ""}
          <button class="btn small ghost" data-g="edit">${escapeHtml(t("ui.groups.edit"))}</button></div></div>
      <div class="gr-msgs" id="grMsgs">${msgs.map(msgHtml).join("")}</div>
      <div class="gr-typing" id="grTyping">${g.typing?.length ? escapeHtml(t("ui.groups.typing", { names: g.typing.join("، ") })) : ""}</div>
      <div class="gr-hint">${escapeHtml(t("ui.groups.hint"))}</div>
      <form class="gr-input" id="grForm"><textarea id="grText" rows="1" placeholder="${escapeHtml(t("ui.groups.inputPh"))}"></textarea>
        <button class="btn primary" type="submit">${escapeHtml(t("ui.groups.send"))}</button></form>`;
    $g("grText")?.focus();
    badge();
  }
  function msgHtml(m) {
    if (m.from === "system") return `<div class="gr-msg system">${escapeHtml(m.text)}</div>`;
    const boss = m.from === "boss";
    return `<div class="gr-msg ${boss ? "boss" : ""}"><span class="gr-from" style="${!boss && m.color ? `color:${escapeHtml(m.color)}` : ""}">${escapeHtml(boss ? t("ui.groups.you") : m.name)}</span>${withMentions(m.text)}<time>${escapeHtml(time(m.ts))}</time></div>`;
  }
  function scrollEnd() { const el = $g("grMsgs"); if (el) el.scrollTop = el.scrollHeight; }

  // ---- create / edit ----
  function formHtml() {
    const e = G.edit || { name: "", members: [], lead: "" };
    const chosen = new Set(e.members.map((m) => `${m.office}/${m.emp}`));
    const offices = [...state.offices.values()];
    return `<form class="gr-form" id="grEdit">
        <label><span>${escapeHtml(t("ui.groups.name"))}</span><input type="text" id="grName" maxlength="60" value="${escapeHtml(e.name)}" /></label>
        <div><span class="muted" style="font-size:12px">${escapeHtml(t("ui.groups.members"))}</span>
        ${offices.map((o) => `<div class="gr-office"><b>${escapeHtml(o.info.name)}</b><div class="gr-people">
            ${[...o.employees.values()].map((p) => { const k = `${o.info.id}/${p.id}`; return `<label class="gr-person" title="${escapeHtml(p.role || "")}"><input type="checkbox" data-member="${escapeHtml(k)}" ${chosen.has(k) ? "checked" : ""} />${escapeHtml(p.name)}</label>`; }).join("")}
          </div></div>`).join("")}</div>
        <label><span>${escapeHtml(t("ui.groups.lead"))}</span><select id="grLead"></select></label>
      </form>
      <div class="gr-form-actions">
        ${e.id ? `<button class="btn small ghost" data-g="delete" style="margin-inline-end:auto">${escapeHtml(t("ui.groups.delete"))}</button>` : ""}
        <button class="btn small ghost" data-g="cancel">${escapeHtml(t("ui.groups.cancel"))}</button>
        <button class="btn small primary" data-g="saveForm">${escapeHtml(t(e.id ? "ui.groups.save" : "ui.groups.create"))}</button>
      </div>`;
  }
  function picked() { return [...document.querySelectorAll("#grEdit [data-member]:checked")].map((c) => { const [office, ...rest] = c.dataset.member.split("/"); return { office, emp: rest.join("/") }; }); }
  function fillLead() {
    const sel = $g("grLead"); if (!sel) return;
    const want = sel.value || G.edit?.lead || "";
    const names = new Map([...state.offices.values()].flatMap((o) => [...o.employees.values()].map((p) => [`${o.info.id}/${p.id}`, `${p.name} — ${o.info.name}`])));
    sel.innerHTML = picked().map((m) => { const k = `${m.office}/${m.emp}`; return `<option value="${escapeHtml(k)}" ${k === want ? "selected" : ""}>${escapeHtml(names.get(k) || k)}</option>`; }).join("");
  }
  function openForm(g) { G.view = "form"; G.edit = g ? { id: g.id, name: g.name, members: g.members.map((m) => ({ office: m.office, emp: m.emp })), lead: g.lead } : null; render(); fillLead(); $g("grName")?.focus(); }

  // ---- events ----
  btn.onclick = () => (open() ? hide() : show());
  modal.addEventListener("click", async (ev) => {
    if (ev.target === modal) return hide();
    const item = ev.target.closest("[data-gid]");
    if (item) return select(item.dataset.gid);
    const a = ev.target.closest("[data-g]")?.dataset.g;
    if (!a) return;
    if (a === "close") hide();
    else if (a === "new") openForm(null);
    else if (a === "edit") openForm(cur());
    else if (a === "cancel") { G.view = "chat"; render(); }
    else if (a === "fromOffices") {
      try { const r = await api("POST", "/api/groups/from-offices"); toast(t("ui.groups.fromOfficesDone", { n: r.added })); await loadList(); if (!G.cur && G.list[0]) select(G.list[0].id); } catch (e) { toast(e.message); }
    } else if (a === "delete") {
      const g = cur(); if (!g || !confirm(t("ui.groups.deleteConfirm", { name: g.name }))) return;
      try { await api("DELETE", `/api/groups/${encodeURIComponent(g.id)}`); G.list = G.list.filter((x) => x.id !== g.id); G.cur = G.list[0]?.id ?? null; G.view = "chat"; if (G.cur) select(G.cur); else render(); } catch (e) { toast(e.message); }
    } else if (a === "saveForm") {
      const body = { name: $g("grName").value.trim(), members: picked(), lead: $g("grLead").value };
      try {
        const r = G.edit?.id ? await api("PUT", `/api/groups/${encodeURIComponent(G.edit.id)}`, body) : await api("POST", "/api/groups", body);
        upsert(r); G.edit = null; select(r.id);
      } catch (e) { toast(e.message); }
    }
  });
  modal.addEventListener("change", (ev) => { if (ev.target.matches("[data-member]")) fillLead(); });
  modal.addEventListener("submit", async (ev) => {
    if (ev.target.id !== "grForm") return;
    ev.preventDefault();
    const box = $g("grText"), text = box.value.trim(), g = cur();
    if (!text || !g) return;
    box.value = "";
    try { await api("POST", `/api/groups/${encodeURIComponent(g.id)}/messages`, { text }); } catch (e) { toast(e.message); box.value = text; }
  });
  modal.addEventListener("keydown", (ev) => {
    if (ev.target.id === "grText" && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $g("grForm").requestSubmit(); }
    if (ev.key === "Escape") hide();
  });

  // ---- live updates from the office's websocket ----
  const prevHandle = window.handle;
  window.handle = handle = function (m) {
    if (m && m.type === "group") {
      upsert(m.group);
      if (open()) {
        if (m.group.id === G.cur && G.view === "chat") {
          const el = $g("grTyping"); if (el) el.textContent = m.group.typing?.length ? t("ui.groups.typing", { names: m.group.typing.join("، ") }) : "";
          const head = document.querySelector(".gr-chat-head .gr-head-actions");
          const p = head?.querySelector(".gr-paused");
          if (head && !!p !== !!m.group.paused) { if (p) p.remove(); else head.insertAdjacentHTML("afterbegin", `<span class="gr-paused">${escapeHtml(t("ui.groups.paused"))}</span>`); }
        }
        const list = $g("grList"); const keep = list?.scrollTop; renderList(); if (list) list.scrollTop = keep;
      }
      if (m.group.id === G.cur && open()) markSeen(G.cur); else badge();
      return;
    }
    if (m && m.type === "group_message") {
      const arr = G.msgs.get(m.group); if (arr) arr.push(m.message);
      if (open() && m.group === G.cur && G.view === "chat") { const el = $g("grMsgs"); if (el) { const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80; el.insertAdjacentHTML("beforeend", msgHtml(m.message)); if (near) scrollEnd(); } }
      return;
    }
    if (m && m.type === "group_removed") { G.list = G.list.filter((g) => g.id !== m.id); if (G.cur === m.id) G.cur = null; render(); return; }
    return prevHandle(m);
  };

  loadList();
})();
