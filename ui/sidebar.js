/**
 * frontend/ui/sidebar.js
 * ========================
 * 節點詳情側邊欄：顯示選中節點的完整資訊，支援依賴/被引用清單分頁、
 * 快速操作（複製名稱、開啟文件、高亮依賴）。
 */

const DEPS_PAGE_SIZE = 20;

const KIND_LABELS = {
  theorem: "theorem", def: "def", lemma: "lemma", structure: "structure",
  class: "class", instance: "instance", axiom: "axiom", opaque: "opaque", other: "other",
};

export class Sidebar extends EventTarget {
  /**
   * @param {HTMLElement} containerEl 對應 <aside id="sidebar"> 容器
   * @param {import('../engine/graph.js').GraphData} graphData
   * @param {import('../engine/camera.js').Camera} camera
   * @param {import('../engine/renderer.js').Renderer} renderer
   * @param {import('../engine/loader.js').DataLoader} [loader] 用於按需載入節點詳情
   */
  constructor(containerEl, graphData, camera, renderer, loader = null) {
    super();
    this.container = containerEl;
    this.graphData = graphData;
    this.camera = camera;
    this.renderer = renderer;
    this.loader = loader;

    this._currentNodeId = null;
    this._depsExpanded = false;
    this._usedByExpanded = false;

    this._buildDom();
    this.showPlaceholder();
  }

  // ── DOM 結構建立 ───────────────────────────────────────────────────

  _buildDom() {
    this.container.innerHTML = `
      <div id="sidebar-placeholder">
        <div class="sidebar-empty-icon">◎</div>
        <p class="sidebar-empty-title">點擊節點查看詳情</p>
        <p class="sidebar-empty-desc">
          縮放等級決定顯示細節（LOD）：縮小時僅顯示色點，放大後逐步顯示名稱、
          種類標籤與文件摘要。點擊任一節點可查看完整資訊與依賴關係。
        </p>
      </div>
      <div id="sidebar-content" hidden>
        <div id="node-header">
          <span id="node-kind-badge" class="kind-badge"></span>
          <h2 id="node-short-name"></h2>
          <code id="node-full-id" title="點擊複製"></code>
        </div>
        <div id="node-module-line">
          模組：<a href="#" id="node-module-link"></a>
        </div>
        <div id="node-stats"></div>
        <div id="node-docstring-wrap">
          <h3>文件</h3>
          <div id="node-docstring"></div>
        </div>
        <div id="node-deps-wrap">
          <h3>依賴 (Depends on) <span id="deps-count" class="count-badge"></span></h3>
          <ul id="node-deps"></ul>
          <button id="deps-show-more" class="link-btn" hidden></button>
        </div>
        <div id="node-used-by-wrap">
          <h3>被引用 (Used by) <span id="used-by-count" class="count-badge"></span></h3>
          <ul id="node-used-by"></ul>
          <button id="used-by-show-more" class="link-btn" hidden></button>
        </div>
        <div id="node-actions">
          <button id="action-copy" class="action-btn">複製完整名稱</button>
          <button id="action-open-docs" class="action-btn">在 Mathlib4 文件開啟</button>
          <button id="action-highlight" class="action-btn">高亮所有直接依賴</button>
        </div>
      </div>
    `;

    this._els = {
      placeholder: this.container.querySelector("#sidebar-placeholder"),
      content: this.container.querySelector("#sidebar-content"),
      kindBadge: this.container.querySelector("#node-kind-badge"),
      shortName: this.container.querySelector("#node-short-name"),
      fullId: this.container.querySelector("#node-full-id"),
      moduleLink: this.container.querySelector("#node-module-link"),
      stats: this.container.querySelector("#node-stats"),
      docstring: this.container.querySelector("#node-docstring"),
      depsList: this.container.querySelector("#node-deps"),
      depsCount: this.container.querySelector("#deps-count"),
      depsShowMore: this.container.querySelector("#deps-show-more"),
      usedByList: this.container.querySelector("#node-used-by"),
      usedByCount: this.container.querySelector("#used-by-count"),
      usedByShowMore: this.container.querySelector("#used-by-show-more"),
      actionCopy: this.container.querySelector("#action-copy"),
      actionOpenDocs: this.container.querySelector("#action-open-docs"),
      actionHighlight: this.container.querySelector("#action-highlight"),
    };

    this._els.fullId.addEventListener("click", () => this._copyFullName());
    this._els.actionCopy.addEventListener("click", () => this._copyFullName());
    this._els.actionOpenDocs.addEventListener("click", () => this._openMathlibDocs());
    this._els.actionHighlight.addEventListener("click", () => this._highlightDeps());
    this._els.depsShowMore.addEventListener("click", () => {
      this._depsExpanded = true;
      this._renderDepsList();
    });
    this._els.usedByShowMore.addEventListener("click", () => {
      this._usedByExpanded = true;
      this._renderUsedByList();
    });
    this._els.moduleLink.addEventListener("click", (e) => {
      e.preventDefault();
      this.dispatchEvent(new CustomEvent("module-highlight", { detail: this._currentModule }));
    });
  }

  // ── 狀態切換 ───────────────────────────────────────────────────────

  showPlaceholder() {
    this._currentNodeId = null;
    this._els.placeholder.hidden = false;
    this._els.content.hidden = true;
  }

  showLoading(nodeId) {
    this._currentNodeId = nodeId;
    this._els.placeholder.hidden = true;
    this._els.content.hidden = false;
    this._els.content.classList.remove("fade-in");

    const attr = this.graphData.getNodeAttr(nodeId);
    this._els.shortName.textContent = attr ? attr.short_name : nodeId;
    this._els.fullId.textContent = nodeId;
    this._els.kindBadge.textContent = attr ? KIND_LABELS[attr.kind] || attr.kind : "";
    this._setKindBadgeColor(attr?.kind);

    this._els.stats.innerHTML = `<div class="skeleton skeleton-stats"></div>`;
    this._els.docstring.innerHTML = `<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div>`;
    this._els.depsList.innerHTML = `<li class="skeleton skeleton-line"></li>`;
    this._els.usedByList.innerHTML = `<li class="skeleton skeleton-line"></li>`;
  }

  /** 載入並渲染節點詳情。 */
  async showNode(nodeId) {
    this.showLoading(nodeId);

    let detail = this.graphData.getNodeDetail(nodeId);
    if (!detail && this.loader) {
      try {
        detail = await this.loader.loadNodeDetail(nodeId);
      } catch (err) {
        this._els.docstring.innerHTML = `<p class="error-text">載入詳情失敗：${this._escape(String(err))}</p>`;
      }
    }

    let neighbors = { in: [], out: [] };
    if (this.loader) {
      try {
        neighbors = await this.loader.loadNeighbors(nodeId);
      } catch {
        neighbors = this.graphData.getNeighbors(nodeId);
      }
    } else {
      neighbors = this.graphData.getNeighbors(nodeId);
    }

    if (this._currentNodeId !== nodeId) return; // 使用者已切換到別的節點

    this._currentDetail = detail;
    this._currentNeighbors = neighbors;
    this._currentModule = detail?.module || this.graphData.getNodeAttr(nodeId)?.ns;
    this._depsExpanded = false;
    this._usedByExpanded = false;

    this._renderFull(nodeId, detail, neighbors);

    // 觸發淡入動畫
    requestAnimationFrame(() => this._els.content.classList.add("fade-in"));
  }

  hide() {
    this.container.classList.add("sidebar-hidden");
  }

  show() {
    this.container.classList.remove("sidebar-hidden");
  }

  // ── 渲染 ────────────────────────────────────────────────────────────

  _renderFull(nodeId, detail, neighbors) {
    const attr = this.graphData.getNodeAttr(nodeId);
    const shortName = detail?.short_name || attr?.short_name || nodeId;
    const kind = detail?.kind || attr?.kind || "other";
    const module = detail?.module || attr?.ns || "";

    this._els.shortName.textContent = shortName;
    this._els.fullId.textContent = nodeId;
    this._els.kindBadge.textContent = KIND_LABELS[kind] || kind;
    this._setKindBadgeColor(kind);
    this._els.moduleLink.textContent = module;

    // 統計
    const inCount = neighbors.in_count ?? neighbors.in?.length ?? 0;
    const outCount = neighbors.out_count ?? neighbors.out?.length ?? 0;
    const pagerankPct = attr?.pagerank !== undefined
      ? `${Math.round((attr.pagerank ?? 0) * 100)}%`
      : "—";

    this._els.stats.innerHTML = `
      <div class="stat-item"><span class="stat-value">${inCount}</span><span class="stat-label">被引用</span></div>
      <div class="stat-item"><span class="stat-value">${outCount}</span><span class="stat-label">依賴數</span></div>
      <div class="stat-item"><span class="stat-value">${pagerankPct}</span><span class="stat-label">重要度</span></div>
    `;

    // 文件字串（簡易 markdown：粗體、inline code、換行）
    if (detail?.doc_string) {
      this._els.docstring.innerHTML = this._renderMarkdownLite(detail.doc_string);
      this._els.docstring.parentElement.hidden = false;
    } else {
      this._els.docstring.innerHTML = `<p class="empty-text">（無文件字串）</p>`;
      this._els.docstring.parentElement.hidden = false;
    }

    // 依賴 / 被引用清單
    this._depsIds = detail?.deps || neighbors.out || [];
    this._usedByIds = neighbors.in || [];
    this._renderDepsList();
    this._renderUsedByList();
  }

  _renderDepsList() {
    this._els.depsCount.textContent = `(${this._depsIds.length})`;
    this._renderNodeList(this._els.depsList, this._depsIds, this._depsExpanded);
    this._els.depsShowMore.hidden = this._depsExpanded || this._depsIds.length <= DEPS_PAGE_SIZE;
    this._els.depsShowMore.textContent = `顯示全部 ${this._depsIds.length} 個`;
  }

  _renderUsedByList() {
    this._els.usedByCount.textContent = `(${this._usedByIds.length})`;
    this._renderNodeList(this._els.usedByList, this._usedByIds, this._usedByExpanded);
    this._els.usedByShowMore.hidden = this._usedByExpanded || this._usedByIds.length <= DEPS_PAGE_SIZE;
    this._els.usedByShowMore.textContent = `顯示全部 ${this._usedByIds.length} 個`;
  }

  _renderNodeList(ulEl, ids, expanded) {
    const shown = expanded ? ids : ids.slice(0, DEPS_PAGE_SIZE);
    ulEl.innerHTML = "";
    for (const id of shown) {
      const attr = this.graphData.getNodeAttr(id);
      const li = document.createElement("li");
      li.className = "dep-item";
      li.dataset.kind = attr?.kind || "other";
      li.innerHTML = `
        <span class="dep-kind-dot" data-kind="${attr?.kind || "other"}"></span>
        <span class="dep-name">${this._escape(attr?.short_name || id)}</span>
      `;
      li.title = id;
      li.addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("node-jump", { detail: id }));
      });
      ulEl.appendChild(li);
    }
    if (shown.length === 0) {
      ulEl.innerHTML = `<li class="empty-text">（無）</li>`;
    }
  }

  // ── 快速操作 ───────────────────────────────────────────────────────

  async _copyFullName() {
    if (!this._currentNodeId) return;
    try {
      await navigator.clipboard.writeText(this._currentNodeId);
      this._flashButton(this._els.actionCopy, "已複製 ✓");
    } catch {
      // clipboard API 不可用時靜默失敗
    }
  }

  _openMathlibDocs() {
    if (!this._currentNodeId) return;
    const url = `https://leanprover-community.github.io/mathlib4_docs/find/?pattern=${encodeURIComponent(this._currentNodeId)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  _highlightDeps() {
    if (!this._currentNodeId) return;
    this.dispatchEvent(new CustomEvent("highlight-deps", { detail: this._currentNodeId }));
  }

  _flashButton(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    btn.classList.add("flash");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("flash");
    }, 1500);
  }

  // ── 輔助 ────────────────────────────────────────────────────────────

  _setKindBadgeColor(kind) {
    this._els.kindBadge.dataset.kind = kind || "other";
  }

  _escape(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /** 極簡 markdown：**bold**、`code`、換行。 */
  _renderMarkdownLite(text) {
    let escaped = this._escape(text);
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/`([^`]+?)`/g, "<code>$1</code>");
    escaped = escaped.replace(/\n/g, "<br>");
    return escaped;
  }
}
