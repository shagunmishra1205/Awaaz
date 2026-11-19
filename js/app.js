import { t, getLang, setLang, applyStatic } from './i18n.js';
import {
  SAMPLE_FORMS, parseText, normalize, labelFor, displayValue, fieldPrefill,
  EXPIRY_MS, STORAGE_KEY, PREFS_KEY, buildPrefillUrl,
} from './data.js';
import { listen, stopListening, speak, speechInputSupported } from './speech.js';
import { serverOnline, serverValidate, serverParseText, serverExtractText, serverParseUrl } from './api.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const L = () => getLang();

const state = {
  form: null,
  idx: 0,
  answers: {},
  pending: null,        // { value, raw } waiting for confirmation (FR4)
  autoRead: true,
  shortcuts: true,
  micOK: false,
  listening: false,
  saveOn: false,
  returnToReview: false,
  prefs: {},
};

// ---------- Small helpers ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids.map((k) => (typeof k === 'string' ? document.createTextNode(k) : k)));
  return n;
}
const current = () => state.form.fields[state.idx];
const visibleScreen = () => document.querySelector('.screen:not([hidden])')?.id.replace('screen-', '');
const hasAnswer = (f) => state.answers[f.id] !== undefined && state.answers[f.id] !== '';

function show(name) {
  $('.navlinks').hidden = name !== 'start';
  $$('.screen').forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
  document.querySelector(`#screen-${name} h2`)?.focus();
  window.scrollTo({ top: 0 });
}

function owl(on) { $$('.owl').forEach((o) => o.classList.toggle('talking', on)); }
function owlHappy() {
  $$('.owl').forEach((o) => {
    o.classList.add('happy');
    setTimeout(() => o.classList.remove('happy'), 1100);
  });
}

let toastTimer;
function showToast(msg) {
  const x = $('#toast');
  x.textContent = msg;
  x.classList.add('show');
  $('#live').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => x.classList.remove('show'), 3800);
}

function speakText(text, lang = L()) {
  const ok = speak(text, lang, { onStart: () => owl(true), onEnd: () => owl(false) });
  if (!ok && lang === 'hi') showToast(t('noHindiVoice'));
}

function openDlg(id) {
  const d = document.getElementById(id);
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
}

// ---------- Preferences ----------
function loadPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { /* ignore */ }
  state.prefs = {
    lang: 'en',
    autoRead: true,
    contrast: window.matchMedia('(prefers-contrast: more)').matches,
    large: false,
    shortcuts: true,
    ...saved,
  };
  setLang(state.prefs.lang);
  state.autoRead = state.prefs.autoRead;
  state.shortcuts = state.prefs.shortcuts;
  document.body.classList.toggle('hc', !!state.prefs.contrast);
  document.documentElement.classList.toggle('large', !!state.prefs.large);
}

function savePrefs() {
  state.prefs.autoRead = state.autoRead;
  state.prefs.shortcuts = state.shortcuts;
  state.prefs.contrast = document.body.classList.contains('hc');
  state.prefs.large = document.documentElement.classList.contains('large');
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* ignore */ }
}

function updateToggles() {
  const set = (id, on) => $(id).setAttribute('aria-pressed', String(on));
  set('#btnAutoRead', state.autoRead);
  set('#btnContrast', document.body.classList.contains('hc'));
  set('#btnLarge', document.documentElement.classList.contains('large'));
  set('#btnShortcuts', state.shortcuts);
  $$('[data-lang-btn]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.langBtn === L())));
}

// ---------- Saved progress (F10) ----------
function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!s) return null;
    if (Date.now() - s.savedAt > EXPIRY_MS) { clearSaved(); return null; }
    return s;
  } catch { return null; }
}
function persist() {
  if (!state.saveOn || !state.form) return;
  // Sensitive values are never kept, per data-minimisation rules.
  const answers = {};
  state.form.fields.forEach((f) => {
    if (f.type !== 'sensitive' && state.answers[f.id] !== undefined) answers[f.id] = state.answers[f.id];
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), form: state.form, answers, idx: state.idx }));
  } catch { /* storage full or blocked */ }
}
function clearSaved() { localStorage.removeItem(STORAGE_KEY); }
function renderResume() {
  $('#resumeBox').hidden = !loadSaved();
  renderStorage();
}

// Shows where saved progress lives and when it expires (storage section).
function renderStorage() {
  const s = loadSaved();
  const box = $('#storeStatus');
  if (!s) { box.textContent = t('storeStatusNone'); return; }
  const hours = Math.max(0, Math.round((EXPIRY_MS - (Date.now() - s.savedAt)) / 3600000));
  box.textContent = t('storeStatusHas', Object.keys(s.answers || {}).length, hours);
}

// ---------- Starting a form ----------
function startForm(form) {
  state.form = form;
  state.answers = {};
  state.idx = 0;
  state.pending = null;
  state.returnToReview = false;
  state.saveOn = $('#saveProgress').checked;
  $('#formTitle').textContent = form.title[L()] || form.title.en;
  show('flow');
  askQuestion();
}

function onResume() {
  const s = loadSaved();
  if (!s) return renderResume();
  state.form = s.form;
  state.answers = s.answers || {};
  state.idx = Math.min(s.idx || 0, s.form.fields.length - 1);
  state.pending = null;
  state.returnToReview = false;
  state.saveOn = true;
  $('#saveProgress').checked = true;
  $('#formTitle').textContent = s.form.title[L()] || s.form.title.en;
  show('flow');
  askQuestion();
}

// ---------- Guided flow (FR1, FR2, FR3, FR7) ----------
function askQuestion(prefill) {
  const f = current();
  const n = state.form.fields.length;
  const lang = L();
  state.pending = null;
  $('#readback').hidden = true;
  $('#answerArea').hidden = false;

  $('#qCount').textContent = t('questionOf', state.idx + 1, n);
  $('#progressBar').setAttribute('aria-valuemax', String(n));
  $('#progressBar').setAttribute('aria-valuenow', String(state.idx));
  $('#progressFill').style.width = `${(state.idx / n) * 100}%`;
  renderDots();

  $('#qTitle').textContent = labelFor(f, lang);
  const badge = $('#qReq');
  badge.textContent = f.required ? t('required') : t('optional');
  badge.className = `badge ${f.required ? 'req' : 'opt'}`;
  $('#qHint').textContent = f.hint ? (f.hint[lang] || f.hint.en || '') : '';
  $('#flagNote').hidden = !f.flag;
  $('#flagNote').textContent = f.flag ? t('flagged') : '';
  $('#fieldError').textContent = '';

  const value = prefill ?? fieldPrefill(f, state.answers[f.id]);
  const isSel = f.type === 'select';
  $('#selectField').hidden = !isSel;
  $('#textField').hidden = isSel;

  if (isSel) {
    renderOptions(f, lang);
    $('#answerSelect').value = value;
  } else {
    const inp = $('#answerInput');
    inp.value = value;
    inp.type = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
    inp.inputMode = ['phone', 'pin', 'number', 'sensitive'].includes(f.type) ? 'numeric' : 'text';
    inp.placeholder = f.type === 'date' ? 'dd/mm/yyyy' : '';
  }

  if (state.autoRead) readQuestion();
  $('#qTitle').focus();
}

function renderDots() {
  const box = $('#dots');
  box.replaceChildren(...state.form.fields.map((f, i) => {
    const cls = i < state.idx ? 'done' : i === state.idx ? 'current' : '';
    return el('span', { class: `dot ${cls} ${f.flag ? 'flag' : ''}` });
  }));
}

function renderOptions(f, lang) {
  const grid = $('#optionGrid');
  const sel = $('#answerSelect');
  sel.replaceChildren(el('option', { value: '' }, t('chooseOption')));
  grid.replaceChildren();
  f.options.forEach((o, i) => {
    const label = o[lang] || o.en || o.v;
    grid.append(el('button', { type: 'button', class: 'opt-card', 'data-v': o.v },
      el('span', { class: 'num', 'aria-hidden': 'true' }, String(i + 1)), label));
    sel.append(el('option', { value: o.v }, label));
  });
}

function readQuestion() {
  const f = current();
  const lang = f.lang || L();
  let text = `${labelFor(f, lang)}.`;
  const hint = f.hint && (f.hint[lang] || f.hint.en);
  if (hint) text += ` ${hint}`;
  if (f.type === 'select') {
    text += ` ${t('optionsSay')} ${f.options.map((o, i) => `${i + 1}. ${o[lang] || o.en || o.v}`).join('. ')}.`;
  }
  speakText(text, lang);
}

async function submitRaw(raw) {
  const f = current();
  // Server check is off by default (answers stay on the device); see SERVER_VALIDATION in api.js.
  const res = (await serverValidate(f, raw)) || normalize(f, raw);
  if (!res.valid) return fail(t(res.err));
  state.pending = { value: res.value, raw: String(raw).trim() };
  showReadback();
}

function fail(msg) {
  $('#fieldError').textContent = msg;
  (current().type === 'select' ? $('#answerSelect') : $('#answerInput')).focus();
  $('#live').textContent = msg;
  speakText(msg);
}

// ---------- Read-back and confirmation (FR4) ----------
function showReadback() {
  const f = current();
  $('#answerArea').hidden = true;
  $('#readback').hidden = false;
  $('#rbValue').textContent = displayValue(f, state.pending.value, L()) || t('skipped');
  $('#rbQ').textContent = t('readbackQ');
  $('#rbValue').focus();
  readbackSpeak();
}

function readbackSpeak() {
  const f = current();
  const shown = displayValue(f, state.pending?.value, L()) || t('skipped');
  speakText(`${t('youSaid')}: ${shown}. ${t('readbackQ')}`);
}

function confirmAnswer() {
  if (!state.pending) return;
  state.answers[current().id] = state.pending.value;
  state.pending = null;
  persist();
  owlHappy();
  state.idx++;
  if (state.returnToReview || state.idx >= state.form.fields.length) {
    state.returnToReview = false;
    state.idx = state.form.fields.length - 1;
    goReview();
  } else {
    askQuestion();
  }
}

function editAnswer() {
  const raw = state.pending?.raw ?? '';
  state.pending = null;
  askQuestion(raw);
}

function goBack() {
  if (state.idx === 0) return;
  state.idx--;
  askQuestion();
}

function repeat() {
  if (!$('#readback').hidden && state.pending) readbackSpeak();
  else readQuestion();
}

// ---------- Voice input (F3, FR5) ----------
function onMic() {
  if (state.listening) { stopListening(); return; }
  if (!speechInputSupported) return fail(t('noVoiceSupport'));
  if (!state.micOK) return openDlg('consentDlg');
  startMic();
}

function startMic() {
  window.speechSynthesis?.cancel();
  setMic(true);
  listen(L())
    .then(({ text, confidence }) => {
      setMic(false);
      if (confidence < 0.6) return fail(t('lowConfidence'));
      if (current().type !== 'select') $('#answerInput').value = text;
      submitRaw(text);
    })
    .catch((err) => {
      setMic(false);
      if (err.code === 'not-allowed') fail(t('micDenied'));
      else if (err.code === 'no-speech') fail(t('noSpeech'));
      else fail(t('noVoiceSupport'));
    });
}

function setMic(on) {
  state.listening = on;
  const b = $('#btnMic');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  $('#micLabel').textContent = on ? t('micStop') : t('mic');
  $('#waves').classList.toggle('on', on);
  $('#micStatus').textContent = on ? t('listening') : '';
}

// ---------- Keyboard shortcuts (spec section 9) ----------
function onKey(e) {
  if (!state.shortcuts || document.querySelector('dialog[open]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(e.target.tagName)) return;
  const inFlow = visibleScreen() === 'flow';
  const rb = !$('#readback').hidden;
  const key = e.key.toLowerCase();
  if (e.code === 'Space' && inFlow && !rb) { e.preventDefault(); onMic(); }
  else if (key === 'r' && inFlow) repeat();
  else if (e.key === 'Enter' && inFlow && rb) confirmAnswer();
  else if (key === 'e' && inFlow && rb) editAnswer();
}

// ---------- Review (F8, FR8) ----------
function goReview() {
  renderReview();
  show('review');
  const missing = state.form.fields.filter((f) => f.required && !hasAnswer(f)).length;
  if (missing) $('#live').textContent = t('missingCount', missing);
}

function renderReview() {
  const f = state.form;
  const lang = L();
  const list = $('#reviewList');
  let missing = 0;
  let answered = 0;

  list.replaceChildren(...f.fields.map((fld, i) => {
    const has = hasAnswer(fld);
    if (has) answered++;
    else if (fld.required) missing++;
    const shown = has
      ? displayValue(fld, state.answers[fld.id], lang)
      : (fld.required ? t('missing') : t('skipped'));
    const name = labelFor(fld, lang);
    return el('li', { class: `review-item ${fld.required && !has ? 'bad' : ''}` },
      el('p', { class: 'rq' }, name),
      el('p', { class: 'rv' }, shown),
      el('button', { type: 'button', class: 'btn small', 'data-edit': String(i), 'aria-label': `${t('change')}: ${name}` }, `✏️ ${t('change')}`));
  }));

  $('#reviewSummary').textContent = t('answeredCount', answered, f.fields.length);
  $('#missingNote').textContent = missing ? t('missingCount', missing) : '';
  $('#btnFinish').disabled = missing > 0;
  buildPrintSheet();
}

function onReviewEdit(e) {
  const b = e.target.closest('[data-edit]');
  if (!b) return;
  state.idx = Number(b.dataset.edit);
  state.returnToReview = true;
  state.pending = null;
  show('flow');
  askQuestion();
}

// Google Forms only: offer to open the real form with the confirmed answers filled in.
let fillUrl = null;
function renderFill() {
  const fill = state.form && state.form.sourceUrl ? buildPrefillUrl(state.form, state.answers) : null;
  fillUrl = fill ? fill.url : null;
  $('#btnOpenForm').hidden = !fill;
  $('#fillNote').hidden = !fill;
  // The usual line says "type these values yourself", which is wrong when we can fill the form.
  $('#screen-done [data-i18n="doneSub"]').textContent = t(fill ? 'doneSubFill' : 'doneSub');
  if (fill) $('#fillNote').textContent = t('fillNote', fill.filled) + (fill.left ? ` ${t('fillLeft', fill.left)}` : '');
}
function openFilledForm() {
  if (fillUrl) window.open(fillUrl, '_blank', 'noopener,noreferrer');
}

function onFinish() {
  clearSaved();
  renderFill();
  show('done');
  confetti();
  owlHappy();
  $('#live').textContent = `${t('doneTitle')} ${t('doneSub')}`;
}

// ---------- Export: PDF via print dialog, copy (F8) ----------
function buildPrintSheet() {
  const f = state.form;
  const lang = L();
  const sheet = $('#printSheet');
  sheet.lang = lang;
  const date = new Date().toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN');
  sheet.replaceChildren(
    el('h1', {}, f.title[lang] || f.title.en),
    el('p', {}, `${t('pdfHeading')} · ${t('printedOn')}: ${date}`),
    el('dl', {}, ...f.fields.flatMap((fld) => [
      el('dt', {}, labelFor(fld, lang)),
      el('dd', {}, displayValue(fld, state.answers[fld.id], lang) || '-'),
    ])),
  );
}

function exportPdf() {
  buildPrintSheet();
  const old = document.title;
  document.title = `AwaazForm - ${state.form.title[L()] || state.form.title.en}`;
  window.print();
  setTimeout(() => { document.title = old; }, 800);
}

async function copyAnswers() {
  const lang = L();
  const text = state.form.fields
    .map((f) => `${labelFor(f, lang)}: ${displayValue(f, state.answers[f.id], lang) || '-'}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('copied'));
  } catch {
    showToast(t('copyFail'));
  }
}

// ---------- Paste a form link (checked here, questions copied by the user) ----------
async function onLinkSubmit(e) {
  e.preventDefault();
  const msg = $('#linkMsg');
  const panel = $('#linkPanel');
  const raw = $('#formLink').value.trim();
  let url;
  try { url = new URL(raw); } catch { url = null; }
  if (!url) {
    msg.textContent = t('linkInvalid');
    panel.hidden = true;
    return;
  }
  if (url.protocol !== 'https:') {
    msg.textContent = t('linkHttps');
    panel.hidden = true;
    return;
  }
  $('#linkOpen').href = url.href;
  panel.hidden = false;

  // With the server running, it visits the link and reads the questions for us.
  msg.textContent = t('linkReading');
  const r = await serverParseUrl(url.href);
  if (r.offline) { msg.textContent = t('linkOk'); return; }
  if (!r.ok) { msg.textContent = t(LINK_ERRORS[r.code] || 'linkFetchFailed'); return; }

  msg.textContent = t('linkFound', r.fields.length);
  startForm({ id: 'link', title: r.title, fields: r.fields, sourceUrl: r.sourceUrl });
  if (r.flagged) showToast(t('flagCount', r.flagged));
}

const LINK_ERRORS = {
  blocked: 'linkBlocked',
  needs_signin: 'linkNeedsSignin',
  no_questions: 'linkNoQuestions',
  not_html: 'linkNoQuestions',
  too_large: 'linkNoQuestions',
  fetch_failed: 'linkFetchFailed',
};

// ---------- Paste & upload (F1) ----------
async function onPasteSubmit(e) {
  e.preventDefault();
  const text = $('#pasteText').value;
  // Only the question text goes to the server, never answers. Falls back to the on-device parser.
  const fields = (await serverParseText(text)) || parseText(text);
  if (!fields.length) {
    $('#pasteErr').textContent = t('noQuestions');
    return;
  }
  $('#pasteErr').textContent = '';
  const flagged = fields.filter((f) => f.flag).length;
  startForm({ id: 'custom', title: { en: 'My form', hi: 'मेरा फॉर्म' }, fields });
  if (flagged) showToast(t('flagCount', flagged));
}

function loadPdfLib() {
  if (window.pdfjsLib) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = el('script', { src: `${PDFJS}/pdf.min.js` });
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
      resolve();
    };
    s.onerror = () => reject(new Error(t('noPdfLib')));
    document.head.append(s);
  });
}

async function pdfToText(file) {
  await loadPdfLib();
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  if (pdf.numPages > 20) throw new Error(t('pdfPages'));
  let out = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('') + '\n';
  }
  return out;
}

async function onFile(e) {
  const file = e.target.files[0];
  const msg = $('#uploadMsg');
  if (!file) return;
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['txt', 'pdf'].includes(ext)) throw new Error(t('fileType'));
    if (file.size > 5 * 1024 * 1024) throw new Error(t('fileBig'));
    let text;
    if (ext === 'pdf') {
      const head = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
      if (head !== '%PDF-') throw new Error(t('fileType'));
      text = (await serverExtractText(file)) || (await pdfToText(file));
    } else {
      text = await file.text();
    }
    if (!text.trim()) throw new Error(t('pdfNoText'));
    $('#pasteText').value = text.trim();
    msg.textContent = t('fileLoaded');
  } catch (err) {
    msg.textContent = err.message;
  }
}

// ---------- Confetti (celebration, skipped for reduced motion) ----------
function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#confetti');
  const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff'];
  box.replaceChildren(...Array.from({ length: 60 }, (_, i) => {
    const s = el('span');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = `${Math.random() * 0.6}s`;
    s.style.setProperty('--drift', `${Math.random() * 200 - 100}px`);
    return s;
  }));
  setTimeout(() => box.replaceChildren(), 3600);
}

// ---------- Language switch without losing answers (FR9) ----------
function switchLang(code) {
  const f = state.form && current();
  const typed = f && f.type === 'select' ? $('#answerSelect').value : $('#answerInput').value;
  setLang(code);
  state.prefs.lang = code;
  savePrefs();
  applyStatic();
  updateToggles();
  if (state.form) $('#formTitle').textContent = state.form.title[code] || state.form.title.en;

  const s = visibleScreen();
  if (s === 'flow') {
    if (!$('#readback').hidden && state.pending) showReadback();
    else askQuestion(typed);
  } else if (s === 'review') {
    renderReview();
  } else if (s === 'done') {
    renderFill();
  } else if (s === 'start') {
    renderResume();
  }
}

// ---------- Keyboard: dialogs ----------
function bind() {
  $$('[data-lang-btn]').forEach((b) => b.addEventListener('click', () => switchLang(b.dataset.langBtn)));
  $$('[data-sample]').forEach((b) => b.addEventListener('click', () => startForm(structuredClone(SAMPLE_FORMS[b.dataset.sample]))));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => {
    show(b.dataset.go);
    if (b.dataset.go === 'start') renderResume();
  }));

  $('#btnAutoRead').addEventListener('click', () => { state.autoRead = !state.autoRead; savePrefs(); updateToggles(); });
  $('#btnContrast').addEventListener('click', () => { document.body.classList.toggle('hc'); savePrefs(); updateToggles(); });
  $('#btnLarge').addEventListener('click', () => { document.documentElement.classList.toggle('large'); savePrefs(); updateToggles(); });
  $('#btnShortcuts').addEventListener('click', () => { state.shortcuts = !state.shortcuts; savePrefs(); updateToggles(); });
  $('#btnHelp').addEventListener('click', () => openDlg('helpDlg'));
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#consentAgree').addEventListener('click', () => {
    state.micOK = true;
    $('#consentDlg').close();
    startMic();
  });

  $('#linkForm').addEventListener('submit', onLinkSubmit);
  $('#btnSignIn').addEventListener('click', () => openDlg('signDlg'));
  $('#btnStoreDelete').addEventListener('click', () => { clearSaved(); renderResume(); showToast(t('deleted')); });
  $('#saveProgress').addEventListener('change', (e) => {
    if (!e.target.checked) { clearSaved(); renderResume(); }
  });
  $('#btnResume').addEventListener('click', onResume);
  $('#btnDeleteSaved').addEventListener('click', () => { clearSaved(); renderResume(); showToast(t('deleted')); });

  $('#pasteForm').addEventListener('submit', onPasteSubmit);
  $('#fileInput').addEventListener('change', onFile);

  $('#btnMic').addEventListener('click', onMic);
  $('#btnListenQ').addEventListener('click', readQuestion);
  $('#answerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = current();
    submitRaw(f.type === 'select' ? $('#answerSelect').value : $('#answerInput').value);
  });
  $('#optionGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.opt-card');
    if (b) submitRaw(b.dataset.v);
  });
  $('#btnBack').addEventListener('click', goBack);
  $('#btnConfirm').addEventListener('click', confirmAnswer);
  $('#btnEdit').addEventListener('click', editAnswer);
  $('#btnRepeat').addEventListener('click', repeat);

  $('#reviewList').addEventListener('click', onReviewEdit);
  $('#btnReviewBack').addEventListener('click', () => {
    state.idx = state.form.fields.length - 1;
    state.returnToReview = true;
    state.pending = null;
    show('flow');
    askQuestion();
  });
  $('#btnFinish').addEventListener('click', onFinish);

  $('#btnOpenForm').addEventListener('click', openFilledForm);
  $('#btnPdf').addEventListener('click', exportPdf);
  $('#btnCopy').addEventListener('click', copyAnswers);
  $('#btnNew').addEventListener('click', () => { show('start'); renderResume(); });

  document.addEventListener('keydown', onKey);
}

function init() {
  loadPrefs();
  applyStatic();
  updateToggles();
  renderResume();
  bind();
  // Let the user know when the optional server is connected. Silent if it is off.
  serverOnline().then((on) => { if (on) showToast(t('serverOn')); });
}

init();
