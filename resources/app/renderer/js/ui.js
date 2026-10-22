// Overlay UI primitives: modal dialogs, quick pick, context menus, toasts, tooltips.
import { h, icon, clear, fuzzy, highlight, iconBtn } from './util.js';

const root = () => document.getElementById('overlay-root');
let modalDepth = 0;
export const isModalOpen = () => modalDepth > 0;

// ------------------------------------------------------------------ modal
/**
 * Generic modal. `body` is a node; `buttons` = [{label, value, primary, danger}].
 * Resolves with the clicked button value, or undefined when dismissed.
 */
export function modal({ title, body, buttons = [{ label: '确定', value: true, primary: true }], wide = false, onOpen, dismissable = true, iconName }) {
  return new Promise((resolve) => {
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      modalDepth--;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(v);
    };
    const btnEls = buttons.map((b) => h(`button.btn${b.primary ? '' : b.danger ? '.danger' : '.secondary'}`, { onclick: async () => {
      if (b.validate) {
        const ok = await b.validate();
        if (!ok) return;
      }
      close(typeof b.value === 'function' ? b.value() : b.value);
    } }, b.label));
    const box = h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' },
      title ? h('div.modal-head', iconName ? icon(iconName) : null, h('span.grow', title), dismissable ? iconBtn('close', '关闭', () => close(undefined)) : null) : null,
      h('div.modal-body', body),
      btnEls.length ? h('div.modal-foot', btnEls) : null);
    const backdrop = h('div.backdrop', { onmousedown: (e) => { if (e.target === backdrop && dismissable) close(undefined); } }, box);
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        e.preventDefault();
        close(undefined);
      } else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && !(e.target.closest && e.target.closest('.monaco-editor'))) {
        const primary = buttons.findIndex((b) => b.primary);
        if (primary !== -1) {
          e.preventDefault();
          e.stopPropagation();
          btnEls[primary].click();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    modalDepth++;
    root().appendChild(backdrop);
    const focusable = box.querySelector('input, textarea, select') || btnEls.find((_, i) => buttons[i].primary) || btnEls[0];
    if (focusable) setTimeout(() => focusable.focus(), 0);
    if (onOpen) onOpen({ close, box });
  });
}

export async function confirm(title, message, { okLabel = '确定', cancelLabel = '取消', danger = false } = {}) {
  const r = await modal({
    title,
    body: h('div', { style: { whiteSpace: 'pre-wrap' } }, message || ''),
    buttons: [{ label: cancelLabel, value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  });
  return r === true;
}

export async function alertBox(title, message, { pre = false } = {}) {
  await modal({ title, body: pre ? h('pre.selectable', message) : h('div', { style: { whiteSpace: 'pre-wrap' } }, message), buttons: [{ label: '确定', value: true, primary: true }] });
}

export async function prompt(title, { value = '', placeholder = '', message = '', password = false, okLabel = '确定' } = {}) {
  const input = h('input.input', { type: password ? 'password' : 'text', value, placeholder, style: { width: '100%' } });
  const r = await modal({
    title,
    body: h('div.col', { style: { gap: '8px', minWidth: '420px' } }, message ? h('div.muted', message) : null, input),
    buttons: [{ label: '取消', value: undefined }, { label: okLabel, value: () => input.value, primary: true }],
    onOpen: () => setTimeout(() => { input.focus(); input.select(); }, 0),
  });
  return r;
}

export async function editorPrompt(title, prefill = '', { okLabel = '确定' } = {}) {
  const ta = h('textarea.textarea', { rows: 14, style: { width: 'min(720px, 80vw)' } });
  ta.value = prefill;
  return modal({
    title,
    body: ta,
    wide: true,
    buttons: [{ label: '取消', value: undefined }, { label: okLabel, value: () => ta.value, primary: true }],
  });
}

// ------------------------------------------------------------------ quick pick
/**
 * items: [{label, description, detail, icon, value, separator, keys, alwaysShow}]
 * or a function (query) => items | Promise<items> for dynamic lists.
 */
export function quickPick({ items, placeholder = '', title = '', value = '', matchOn = ['label', 'description'], onChange, multiline = false, emptyText = '没有匹配的结果', onAccept, keepOpen = false, buttons }) {
  return new Promise((resolve) => {
    let selected = 0;
    let current = [];
    let done = false;
    let source = items;
    let reqSeq = 0;
    const input = h('input.input', { placeholder, value, spellcheck: false });
    const list = h('div.qp-list', { role: 'listbox' });
    const box = h('div.quickpick', title ? h('div.qp-title', title) : null, h('div.qp-input', input), list);
    const backdrop = h('div.backdrop.clear', { onmousedown: (e) => { if (e.target === backdrop) close(undefined); } }, h('div', { style: { margin: '0 auto' } }, box));
    const close = (v) => {
      if (done) return;
      done = true;
      modalDepth--;
      backdrop.remove();
      resolve(v);
    };

    const render = () => {
      clear(list);
      if (!current.length) {
        list.appendChild(h('div.qp-empty', emptyText));
        return;
      }
      current.forEach((it, i) => {
        if (it.separator) {
          list.appendChild(h('div.qp-sep', it.label));
          return;
        }
        const two = multiline || !!it.detail;
        const row = h(`div.qp-item${two ? '.two-line' : ''}${i === selected ? '.selected' : ''}`, {
          role: 'option',
          onmousemove: () => {
            if (selected !== i) {
              selected = i;
              for (const el of list.querySelectorAll('.qp-item.selected')) el.classList.remove('selected');
              row.classList.add('selected');
            }
          },
          onmousedown: (e) => { e.preventDefault(); accept(i); },
        },
        it.iconEl ? it.iconEl : it.icon ? icon(it.icon) : null,
        h('div.qp-text',
          h('div.row', { style: { gap: '0', minWidth: 0 } }, h('span.qp-label', highlight(it.label, it._pos)), it.description && !two ? h('span.qp-desc', it.description) : null),
          two && (it.description || it.detail) ? h('div.qp-detail', it.detail || it.description) : null),
        it.keys ? h('span.qp-key', it.keys) : null,
        it.buttons ? it.buttons.map((b) => iconBtn(b.icon, b.title, () => { if (b.run(it, close) !== false) close(undefined); })) : null);
        list.appendChild(row);
      });
      const sel = list.querySelector('.qp-item.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    };

    const filter = async () => {
      const q = input.value;
      const my = ++reqSeq;
      let base = typeof source === 'function' ? await source(q) : source;
      if (my !== reqSeq || done) return;
      base = base || [];
      if (typeof source === 'function' && base.dynamic) {
        current = base;
      } else if (!q.trim()) {
        current = base.map((it) => ({ ...it, _pos: null }));
      } else {
        const scored = [];
        for (const it of base) {
          if (it.separator) continue;
          if (it.alwaysShow) { scored.push({ it: { ...it, _pos: null }, score: -1e9 }); continue; }
          let best = null;
          for (const key of matchOn) {
            const text = it[key];
            if (!text) continue;
            const m = fuzzy(q, text);
            if (m && (!best || m.score > best.score)) best = { ...m, key };
          }
          if (best) scored.push({ it: { ...it, _pos: best.key === 'label' ? best.positions : null }, score: best.score });
        }
        scored.sort((a, b) => b.score - a.score);
        current = scored.slice(0, 300).map((s) => s.it);
      }
      selected = current.findIndex((c) => !c.separator);
      if (selected < 0) selected = 0;
      if (onChange) onChange(q);
      render();
    };

    const accept = (i) => {
      const it = current[i];
      if (onAccept) {
        const r = onAccept(it, input.value, { close, refresh: filter, setItems: (n) => { source = n; filter(); } });
        if (r === false) return;
      }
      if (!keepOpen) close(it ? (it.value !== undefined ? it.value : it) : (input.value ? { custom: input.value } : undefined));
    };

    input.addEventListener('input', filter);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        e.preventDefault();
        do { selected = (selected + 1) % Math.max(1, current.length); } while (current[selected] && current[selected].separator && current.length > 1);
        render();
      } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        e.preventDefault();
        do { selected = (selected - 1 + current.length) % Math.max(1, current.length); } while (current[selected] && current[selected].separator && current.length > 1);
        render();
      } else if (e.key === 'PageDown') {
        e.preventDefault(); selected = Math.min(current.length - 1, selected + 10); render();
      } else if (e.key === 'PageUp') {
        e.preventDefault(); selected = Math.max(0, selected - 10); render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        accept(selected);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(undefined);
      }
    });
    modalDepth++;
    root().appendChild(backdrop);
    if (buttons) void buttons;
    input.focus();
    if (value) input.setSelectionRange(value.length, value.length);
    filter();
  });
}

// ------------------------------------------------------------------ context menu
/** items: [{label, icon, keys, run, disabled, separator, checked}] */
export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = h('div.ctx-menu', { role: 'menu' });
  let sel = -1;
  const rows = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { menu.appendChild(h('div.sep')); continue; }
    const row = h(`div.mi${it.disabled ? '.disabled' : ''}`, {
      role: 'menuitem',
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { closeContextMenu(); it.run && it.run(); },
    }, it.checked !== undefined ? icon(it.checked ? 'check' : 'blank') : it.icon ? icon(it.icon) : h('i.codicon.codicon-blank'), h('span', it.label), it.keys ? h('span.mi-key', it.keys) : null);
    rows.push({ row, it });
    menu.appendChild(row);
  }
  root().appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  const onDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeContextMenu(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      sel = e.key === 'ArrowDown' ? (sel + 1) % rows.length : (sel - 1 + rows.length) % rows.length;
      rows.forEach((r2, i) => r2.row.classList.toggle('selected', i === sel));
    } else if (e.key === 'Enter' && sel >= 0) {
      e.preventDefault();
      rows[sel].row.click();
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
  }, 0);
  activeMenu = { menu, onDown, onKey };
}
let activeMenu = null;
export function closeContextMenu() {
  if (!activeMenu) return;
  activeMenu.menu.remove();
  document.removeEventListener('mousedown', activeMenu.onDown, true);
  document.removeEventListener('keydown', activeMenu.onKey, true);
  window.removeEventListener('blur', closeContextMenu);
  activeMenu = null;
}

// ------------------------------------------------------------------ toasts
let toastBox = null;
export function toast(message, type = 'info', { timeout, actions } = {}) {
  if (!toastBox) {
    toastBox = h('div.toasts');
    root().appendChild(toastBox);
  }
  const iconName = type === 'error' ? 'error' : type === 'warning' ? 'warning' : type === 'success' ? 'pass' : 'info';
  const t = h(`div.toast.${type}`, icon(iconName),
    h('div.grow', h('div.toast-msg', message), actions ? h('div.toast-actions', actions.map((a) => h('button.btn.small' + (a.primary ? '' : '.secondary'), { onclick: () => { a.run(); t.remove(); } }, a.label))) : null),
    iconBtn('close', '关闭', () => t.remove()));
  toastBox.appendChild(t);
  const ms = timeout !== undefined ? timeout : type === 'error' ? 12000 : 5000;
  if (ms > 0) {
    let timer = setTimeout(() => t.remove(), ms);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { timer = setTimeout(() => t.remove(), 2500); });
  }
  while (toastBox.children.length > 5) toastBox.firstChild.remove();
  return t;
}

// ------------------------------------------------------------------ lightbox
export function lightbox(src) {
  const el = h('div.lightbox', { onclick: () => el.remove() }, h('img', { src }));
  const onKey = (e) => { if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', onKey, true); } };
  document.addEventListener('keydown', onKey, true);
  root().appendChild(el);
}
