/**
 * frontend/ui/search.js
 * =======================
 * 搜尋與過濾 UI 模組：全文搜尋（Web Worker + Fuse.js）、命名空間過濾器、
 * 種類過濾、依賴路徑查找。透過 FilterState 與 renderer.js 整合節點可見性／高亮。
 */

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_RESULT_LIMIT = 30;
const ALL_KINDS = ["theorem", "def", "lemma", "structure", "class", "instance", "axiom", "opaque"];

// ═══════════════════════════════════════════════════════════════════════
// FilterState
// ═══════════════════════════════════════════════════════════════════════

export class FilterState {
  constructor() {
    /** @type {Set<string>|null} null 表示全選（不過濾） */
    this.activeNamespaces = null;
    /** @type {Set<string>} */
    this.activeKinds = new Set(ALL_KINDS);
    /** @type {Set<string>} */
    this.searchHighlights = new Set();
    /** @type {string[]} 有序 */
    this.pathHighlights = [];
  }

  isNodeVisible(nodeId, nodeAttr) {
    if (!nodeAttr) return true;
    if (this.activeNamespaces !== null && !this.activeNamespaces.has(nodeAttr.ns)) return false;
    if (!this.activeKinds.has(nodeAttr.kind)) return false;
    return true;
  }

  getNodeHighlight(nodeId) {
    if (this.pathHighlights.includes(nodeId)) return "path";
    if (this.searchHighlights.has(nodeId)) return "search";
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SearchUI
// ═══════════════════════════════════════════════════════════════════════

export class SearchUI extends EventTarget {
  /**
   * @param {HTMLElement} containerEl 對應 <div id="search-panel">
   * @param {import('../engine/graph.js').GraphData} graphData
   * @param {import('../engine/camera.js').Camera} camera
   * @param {string} workerUrl search-worker.js 的 URL
   */
  constructor(containerEl, graphData, camera, workerUrl = "./search-worker.js") {
    super();
    this.container = containerEl;
    this.graphData = graphData;
    this.camera = camera;
    this.filterState = new FilterState();

    this._worker = new Worker(workerUrl);
    this._workerReady = false;
    this._debounceTimer = null;
    this._adjacency = null;

    this._buildDom();
    this._bindWorker();
  }

  /** 提供 search_index.json 內容初始化 Worker 中的 Fuse 實例。 */
  initIndex(searchIndexData) {
    this._worker.postMessage({ type: "init", index: searchIndexData });
  }

  /** 提供鄰接表供路徑查找使用。 */
  setAdjacency(adjacency) {
    this._adjacency = adjacency;
  }

  /** 依目前已知節點建立命名空間樹（節點數統計）。 */
  buildNamespaceTree(nsCounts) {
    this._els.nsTree.innerHTML = "";
    const sorted = Object.entries(nsCounts).sort((a, b) => b[1] - a[1]);
    for (const [ns, count] of sorted) {
      const row = document.createElement("label");
      row.className = "ns-row";
      row.innerHTML = `
        <input type="checkbox" checked data-ns="${this._escape(ns)}">
        <span class="ns-name">${this._escape(ns)}</span>
        <span class="ns-count">${count}</span>
      `;
      const checkbox = row.querySelector("input");
      checkbox.addEventListener("change", () => this._onNamespaceToggle());
      this._els.nsTree.appendChild(row);
    }
  }

  // ── DOM ─────────────────────────────────────────────────────────────

  _buildDom() {
    this.container.innerHTML = `
      <input id="search-input" type="search" placeholder="搜尋定理、定義…" autocomplete="off">
      <div id="search-results"></div>
      <details id="filter-namespaces" open>
        <summary>命名空間 <button id="ns-select-all" class="mini-link">全選</button> / <button id="ns-select-none" class="mini-link">清除</button></summary>
        <div id="ns-tree"></div>
      </details>
      <details id="filter-kinds">
        <summary>種類 <button id="kind-select-all" class="mini-link">全選</button> / <button id="kind-select-none" class="mini-link">清除</button></summary>
        <div id="kind-checkboxes"></div>
      </details>
      <details id="path-finder">
        <summary>路徑查找</summary>
        <div class="path-finder-body">
          <input id="path-from" type="text" list="node-id-list" placeholder="起點節點 id…">
          <input id="path-to" type="text" list="node-id-list" placeholder="終點節點 id…">
          <button id="path-find-btn" class="action-btn">查找最短路徑</button>
          <div id="path-result"></div>
        </div>
      </details>
      <datalist id="node-id-list"></datalist>
    `;

    this._els = {
      input: this.container.querySelector("#search-input"),
      results: this.container.querySelector("#search-results"),
      nsTree: this.container.querySelector("#ns-tree"),
      kindBoxes: this.container.querySelector("#kind-checkboxes"),
      pathFrom: this.container.querySelector("#path-from"),
      pathTo: this.container.querySelector("#path-to"),
      pathFindBtn: this.container.querySelector("#path-find-btn"),
      pathResult: this.container.querySelector("#path-result"),
      nodeIdList: this.container.querySelector("#node-id-list"),
    };

    this._buildKindCheckboxes();

    this._els.input.addEventListener("input", () => this._onSearchInput());
    this.container.querySelector("#ns-select-all").addEventListener("click", (e) => {
      e.preventDefault();
      this._setAllNamespaces(true);
    });
    this.container.querySelector("#ns-select-none").addEventListener("click", (e) => {
      e.preventDefault();
      this._setAllNamespaces(false);
    });
    this.container.querySelector("#kind-select-all").addEventListener("click", (e) => {
      e.preventDefault();
      this._setAllKinds(true);
    });
    this.container.querySelector("#kind-select-none").addEventListener("click", (e) => {
      e.preventDefault();
      this._setAllKinds(false);
    });
    this._els.pathFindBtn.addEventListener("click", () => this._onFindPath());
  }

  _buildKindCheckboxes() {
    this._els.kindBoxes.innerHTML = "";
    for (const kind of ALL_KINDS) {
      const row = document.createElement("label");
      row.className = "kind-row";
      row.innerHTML = `<input type="checkbox" checked data-kind="${kind}"> ${kind}`;
      row.querySelector("input").addEventListener("change", () => this._onKindToggle());
      this._els.kindBoxes.appendChild(row);
    }
  }

  /** 提供節點 id 清單以填充 autocomplete datalist（路徑查找用，建議只放部分樣本）。 */
  populateNodeIdList(ids) {
    this._els.nodeIdList.innerHTML = "";
    const sample = ids.slice(0, 2000); // 避免 datalist 過大拖慢瀏覽器
    for (const id of sample) {
      const opt = document.createElement("option");
      opt.value = id;
      this._els.nodeIdList.appendChild(opt);
    }
  }

  // ── 搜尋 ────────────────────────────────────────────────────────────

  _onSearchInput() {
    clearTimeout(this._debounceTimer);
    const query = this._els.input.value.trim();
    if (query.length === 0) {
      this._els.results.innerHTML = "";
      this.filterState.searchHighlights.clear();
      this._emitFilterChange();
      return;
    }
    this._debounceTimer = setTimeout(() => {
      this._worker.postMessage({ type: "search", query, limit: SEARCH_RESULT_LIMIT });
    }, SEARCH_DEBOUNCE_MS);
  }

  _bindWorker() {
    this._worker.onmessage = ({ data }) => {
      if (data.type === "ready") {
        this._workerReady = true;
        if (data.degraded) {
          console.warn("[search] Fuse.js 無法從 CDN 載入，已降級為簡單子字串搜尋");
        }
      } else if (data.type === "results") {
        this._renderSearchResults(data.results);
      } else if (data.type === "path") {
        this._renderPathResult(data.path);
      } else if (data.type === "error") {
        console.warn("[search] worker error:", data.error);
      }
    };
  }

  _renderSearchResults(results) {
    this._els.results.innerHTML = "";
    this.filterState.searchHighlights = new Set(results.map((r) => r.item.id));

    if (results.length === 0) {
      this._els.results.innerHTML = `<div class="empty-text">無符合結果</div>`;
    } else {
      for (const r of results) {
        const row = document.createElement("div");
        row.className = "search-result-item";
        const scorePct = r.score !== undefined ? Math.round((1 - r.score) * 100) : null;
        row.innerHTML = `
          <span class="result-name">${this._escape(r.item.short_name)}</span>
          <span class="result-module">${this._escape(r.item.module)}</span>
          ${scorePct !== null ? `<span class="result-score">${scorePct}%</span>` : ""}
        `;
        row.addEventListener("click", () => {
          this.dispatchEvent(new CustomEvent("result-click", { detail: r.item.id }));
        });
        this._els.results.appendChild(row);
      }
    }

    this._emitFilterChange();
  }

  // ── 命名空間 / 種類過濾 ────────────────────────────────────────────

  _onNamespaceToggle() {
    const checkboxes = this._els.nsTree.querySelectorAll("input[type=checkbox]");
    const checked = Array.from(checkboxes).filter((c) => c.checked).map((c) => c.dataset.ns);
    const total = checkboxes.length;

    this.filterState.activeNamespaces = checked.length === total ? null : new Set(checked);
    this._emitFilterChange();
  }

  _setAllNamespaces(checked) {
    this._els.nsTree.querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = checked; });
    this._onNamespaceToggle();
  }

  _onKindToggle() {
    const checkboxes = this._els.kindBoxes.querySelectorAll("input[type=checkbox]");
    const checked = Array.from(checkboxes).filter((c) => c.checked).map((c) => c.dataset.kind);
    this.filterState.activeKinds = new Set(checked);
    this._emitFilterChange();
  }

  _setAllKinds(checked) {
    this._els.kindBoxes.querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = checked; });
    this._onKindToggle();
  }

  // ── 路徑查找 ───────────────────────────────────────────────────────

  _onFindPath() {
    const srcId = this._els.pathFrom.value.trim();
    const dstId = this._els.pathTo.value.trim();
    if (!srcId || !dstId) {
      this._els.pathResult.innerHTML = `<div class="error-text">請輸入起點與終點</div>`;
      return;
    }
    if (!this._adjacency) {
      this._els.pathResult.innerHTML = `<div class="error-text">鄰接資料尚未載入</div>`;
      return;
    }
    this._els.pathResult.innerHTML = `<div class="empty-text">查找中…</div>`;
    this._worker.postMessage({ type: "bfs", srcId, dstId, adjacency: this._adjacency });
  }

  _renderPathResult(path) {
    if (!path) {
      this._els.pathResult.innerHTML = `<div class="error-text">找不到路徑</div>`;
      this.filterState.pathHighlights = [];
      this._emitFilterChange();
      return;
    }

    this.filterState.pathHighlights = path;
    this._emitFilterChange();

    const items = path.map((id) => {
      const attr = this.graphData.getNodeAttr(id);
      return `<li>${this._escape(attr?.short_name || id)}</li>`;
    }).join("");

    this._els.pathResult.innerHTML = `
      <div class="path-summary">路徑長度：${path.length - 1} 步</div>
      <ol class="path-list">${items}</ol>
    `;

    this.dispatchEvent(new CustomEvent("path-found", { detail: path }));
  }

  // ── 對外通知 ───────────────────────────────────────────────────────

  _emitFilterChange() {
    this.dispatchEvent(new CustomEvent("filter-change", { detail: this.filterState }));
  }

  _escape(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }
}
