// drawing-view.js — shows one sheet with pan/zoom and the pins on top of it.
//
// How positioning works:
//   The sheet is rendered ONCE into a "base" picture that is never put on the page. What you see
//   is a screen-sized canvas: on every pan/zoom step the visible part of the base picture is
//   copied onto it (drawScreen). Nothing on the page is ever enlarged with CSS: iPhone Safari
//   re-paints enlarged things at the zoomed-in sharpness, and zooming OUT fast from deep zoom
//   then made it paint the whole 42"x30" sheet at that sharpness — it ran out of memory and
//   killed the page (v29–v31 crashes). Now memory stays the same at any zoom.
//     - detail: once a gesture settles, the visible part is re-rendered sharp at screen
//       resolution (also off the page) and copied on top of the base picture;
//     - pin layer: the pins, each moved to its spot on screen (plain screen pixels).
//   Drawing units = the drawing's own units (PDF points or image pixels).
//   Pins are stored as fractions of the page (x, y from 0 to 1), so a pin at
//   x=0.5, y=0.5 is always dead-center no matter the zoom or screen size.

import { el, statusKey } from './ui.js';
import { itemRef, isNumberPending } from './db.js';
import { getPdf } from './sheet-render.js';

// Memory: iPhone Safari kills the page ("A problem repeatedly occurred") if canvases use too much,
// so phones/tablets get smaller limits than computers.
const TOUCH = window.matchMedia('(pointer: coarse)').matches;
// Base render (the whole sheet) is capped so big sheets stay within memory limits.
const MAX_BASE_PIXELS = TOUCH ? 6_000_000 : 10_000_000;
const MAX_BASE_SCALE = 4;
// When zoomed in, the visible area is re-rendered sharp at screen resolution (capped for memory).
const MAX_DETAIL_PIXELS = TOUCH ? 4_000_000 : 8_000_000;
// Re-render no finer than 2 device pixels per screen point: 3x phones look the same, at less than half the memory.
const MAX_DPR = 2;
// Wait this long after the last zoom/pan before re-rendering sharp.
const DETAIL_DELAY_MS = 250;
const TAP_SLOP = 8; // px a finger can wiggle and still count as a tap / long-press
const LONG_PRESS_MS = 500; // hold this long to drop a pin
const GROUP_DIST = 26; // px on screen: pins closer than this overlap, so they're shown as one "+N" pin

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class DrawingView {
  // onLongPress(x, y): finger held on the sheet (x, y are 0–1 page fractions)
  // onEmptyTap(x, y): quick tap on the sheet but not on a pin
  // onPinTap(itemId): tap on an existing pin
  // onGroupTap(itemIds, x, y): tap on a "+N" pin (several overlapping pins)
  constructor(stage, { onLongPress, onEmptyTap, onPinTap, onGroupTap }) {
    this.stage = stage;
    this.onLongPress = onLongPress;
    this.onEmptyTap = onEmptyTap;
    this.onPinTap = onPinTap;
    this.onGroupTap = onGroupTap;

    this.screen = el('canvas', { class: 'sheet-screen' }); // screen pixels (see top of file)
    this.pinLayer = el('div', { class: 'pin-layer' });     // screen pixels
    stage.append(this.screen, this.pinLayer);
    this.base = null;         // the whole sheet: a canvas (PDF) or an <img>, never on the page
    this.detailCanvas = null; // sharp render of the visible part, never on the page
    this.detailToken = 0;
    this.screenDpr = 1;

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

    this.resizeObserver = new ResizeObserver(() => {
      this.sizeScreen();
      if (!this.userMoved) this.fit();
      else this.apply();
    });
    this.resizeObserver.observe(stage);
  }

  // ---------- Showing a sheet ----------

  // A synced sheet whose drawing file hasn't downloaded yet: blank sheet + "Loading sheet…".
  showWaiting(drawing) {
    ++this.token;
    this.ready = false;
    this.clearSheet();
    this.W = drawing.widthPx;
    this.H = drawing.heightPx;
    this.fit();
    this.stage.classList.add('loading');
  }

  async show(drawing, blob) {
    const token = ++this.token;
    this.ready = false;
    this.clearSheet();
    this.W = drawing.widthPx;
    this.H = drawing.heightPx;
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
        try {
          await this.baseTask.promise;
        } catch (err) {
          canvas.width = canvas.height = 0;
          throw err;
        }
        if (token !== this.token) { canvas.width = canvas.height = 0; return; }
        this.base = canvas;
      } else {
        this.objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.draggable = false;
        img.src = this.objectUrl;
        await img.decode();
        if (token !== this.token) return;
        this.base = img;
        this.img = img;
      }
      this.ready = true;
      this.drawScreen();
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
    this.detailToken++;
    // Let pdf.js drop this page's decoded images etc. (after the cancels above have landed).
    const page = this.page;
    if (page) setTimeout(() => { try { page.cleanup(); } catch { /* still busy: freed later */ } }, 500);
    this.page = null;
    this.img = null;
    clearTimeout(this.detailTimer);
    if (this.base && this.base.tagName === 'CANVAS') this.base.width = this.base.height = 0; // frees memory on iOS
    this.base = null;
    this.removeDetail();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  destroy() {
    clearTimeout(this.regroupTimer);
    window.removeEventListener('pointerup', this.onWindowUp);
    window.removeEventListener('pointercancel', this.onWindowUp);
    this.token++;
    this.clearSheet();
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
    this.screen.width = this.screen.height = 0;
  }

  // ---------- Pins ----------

  setItems(items) {
    this.items = items;
    this.renderPins();
  }

  // Draws the pins. Pins that would overlap at the current zoom are merged into one gray
  // "+N" pin; zooming in far enough splits them apart again (see apply()).
  renderPins() {
    this.groupScale = this.s;
    const pins = this.groupPins(this.items || []).map((g) => {
      if (g.length === 1) {
        const it = g[0];
        return this.makePin(it.x, it.y, itemRef(it), {
          id: it.id, status: statusKey(it.status), ...(isNumberPending(it) ? { unsynced: '1' } : {}),
        });
      }
      const x = g.reduce((sum, it) => sum + it.x, 0) / g.length;
      const y = g.reduce((sum, it) => sum + it.y, 0) / g.length;
      return this.makePin(x, y, `+${g.length}`, { group: g.map((it) => it.id).join(','), status: 'group', x, y });
    });
    this.pinLayer.replaceChildren(...pins, ...(this.pendingPin ? [this.pendingPin] : []));
  }

  // Splits items into groups of pins that overlap on screen at the current zoom.
  groupPins(items) {
    const sx = this.W * this.s;
    const sy = this.H * this.s;
    const groups = []; // { x, y (screen px of the first pin), members }
    for (const it of items) {
      const px = it.x * sx;
      const py = it.y * sy;
      const near = groups.find((g) => Math.abs(g.x - px) < GROUP_DIST && Math.abs(g.y - py) < GROUP_DIST);
      if (near) near.members.push(it);
      else groups.push({ x: px, y: py, members: [it] });
    }
    return groups.map((g) => g.members);
  }

  makePin(x, y, label, dataset) {
    const pin = el('div', { class: 'pin', dataset }, el('span', {}, label));
    pin.pageX = x;
    pin.pageY = y;
    this.placePin(pin);
    return pin;
  }

  // Moves a pin to its spot on screen (whole pixels keep the number crisp).
  placePin(pin) {
    const x = Math.round(this.tx + pin.pageX * this.W * this.s);
    const y = Math.round(this.ty + pin.pageY * this.H * this.s);
    pin.style.transform = `translate(${x}px, ${y}px)`;
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

  // Zoom in on a "+N" group just far enough that its pins spread apart (as far as the
  // zoom allows — pins at the exact same spot stay grouped; the group menu still lists them).
  zoomToSeparate(items) {
    const r = this.stage.getBoundingClientRect();
    const x = items.reduce((sum, it) => sum + it.x, 0) / items.length;
    const y = items.reduce((sum, it) => sum + it.y, 0) / items.length;
    let closest = Infinity; // page units between the closest two pins (the larger of the x / y gaps)
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const gap = Math.max(Math.abs(items[i].x - items[j].x) * this.W, Math.abs(items[i].y - items[j].y) * this.H);
        closest = Math.min(closest, gap);
      }
    }
    const needed = closest > 0 ? (GROUP_DIST * 1.5) / closest : Infinity;
    const s = this.clampScale(Math.max(this.s * 2, needed));
    this.s = s;
    this.tx = r.width / 2 - x * this.W * s;
    this.ty = r.height / 2 - y * this.H * s;
    this.userMoved = true;
    this.apply();
  }

  flashPin(id) {
    if (this.groupScale !== this.s) this.renderPins(); // make sure grouping matches the current zoom
    const pin = [...this.pinLayer.children].find(
      (p) => p.dataset.id === id || (p.dataset.group || '').split(',').includes(id));
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
    this.requestDraw();
    for (const pin of this.pinLayer.children) this.placePin(pin);
    this.scheduleDetail();
    // Zoom changed: regroup overlapping pins (throttled; panning alone doesn't change grouping).
    if (this.items && this.groupScale && Math.abs(Math.log(this.s / this.groupScale)) > 0.03 && !this.regroupTimer) {
      this.regroupTimer = setTimeout(() => { this.regroupTimer = null; this.renderPins(); }, 40);
    }
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
    if (g.pinEl && g.pinEl.dataset.group) {
      const d = g.pinEl.dataset;
      this.onGroupTap(d.group.split(','), Number(d.x), Number(d.y));
      return;
    }
    const spot = !g.pinEl && this.pageFraction(g.start);
    if (spot) this.onEmptyTap(spot.x, spot.y);
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

  // ---------- Sharp re-render when zoomed in ----------

  // Called on every zoom / pan step: re-render sharp once things have been still for a moment.
  // A render already running is left to finish (cancelling pdf.js half-way leaves its scratch
  // canvases for Safari to clean up "later", and rapid zooming piled those up into a crash);
  // only one runs at a time, and the next one starts after it.
  scheduleDetail() {
    clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => this.renderDetail(), DETAIL_DELAY_MS);
  }

  // Re-draws the visible part of the sheet at screen resolution, in the detail layer.
  async renderDetail() {
    if (!this.ready || (!this.page && !this.img)) return;
    // Fingers still on the screen (mid-pinch): wait until they lift.
    if (this.pointers.size > 0) { this.scheduleDetail(); return; }
    // Only one render at a time: if the previous one is still winding down, try again shortly.
    if (this.detailBusy) { this.scheduleDetail(); return; }
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const wanted = this.s * dpr; // device pixels per drawing unit
    // Until you zoom in past what the base picture already holds, it's sharp enough: no extra
    // render (this is what made zooming OUT expensive — it re-rendered the whole sheet).
    const basePerUnit = this.page ? this.baseScale : (this.img ? this.img.naturalWidth / this.W : 1);
    if (wanted <= basePerUnit * 1.25) {
      this.detailToken++;
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
    const view = { s: this.s, x0, y0, scale }; // the zoom this render was made for

    // Already showing a sharp render made for this exact view? Nothing to do.
    const v = this.detailView;
    if (this.detailCanvas && v && v.s === this.s && v.x0 === x0 && v.y0 === y0) return;
    const token = ++this.detailToken;
    this.detailBusy = true;
    try {
      await this.drawDetail(token, x0, y0, x1, y1, scale, view);
    } finally {
      this.detailBusy = false;
    }
  }

  async drawDetail(token, x0, y0, x1, y1, scale, view) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((x1 - x0) * scale);
    canvas.height = Math.ceil((y1 - y0) * scale);
    const ctx = canvas.getContext('2d');
    if (this.page) {
      const viewport = this.page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
      const task = this.page.render({ canvasContext: ctx, viewport });
      this.detailTask = task;
      try {
        await task.promise;
      } catch {
        canvas.width = canvas.height = 0;
        return; // cancelled by a newer render
      }
    } else {
      // Image sheet: copy just the visible part of the image at screen resolution.
      const k = this.img.naturalWidth / this.W;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.img, x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k, 0, 0, canvas.width, canvas.height);
    }
    if (token !== this.detailToken) {
      canvas.width = canvas.height = 0;
      return; // a newer render replaced this one
    }
    this.removeDetail();
    this.detailCanvas = canvas;
    this.detailView = view;
    this.requestDraw();
  }

  removeDetail() {
    if (!this.detailCanvas) return;
    this.detailCanvas.width = this.detailCanvas.height = 0;
    this.detailCanvas = null;
    this.requestDraw();
  }

  // ---------- The screen canvas ----------

  // Matches the screen canvas to the stage's size (in device pixels, capped like the renders).
  sizeScreen() {
    const r = this.stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (this.screen.width !== w || this.screen.height !== h) {
      this.screen.width = w;
      this.screen.height = h;
    }
    this.screenDpr = dpr;
  }

  // Redraw at the next screen refresh (many pan/zoom steps can arrive per frame).
  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.drawScreen(); });
  }

  // Copies the visible part of the sheet onto the screen canvas: white page, the base picture,
  // then the sharp detail render (stretched a little until the gesture stops and it's redone).
  drawScreen() {
    if (!this.screen.width) this.sizeScreen();
    const ctx = this.screen.getContext('2d');
    const d = this.screenDpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.screen.width, this.screen.height);
    ctx.setTransform(d * this.s, 0, 0, d * this.s, d * this.tx, d * this.ty);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.W, this.H);
    if (this.base) ctx.drawImage(this.base, 0, 0, this.W, this.H);
    const c = this.detailCanvas;
    if (c) {
      const v = this.detailView;
      ctx.drawImage(c, v.x0, v.y0, c.width / v.scale, c.height / v.scale);
    }
    // A thin edge so the sheet stands out from the gray background.
    ctx.strokeStyle = 'rgba(0, 0, 0, .25)';
    ctx.lineWidth = 1 / this.s;
    ctx.strokeRect(0, 0, this.W, this.H);
  }
}
