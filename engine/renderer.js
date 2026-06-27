/**
 * frontend/engine/renderer.js
 * ==============================
 * Canvas 2D LOD（細節層級）渲染引擎。
 *
 * 三層 Canvas 疊加：
 *   canvas-edges    背景層，渲染邊（低更新頻率）
 *   canvas-nodes    節點層，渲染節點（每幀更新）
 *   canvas-interact 互動層，渲染懸停/選中高亮（滑鼠事件後更新）
 *
 * LOD 規格：
 *   LOD 0  < 0.3x   實心圓點（3px，按分類著色），不渲染邊，無文字
 *   LOD 1  0.3–0.8x 實心圓（radius * scale），僅選中節點的邊，無文字
 *   LOD 2  0.8–1.8x 圓 + 描邊，僅選中節點的邊，r > 8px 時顯示 short_name
 *   LOD 3  1.8–4x   圓 + 描邊，視口內全部邊，short_name + kind 標籤
 *   LOD 4  > 4x     圓 + 厚描邊，視口內全部邊，short_name + kind + doc 摘要（選中時）
 */

const LOD_THRESHOLDS = [0.3, 0.8, 1.8, 4.0]; // 4 個分界 -> 5 個 LOD（0..4）

// 低倍率下邊的最大渲染數量（避免 3763 條邊全畫導致卡頓）
const MAX_EDGES_LOD0 = 3000;

/** 分類色彩（依頂層命名空間），深淺色模式各一份。 */
export const CAT_COLORS = {
  light: {
    "Mathlib.Algebra": { fill: "#E6F1FB", stroke: "#185FA5", text: "#0C447C" },
    "Mathlib.Analysis": { fill: "#FAEEDA", stroke: "#854F0B", text: "#633806" },
    "Mathlib.Topology": { fill: "#FAECE7", stroke: "#993C1D", text: "#712B13" },
    "Mathlib.NumberTheory": { fill: "#EAF3DE", stroke: "#3B6D11", text: "#27500A" },
    "Mathlib.Geometry": { fill: "#F1ECFA", stroke: "#6B3FA0", text: "#4D2C75" },
    "Mathlib.Order": { fill: "#E6F5F5", stroke: "#1A6B8A", text: "#114A60" },
    "Mathlib.CategoryTheory": { fill: "#FBE9E7", stroke: "#8A3F1A", text: "#642D12" },
    "Mathlib.Probability": { fill: "#E9F5EC", stroke: "#2C7A5F", text: "#1E5642" },
    default: { fill: "#F1EFE8", stroke: "#5F5E5A", text: "#444441" },
  },
  dark: {
    "Mathlib.Algebra": { fill: "#16314f", stroke: "#5B9BD5", text: "#BFDDF5" },
    "Mathlib.Analysis": { fill: "#3a2d12", stroke: "#D6A03D", text: "#F2D9A4" },
    "Mathlib.Topology": { fill: "#3a2218", stroke: "#D87F4D", text: "#F2C9AE" },
    "Mathlib.NumberTheory": { fill: "#243a14", stroke: "#84B84A", text: "#D3E8B5" },
    "Mathlib.Geometry": { fill: "#2a2040", stroke: "#A78BD0", text: "#DCD0EE" },
    "Mathlib.Order": { fill: "#173436", stroke: "#4FA9C4", text: "#B8E2EC" },
    "Mathlib.CategoryTheory": { fill: "#3a2414", stroke: "#C97A45", text: "#EFC8A8" },
    "Mathlib.Probability": { fill: "#16332a", stroke: "#5BAE8C", text: "#BDE5D2" },
    default: { fill: "#2a2a27", stroke: "#9A9893", text: "#D8D6CF" },
  },
};

/** 種類圖示形狀（供 legend 與節點渲染共用判斷邏輯）。 */
export const KIND_SHAPES = {
  theorem: "circle-filled",
  lemma: "circle-filled",
  def: "circle-hollow",
  structure: "circle-hollow",
  class: "diamond",
  instance: "diamond",
  axiom: "circle-filled",
  opaque: "circle-hollow",
};

export class Renderer {
  /**
   * @param {HTMLElement} containerEl 包含三層 canvas 的容器元素
   * @param {import('./graph.js').GraphData} graphData
   * @param {import('./graph.js').Quadtree} quadtree
   */
  constructor(containerEl, graphData, quadtree) {
    this.container = containerEl;
    this.graphData = graphData;
    this.quadtree = quadtree || graphData.quadtree;

    this.edgesCanvas = containerEl.querySelector("#canvas-edges");
    this.nodesCanvas = containerEl.querySelector("#canvas-nodes");
    this.interactCanvas = containerEl.querySelector("#canvas-interact");

    this.edgesCtx = this.edgesCanvas.getContext("2d");
    this.nodesCtx = this.nodesCanvas.getContext("2d");
    this.interactCtx = this.interactCanvas.getContext("2d");

    this.transform = { x: 0, y: 0, scale: 1 };
    this.hoveredNode = null;
    this.selectedNode = null;
    this.highlightedDeps = new Set(); // "高亮所有直接依賴" 用
    this.pathHighlight = []; // 路徑查找結果（有序節點 id）
    this.topicHighlight = null; // 領域高亮：{ ns: string, nodeIds: Set<string> } | null
    this.showEdgesAtLOD0 = true; // 低倍率顯示邊開關

    this.theme = "light"; // 'light' | 'dark'

    /** @type {import('../ui/search.js').FilterState|null} */
    this.filterState = null;

    this._running = false;
    this._rafId = null;
    this._needsEdgeRedraw = true;
    this._needsNodeRedraw = true;
    this._needsInteractRedraw = true;

    this._dpr = window.devicePixelRatio || 1;
    this._resizeObserver = new ResizeObserver(() => this._handleResize());
    this._resizeObserver.observe(containerEl);
    this._handleResize();
  }

  // ── 公開 API ───────────────────────────────────────────────────────

  startLoop() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._renderFrame();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stopLoop() {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  /** 由 camera.js 呼叫，更新視圖變換後標記需要重繪。 */
  onTransformChanged(transform) {
    this.transform = transform;
    this._needsEdgeRedraw = true;
    this._needsNodeRedraw = true;
    this._needsInteractRedraw = true;
  }

  setHoveredNode(nodeId) {
    if (this.hoveredNode === nodeId) return;
    this.hoveredNode = nodeId;
    this._needsInteractRedraw = true;
  }

  setSelectedNode(nodeId) {
    if (this.selectedNode === nodeId) return;
    this.selectedNode = nodeId;
    this._needsEdgeRedraw = true; // LOD 1/2 只畫選中節點的邊
    this._needsInteractRedraw = true;
  }

  setHighlightedDeps(nodeIds) {
    this.highlightedDeps = new Set(nodeIds || []);
    this._needsInteractRedraw = true;
  }

  setPathHighlight(nodeIds) {
    this.pathHighlight = nodeIds || [];
    this._needsInteractRedraw = true;
    this._needsEdgeRedraw = true;
  }

  /** 設定領域高亮（點擊 legend 領域標籤時呼叫）。
   *  @param {string|null} ns  頂層命名空間，null 表示清除
   *  @param {string[]} nodeIds 該領域的所有節點 id
   */
  setTopicHighlight(ns, nodeIds) {
    this.topicHighlight = ns ? { ns, nodeIds: new Set(nodeIds) } : null;
    this._needsEdgeRedraw = true;
    this._needsNodeRedraw = true;
    this._needsInteractRedraw = true;
  }

  /** 切換低倍率邊的顯示。 */
  toggleEdgesAtLOD0(show) {
    this.showEdgesAtLOD0 = show;
    this._needsEdgeRedraw = true;
  }

  setFilterState(filterState) {
    this.filterState = filterState;
    this._needsNodeRedraw = true;
    this._needsEdgeRedraw = true;
  }

  setTheme(theme) {
    this.theme = theme === "dark" ? "dark" : "light";
    this._needsEdgeRedraw = true;
    this._needsNodeRedraw = true;
    this._needsInteractRedraw = true;
  }

  /** 圖形資料新增邊或節點後呼叫，強制下一幀重繪。 */
  notifyDataChanged() {
    this._needsEdgeRedraw = true;
    this._needsNodeRedraw = true;
  }

  redrawEdges() {
    this._needsEdgeRedraw = true;
  }

  redrawNodes() {
    this._needsNodeRedraw = true;
  }

  redrawInteract() {
    this._needsInteractRedraw = true;
  }

  getCurrentLOD() {
    return this._lodForScale(this.transform.scale);
  }

  // ── 內部：尺寸管理 ─────────────────────────────────────────────────

  _handleResize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    for (const canvas of [this.edgesCanvas, this.nodesCanvas, this.interactCanvas]) {
      canvas.width = w * this._dpr;
      canvas.height = h * this._dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    this._needsEdgeRedraw = true;
    this._needsNodeRedraw = true;
    this._needsInteractRedraw = true;
  }

  // ── 內部：LOD 判定 ─────────────────────────────────────────────────

  _lodForScale(scale) {
    for (let i = 0; i < LOD_THRESHOLDS.length; i++) {
      if (scale < LOD_THRESHOLDS[i]) return i;
    }
    return LOD_THRESHOLDS.length; // 4
  }

  // ── 主渲染流程 ─────────────────────────────────────────────────────

  _renderFrame() {
    const lod = this.getCurrentLOD();

    if (this._needsEdgeRedraw) {
      this._drawEdges(lod);
      this._needsEdgeRedraw = false;
    }
    if (this._needsNodeRedraw) {
      this._drawNodes(lod);
      this._needsNodeRedraw = false;
    }
    if (this._needsInteractRedraw) {
      this._drawInteract(lod);
      this._needsInteractRedraw = false;
    }
  }

  _applyTransformCtx(ctx) {
    ctx.setTransform(
      this._dpr * this.transform.scale, 0, 0,
      this._dpr * this.transform.scale,
      this._dpr * this.transform.x, this._dpr * this.transform.y
    );
  }

  _clearCtx(ctx, canvas) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  _colorsFor(ns) {
    const palette = CAT_COLORS[this.theme];
    return palette[ns] || palette.default;
  }

  _isNodeVisible(nodeId, attr) {
    if (!this.filterState) return true;
    return this.filterState.isNodeVisible(nodeId, attr);
  }

  // ── 邊渲染 ─────────────────────────────────────────────────────────

  _drawEdges(lod) {
    const ctx = this.edgesCtx;
    this._clearCtx(ctx, this.edgesCanvas);

    ctx.save();
    this._applyTransformCtx(ctx);

    const edges = this.graphData.edges;
    const getAttr = (id) => this.graphData.getNodeAttr(id);
    const isDark = this.theme === "dark";

    // ── 領域高亮模式：只畫該領域內部的邊 ──────────────────────────
    if (this.topicHighlight) {
      const { nodeIds: topicSet } = this.topicHighlight;
      ctx.lineWidth = 1.2 / this.transform.scale;
      ctx.strokeStyle = isDark ? "rgba(255,220,100,0.55)" : "rgba(30,95,165,0.45)";
      ctx.beginPath();
      for (const e of edges) {
        if (!topicSet.has(e.s) || !topicSet.has(e.d)) continue;
        const a = getAttr(e.s);
        const b = getAttr(e.d);
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    // ── 低倍率（LOD 0/1）：顯示全局邊（採樣以控制數量，過濾工具性噪音邊） ───────────
    if (lod <= 1 && this.showEdgesAtLOD0) {
      ctx.lineWidth = 0.8 / this.transform.scale;
      ctx.strokeStyle = isDark ? "rgba(200,200,190,0.18)" : "rgba(80,80,70,0.18)";
      ctx.beginPath();

      // 工具性模組關鍵字：這些模組的出邊在低倍率下省略，減少噪音
      const UTILITY_RE = /\.(Tactic|Util|Lean|Mathport|Init|Meta)\./;

      let drawn = 0;
      const step = edges.length > MAX_EDGES_LOD0
        ? Math.ceil(edges.length / MAX_EDGES_LOD0) : 1;
      for (let i = 0; i < edges.length; i += step) {
        const e = edges[i];
        // 省略起點是工具性模組的邊（避免 Tactic 發散出的大量連線）
        if (UTILITY_RE.test(e.s)) continue;
        const a = getAttr(e.s);
        const b = getAttr(e.d);
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        drawn++;
      }
      ctx.stroke();

      // 選中節點的邊額外加粗顯示
      if (this.selectedNode) {
        ctx.lineWidth = 2 / this.transform.scale;
        ctx.strokeStyle = isDark ? "rgba(220,220,100,0.7)" : "rgba(30,95,165,0.7)";
        ctx.beginPath();
        for (const e of edges) {
          if (e.s !== this.selectedNode && e.d !== this.selectedNode) continue;
          const a = getAttr(e.s);
          const b = getAttr(e.d);
          if (!a || !b) continue;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    ctx.lineWidth = 1 / this.transform.scale;
    ctx.strokeStyle = isDark ? "rgba(220,220,210,0.25)" : "rgba(80,80,70,0.25)";

    if (lod <= 2) {
      // 僅渲染選中節點相關的邊
      const focus = this.selectedNode;
      if (focus) {
        ctx.beginPath();
        for (const e of edges) {
          if (e.s !== focus && e.d !== focus) continue;
          const a = getAttr(e.s);
          const b = getAttr(e.d);
          if (!a || !b) continue;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }
    } else {
      // LOD 3/4：視口內全部邊
      const bounds = this._currentViewportBounds();
      const visibleIds = new Set(this.graphData.queryViewport(bounds));
      ctx.beginPath();
      for (const e of edges) {
        if (!visibleIds.has(e.s) && !visibleIds.has(e.d)) continue;
        const a = getAttr(e.s);
        const b = getAttr(e.d);
        if (!a || !b) continue;
        if (this.filterState && !(this._isNodeVisible(e.s, a) && this._isNodeVisible(e.d, b))) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }

    // 路徑高亮邊（加粗，特殊顏色）
    if (this.pathHighlight.length > 1) {
      ctx.lineWidth = 3 / this.transform.scale;
      ctx.strokeStyle = "#E0533D";
      ctx.beginPath();
      for (let i = 0; i < this.pathHighlight.length - 1; i++) {
        const a = getAttr(this.pathHighlight[i]);
        const b = getAttr(this.pathHighlight[i + 1]);
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  // ── 節點渲染 ───────────────────────────────────────────────────────

  _currentViewportBounds() {
    const rect = this.container.getBoundingClientRect();
    const [wx0, wy0] = this._screenToWorldLocal(0, 0);
    const [wx1, wy1] = this._screenToWorldLocal(rect.width, rect.height);
    return {
      x: Math.min(wx0, wx1), y: Math.min(wy0, wy1),
      w: Math.abs(wx1 - wx0), h: Math.abs(wy1 - wy0),
    };
  }

  _screenToWorldLocal(sx, sy) {
    const { x, y, scale } = this.transform;
    return [(sx - x) / scale, (sy - y) / scale];
  }

  _drawNodes(lod) {
    const ctx = this.nodesCtx;
    this._clearCtx(ctx, this.nodesCanvas);

    ctx.save();
    this._applyTransformCtx(ctx);

    const bounds = this._currentViewportBounds();
    const ids = this.graphData.queryViewport(bounds);

    if (lod === 0) {
      this._drawNodesLOD0(ctx, ids);
    } else if (lod === 1) {
      this._drawNodesShapes(ctx, ids, { stroke: false, text: "none" });
    } else if (lod === 2) {
      this._drawNodesShapes(ctx, ids, { stroke: true, text: "shortIfBig" });
    } else if (lod === 3) {
      this._drawNodesShapes(ctx, ids, { stroke: true, text: "shortAndKind" });
    } else {
      this._drawNodesShapes(ctx, ids, { stroke: true, strokeWidth: 2, text: "full" });
    }

    ctx.restore();
  }

  /** LOD 0：批次依分類分組填色的小圓點，最大化效能（單一 path 一次 fill）。 */
  _drawNodesLOD0(ctx, ids) {
    const groups = new Map(); // colorKey -> points[]
    for (const id of ids) {
      const attr = this.graphData.getNodeAttr(id);
      if (!attr) continue;
      if (!this._isNodeVisible(id, attr)) continue;
      const colors = this._colorsFor(attr.ns);
      const key = colors.stroke;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(attr);
    }

    const r = 3 / this.transform.scale; // 螢幕固定 3px
    for (const [color, points] of groups) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const p of points) {
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  _drawNodesShapes(ctx, ids, opts) {
    const { stroke, strokeWidth = 1, text } = opts;
    const scale = this.transform.scale;

    for (const id of ids) {
      const attr = this.graphData.getNodeAttr(id);
      if (!attr) continue;
      if (!this._isNodeVisible(id, attr)) continue;

      const colors = this._colorsFor(attr.ns);
      const r = Math.max(attr.r, 2);
      const shape = KIND_SHAPES[attr.kind] || "circle-filled";

      ctx.fillStyle = colors.fill;
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = strokeWidth / scale;

      this._drawShape(ctx, shape, attr.x, attr.y, r, stroke);

      // 文字渲染（依 text 模式）
      if (text === "shortIfBig" && r * scale > 8) {
        this._drawLabel(ctx, attr, colors, r, scale, { onlyShort: true });
      } else if (text === "shortAndKind") {
        this._drawLabel(ctx, attr, colors, r, scale, { onlyShort: false });
      } else if (text === "full") {
        const showDoc = id === this.selectedNode;
        this._drawLabel(ctx, attr, colors, r, scale, { onlyShort: false, showDoc });
      }
    }
  }

  _drawShape(ctx, shape, x, y, r, withStroke) {
    ctx.beginPath();
    if (shape === "diamond") {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }

    if (shape === "circle-hollow") {
      ctx.save();
      ctx.fillStyle = this.theme === "dark" ? "#1c1c1a" : "#ffffff";
      ctx.fill();
      ctx.restore();
      ctx.stroke();
    } else {
      ctx.fill();
      if (withStroke) ctx.stroke();
    }
  }

  _drawLabel(ctx, attr, colors, r, scale, { onlyShort, showDoc = false }) {
    // 字體大小以「螢幕像素」為基準再換算回世界座標，確保不管縮放多少，
    // 畫面上的文字永遠維持一個可讀的最小尺寸（這裡設定螢幕上至少 13px）。
    const screenFontSize = 13;
    const fontSize = screenFontSize / scale;
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = colors.text;
    ctx.textBaseline = "middle";

    let label = attr.short_name;
    if (!onlyShort) label = `${attr.short_name}  ·${attr.kind}`;

    // 文字底部加一層半透明背景，避免跟邊線/其他節點重疊時難以辨識
    const labelX = attr.x + r + 5 / scale;
    const labelY = attr.y;
    const textWidth = ctx.measureText(label).width;
    const padX = 3 / scale;
    const padY = 2 / scale;

    ctx.save();
    ctx.fillStyle = this.theme === "dark" ? "rgba(28,28,26,0.78)" : "rgba(255,255,255,0.82)";
    ctx.fillRect(labelX - padX, labelY - fontSize / 2 - padY, textWidth + padX * 2, fontSize + padY * 2);
    ctx.restore();

    ctx.textAlign = "left";
    ctx.fillStyle = colors.text;
    ctx.fillText(label, labelX, labelY);

    if (showDoc) {
      const detail = this.graphData.getNodeDetail(attr.id);
      if (detail && detail.doc_string) {
        const docFontSize = (screenFontSize - 2) / scale;
        ctx.font = `${docFontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = this.theme === "dark" ? "#a8a69f" : "#6b6a64";
        const summary = detail.doc_string.slice(0, 60) + (detail.doc_string.length > 60 ? "…" : "");
        ctx.fillText(summary, labelX, labelY + fontSize + 3 / scale);
      }
    }
  }

  // ── 互動層渲染（懸停/選中高亮） ───────────────────────────────────

  _drawInteract(lod) {
    const ctx = this.interactCtx;
    this._clearCtx(ctx, this.interactCanvas);

    ctx.save();
    this._applyTransformCtx(ctx);
    const scale = this.transform.scale;

    // ── 領域高亮：非該領域節點變暗，該領域節點加光環 ──────────────
    if (this.topicHighlight) {
      const { nodeIds: topicSet } = this.topicHighlight;
      const bounds = this._currentViewportBounds();
      const visibleIds = this.graphData.queryViewport(bounds);
      const isDark = this.theme === "dark";
      const dimColor = isDark ? "rgba(0,0,0,0.62)" : "rgba(255,255,255,0.68)";

      // 變暗非該領域節點
      for (const id of visibleIds) {
        if (topicSet.has(id)) continue;
        const attr = this.graphData.getNodeAttr(id);
        if (!attr) continue;
        const r = Math.max(attr.r, 3) + 1 / scale;
        ctx.fillStyle = dimColor;
        ctx.beginPath();
        ctx.arc(attr.x, attr.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 該領域節點加亮框 + 標籤（只在倍率夠大時才畫標籤避免擁擠）
      const showLabel = scale > 0.15;
      const labelFontSize = Math.max(11, 13) / scale;
      for (const id of visibleIds) {
        if (!topicSet.has(id)) continue;
        const attr = this.graphData.getNodeAttr(id);
        if (!attr) continue;
        const r = Math.max(attr.r, 4) + 2 / scale;
        ctx.strokeStyle = isDark ? "#FFD966" : "#185FA5";
        ctx.lineWidth = 1.5 / scale;
        ctx.beginPath();
        ctx.arc(attr.x, attr.y, r, 0, Math.PI * 2);
        ctx.stroke();

        if (showLabel && scale > 0.3) {
          ctx.font = `600 ${labelFontSize}px ui-sans-serif, system-ui, sans-serif`;
          const labelX = attr.x + r + 4 / scale;
          const labelY = attr.y;
          const tw = ctx.measureText(attr.short_name).width;
          const px = 2 / scale, py = 1.5 / scale;
          ctx.fillStyle = isDark ? "rgba(40,35,10,0.88)" : "rgba(255,255,255,0.88)";
          ctx.fillRect(labelX - px, labelY - labelFontSize / 2 - py, tw + px * 2, labelFontSize + py * 2);
          ctx.fillStyle = isDark ? "#FFD966" : "#185FA5";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(attr.short_name, labelX, labelY);
        }
      }
    }
    // 確保不論目前 LOD 為何，使用者都能清楚看出「跟這個節點相連的是誰」。
    if (this.highlightedDeps.size > 0) {
      const labelFontSize = 13 / scale;

      for (const id of this.highlightedDeps) {
        const attr = this.graphData.getNodeAttr(id);
        if (!attr) continue;
        const r = Math.max(attr.r, 4) + 3 / scale;

        ctx.fillStyle = "rgba(224, 83, 61, 0.28)";
        ctx.strokeStyle = "#E0533D";
        ctx.lineWidth = 2.5 / scale;
        ctx.beginPath();
        ctx.arc(attr.x, attr.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 名稱標籤（帶背景底色，確保在任何縮放層級都清楚可讀）
        ctx.font = `600 ${labelFontSize}px ui-sans-serif, system-ui, sans-serif`;
        const labelX = attr.x + r + 5 / scale;
        const labelY = attr.y;
        const textWidth = ctx.measureText(attr.short_name).width;
        const padX = 3 / scale;
        const padY = 2 / scale;

        ctx.fillStyle = this.theme === "dark" ? "rgba(224,83,61,0.92)" : "rgba(224,83,61,0.95)";
        ctx.fillRect(labelX - padX, labelY - labelFontSize / 2 - padY, textWidth + padX * 2, labelFontSize + padY * 2);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(attr.short_name, labelX, labelY);
      }
    }

    // 路徑高亮節點
    if (this.pathHighlight.length > 0) {
      ctx.fillStyle = "rgba(224, 83, 61, 0.4)";
      for (const id of this.pathHighlight) {
        const attr = this.graphData.getNodeAttr(id);
        if (!attr) continue;
        const r = Math.max(attr.r, 4) + 2 / scale;
        ctx.beginPath();
        ctx.arc(attr.x, attr.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 懸停高亮
    if (this.hoveredNode) {
      const attr = this.graphData.getNodeAttr(this.hoveredNode);
      if (attr) {
        ctx.strokeStyle = this.theme === "dark" ? "#ffffff" : "#1c1c1a";
        ctx.lineWidth = 2 / scale;
        const r = Math.max(attr.r, 4) + 4 / scale;
        ctx.beginPath();
        ctx.arc(attr.x, attr.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 選中高亮（外框 + 動態光環效果以純描邊近似）
    if (this.selectedNode) {
      const attr = this.graphData.getNodeAttr(this.selectedNode);
      if (attr) {
        ctx.strokeStyle = "#185FA5";
        ctx.lineWidth = 3 / scale;
        const r = Math.max(attr.r, 4) + 6 / scale;
        ctx.beginPath();
        ctx.arc(attr.x, attr.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * 將圖形以離線方式渲染一次 LOD 0 版本到 OffscreenCanvas（供 minimap.js 使用）。
   * @returns {OffscreenCanvas|HTMLCanvasElement}
   */
  buildOfflineSnapshot(width, height, graphBounds) {
    const canvas = (typeof OffscreenCanvas !== "undefined")
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d");

    const scaleX = width / graphBounds.w;
    const scaleY = height / graphBounds.h;
    const scale = Math.min(scaleX, scaleY);

    ctx.save();
    ctx.translate(-graphBounds.x * scale, -graphBounds.y * scale);
    ctx.scale(scale, scale);

    const groups = new Map();
    for (let i = 0; i < this.graphData.nodeIds.length; i++) {
      const id = this.graphData.nodeIds[i];
      const attr = this.graphData.getNodeAttr(id);
      if (!attr) continue;
      const colors = this._colorsFor(attr.ns);
      if (!groups.has(colors.stroke)) groups.set(colors.stroke, []);
      groups.get(colors.stroke).push(attr);
    }

    const r = 2 / scale;
    for (const [color, points] of groups) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const p of points) {
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.restore();

    return canvas;
  }
}
