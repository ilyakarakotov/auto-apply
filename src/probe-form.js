// Form-state probe. Runs IN THE PAGE. Token-lean replacement for snapshots/screenshots:
//   playwright-cli eval "$(cat src/probe-form.js)" --raw
// Returns compact JSON; submit only when ok:true. Encodes the hard-won fixes:
// - required checkbox GROUPS count as satisfied if ANY member is checked (197-country lists)
// - only VISIBLE errors count (Lever keeps hidden error templates in the DOM)
// - phone/intl-tel "filled" = placeholder gone (its value renders short, e.g. "+1")
() => {
  const vis = (el) => el && el.offsetParent !== null;
  const label = (el) => {
    let t = (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || '';
    if (!t) { const id = el.getAttribute('aria-labelledby'); const n = id && document.getElementById(id); t = n ? n.textContent : ''; }
    if (!t && el.closest('label')) t = el.closest('label').textContent;
    return (t || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  };

  // required text/textarea/email/tel still empty (visible only)
  const emptyText = [];
  for (const el of document.querySelectorAll('input[type=text],input[type=email],input[type=tel],input:not([type]),textarea')) {
    if (!vis(el)) continue;
    const req = el.required || el.getAttribute('aria-required') === 'true';
    if (!req) continue;
    if (el.value && el.value.trim()) continue;
    // react-select search input is an empty [role=combobox] even when a value is chosen;
    // treat as filled if its control shows a single-value (and not the "Select..." placeholder).
    if (el.getAttribute('role') === 'combobox') {
      const ctrl = el.closest('[class*=control]');
      if (ctrl && (ctrl.querySelector('[class*=single-value],[class*=multi-value]') || !/Select\.\.\./.test(ctrl.textContent))) continue;
    }
    emptyText.push(label(el) || el.name || '?');
  }

  // dropdowns still on placeholder (react-select) + empty native selects
  const emptyDrop = [];
  for (const el of document.querySelectorAll('[role=combobox]')) {
    if (!vis(el)) continue;
    const ctrl = el.closest('[class*=control]');
    if (ctrl && /Select\.\.\./.test(ctrl.textContent)) emptyDrop.push(label(el) || '?');
  }
  for (const el of document.querySelectorAll('select')) {
    if (!vis(el)) continue;
    const req = el.required || el.getAttribute('aria-required') === 'true';
    if (req && !el.value) emptyDrop.push(label(el) || el.name || '?');
  }

  // required radio groups with nothing picked
  const radioByName = {};
  for (const r of document.querySelectorAll('input[type=radio]')) (radioByName[r.name || 'anon'] = radioByName[r.name || 'anon'] || []).push(r);
  const emptyRadio = [];
  for (const [name, rs] of Object.entries(radioByName)) {
    if (rs.some(r => r.checked)) continue;
    if (!rs.some(r => r.required || r.getAttribute('aria-required') === 'true')) continue;
    const fs = rs[0].closest('fieldset,[role=radiogroup]');
    const lg = fs && fs.querySelector('legend,[class*=label]');
    emptyRadio.push((lg ? lg.textContent.replace(/\s+/g, ' ').trim().slice(0, 90) : name));
  }

  // required checkbox groups: ANY checked = satisfied; singles must be checked themselves
  const cbByName = {};
  for (const c of document.querySelectorAll('input[type=checkbox]')) (cbByName[c.name || ('anon' + Math.random())] = cbByName[c.name || 'anon'] || []).push(c);
  const emptyCheck = [];
  for (const [name, cs] of Object.entries(cbByName)) {
    const req = cs.some(c => c.required || c.getAttribute('aria-required') === 'true');
    if (!req) continue;
    if (cs.some(c => c.checked)) continue;
    emptyCheck.push(label(cs[0]) || name);
  }

  // required Yes/No BUTTON widgets (Ashby) with neither option selected (_active_)
  const emptyButtons = [];
  const ynSeen = [];
  for (const yb of document.querySelectorAll('button')) {
    if (!vis(yb) || !/^Yes$/i.test((yb.textContent || '').trim())) continue;
    let node = yb, wrapper = null;
    for (let k = 0; k < 8 && node; k++) {
      node = node.parentElement;
      if (node && [...node.querySelectorAll('button')].some(b => /^No$/i.test((b.textContent || '').trim()))) {
        const q = node.textContent.replace(/\s+/g, ' ').replace(/Yes\s*No/ig, '').trim();
        if (q.length > 12) { wrapper = node; break; }
      }
    }
    if (!wrapper || ynSeen.includes(wrapper)) continue;
    ynSeen.push(wrapper);
    const full = wrapper.textContent.replace(/\s+/g, ' ').trim();
    const required = /\*/.test(full);
    const answered = !!wrapper.querySelector('[aria-pressed="true"],[data-selected="true"],[class*=selected],[class*=active]');
    if (required && !answered) emptyButtons.push(full.replace(/Yes\s*No/ig, '').trim().slice(0, 90));
  }

  // resume attached?
  let resume = false;
  for (const f of document.querySelectorAll('input[type=file]')) if (f.files && f.files.length) resume = true;
  if (!resume) resume = /resume[^]{0,200}\.(pdf|docx?)/i.test(document.body.innerText.slice(0, 8000)) || !!document.querySelector('[class*=chip],[class*=filename],[data-qa*=resume]');

  // visible validation errors only
  const errors = [];
  for (const el of document.querySelectorAll('[class*=error],[role=alert]')) {
    if (!vis(el)) continue;
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    if (t && t.length > 2 && !errors.includes(t.slice(0, 70))) errors.push(t.slice(0, 70));
  }

  // submit control
  let submit = null;
  for (const b of document.querySelectorAll('button,input[type=submit]')) {
    if (!vis(b)) continue;
    const t = (b.textContent || b.value || '').trim();
    if (/^submit( application)?$|^apply$|send application/i.test(t)) { submit = { text: t.slice(0, 30), disabled: b.disabled }; break; }
  }

  // blocking gates
  const body = document.body.innerText.slice(0, 6000);
  const gates = [];
  if (/verification code|enter the \d+.character code|code (was )?sent/i.test(body)) gates.push('email-verification');
  if (document.querySelector('#h-captcha,iframe[src*=hcaptcha]')) gates.push('hcaptcha-present');
  if (document.querySelector('iframe[src*=recaptcha]')) gates.push('recaptcha-present');
  if (/sign in|log in to apply|create (an )?account/i.test(body) && !submit) gates.push('login-wall');

  const ok = !emptyText.length && !emptyDrop.length && !emptyRadio.length && !emptyCheck.length && !emptyButtons.length && !!resume && !errors.length;
  return { ok, emptyText, emptyDrop, emptyRadio, emptyCheck, emptyButtons, resume, errors: errors.slice(0, 6), submit, gates, url: location.pathname.slice(0, 60) };
}
