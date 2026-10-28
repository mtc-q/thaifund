// Editor state + undo history + a tiny event bus.
const clone = o => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const MAX_HISTORY = 120;

class Store extends EventTarget {
  constructor() {
    super();
    this.state = null;
    this.history = [];
    this.index = -1;
    this.patchHandler = null; // (patch, direction) => void   for non-state data (mask brush)
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, e => fn(e.detail)); }

  reset(state, label = 'Open') {
    this.state = state;
    this.history = [{ label, snap: clone(state), patch: null }];
    this.index = 0;
    this.emit('sync', { reason: 'reset' });
    this.emit('history');
  }

  /** Live change (no history entry). `kind` lets listeners decide what to refresh. */
  set(fn, kind = 'params') {
    fn(this.state);
    this.emit('change', { kind });
  }

  /** Records the current state as a history step. */
  commit(label, patch = null) {
    if (!this.state) return;
    const snap = clone(this.state);
    const cur = this.history[this.index];
    if (!patch && cur && JSON.stringify(cur.snap) === JSON.stringify(snap)) return;
    this.history.length = this.index + 1;
    this.history.push({ label, snap, patch });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.index = this.history.length - 1;
    this.emit('history');
  }

  get dirty() { return this.history.length > 1 && this.index > 0; }
  canUndo() { return this.index > 0; }
  canRedo() { return this.index < this.history.length - 1; }

  undo() { if (this.canUndo()) this.jump(this.index - 1); }
  redo() { if (this.canRedo()) this.jump(this.index + 1); }

  jump(target) {
    target = Math.max(0, Math.min(this.history.length - 1, target));
    if (target === this.index) return;
    while (this.index > target) {
      const e = this.history[this.index];
      if (e.patch && this.patchHandler) this.patchHandler(e.patch, -1);
      this.index--;
    }
    while (this.index < target) {
      this.index++;
      const e = this.history[this.index];
      if (e.patch && this.patchHandler) this.patchHandler(e.patch, 1);
    }
    this.state = clone(this.history[this.index].snap);
    this.emit('sync', { reason: 'history' });
    this.emit('change', { kind: 'all' });
    this.emit('history');
  }
}

export const store = new Store();
export { clone };
