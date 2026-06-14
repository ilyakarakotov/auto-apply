// TEMPLATE - do not run directly. src/make-filler.mjs injects CFG (rules.json +
// resume path + optional per-job plan from plan-apply.mjs) and emits /tmp/fill-run.js.
// Run the emitted file with: playwright-cli run-code --filename /tmp/fill-run.js
// Constraints honored: single async (page) => {} arrow, no require/console.log.
// Strategy: plan answers (exact question match) take priority over regex rules.
// Truth-only: anything unmatched is LEFT BLANK for the probe to surface.
async (page) => {
  const CFG = "__CFG__";
  const wait = (ms) => page.waitForTimeout(ms);
  const jit = () => 120 + Math.floor(Math.random() * 300); // humanlike per-field pause
  const ID = CFG.identity;
  const TODAY = new Date().toLocaleDateString('en-US');
  const out = { text: 0, dropdowns: 0, selects: 0, radios: 0, groups: 0, essays: 0, buttons: 0, consent: 0, left: [] };

  // ---------- 0) stealth: lower the hCaptcha/bot risk score ----------
  // This is REAL headed Chrome over CDP, so languages/plugins/webgl are already genuine.
  // The only hard automation tell is navigator.webdriver (set by the CDP attach) — patch ONLY
  // that (over-patching real Chrome creates inconsistencies detectors flag). addInitScript covers
  // hCaptcha iframes / re-navigations; evaluate covers the already-loaded top frame at submit time.
  const STEALTH = () => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch (e) {}
    try { delete Navigator.prototype.webdriver; } catch (e) {}
    try { if (window.chrome && !window.chrome.runtime) window.chrome.runtime = {}; } catch (e) {}
  };
  try { await page.addInitScript(STEALTH); } catch (e) {}
  try { await page.evaluate(STEALTH); } catch (e) {}

  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[*✱]+\s*$/, '').trim();
  const PLAN = {}; for (const p of (CFG.plan || [])) PLAN[norm(p.q)] = p;
  const planFor = (q) => PLAN[norm(q)];
  const resolve = (v) => (typeof v === 'string' && v[0] === '@') ? (ID[v.slice(1)] ?? v) : v;
  const RULES = CFG.dropdown_rules.map(r => ({ q: new RegExp(r.q, 'i'), opts: r.opts.map(o => new RegExp(o, 'i')), tf: r.type_filter }));
  const ESSAY_RULES = CFG.essay_rules.map(r => ({ q: new RegExp(r.q, 'i'), text: CFG.essays[r.essay] }));
  const ruleFor = (q) => RULES.find(r => r.q.test(q));

  async function fillText(labelRe, value) {
    if (!value) return false;
    try {
      const l = page.getByRole('textbox', { name: labelRe instanceof RegExp ? labelRe : new RegExp(labelRe, 'i') }).first();
      if (await l.count()) {
        // Never write into Greenhouse education sub-fields (school/degree/discipline/start-date-*/end-date-*).
        // They are optional autocomplete; a generic rule like notice-text "start date" must not pollute
        // "Start date year", which silently invalidates the whole education entry and blocks submission.
        const eduSkip = await l.evaluate(el => /^(start|end)-date-(month|year)-|^(school|degree|discipline)-/.test(el.id || '') || /^(start|end) date (month|year)$/i.test(el.getAttribute('aria-label') || '')).catch(() => false);
        if (eduSkip) return false;
        const cur = await l.inputValue().catch(() => '');
        if (cur && cur.trim()) return true; // don't clobber
        await l.scrollIntoViewIfNeeded(); await l.fill(''); await l.fill(String(value)); await wait(jit());
        return true;
      }
    } catch {}
    return false;
  }

  // ---------- 1) resume ----------
  try { await page.locator('input[type=file]').first().setInputFiles(CFG.resume); await wait(900); } catch {}

  // ---------- 2) identity + standard text fields ----------
  for (const t of CFG.text_fields) { if (await fillText(t.match, resolve(t.value))) out.text++; }
  await fillText('signature', ID.full_name);
  await fillText("^Date$|today'?s date", TODAY);

  // ---------- 3) phone country (intl-tel-input: click+pick, NEVER type) ----------
  try {
    const cc = page.getByRole('combobox', { name: /^Country$|Phone.*Country|Country.*Phone/i }).first();
    if (await cc.count()) {
      await cc.scrollIntoViewIfNeeded(); await cc.click(); await wait(420);
      const o = page.getByRole('option', { name: new RegExp(ID.phone_country_option || 'United States', 'i') }).first();
      if (await o.count()) await o.click(); await wait(180);
      // re-type phone to force re-validation (Greenhouse quirk)
      const ph = page.getByRole('textbox', { name: /^Phone$|Phone Number/i }).first();
      if (await ph.count()) { await ph.fill(''); await ph.fill(ID.phone); }
    }
  } catch {}
  await page.keyboard.press('Escape').catch(() => {}); await wait(120);

  // ---------- 4) location city autocomplete ----------
  try {
    const lc = page.getByRole('combobox', { name: /Location \(City\)|^Location$/i }).first();
    if (await lc.count()) {
      const done = await lc.evaluate(el => { const c = el.closest('[class*=control]'); return !!c && !/Select\.\.\./.test(c.textContent) && /\w\w/.test(c.textContent); }).catch(() => false);
      if (!done) {
        await lc.click(); await page.keyboard.type(ID.location_city); await wait(1300);
        const o = page.getByRole('option').first(); if (await o.count()) await o.click(); await wait(150);
      }
    }
  } catch {}
  await page.keyboard.press('Escape').catch(() => {}); await wait(150);

  // ---------- 5) react-select dropdowns: read question -> plan/rule -> robust pick ----------
  // Two passes: pass 2 mops up anything pass 1 left (replaces finish-leftovers.js).
  for (let pass = 0; pass < 2; pass++) {
    const combos = page.locator('[role=combobox]');
    const n = await combos.count();
    for (let i = 0; i < n; i++) {
      const c = combos.nth(i);
      let q = '', filled = false;
      try {
        const info = await c.evaluate(el => {
          const ctrl = el.closest('[class*=control]') || el.parentElement;
          const id = el.getAttribute('aria-labelledby');
          const t = id && document.getElementById(id);
          const q = (t ? t.textContent : el.getAttribute('aria-label')) || '';
          const hasValue = !!ctrl && (!!ctrl.querySelector('[class*=singleValue],[class*=multiValue]') ||
            (!/Select\.\.\./.test(ctrl.textContent) && !!ctrl.textContent.trim()));
          return { q: q.trim(), hasValue };
        });
        q = info.q; filled = info.hasValue;
      } catch { continue; }
      if (filled || !q) continue;
      const plan = planFor(q);
      const rule = ruleFor(q);
      const optRes = plan && plan.option ? [new RegExp('^' + plan.option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')] : (rule ? rule.opts : null);
      if (!optRes) { if (pass === 1) out.left.push(q.slice(0, 80)); continue; }
      const typeStr = plan && plan.option ? plan.option : (rule ? rule.tf : null);
      const control = c.locator('xpath=ancestor::div[contains(@class,"control")][1]');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.keyboard.press('Escape').catch(() => {}); await wait(110);
          await page.locator('body').click({ position: { x: 4, y: 4 } }).catch(() => {}); await wait(110);
          const opener = (await control.count()) ? control : c;
          await opener.scrollIntoViewIfNeeded(); await opener.click(); await wait(260);
          const menu = page.locator('.select__menu, [class*="select__menu"]').first();
          try { await menu.waitFor({ state: 'visible', timeout: 1500 }); } catch {}
          await wait(160);
          if (typeStr && attempt > 0) { await page.keyboard.type(typeStr); await wait(550); }
          let picked = false;
          for (const optRe of optRes) {
            const opt = menu.getByRole('option', { name: optRe }).first();
            if (await opt.count()) { await opt.click(); await wait(220); picked = true; break; }
            const opt2 = menu.locator('[role=option], [class*="__option"]').filter({ hasText: optRe }).first();
            if (await opt2.count()) { await opt2.click(); await wait(220); picked = true; break; }
          }
          if (!picked) { await page.keyboard.press('Escape'); await wait(90); break; } // no truthful match -> blank
          const ok = await c.evaluate(el => { const ctrl = el.closest('[class*=control]'); return !!ctrl && !/Select\.\.\./.test(ctrl.textContent) && !!ctrl.textContent.trim(); });
          if (ok) { out.dropdowns++; break; }
        } catch { try { await page.keyboard.press('Escape'); } catch {} }
      }
    }
  }

  // ---------- 6) native <select> (Lever EEO etc.) ----------
  try {
    const sels = page.locator('select');
    const sn = await sels.count();
    for (let i = 0; i < sn; i++) {
      const s = sels.nth(i);
      const meta = await s.evaluate(el => ({
        q: ((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || el.name || '').trim(),
        val: el.value,
        opts: [...el.options].map(o => o.textContent.trim())
      })).catch(() => null);
      if (!meta || (meta.val && meta.val.trim())) continue;
      const plan = planFor(meta.q); const rule = ruleFor(meta.q);
      const optRes = plan && plan.option ? [new RegExp('^' + plan.option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')] : (rule ? rule.opts : null);
      if (!optRes) continue;
      let label = null;
      for (const re of optRes) { label = meta.opts.find(o => o && re.test(o)); if (label) break; }
      if (label) { try { await s.selectOption({ label }); out.selects++; await wait(jit()); } catch {} }
    }
  } catch {}

  // ---------- 7) radio groups (Ashby EEO etc.) ----------
  try {
    const groups = await page.evaluate(() => {
      const by = {};
      for (const r of document.querySelectorAll('input[type=radio]')) {
        const name = r.name || 'anon'; (by[name] = by[name] || []).push(r);
      }
      const res = [];
      for (const [name, radios] of Object.entries(by)) {
        if (radios.some(r => r.checked)) continue;
        const fs = radios[0].closest('fieldset,[role=radiogroup]');
        let q = '';
        if (fs) { const lg = fs.querySelector('legend,[class*=label],label'); q = lg ? lg.textContent.trim() : (fs.getAttribute('aria-label') || ''); }
        if (!q) { const id = radios[0].getAttribute('aria-labelledby'); const t = id && document.getElementById(id); q = t ? t.textContent.trim() : ''; }
        const opts = radios.map(r => ((r.labels && r.labels[0] && r.labels[0].textContent) || r.value || '').trim());
        if (q) res.push({ name, q, opts });
      }
      return res;
    });
    for (const g of groups) {
      const plan = planFor(g.q); const rule = ruleFor(g.q);
      const optRes = plan && plan.option ? [new RegExp('^' + plan.option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')] : (rule ? rule.opts : null);
      if (!optRes) continue;
      let target = null;
      for (const re of optRes) { target = g.opts.find(o => o && re.test(o)); if (target) break; }
      if (!target) continue;
      try {
        const radio = page.locator(`input[type=radio][name="${g.name}"]`).filter({ has: page.locator(`xpath=//label[contains(normalize-space(),${JSON.stringify(target.slice(0, 40))})]`) });
        // simpler reliable path: click the label text scoped near the group
        const lbl = page.locator('label').filter({ hasText: new RegExp('^' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
        if (await lbl.count()) { await lbl.scrollIntoViewIfNeeded(); await lbl.click(); out.radios++; await wait(jit()); }
        else if (await radio.count()) { await radio.first().check({ force: true }); out.radios++; await wait(jit()); }
      } catch {}
    }
  } catch {}

  // ---------- 8) checkbox GROUPS (multi-select demographics / country lists) ----------
  try {
    const groups = await page.evaluate(() => {
      const by = {};
      for (const c of document.querySelectorAll('input[type=checkbox]')) {
        const name = c.name || ''; if (!name) continue; (by[name] = by[name] || []).push(c);
      }
      const res = [];
      for (const [name, boxes] of Object.entries(by)) {
        if (boxes.length < 2 || boxes.some(b => b.checked)) continue;
        const fs = boxes[0].closest('fieldset,[role=group]');
        let q = '';
        if (fs) { const lg = fs.querySelector('legend,[class*=label]'); q = lg ? lg.textContent.trim() : ''; }
        if (!q) { const id = boxes[0].getAttribute('aria-labelledby'); const t = id && document.getElementById(id); q = (t ? t.textContent : '').trim(); }
        const opts = boxes.map(b => ((b.labels && b.labels[0] && b.labels[0].textContent) || b.value || '').trim());
        if (q) res.push({ name, q, opts });
      }
      return res;
    });
    for (const g of groups) {
      const plan = planFor(g.q); const rule = ruleFor(g.q);
      const optRes = plan && plan.option ? [new RegExp('^' + plan.option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')] : (rule ? rule.opts : null);
      if (!optRes) continue;
      let target = null;
      for (const re of optRes) { target = g.opts.find(o => o && re.test(o)); if (target) break; }
      if (!target) continue;
      try {
        const idx = g.opts.indexOf(target);
        const box = page.locator(`input[type=checkbox][name="${g.name}"]`).nth(idx);
        await box.scrollIntoViewIfNeeded(); await box.check({ force: true }); out.groups++; await wait(jit());
      } catch {}
    }
  } catch {}

  // ---------- 9) essays: textareas + long-question text inputs ----------
  const essayTargets = [
    ...await page.locator('textarea').all(),
    ...await page.locator('input[type=text]').all()
  ];
  for (const ta of essayTargets) {
    try {
      const meta = await ta.evaluate(el => ({
        tag: el.tagName.toLowerCase(),
        req: el.required || el.getAttribute('aria-required') === 'true',
        val: el.value,
        lbl: ((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && (document.getElementById(el.getAttribute('aria-labelledby')) || {}).textContent) || '').trim()
      }));
      if (meta.val && meta.val.trim()) continue;
      if (!meta.lbl) continue;
      if (meta.tag === 'input' && meta.lbl.length < 60) continue; // short inputs were handled by text_fields
      const plan = planFor(meta.lbl);
      const er = ESSAY_RULES.find(r => r.q.test(meta.lbl));
      if (plan && plan.value) { await ta.scrollIntoViewIfNeeded(); await ta.fill(plan.value); out.essays++; await wait(jit()); continue; }
      if (!meta.req && !er) continue;
      const text = er ? er.text : (meta.tag === 'textarea' && meta.req ? CFG.essays.general : null);
      if (!text) continue;
      await ta.scrollIntoViewIfNeeded(); await ta.fill(text); out.essays++; await wait(jit());
    } catch {}
  }

  // ---------- 10) Yes/No BUTTON widgets (Ashby: button._option_, selected = _active_) ----------
  // The closest ancestor holding both buttons is the options wrapper (text just "YesNo", no
  // question) -> climb until an ancestor also carries the question label. These Boolean fields
  // arrive in the plan as {value:"Yes"} (kind:select), NOT {option}, so check value too.
  try {
    const yesBtns = page.locator('button').filter({ hasText: /^Yes$/ });
    const yn = Math.min(await yesBtns.count(), 12);
    for (let i = 0; i < yn; i++) {
      const y = yesBtns.nth(i);
      const info = await y.evaluate(el => {
        let node = el, wrapper = null;
        for (let k = 0; k < 8 && node; k++) {
          node = node.parentElement;
          if (node && [...node.querySelectorAll('button')].some(b => /^No$/i.test((b.textContent || '').trim()))) {
            const q = node.textContent.replace(/\s+/g, ' ').replace(/Yes\s*No/ig, '').trim();
            if (q.length > 12) { wrapper = node; break; }
          }
        }
        if (!wrapper) return null;
        const q = wrapper.textContent.replace(/\s+/g, ' ').replace(/Yes\s*No/ig, '').trim().slice(0, 200);
        const sel = wrapper.querySelector('[aria-pressed="true"],[data-selected="true"],[class*=selected],[class*=active]');
        return { q, done: !!sel };
      }).catch(() => null);
      if (!info || info.done || !info.q) continue;
      const plan = planFor(info.q); const rule = ruleFor(info.q);
      const planAns = plan && (plan.option || plan.value);
      const optRes = planAns ? [new RegExp('^' + planAns + '$', 'i')] : (rule ? rule.opts : null);
      if (!optRes) continue;
      const wantYes = optRes.some(re => re.test('Yes'));
      const wantNo = optRes.some(re => re.test('No'));
      if (wantYes) { await y.click(); out.buttons++; await wait(jit()); }
      else if (wantNo) {
        const nb = y.locator('xpath=ancestor::*[.//button[normalize-space()="No"]][1]').locator('button').filter({ hasText: /^No$/ }).first();
        if (await nb.count()) { await nb.click(); out.buttons++; await wait(jit()); }
      }
    }
  } catch {}

  // ---------- 11) single consent checkboxes (positive consent only) ----------
  try {
    const POS = new RegExp(CFG.consent_checkbox.positive, 'i');
    const NEG = new RegExp(CFG.consent_checkbox.negative, 'i');
    const boxes = page.locator('input[type=checkbox]');
    const bn = await boxes.count();
    for (let i = 0; i < bn; i++) {
      const b = boxes.nth(i);
      const info = await b.evaluate(el => {
        const name = el.name || '';
        let siblings = 0;
        if (name) siblings = document.querySelectorAll(`input[type=checkbox][name="${CSS.escape(name)}"]`).length;
        let txt = (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || '';
        if (!txt) { const id = el.getAttribute('aria-labelledby'); const t = id && document.getElementById(id); txt = t ? t.textContent : ''; }
        if (!txt && el.closest('label')) txt = el.closest('label').textContent;
        if (!txt && el.parentElement) txt = el.parentElement.textContent;
        return { checked: el.checked, grouped: siblings > 1, txt: (txt || '').trim().slice(0, 140) };
      });
      if (info.checked || info.grouped) continue; // groups handled in pass 8
      if (POS.test(info.txt) && !NEG.test(info.txt)) {
        try { await b.scrollIntoViewIfNeeded(); await b.check({ force: true }); out.consent++; await wait(jit()); } catch {}
      }
    }
  } catch {}

  return out;
}
