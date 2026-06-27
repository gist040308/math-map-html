/**
 * frontend/app.js
 * =================
 * 應用程式進入點：初始化所有引擎與 UI 模組，串接事件，啟動渲染循環與資料載入。
 */

import { GraphData } from "./engine/graph.js";
import { Camera } from "./engine/camera.js";
import { Renderer } from "./engine/renderer.js";
import { DataLoader } from "./engine/loader.js";
import { Sidebar } from "./ui/sidebar.js";
import { SearchUI } from "./ui/search.js";
import { Minimap } from "./ui/minimap.js";
import { Legend } from "./ui/legend.js";

const CANVAS_SIZE = 100000;
const DATA_BASE_URL = "./data";

const NS_COLOR_FALLBACK = [
  "#185FA5", "#854F0B", "#993C1D", "#3B6D11",
  "#6B3FA0", "#1A6B8A", "#8A3F1A", "#2C7A5F",
];

async function main() {
  const viewport = document.getElementById("viewport");
  const sidebarEl = document.getElementById("sidebar");
  const searchPanelEl = document.getElementById("search-panel");
  const minimapEl = document.getElementById("minimap-container");
  const legendEl = document.getElementById("legend-container");
  const progressBar = document.getElementById("load-progress-bar");
  const progressWrap = document.getElementById("load-progress");

  // ── 核心資料與引擎 ─────────────────────────────────────────────────
  const graphData = new GraphData();
  const interactCanvas = document.getElementById("canvas-interact");
  const camera = new Camera(interactCanvas, (transform) => {
    renderer.onTransformChanged(transform);
    minimap.update();
    legend.update();
    loader.onViewportChange(camera.getViewportBounds(), camera);
  });
  const renderer = new Renderer(viewport, graphData, null);
  const loader = new DataLoader(DATA_BASE_URL, graphData);

  // ── UI 模組 ────────────────────────────────────────────────────────
  const sidebar = new Sidebar(sidebarEl, graphData, camera, renderer, loader);
  const search = new SearchUI(searchPanelEl, graphData, camera, "./ui/search-worker.js");
  const minimap = new Minimap(minimapEl, camera, graphData, CANVAS_SIZE);
  const legend = new Legend(legendEl, graphData, camera, renderer);

  // ── 共用：選中節點時自動高亮其所有直接鄰居（上游 + 下游），
  //         並把鏡頭縮放到「剛好能同時看到選中節點與所有鄰居」的程度。
  //         （取代之前固定 2.5x 縮放的做法——固定倍率在鄰居節點距離較遠時
  //          會把鄰居擠出畫面外，使用者只看到連線卻看不到線的另一端。）
  async function focusNodeWithNeighbors(nodeId) {
    const attr = graphData.getNodeAttr(nodeId);
    if (!attr) return;

    const neighbors = await loader.loadNeighbors(nodeId);
    const neighborIds = [...(neighbors.in || []), ...(neighbors.out || [])];

    // 收集選中節點 + 所有鄰居的座標，計算包圍框
    const points = [attr, ...neighborIds.map((id) => graphData.getNodeAttr(id)).filter(Boolean)];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const rect = viewport.getBoundingClientRect();
    const usableW = rect.width * 0.85;
    const usableH = rect.height * 0.85;

    const fitScale = Math.min(usableW / spanX, usableH / spanY);

    // 讀性下限：縮放不低於 1.4x。標籤文字固定為螢幕 13px（見 renderer.js
    // _drawLabel），在 1.4x 縮放下仍清楚可讀。若鄰居在這個縮放下仍無法
    // 全部入鏡（鄰居分散在差異很大的方向時可能發生），寧可讓部分外圍
    // 鄰居落在視窗邊緣之外，使用者仍可透過拖曳/縮小自行查看全貌，
    // 也不要為了塞滿全部鄰居而縮小到文字難以辨識的程度。
    // 上限 6x：鄰居距離很近時避免縮放過度誇張。
    const MIN_READABLE_SCALE = 1.4;
    const MAX_SCALE = 6;
    const targetScale = Math.min(Math.max(fitScale, MIN_READABLE_SCALE), MAX_SCALE);

    await camera.flyTo(centerX, centerY, targetScale);
    renderer.setSelectedNode(nodeId);
    renderer.setHighlightedDeps(neighborIds);
  }

  // ── 事件串接：Sidebar -> Camera/Renderer ────────────────────────────
  sidebar.addEventListener("node-jump", async (e) => {
    const nodeId = e.detail;
    await focusNodeWithNeighbors(nodeId);
    await sidebar.showNode(nodeId);
  });

  sidebar.addEventListener("highlight-deps", (e) => {
    const nodeId = e.detail;
    const neighbors = graphData.getNeighbors(nodeId);
    renderer.setHighlightedDeps(neighbors.out || []);
  });

  sidebar.addEventListener("module-highlight", (e) => {
    const moduleName = e.detail;
    if (!moduleName) return;
    search.filterState.activeNamespaces = new Set([moduleName]);
    renderer.setFilterState(search.filterState);
  });

  // ── 事件串接：Search -> Renderer/Camera ─────────────────────────────
  search.addEventListener("filter-change", (e) => {
    renderer.setFilterState(e.detail);
  });

  search.addEventListener("result-click", async (e) => {
    const nodeId = e.detail;
    await focusNodeWithNeighbors(nodeId);
    await sidebar.showNode(nodeId);
  });

  search.addEventListener("path-found", (e) => {
    renderer.setPathHighlight(e.detail);
  });

  // ── 事件串接：Legend -> Search（命名空間點擊過濾） ───────────────────
  legend.addEventListener("namespace-toggle", (e) => {
    const ns = e.detail;
    const current = search.filterState.activeNamespaces;
    if (current === null) {
      search.filterState.activeNamespaces = new Set([ns]);
    } else if (current.has(ns)) {
      current.delete(ns);
    } else {
      current.add(ns);
    }
    renderer.setFilterState(search.filterState);
  });

  // ── 事件串接：Legend -> Renderer（領域聚焦） ─────────────────────────
  legend.addEventListener("topic-focus", async (e) => {
    const topicKey = e.detail; // e.g. "LinearAlgebra"
    const prefix = `Mathlib.${topicKey}.`;

    // 收集所有屬於該領域的節點
    const topicIds = graphData.nodeIds.filter((id) =>
      id.startsWith(prefix) || id === `Mathlib.${topicKey}`
    );

    if (topicIds.length === 0) return;

    // 計算包圍框並飛過去
    const points = topicIds.map((id) => graphData.getNodeAttr(id)).filter(Boolean);
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const rect = viewport.getBoundingClientRect();
    const fitScale = Math.min(rect.width * 0.85 / spanX, rect.height * 0.85 / spanY);
    const targetScale = Math.min(Math.max(fitScale, 0.05), 2.0);

    renderer.setTopicHighlight(topicKey, topicIds);
    await camera.flyTo(centerX, centerY, targetScale);
  });

  legend.addEventListener("topic-clear", () => {
    renderer.setTopicHighlight(null, []);
  });

  // ── 事件串接：Legend -> Renderer（低倍率邊切換） ──────────────────────
  legend.addEventListener("edge-toggle", (e) => {
    renderer.toggleEdgesAtLOD0(e.detail);
  });

  // ── 互動層：滑鼠移動（hover）與點擊（選中） ──────────────────────────
  let hoverRaf = null;
  interactCanvas.addEventListener("mousemove", (e) => {
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = null;
      const rect = interactCanvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const hitId = graphData.hitTest(sx, sy, camera);
      renderer.setHoveredNode(hitId);
      interactCanvas.style.cursor = hitId ? "pointer" : "grab";
    });
  });

  interactCanvas.addEventListener("click", async (e) => {
    const rect = interactCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hitId = graphData.hitTest(sx, sy, camera);
    if (hitId) {
      renderer.setSelectedNode(hitId);
      const neighbors = await loader.loadNeighbors(hitId);
      renderer.setHighlightedDeps([...(neighbors.in || []), ...(neighbors.out || [])]);
      await sidebar.showNode(hitId);
    } else {
      renderer.setSelectedNode(null);
      renderer.setHighlightedDeps([]);
      sidebar.showPlaceholder();
    }
  });

  // ── 載入事件 ───────────────────────────────────────────────────────
  loader.addEventListener("meta-loaded", ({ detail }) => {
    progressBar.style.width = "40%";

    camera.reset(viewport.clientWidth, viewport.clientHeight, {
      x: 0, y: 0, w: CANVAS_SIZE, h: CANVAS_SIZE,
    });
    renderer.startLoop();
    minimap.buildMinimapCanvas(renderer);

    // 命名空間分類與搜尋索引設置
    const nsCounts = {};
    for (const attr of graphData.nodeAttrs.values()) {
      nsCounts[attr.ns] = (nsCounts[attr.ns] || 0) + 1;
    }
    search.buildNamespaceTree(nsCounts);
    search.populateNodeIdList(graphData.nodeIds);

    const categories = Object.entries(nsCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([ns, count], i) => ({
        namespace: ns,
        count,
        color: NS_COLOR_FALLBACK[i % NS_COLOR_FALLBACK.length],
      }));
    legend.setCategories(categories);

    fetch(`${DATA_BASE_URL}/index/search_index.json`)
      .then((r) => r.json())
      .then((idx) => search.initIndex(idx))
      .catch(() => console.warn("[app] 搜尋索引載入失敗"));
  });

  loader.addEventListener("chunk-loaded", ({ detail }) => {
    const pct = 40 + Math.round((detail.chunksLoaded / Math.max(detail.totalChunks, 1)) * 60);
    progressBar.style.width = `${pct}%`;
    legend.setEdgeProgress(detail.edgesLoaded, detail.edgesTotal);
    renderer.notifyDataChanged();

    if (graphData.adjacency) {
      search.setAdjacency(graphData.adjacency);
    }
  });

  loader.addEventListener("all-loaded", ({ detail }) => {
    progressBar.style.width = "100%";
    progressWrap.classList.add("done");
    console.info(`[app] 全部資料載入完成，耗時 ${(detail.duration / 1000).toFixed(1)}s`);
    if (graphData.adjacency) search.setAdjacency(graphData.adjacency);
  });

  loader.addEventListener("error", ({ detail }) => {
    console.error(`[app] 載入錯誤：${detail.url}`, detail.error);
  });

  // ── 鍵盤快捷鍵 ─────────────────────────────────────────────────────
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      renderer.setSelectedNode(null);
      renderer.setHighlightedDeps([]);
      sidebar.showPlaceholder();
    } else if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      document.getElementById("search-input")?.focus();
    } else if (e.key === "0") {
      camera.reset(viewport.clientWidth, viewport.clientHeight, {
        x: 0, y: 0, w: CANVAS_SIZE, h: CANVAS_SIZE,
      });
    }
  });

  // ── 深淺色模式切換 ─────────────────────────────────────────────────
  const themeToggleBtn = document.getElementById("theme-toggle");
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const root = document.documentElement;
      const isDark = root.getAttribute("data-theme") === "dark";
      root.setAttribute("data-theme", isDark ? "light" : "dark");
      renderer.setTheme(isDark ? "light" : "dark");
      themeToggleBtn.textContent = isDark ? "🌙" : "☀️";
      try { localStorage.setItem("mathlib-viz-theme", isDark ? "light" : "dark"); } catch {}
    });

    try {
      const saved = localStorage.getItem("mathlib-viz-theme");
      if (saved === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
        renderer.setTheme("dark");
        themeToggleBtn.textContent = "☀️";
      }
    } catch {}
  }

  // ── Service Worker（可選） ────────────────────────────────────────
  loader.registerServiceWorker("./sw.js").catch(() => {});

  // ── 啟動載入序列 ───────────────────────────────────────────────────
  await loader.start();
}

main().catch((err) => {
  console.error("[app] 初始化失敗：", err);
  const el = document.getElementById("viewport");
  if (el) {
    el.innerHTML = `<div style="padding:40px;color:#c0392b;">應用程式初始化失敗：${err.message}</div>`;
  }
});
