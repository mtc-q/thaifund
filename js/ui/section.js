// Collapsible panel section with bypass toggle, actions and reset.
import { h, icon } from './kit.js';

const KEY = 'thaifund.sections';
let openState = {};
try { openState = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { openState = {}; }
const saveOpen = () => { try { localStorage.setItem(KEY, JSON.stringify(openState)); } catch { /* private mode */ } };

// Header layout: [on/off box] Title ........ [actions] [reset] [chevron]
export function makeSection({ id, title, open = false, actions = [], onBypass, onReset }) {
  const toggle = onBypass ? h('button', { class: 'sec-toggle', type: 'button', title: 'Show / hide this section’s changes' }, icon('i-check')) : null;
  const chev = h('span', { class: 'sec-chev' }, icon('i-chevron'));
  const reset = onReset ? h('button', { class: 'sec-btn quiet', type: 'button', title: 'Reset ' + title }, icon('i-revert')) : null;
  const head = h('div', { class: 'sec-head', role: 'button', tabindex: '0', 'aria-expanded': 'false' },
    toggle, h('span', { class: 'sec-title' }, title), h('span', { class: 'sec-actions' }, ...actions, reset), chev);
  const body = h('div', { class: 'sec-body' });
  const el = h('section', { class: 'section', 'data-section': id }, head, body);
  const isOpen = openState[id] ?? open;
  const setOpen = v => { el.classList.toggle('open', v); head.setAttribute('aria-expanded', v); openState[id] = v; saveOpen(); el.dispatchEvent(new CustomEvent('toggle', { detail: v })); };
  el.classList.toggle('open', isOpen);
  head.addEventListener('click', e => { if (e.target.closest('.sec-actions button, .sec-toggle')) return; setOpen(!el.classList.contains('open')); });
  head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!el.classList.contains('open')); } });
  toggle?.addEventListener('click', e => { e.stopPropagation(); onBypass(); });
  reset?.addEventListener('click', e => { e.stopPropagation(); onReset(); });
  for (const a of actions) a.addEventListener('click', e => e.stopPropagation());
  return {
    el, body, head,
    isOpen: () => el.classList.contains('open'),
    setOpen,
    setModified(v) { el.classList.toggle('modified', !!v); },
    setBypassed(v) { el.classList.toggle('bypassed', !!v); },
  };
}

/** Small header action. With a label it renders as a word ("Auto"), otherwise as an icon. */
export function actionBtn(iconId, title, label) {
  return label
    ? h('button', { class: 'sec-btn text quiet', type: 'button', title }, label)
    : h('button', { class: 'sec-btn quiet', type: 'button', title }, icon(iconId));
}
