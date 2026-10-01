// drawing-view.js — shows one sheet with pan/zoom and the pins on top of it.
//
// How positioning works:
//   The sheet sits in a "world" box sized in the drawing's own units
//   (PDF points or image pixels). Pan/zoom is one CSS transform on that box.
//   Pins are stored as fractions of the page (x, y from 0 to 1), so a pin at
//   x=0.5, y=0.5 is always dead-center no matter the zoom or screen size.

import { el, statusKey } from './ui.js';
import { itemRef } from './db.js';
import { getPdf } from './sheet-render.js';

// Base render is capped so big sheets stay within phone memory limits (iOS caps
// a single canvas at ~16.7M pixels).
const MAX_BASE_PIXELS = 10_000_000;
const MAX_BASE_SCALE = 4;
// When zoomed past the base render's sharpness, the visible area is re-rendered crisp.
const MAX_DETAIL_PIXELS = 6_000_000;
const TAP_SLOP = 8; // px a finger can wiggle and still count as a tap / long-press
const LONG_PRESS_MS = 500; // hold this long to drop a pin

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class DrawingView {
  // onLongPress(x, y): finger held on the sheet (x, y are 0–1 page fractions)
  // onEmptyTap(): quick tap on the sheet but not on a pin
  // onPinTap(itemId): tap on an existing pin
  constructor(stage, { onLongPress, onEmptyTap, onPinTap }) {
    this.stage = stage;
    this.onLongPress = onLongPress;
    this.onEmptyTap = onEmptyTap;
    this.onPinTap = onPinTap;

    this.sheetLayer = el('div', { class: 'sheet-layer' });
    this.pinLayer = el('div', { class: 'pin-layer' });
    this.world = el('div', { class: 'world' }, this.sheetLayer, this.pinLayer);
    stage.append(this.world);

    this.s = 1; this.tx = 0; this.ty = 0; this.W = 1; this.H = 1;
    this.fitScale = 1;
    this.pointers = new Map();
    this.gesture = null;
    this.token = 0;
    this.ready = false;
    this.pendingPin = null;

    stage.addEventListener('pointerdown', (e) => this.onDown(e));
    stage.addEventListener('pointermove', (e) => this.onMove(e));
    stage.addEventListener('pointerup', (e) => this.onUp(e));
    stage.addEventListener('pointercancel', (e) => this.onUp(e));
    // iPhone/iPad Safari can send the "finger lifted" event somewhere else (e.g. to the
    // item form that just opened under the finger). If the drawing never hears it, it
    // thinks that finger is still down and treats every later touch as a pinch.
    stage.addEventListener('lostpointercapture', (e) => this.forget(e.pointerId));
    this.onWindowUp = (e) => this.forget(e.pointerId);
    window.addEventListener('pointerup', this.onWindowUp); // runs after the stage's own handler
    window.addEventListener('pointercancel', this.onWindowUp);
    stage.addEventListener('contextmenu', (e) => e.preventDefault()); // Android long-press menu
    stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // Safari trackpad pinch (desktop). On iPhone, pinch is handled by pointer events.
    stage.addEventListener('gesturestart', (e) => { e.preventDefault(); this.gestureScale0 = this.s; });
    stage.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (this.pointers.size >= 2) return;
      this.zoomAt(this.localPoint(e), (this.gestureScale0 * e.scale) / this.s);
    });

    this.resizeObserver = new ResizeObserver(() => { if (!this.userMoved) this.fit(); });
    this.resizeObserver.observe(stage);
  }

  // ---------- Showing a sheet ----------

  async show(drawing, blob) {
    const token = ++this.token;
    this.ready = false;
    this.clearSheet();
    this.W = drawing.widthPx;
    this.H = drawing.heightPx;
    this.world.style.width = `${this.W}px`;
    this.world.style.height = `${this.H}px`;
    this.fit();
    this.stage.classList.add('loading');
    try {
      if (drawing.fileType === 'pdf') {
        const doc = await getPdf(drawing.fileId, blob);
        const page = await doc.getPage(drawing.pageNumber);
        if (token !== this.token) return;
        this.page = page;
        this.baseScale = Math.min(MAX_BASE_SCALE, Math.sqrt(MAX_BASE_PIXELS / (this.W * this.H)));
        const vp = page.getViewport({ scale: this.baseScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        this.baseTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
        await this.baseTask.promise;
        if (token !== this.token) return;
        this.sheetLayer.prepend(canvas);
      } else {
        this.objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.draggable = false;
        img.src = this.objectUrl;
        await img.decode();
        if (token !== this.token) return;
        this.sheetLayer.prepend(img);
      }
      this.ready = true;
      this.scheduleDetail();
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      throw err;
    } finally {
      if (token === this.token) this.stage.classList.remove('loading');
    }
  }

  clearSheet() {
    if (this.baseTask) this.baseTask.cancel();
    if (this.detailTask) this.detailTask.cancel();
    this.baseTask = this.detailTask = null;
    this.page = null;
    clearTimeout(this.detailTimer);
    for (const c of this.sheetLayer.querySelectorAll('canvas')) c.width = c.height = 0; // frees memory on iOS
    this.sheetLayer.replaceChildren();
    this.detailCanvas = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  destroy() {
    window.removeEventListener('pointerup', this.onWindowUp);
    window.removeEventListener('pointercancel', this.onWindowUp);
    this.token++;
    this.clearSheet();
    this.resizeObserver.disconnect();
  }

  // ---------- Pins ----------

  setItems(items) {
    this.items = items;
    const pins = items.map((it) => this.makePin(it.x, it.y, itemRef(it), {
      id: it.id, status: statusKey(it.status),
    }));
    this.pinLayer.replaceChildren(...pins, ...(this.pendingPin ? [this.pendingPin] : []));
  }

  makePin(x, y, label, dataset) {
    return el('div', {
      class: 'pin', dataset, style: `left:${x * 100}%;top:${y * 100}%`,
    }, el('span', {}, label));
  }

  setPendingPin(x, y) {
    this.clearPendingPin();
    this.pendingPin = this.makePin(x, y, '+', { status: 'pending' });
    this.pendingPin.classList.add('pending');
    this.pinLayer.append(this.pendingPin);
  }

  clearPendingPin() {
    if (this.pendingPin) this.pendingPin.remove();
    this.pendingPin = null;
  }

  // ---------- Pan / zoom ----------

  fit() {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const pad = 12;
    const s = Math.min((r.width - 2 * pad) / this.W, (r.height - 2 * pad) / this.H);
    this.fitScale = s;
    this.s = s;
    this.tx = (r.width - this.W * s) / 2;
    this.ty = (r.height - this.H * s) / 2;
    this.userMoved = false;
    this.apply();
  }

  // Center the view on a spot (0–1 page fractions), zooming in if needed.
  focusOn(x, y) {
    const r = this.stage.getBoundingClientRect();
    const s = this.clampScale(Math.max(this.s, this.fitScale * 3));
    this.s = s;
    this.tx = r.width / 2 - x * this.W * s;
    this.ty = r.height / 2 - y * this.H * s;
    this.userMoved = true;
    this.apply();
  }

  flashPin(id) {
    const pin = [...this.pinLayer.children].find((p) => p.dataset.id === id);
    if (!pin) return;
    pin.classList.remove('flash');
    void pin.offsetWidth; // restart the animation
    pin.classList.add('flash');
    setTimeout(() => pin.classList.remove('flash'), 2600);
  }

  clampScale(s) {
    const min = this.fitScale * 0.5;
    const max = Math.max(this.fitScale * 40, 4);
    return Math.min(max, Math.max(min, s));
  }

  zoomAt(p, factor) {
    const s = this.clampScale(this.s * factor);
    const k = s / this.s;
    this.tx = p.x - (p.x - this.tx) * k;
    this.ty = p.y - (p.y - this.ty) * k;
    this.s = s;
    this.userMoved = true;
    this.apply();
  }

  apply() {
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`;
    // Pins counter-scale so they stay the same size on screen at any zoom.
    this.world.style.setProperty('--pin-scale', 1 / this.s);
    this.scheduleDetail();
  }

  localPoint(e) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Drop a finger we've lost track of (see constructor).
  forget(pointerId) {
    if (!this.pointers.has(pointerId)) return;
    this.pointers.delete(pointerId);
    this.cancelPress();
    if (this.pointers.size === 0) this.gesture = null;
  }

  onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The first finger of a new touch: anything still on record is left over, so start fresh.
    if (e.isPrimary) {
      this.pointers.clear();
      this.cancelPress();
    }
    const p = this.localPoint(e);
    const pinEl = e.target.closest('.pin');
    this.stage.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.gesture = { type: 'pan', start: p, last: p, moved: false, pinEl };
      if (!pinEl) this.startPress(this.gesture);
    } else if (this.pointers.size === 2) {
      this.cancelPress();
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        type: 'pinch', dist0: dist(a, b) || 1, mid0: mid(a, b), s0: this.s, tx0: this.tx, ty0: this.ty,
      };
    }
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.localPoint(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pan' && this.pointers.size === 1) {
      if (!g.moved && dist(p, g.start) > TAP_SLOP) {
        g.moved = true;
        this.cancelPress();
      }
      if (g.moved) {
        this.tx += p.x - g.last.x;
        this.ty += p.y - g.last.y;
        this.userMoved = true;
        this.apply();
      }
      g.last = p;
    } else if (g.type === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const m = mid(a, b);
      const s = this.clampScale((g.s0 * dist(a, b)) / g.dist0);
      const k = s / g.s0;
      this.s = s;
      this.tx = m.x - (g.mid0.x - g.tx0) * k;
      this.ty = m.y - (g.mid0.y - g.ty0) * k;
      this.userMoved = true;
      this.apply();
    }
  }

  onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.cancelPress();
    const g = this.gesture;
    const isTap = e.type === 'pointerup' && g && g.type === 'pan' && !g.moved && this.pointers.size === 0;
    if (isTap) this.handleTap(g);
    if (this.pointers.size === 1) {
      // Lifted one finger of a pinch: continue as a pan, but never as a tap.
      const p = [...this.pointers.values()][0];
      this.gesture = { type: 'pan', start: p, last: p, moved: true };
    } else if (this.pointers.size === 0) {
      this.gesture = null;
    }
  }

  handleTap(g) {
    if (g.pinEl && g.pinEl.dataset.id) {
      this.onPinTap(g.pinEl.dataset.id);
      return;
    }
    if (!g.pinEl && this.pageFraction(g.start)) this.onEmptyTap();
  }

  // Screen point -> {x, y} as 0–1 fractions of the page, or null if off the sheet.
  pageFraction(p) {
    if (!this.ready) return null;
    const x = (p.x - this.tx) / this.s / this.W;
    const y = (p.y - this.ty) / this.s / this.H;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }

  // ---------- Long-press to drop a pin ----------

  startPress(g) {
    const spot = this.pageFraction(g.start);
    if (!spot) return;
    // A ring fills in under the finger so you know the hold is working.
    this.pressRing = el('div', { class: 'press-ring', style: `left:${g.start.x}px;top:${g.start.y}px` });
    this.stage.append(this.pressRing);
    this.pressTimer = setTimeout(() => {
      this.cancelPress();
      g.type = 'done'; // ignore the rest of this touch
      this.pointers.clear(); // the form opens under the finger; don't wait to hear it lift
      if (navigator.vibrate) navigator.vibrate(15);
      this.onLongPress(spot.x, spot.y);
    }, LONG_PRESS_MS);
  }

  cancelPress() {
    clearTimeout(this.pressTimer);
    this.pressTimer = null;
    if (this.pressRing) this.pressRing.remove();
    this.pressRing = null;
  }

  onWheel(e) {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : 1;
    const speed = e.ctrlKey ? 0.01 : 0.002; // ctrlKey = trackpad pinch in Chrome
    this.zoomAt(this.localPoint(e), Math.exp(-e.deltaY * lines * speed));
  }

  // ---------- Crisp re-render when zoomed in (PDF only) ----------

  scheduleDetail() {
    clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => this.renderDetail(), 200);
  }

  async renderDetail() {
    if (!this.page || !this.ready) return;
    const dpr = window.devicePixelRatio || 1;
    const wanted = this.s * dpr; // screen pixels per drawing unit
    if (wanted <= this.baseScale * 1.15) {
      if (this.detailTask) this.detailTask.cancel();
      this.detailTask = null;
      this.removeDetail();
      return;
    }
    const r = this.stage.getBoundingClientRect();
    const x0 = Math.max(0, -this.tx / this.s);
    const y0 = Math.max(0, -this.ty / this.s);
    const x1 = Math.min(this.W, (r.width - this.tx) / this.s);
    const y1 = Math.min(this.H, (r.height - this.ty) / this.s);
    if (x1 <= x0 || y1 <= y0) return;
    const areaAtWanted = (x1 - x0) * (y1 - y0) * wanted * wanted;
    const scale = wanted * Math.min(1, Math.sqrt(MAX_DETAIL_PIXELS / areaAtWanted));

    if (this.detailTask) this.detailTask.cancel();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((x1 - x0) * scale);
    canvas.height = Math.ceil((y1 - y0) * scale);
    const viewport = this.page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
    const task = this.page.render({ canvasContext: canvas.getContext('2d'), viewport });
    this.detailTask = task;
    try {
      await task.promise;
    } catch {
      return; // cancelled by a newer render
    }
    if (task !== this.detailTask || !this.page) return;
    canvas.className = 'detail';
    Object.assign(canvas.style, {
      left: `${x0}px`, top: `${y0}px`,
      width: `${canvas.width / scale}px`, height: `${canvas.height / scale}px`,
    });
    this.removeDetail();
    this.sheetLayer.append(canvas);
    this.detailCanvas = canvas;
  }

  removeDetail() {
    if (!this.detailCanvas) return;
    this.detailCanvas.remove();
    this.detailCanvas.width = this.detailCanvas.height = 0;
    this.detailCanvas = null;
  }
}
