/**
 * frontend/ui/minimap.js
 * ========================
 * Minimap：左下角 160x120px 全圖縮圖，顯示當前視口框，支援點擊跳轉與拖曳平移。
 */

const MINIMAP_W = 160;
const MINIMAP_H = 120;

export class Minimap {
  /**
   * @param {HTMLElement} containerEl 容器（將被注入 canvas）
   * @param {import('../engine/camera.js').Camera} camera
   * @param {import('../engine/graph.js').GraphData} graphData
   * @param {number} canvasSize 世界座標的邊長（正方形畫布假設）
   */
  constructor(containerEl, camera, graphData, canvasSize = 100000) {
    this.container = containerEl;
    this.camera = camera;
    this.graphData = graphData;
    this.canvasSize = canvasSize;

    this._buildDom();

    this._offscreen = null; // 離線預渲染的全圖快照
    this._isDraggingViewport = false;
    this._wasDragging = false;

    this._bindEvents();
  }

  _buildDom() {
    this.container.innerHTML = `<canvas id="minimap-canvas" width="${MINIMAP_W}" height="${MINIMAP_H}"></canvas>`;
    this.canvas = this.container.querySelector("#minimap-canvas");
    this.ctx = this.canvas.getContext("2d");
  }

  /**
   * 在 graph_meta 載入完成後呼叫一次：離線渲染全圖的 LOD 0 版本。
   * @param {import('../engine/renderer.js').Renderer} renderer 用於取得分類顏色與節點資料
   */
  buildMinimapCanvas(renderer) {
    const bounds = { x: 0, y: 0, w: this.canvasSize, h: this.canvasSize };
    this._offscreen = renderer.buildOfflineSnapshot(MINIMAP_W, MINIMAP_H, bounds);
    this.update();
  }

  /** 由 camera 的 onTransformChange 回調觸發：只重繪視口框，不重繪節點。 */
  update() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);

    ctx.fillStyle = getComputedStyle(this.container).getPropertyValue("--bg-panel") || "#1c1c1a";
    ctx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);

    if (this._offscreen) {
      ctx.drawImage(this._offscreen, 0, 0, MINIMAP_W, MINIMAP_H);
    }

    // 視口框
    const viewport = this.camera.getViewportBounds();
    const [mx0, my0] = this.worldToMinimap(viewport.x, viewport.y);
    const [mx1, my1] = this.worldToMinimap(viewport.x + viewport.w, viewport.y + viewport.h);

    const x = Math.min(mx0, mx1);
    const y = Math.min(my0, my1);
    const w = Math.abs(mx1 - mx0);
    const h = Math.abs(my1 - my0);

    ctx.fillStyle = "rgba(24, 95, 165, 0.3)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#185FA5";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
  }

  // ── 座標映射 ───────────────────────────────────────────────────────

  /** 世界座標 -> 縮圖像素座標。 */
  worldToMinimap(wx, wy) {
    return [
      (wx / this.canvasSize) * MINIMAP_W,
      (wy / this.canvasSize) * MINIMAP_H,
    ];
  }

  /** 縮圖像素座標 -> 世界座標。 */
  minimapToWorld(mx, my) {
    return [
      (mx / MINIMAP_W) * this.canvasSize,
      (my / MINIMAP_H) * this.canvasSize,
    ];
  }

  // ── 互動 ────────────────────────────────────────────────────────────

  _bindEvents() {
    this.canvas.addEventListener("mousedown", (e) => {
      this._isDraggingViewport = true;
      this._handleDrag(e);
    });

    window.addEventListener("mousemove", (e) => {
      if (!this._isDraggingViewport) return;
      this._handleDrag(e);
    });

    window.addEventListener("mouseup", () => {
      this._isDraggingViewport = false;
    });

    this.canvas.addEventListener("click", (e) => {
      if (this._wasDragging) {
        this._wasDragging = false;
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const [wx, wy] = this.minimapToWorld(mx, my);
      this.camera.flyTo(wx, wy, this.camera.scale, 400);
    });
  }

  _handleDrag(e) {
    this._wasDragging = true;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const [wx, wy] = this.minimapToWorld(
      Math.max(0, Math.min(MINIMAP_W, mx)),
      Math.max(0, Math.min(MINIMAP_H, my))
    );

    // 將視口中心移到拖曳對應的世界座標（即時 pan，非動畫）
    const rect2 = this.camera._canvasRect
      ? this.camera._canvasRect()
      : { width: window.innerWidth, height: window.innerHeight };
    const cx = rect2.width / 2;
    const cy = rect2.height / 2;
    const scale = this.camera.scale;

    const [curWx, curWy] = this.camera.screenToWorld(cx, cy);
    const dx = (curWx - wx) * scale;
    const dy = (curWy - wy) * scale;
    this.camera.panBy(dx, dy);
  }
}
