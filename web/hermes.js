// Hermes import (Settings → Models → Hermes card): every Hermes profile becomes an employee, in the offices of an org file
// (offices + titles, the shape the Hermes Office Bridge keeps) when there is one. Kept in its own file; settings.js only calls
// window.hermesImportRow(p) while drawing the Hermes card.
(function () {
  let preview = null, previewFor = null, orgDraft = null, busy = false;
  let link = null, linkBusy = false;

  // office tools in the profiles (see hermes.ts, "link"): how many have them, and the buttons that add / remove them
  async function loadLink() {
    try { link = await api("GET", "/api/hermes/link"); } catch (e) { link = { error: e.message }; }
    const box = document.querySelector("[data-hermes-linkbox]");
    if (box) box.innerHTML = linkInner();
  }
  function linkText() {
    if (!link) return t("ui.settings.loading");
    if (link.error) return link.error;
    return t("ui.settings.models.hermes.linkStatus", { linked: link.linked, profiles: link.profiles });
  }

  async function loadPreview(org) {
    previewFor = org;
    try { preview = await api("GET", "/api/hermes/import" + (org ? "?orgFile=" + encodeURIComponent(org) : "")); }
    catch (e) { preview = { error: e.message }; }
    if (orgDraft === null && preview?.orgFile) orgDraft = preview.orgFile;
    const el = document.querySelector("[data-hermes-preview]");
    if (el) el.textContent = previewText();
    const inp = document.querySelector("[data-hermes-org]");
    if (inp && !inp.value && orgDraft) inp.value = orgDraft;
  }
  function previewText() {
    if (!preview) return t("ui.settings.loading");
    if (preview.error) return preview.error;
    return t("ui.settings.models.hermes.preview", { profiles: preview.profiles, offices: preview.offices, missing: preview.missing });
  }

  window.hermesImportRow = function (p) {
    if (!p.connected) return "";
    const org = orgDraft ?? "";
    if (preview === null || previewFor !== org) loadPreview(org);
    return `<div class="prov-key hermes-import">
        <label><span>${escapeHtml(t("ui.settings.models.hermes.org"))}</span><input type="text" dir="ltr" data-hermes-org value="${escapeHtml(org)}" placeholder="${escapeHtml(t("ui.settings.models.hermes.orgPh"))}" /></label>
        <button class="btn small primary" data-hermes="import" ${busy ? "disabled" : ""}>${escapeHtml(t(busy ? "ui.settings.models.hermes.importing" : "ui.settings.models.hermes.import"))}</button>
      </div>
      <small class="muted prov-hint">${escapeHtml(t("ui.settings.models.hermes.hint"))}</small>
      <small class="muted prov-hint" data-hermes-preview>${escapeHtml(previewText())}</small>
      ${linkRow()}`;
  };
  function linkRow() {
    if (link === null) loadLink();
    return `<div data-hermes-linkbox>${linkInner()}</div>`;
  }
  function linkInner() {
    const dis = linkBusy || !link || link.error || !link.profiles ? "disabled" : "";
    return `<div class="prov-key hermes-link"><label><span>${escapeHtml(t("ui.settings.models.hermes.linkTitle"))}</span>
        <small class="muted" data-hermes-link>${escapeHtml(linkText())}</small></label>
        <button class="btn small primary" data-hermes="link" ${dis}>${escapeHtml(t(linkBusy ? "ui.settings.models.hermes.linking" : "ui.settings.models.hermes.link"))}</button>
        ${link && link.linked ? `<button class="btn small ghost" data-hermes="unlink" ${dis}>${escapeHtml(t("ui.settings.models.hermes.unlink"))}</button>` : ""}
      </div>
      <small class="muted prov-hint">${escapeHtml(t("ui.settings.models.hermes.linkHint"))}</small>`;
  }
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-hermes="link"], [data-hermes="unlink"]');
    if (!btn || linkBusy) return;
    const action = btn.dataset.hermes;
    if (!confirm(t(action === "link" ? "ui.settings.models.hermes.linkConfirm" : "ui.settings.models.hermes.unlinkConfirm"))) return;
    linkBusy = true; btn.disabled = true; btn.textContent = t("ui.settings.models.hermes.linking");
    try {
      const r = await api("POST", "/api/hermes/link", { action });
      toast(r.failed?.length
        ? t("ui.settings.models.hermes.linkFailed", { n: r.failed.length, list: r.failed.map((f) => `${f.profile} (${f.error})`).join("، ").slice(0, 300) })
        : t("ui.settings.models.hermes.linkDone", { done: r.done }));
    } catch (e) { toast(e.message); }
    linkBusy = false;
    await loadLink();
  });

  document.addEventListener("change", (ev) => {
    const inp = ev.target.closest && ev.target.closest("[data-hermes-org]");
    if (!inp) return;
    orgDraft = inp.value.trim();
    loadPreview(orgDraft);
  });
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-hermes="import"]');
    if (!btn || busy) return;
    const inp = document.querySelector("[data-hermes-org]");
    orgDraft = inp ? inp.value.trim() : orgDraft;
    busy = true; btn.disabled = true; btn.textContent = t("ui.settings.models.hermes.importing");
    try {
      const r = await api("POST", "/api/hermes/import", orgDraft ? { orgFile: orgDraft } : {});
      toast(r.added ? t("ui.settings.models.hermes.done", { added: r.added, offices: r.offices }) : t("ui.settings.models.hermes.none"));
    } catch (e) { toast(e.message); }
    busy = false; btn.disabled = false; btn.textContent = t("ui.settings.models.hermes.import");
    loadPreview(orgDraft || "");
    loadLink();
  });
})();
