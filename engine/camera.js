/**
 * frontend/engine/camera.js
 * ===========================
 * 視圖控制：管理 pan/zoom 變換矩陣、動畫飛行至節點、滑鼠與觸控支援。
 *
 * 座標系統：
 * - 世界座標（world）：圖形佈局座標，範圍 [0, canvasSize]
 * - 螢幕座標（screen）：Canvas 像素座標
 * - transform = {x, y, scale}：screen = world * scale + {x, y}
 */

const SCALE_MIN = 0.05;
const SCALE_MAX = 20;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Camera {
  /**
   * @param {HTMLCanvasElement} canvas 用於綁定事件與取得尺寸的任一層 canvas（建議用最上層的互動層）
   * @param {(transform: {x:number,y:number,scale:number}) => void} onTransformChange
   */
  constructor(canvas, onTransformChange) {
    this.canvas = canvas;
    this._onTransformChange = onTransformChange || (() => {});

    this._x = 0;
    this._y = 0;
    this._scale = 1;

    // pan 狀態
    this._isPanning = false;
    this._panStart = { sx: 0, sy: 0, x: 0, y: 0 };

    // 觸控狀態
    this._touchState = null; // { mode: 'pan'|'pinch', ... }

    // flyTo 動畫狀態
    this._flyAnimFrame = null;

    this._bindEvents();
  }

  // ── 座標轉換 ────────────────────────────────────────────────────────

  /** 世界座標 -> 螢幕座標 */
  worldToScreen(wx, wy) {
    return [wx * this._scale + this._x, wy * this._scale + this._y];
  }

  /** 螢幕座標 -> 世界座標 */
  screenToWorld(sx, sy) {
    return [(sx - this._x) / this._scale, (sy - this._y) / this._scale];
  }

  /** 取得目前視口在世界座標系下的範圍。 */
  getViewportBounds() {
    const rect = this._canvasRect();
    const [wx0, wy0] = this.screenToWorld(0, 0);
    const [wx1, wy1] = this.screenToWorld(rect.width, rect.height);
    return {
      x: Math.min(wx0, wx1),
      y: Math.min(wy0, wy1),
      w: Math.abs(wx1 - wx0),
      h: Math.abs(wy1 - wy0),
    };
  }

  _canvasRect() {
    // 優先用 CSS 像素尺寸（與滑鼠事件座標系一致）
    return { width: this.canvas.clientWidth || this.canvas.width, height: this.canvas.clientHeight || this.canvas.height };
  }

  // ── 縮放／平移 ─────────────────────────────────────────────────────

  /**
   * 以螢幕座標 (centerSx, centerSy) 為中心縮放。
   * @param {number} factor 例如 1.15（放大）或 0.87（縮小）
   */
  zoom(factor, centerSx, centerSy) {
    const newScale = this._clampScale(this._scale * factor);
    const actualFactor = newScale / this._scale;

    // 保持 centerS 對應的世界座標不變
    this._x = centerSx - (centerSx - this._x) * actualFactor;
    this._y = centerSy - (centerSy - this._y) * actualFactor;
    this._scale = newScale;

    this._emitChange();
  }

  /**
   * 縮放到指定倍率（以視口中心為錨點）。
   * @param {number} scale
   * @param {boolean} [animated=false]
   */
  zoomTo(scale, animated = false) {
    const rect = this._canvasRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const [wx, wy] = this.screenToWorld(cx, cy);

    if (animated) {
      this.flyTo(wx, wy, scale);
    } else {
      const clamped = this._clampScale(scale);
      this._x = cx - wx * clamped;
      this._y = cy - wy * clamped;
      this._scale = clamped;
      this._emitChange();
    }
  }

  /** 以螢幕座標位移量平移視圖。 */
  panBy(dx, dy) {
    this._x += dx;
    this._y += dy;
    this._emitChange();
  }

  _clampScale(s) {
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
  }

  // ── 動畫飛行 ────────────────────────────────────────────────────────

  /**
   * 動畫飛行至世界座標 (worldX, worldY)，並縮放到 targetScale。
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} [targetScale=2.0]
   * @param {number} [duration=600] 毫秒
   * @returns {Promise<void>} 動畫完成時 resolve
   */
  flyTo(worldX, worldY, targetScale = 2.0, duration = 600) {
    if (this._flyAnimFrame) {
      cancelAnimationFrame(this._flyAnimFrame);
      this._flyAnimFrame = null;
    }

    const rect = this._canvasRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const startX = this._x;
    const startY = this._y;
    const startScale = this._scale;

    const endScale = this._clampScale(targetScale);
    const endX = cx - worldX * endScale;
    const endY = cy - worldY * endScale;

    const startTime = performance.now();

    return new Promise((resolve) => {
      const step = (now) => {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / duration);
        const eased = easeInOutCubic(t);

        this._x = startX + (endX - startX) * eased;
        this._y = startY + (endY - startY) * eased;
        this._scale = startScale + (endScale - startScale) * eased;
        this._emitChange();

        if (t < 1) {
          this._flyAnimFrame = requestAnimationFrame(step);
        } else {
          this._flyAnimFrame = null;
          resolve();
        }
      };
      this._flyAnimFrame = requestAnimationFrame(step);
    });
  }

  // ── 重置 ────────────────────────────────────────────────────────────

  /**
   * 重置視圖以容納整張圖（fit-all）。
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @param {{x:number,y:number,w:number,h:number}} graphBounds 世界座標範圍
   */
  reset(canvasWidth, canvasHeight, graphBounds) {
    const padding = 0.92; // 留 8% 邊距
    const scaleX = (canvasWidth * padding) / graphBounds.w;
    const scaleY = (canvasHeight * padding) / graphBounds.h;
    const scale = this._clampScale(Math.min(scaleX, scaleY));

    const cx = graphBounds.x + graphBounds.w / 2;
    const cy = graphBounds.y + graphBounds.h / 2;

    this._scale = scale;
    this._x = canvasWidth / 2 - cx * scale;
    this._y = canvasHeight / 2 - cy * scale;
    this._emitChange();
  }

  // ── getter ──────────────────────────────────────────────────────────

  get scale() {
    return this._scale;
  }

  get transform() {
    return { x: this._x, y: this._y, scale: this._scale };
  }

  // ── 事件綁定 ────────────────────────────────────────────────────────

  _bindEvents() {
    const canvas = this.canvas;

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      this.zoom(factor, sx, sy);
    }, { passive: false });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this._isPanning = true;
      const rect = canvas.getBoundingClientRect();
      this._panStart = {
        sx: e.clientX - rect.left,
        sy: e.clientY - rect.top,
        x: this._x,
        y: this._y,
      };
    });

    window.addEventListener("mousemove", (e) => {
      if (!this._isPanning) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this._x = this._panStart.x + (sx - this._panStart.sx);
      this._y = this._panStart.y + (sy - this._panStart.sy);
      this._emitChange();
    });

    window.addEventListener("mouseup", () => {
      this._isPanning = false;
    });

    // ── 觸控：單指 pan + 雙指 pinch-zoom ─────────────────────────────

    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this._touchState = {
          mode: "pan",
          sx: t.clientX - rect.left,
          sy: t.clientY - rect.top,
          x: this._x,
          y: this._y,
        };
      } else if (e.touches.length === 2) {
        const [t0, t1] = e.touches;
        const dx = t1.clientX - t0.clientX;
        const dy = t1.clientY - t0.clientY;
        this._touchState = {
          mode: "pinch",
          startDist: Math.hypot(dx, dy),
          startScale: this._scale,
          centerSx: (t0.clientX + t1.clientX) / 2 - rect.left,
          centerSy: (t0.clientY + t1.clientY) / 2 - rect.top,
        };
      }
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (!this._touchState) return;
      const rect = canvas.getBoundingClientRect();

      if (this._touchState.mode === "pan" && e.touches.length === 1) {
        const t = e.touches[0];
        const sx = t.clientX - rect.left;
        const sy = t.clientY - rect.top;
        this._x = this._touchState.x + (sx - this._touchState.sx);
        this._y = this._touchState.y + (sy - this._touchState.sy);
        this._emitChange();
      } else if (this._touchState.mode === "pinch" && e.touches.length === 2) {
        const [t0, t1] = e.touches;
        const dx = t1.clientX - t0.clientX;
        const dy = t1.clientY - t0.clientY;
        const dist = Math.hypot(dx, dy);
        const factor = dist / this._touchState.startDist;
        const newScale = this._clampScale(this._touchState.startScale * factor);
        const actualFactor = newScale / this._scale;

        const { centerSx, centerSy } = this._touchState;
        this._x = centerSx - (centerSx - this._x) * actualFactor;
        this._y = centerSy - (centerSy - this._y) * actualFactor;
        this._scale = newScale;
        this._emitChange();
      }
    }, { passive: false });

    canvas.addEventListener("touchend", (e) => {
      if (e.touches.length === 0) {
        this._touchState = null;
      } else if (e.touches.length === 1) {
        // 雙指 -> 單指：重新進入 pan 模式
        const rect = canvas.getBoundingClientRect();
        const t = e.touches[0];
        this._touchState = {
          mode: "pan",
          sx: t.clientX - rect.left,
          sy: t.clientY - rect.top,
          x: this._x,
          y: this._y,
        };
      }
    });
  }

  _emitChange() {
    this._onTransformChange(this.transform);
  }
}
