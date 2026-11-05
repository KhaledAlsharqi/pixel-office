// Advisory Council (src/server/council.ts): a 🏛️ button in the strip opens it. A consultation is a brief (goal, situation,
// constraints, what was tried, what is wanted); the advisors answer alone, review each other blind, revise once, and the chair
// writes the report. Live progress arrives on the office websocket as "council" / "council_removed". Kept in its own file.
(function () {
  const C = { list: [], cur: null, view: "list", full: null, cfg: null, problem: null, timer: null };
  const T = (k, v) => t(`ui.council.${k}`, v);
  const DONE = new Set(["done", "failed", "stopped"]);
  const STAGES = ["intake", "answering", "reviewing", "revising", "synthesizing", "done"];

  // ---- button and window ----
  const anchor = document.getElementById("btnGroups") || document.getElementById("btnInbox");
  const btn = document.createElement("button");
  btn.className = "icon-btn small strip-btn"; btn.id = "btnCouncil"; btn.type = "button"; btn.title = T("btnTip");
  btn.innerHTML = '🏛️<i class="strip-dot" id="councilDot" hidden></i>';
  if (anchor) anchor.parentNode.insertBefore(btn, anchor); else document.body.appendChild(btn);
  const modal = document.createElement("div");
  modal.className = "modal"; modal.id = "councilModal"; modal.hidden = true;
  modal.innerHTML = `<div class="modal-card co-card">
      <div class="modal-head"><h2>${escapeHtml(T("title"))}</h2>
        <div class="gr-head-actions">
          <button class="btn small ghost" data-c="settings">⚙ ${escapeHtml(T("settings"))}</button>
          <button class="btn small primary" data-c="new">+ ${escapeHtml(T("new"))}</button>
          <button class="icon-btn" data-c="close">×</button>
        </div></div>
      <div class="co-body"><div class="co-list" id="coList"></div><div class="co-pane" id="coPane"></div></div>
    </div>`;
  document.body.appendChild(modal);
  const $c = (id) => document.getElementById(id);
  const open = () => !modal.hidden;

  async function load() {
    try { const r = await api("GET", "/api/council"); C.list = r.sessions || []; C.cfg = r.config; C.problem = r.problem; } catch (e) { toast(e.message); }
    dot();
  }
  async function show() { modal.hidden = false; await load(); if (!C.cur && C.list[0]) return select(C.list[0].id); if (!C.list.length) C.view = C.problem ? "settings" : "new"; render(); }
  async function select(id) {
    C.cur = id; C.view = "session";
    try { C.full = await api("GET", `/api/council/sessions/${encodeURIComponent(id)}`); } catch (e) { toast(e.message); }
    render();
  }
  function dot() { const d = $c("councilDot"); if (d) d.hidden = !C.list.some((s) => !DONE.has(s.status)); }

  // ---- render ----
  const dotClass = (st) => (st === "done" ? "ok" : st === "failed" ? "bad" : st === "needs_info" ? "ask" : st === "stopped" ? "" : "run");
  const when = (ts) => { try { return new Date(ts).toLocaleString(PO.locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  function render() { if (!open()) return; renderList(); renderPane(); }
  function renderList() {
    if (!open()) return;
    $c("coList").innerHTML = C.list.length ? C.list.map((s) => `<button class="co-item ${s.id === C.cur && C.view === "session" ? "on" : ""}" data-sid="${escapeHtml(s.id)}">
        <b><i class="co-dot ${dotClass(s.status)}"></i>${escapeHtml(s.title)}</b>
        <small>${escapeHtml(s.company || "")} · ${escapeHtml(T(`status.${s.status}`))} · ${escapeHtml(when(s.created))}</small></button>`).join("")
      : `<div class="co-empty">${escapeHtml(T("empty"))}</div>`;
  }
  function renderPane() {
    const pane = $c("coPane");
    if (C.view === "new") pane.innerHTML = formHtml();
    else if (C.view === "settings") { pane.innerHTML = settingsHtml(); fillChair(); }
    else if (C.view === "session" && C.full) pane.innerHTML = sessionHtml(C.full);
    else pane.innerHTML = `<div class="co-empty">${escapeHtml(T("empty"))}</div>`;
  }

  function formHtml() {
    const offices = [...state.offices.values()].map((o) => o.info.name);
    const cur = state.offices.get(state.office)?.info.name || "";
    const ta = (id, label, ph, rows = 3) => `<label><span>${escapeHtml(T(label))}</span><textarea id="${id}" rows="${rows}" placeholder="${escapeHtml(ph ? T(ph) : "")}"></textarea></label>`;
    return `<form class="co-form" id="coForm">
      ${C.problem ? `<div class="co-problem">${escapeHtml(C.problem)}</div>` : ""}
      <div class="co-row">
        <label><span>${escapeHtml(T("company"))}</span><select id="coCompany">${offices.map((n) => `<option ${n === cur ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select></label>
        <label><span>${escapeHtml(T("mode"))}</span><select id="coMode"><option value="full" ${C.cfg?.mode !== "quick" ? "selected" : ""}>${escapeHtml(T("full"))}</option><option value="quick" ${C.cfg?.mode === "quick" ? "selected" : ""}>${escapeHtml(T("quick"))}</option></select></label>
      </div>
      <label><span>${escapeHtml(T("titleF"))}</span><input type="text" id="coTitle" maxlength="120" /></label>
      ${ta("coGoal", "goal", "goalPh", 2)}${ta("coSituation", "situation", "situationPh", 5)}
      <div class="co-row">${ta("coConstraints", "constraints", "constraintsPh", 3)}${ta("coTried", "tried", "triedPh", 3)}</div>
      ${ta("coWanted", "wanted", "wantedPh", 2)}${ta("coOwner", "ownerView", "ownerViewPh", 2)}
      <label class="co-hint" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="coCompare" /> ${escapeHtml(T("compare"))}</label>
      <div class="co-hint">${escapeHtml(T("hint"))}</div>
      <div class="co-actions"><button class="btn primary" type="submit" ${C.problem ? "disabled" : ""}>${escapeHtml(T("submit"))}</button></div>
    </form>`;
  }

  function people() { return [...state.offices.values()].map((o) => ({ office: o.info, emps: [...o.employees.values()] })); }
  // "hermes:gm" says little: the page's model list knows the profile's own model ("gm · gpt-5.5")
  const modelOf = (m) => { if (!m) return ""; const x = (PO.extraModels || []).find((e) => e.id === m); return x?.desc ? x.desc.split(" · ").slice(1).join(" · ") || m : m; };
  function settingsHtml() {
    const cfg = C.cfg || { members: [], internal: "en", reasoning: "high", mode: "full", turnMinutes: 20 };
    const chosen = new Set(cfg.members.map((m) => m.key));
    return `<div class="co-form" id="coSettings">
      ${C.problem ? `<div class="co-problem">${escapeHtml(C.problem)}</div>` : ""}
      <div><span class="muted" style="font-size:12px">${escapeHtml(T("members"))}</span>
        ${people().map((o) => `<div class="co-office"><b>${escapeHtml(o.office.name)}</b><div class="co-pick">${o.emps.map((e) => {
          const k = `${o.office.id}/${e.id}`;
          return `<label title="${escapeHtml(e.role || "")}"><input type="checkbox" data-member="${escapeHtml(k)}" ${chosen.has(k) ? "checked" : ""} />${escapeHtml(e.name)} <small>${escapeHtml(modelOf(e.model))}</small></label>`;
        }).join("")}</div></div>`).join("")}</div>
      <div class="co-row">
        <label><span>${escapeHtml(T("chair"))}</span><select id="coChair" data-want="${escapeHtml(cfg.chairman?.key || "")}"></select></label>
        <label><span>${escapeHtml(T("shariaRev"))}</span><select id="coSharia" data-want="${escapeHtml(cfg.sharia?.key || "")}"></select></label>
      </div>
      <div class="co-row">
        <label><span>${escapeHtml(T("internal"))}</span><select id="coInternal"><option value="en" ${cfg.internal !== "ar" ? "selected" : ""}>${escapeHtml(T("internalEn"))}</option><option value="ar" ${cfg.internal === "ar" ? "selected" : ""}>${escapeHtml(T("internalAr"))}</option></select></label>
        <label><span>${escapeHtml(T("reasoning"))}</span><select id="coReasoning">${["medium", "high", "xhigh", "max"].map((r) => `<option ${r === cfg.reasoning ? "selected" : ""}>${r}</option>`).join("")}</select></label>
      </div>
      <div class="co-row">
        <label><span>${escapeHtml(T("defaultMode"))}</span><select id="coDefMode"><option value="full" ${cfg.mode !== "quick" ? "selected" : ""}>${escapeHtml(T("full"))}</option><option value="quick" ${cfg.mode === "quick" ? "selected" : ""}>${escapeHtml(T("quick"))}</option></select></label>
        <label><span>${escapeHtml(T("turnMinutes"))}</span><input type="text" id="coMinutes" value="${escapeHtml(String(cfg.turnMinutes || 20))}" /></label>
      </div>
      <div class="co-hint">${escapeHtml(T("hint"))}</div>
      <div class="co-actions"><button class="btn small ghost" data-c="office">${escapeHtml(T("makeOffice"))}</button><button class="btn small primary" data-c="saveCfg">${escapeHtml(T("save"))}</button></div>
    </div>`;
  }
  // the chair and the sharia reviewer are picked from everybody (the chair is not an advisor)
  function fillChair() {
    const opts = people().flatMap((o) => o.emps.map((e) => [`${o.office.id}/${e.id}`, `${e.name} — ${o.office.name}${e.model ? ` (${modelOf(e.model)})` : ""}`]));
    for (const id of ["coChair", "coSharia"]) {
      const sel = $c(id); if (!sel) continue;
      const want = sel.dataset.want;
      sel.innerHTML = `<option value="">${escapeHtml(T("none"))}</option>` + opts.map(([k, n]) => `<option value="${escapeHtml(k)}" ${k === want ? "selected" : ""}>${escapeHtml(n)}</option>`).join("");
    }
  }
  const refOf = (k) => { if (!k) return null; const i = k.indexOf("/"); return { office: k.slice(0, i), emp: k.slice(i + 1) }; };

  function sessionHtml(s) {
    const reached = s.status === "needs_info" ? 0 : Math.max(0, STAGES.indexOf(s.status === "sharia" ? "synthesizing" : s.status));
    const stages = STAGES.filter((st) => s.mode === "full" || (st !== "reviewing" && st !== "revising")).map((st) => {
      const i = STAGES.indexOf(st);
      const cls = s.status === "done" || i < reached ? "done" : i === reached && !DONE.has(s.status) ? "now" : "";
      return `<span class="co-stage ${cls}">${escapeHtml(T(`status.${st}`))}</span>`;
    }).join("");
    const r = s.roles || {};
    const live = !DONE.has(s.status);
    return `<div class="co-head"><div><h3>${escapeHtml(s.title)}</h3>
        <small>${escapeHtml(s.company || "")} · ${escapeHtml(T(s.mode === "quick" ? "quick" : "full"))} · ${escapeHtml(when(s.created))}</small>
        <small>${escapeHtml(T("roles", { chair: r.chairman?.name || "-", critic: r.critic?.name || "-", fact: r.fact?.name || "-" }))}</small></div>
        <div class="gr-head-actions">${live ? `<button class="btn small co-stop" data-c="stop">⏹ ${escapeHtml(T("stop"))}</button>` : `<button class="btn small ghost" data-c="delete">${escapeHtml(T("delete"))}</button>`}</div></div>
      <div class="co-stages">${stages}</div>
      <div class="co-people">${(s.members || []).map((m) => `<span class="co-person ${s.working?.includes(m.name) ? "busy" : m.first?.error ? "bad" : ""}" title="${escapeHtml(m.model || "")}">${m.final ? "✓✓ " : m.first?.done ? "✓ " : m.first?.error ? "✗ " : ""}${escapeHtml(m.name)}</span>`).join("")}</div>
      ${s.working?.length ? `<div class="co-hint">${escapeHtml(T("working", { names: s.working.join("، ") }))}</div>` : ""}
      ${s.status === "failed" && s.error ? `<div class="co-problem">${escapeHtml(s.error)}</div>` : ""}
      ${s.status === "needs_info" ? `<div class="co-box"><b>${escapeHtml(T("questions"))}</b><ol>${(s.questions || []).map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ol>
          <div class="co-form"><textarea id="coAnswers" rows="4" placeholder="${escapeHtml(T("answersPh"))}"></textarea>
          <div class="co-actions"><button class="btn small ghost" data-c="skip">${escapeHtml(T("skip"))}</button><button class="btn small primary" data-c="answer">${escapeHtml(T("continue"))}</button></div></div></div>` : ""}
      ${s.agreement ? `<div class="co-hint">${escapeHtml(T("agreement", { agree: T(s.agreement.agree ? "agreeYes" : "agreeNo"), why: s.agreement.why || "" }))}</div>` : ""}
      ${s.ownerView ? `<div class="co-box"><b>${escapeHtml(T("yourView"))}</b><div class="co-report">${md(s.ownerView)}</div></div>` : ""}
      ${s.report ? `<div class="co-box"><b>${escapeHtml(T("report"))}</b><div class="co-report">${md(s.report)}</div></div>` : ""}
      ${s.shariaNotes ? `<div class="co-box"><b>${escapeHtml(T("shariaNotes"))}</b><div class="co-report">${md(s.shariaNotes)}</div></div>` : ""}
      ${s.answers?.length ? `<div class="co-box co-ans"><b>${escapeHtml(T("answers"))}</b>${s.answers.map((a) => `<details><summary>${escapeHtml(a.name)} <small class="muted">${escapeHtml(a.model || "")}</small></summary>
          <div class="co-report"><b>${escapeHtml(T("first"))}</b>${md(a.first || "-")}${a.final && a.final !== a.first ? `<b>${escapeHtml(T("final"))}</b>${md(a.final)}` : ""}</div></details>`).join("")}</div>` : ""}
      ${s.baseline ? `<div class="co-box co-ans"><b>${escapeHtml(T("baseline", { name: s.roles?.chairman?.name || "" }))}</b><details><summary>${escapeHtml(T("baselineOpen"))}</summary><div class="co-report">${md(s.baseline)}</div></details></div>` : ""}
      ${s.exportFile ? `<div class="co-hint" dir="ltr">${escapeHtml(T("export", { file: s.exportFile }))}</div>` : ""}`;
  }

  // ---- events ----
  btn.onclick = () => (open() ? (modal.hidden = true) : show());
  modal.addEventListener("click", async (ev) => {
    if (ev.target === modal) { modal.hidden = true; return; }
    const item = ev.target.closest("[data-sid]");
    if (item) return select(item.dataset.sid);
    const a = ev.target.closest("[data-c]")?.dataset.c;
    if (!a) return;
    const s = C.full;
    try {
      if (a === "close") modal.hidden = true;
      else if (a === "new") { C.view = "new"; render(); }
      else if (a === "settings") { C.view = "settings"; await load(); render(); }
      else if (a === "saveCfg") {
        const members = [...document.querySelectorAll("#coSettings [data-member]:checked")].map((c) => refOf(c.dataset.member));
        const r = await api("PUT", "/api/council/config", { members, chairman: refOf($c("coChair").value), sharia: refOf($c("coSharia").value), internal: $c("coInternal").value, reasoning: $c("coReasoning").value, mode: $c("coDefMode").value, turnMinutes: Number($c("coMinutes").value) });
        C.cfg = r.config; C.problem = r.problem; toast(r.problem || T("saved")); render();
      } else if (a === "office") { await api("POST", "/api/council/office"); toast(T("officeMade")); await load(); render(); }
      else if (a === "stop" && s) { await api("POST", `/api/council/sessions/${encodeURIComponent(s.id)}/stop`); }
      else if (a === "delete" && s) { if (!confirm(T("deleteConfirm"))) return; await api("DELETE", `/api/council/sessions/${encodeURIComponent(s.id)}`); C.cur = null; C.full = null; await load(); C.view = "new"; render(); }
      else if ((a === "answer" || a === "skip") && s) { await api("POST", `/api/council/sessions/${encodeURIComponent(s.id)}/answers`, { text: a === "answer" ? $c("coAnswers").value : "" }); }
    } catch (e) { toast(e.message); }
  });
  modal.addEventListener("submit", async (ev) => {
    if (ev.target.id !== "coForm") return;
    ev.preventDefault();
    const v = (id) => $c(id).value.trim();
    try {
      const r = await api("POST", "/api/council/sessions", { company: v("coCompany"), mode: v("coMode"), title: v("coTitle"), goal: v("coGoal"), situation: v("coSituation"), constraints: v("coConstraints"), tried: v("coTried"), wanted: v("coWanted"), ownerView: v("coOwner"), compare: $c("coCompare").checked });
      await load(); C.cur = r.id; C.full = r; C.view = "session"; render();
    } catch (e) { toast(e.message); }
  });
  modal.addEventListener("keydown", (ev) => { if (ev.key === "Escape") modal.hidden = true; });

  // ---- live progress ----
  const prev = window.handle;
  window.handle = handle = function (m) {
    if (m && m.type === "council") {
      const i = C.list.findIndex((x) => x.id === m.session.id);
      if (i >= 0) C.list[i] = m.session; else C.list.unshift(m.session);
      dot();
      if (open() && m.session.id === C.cur && C.view === "session") {
        // the full record is fetched again, at most twice a second, so typing in the answers box is not disturbed
        clearTimeout(C.timer);
        C.timer = setTimeout(async () => {
          const typing = document.activeElement?.id === "coAnswers" ? document.activeElement.value : null;
          try { C.full = await api("GET", `/api/council/sessions/${encodeURIComponent(C.cur)}`); } catch {}
          render();
          if (typing !== null && $c("coAnswers")) { $c("coAnswers").value = typing; $c("coAnswers").focus(); }
        }, 500);
      } else renderList(); // a form being filled is left alone
      return;
    }
    if (m && m.type === "council_removed") { C.list = C.list.filter((x) => x.id !== m.id); dot(); if (C.cur === m.id) { C.cur = null; C.full = null; C.view = "new"; render(); } else renderList(); return; }
    return prev(m);
  };
  load();
})();
