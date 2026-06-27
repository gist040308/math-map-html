/**
 * frontend/ui/legend.js
 * Legend: bottom-right panel showing categories, node kinds, stats, LOD info.
 */

const TOPICS = [
  { key: "Algebra",              label: "Algebra",              color: "#c8c800" },
  { key: "LinearAlgebra",        label: "LinearAlgebra",        color: "#00bb00" },
  { key: "NumberTheory",         label: "NumberTheory",         color: "#cc4040" },
  { key: "GroupTheory",          label: "GroupTheory",          color: "#ff2040" },
  { key: "RingTheory",           label: "RingTheory",           color: "#ff8000" },
  { key: "FieldTheory",          label: "FieldTheory",          color: "#b0b000" },
  { key: "Analysis",             label: "Analysis",             color: "#00aaaa" },
  { key: "Topology",             label: "Topology",             color: "#cc00cc" },
  { key: "CategoryTheory",       label: "CategoryTheory",       color: "#80a0ff" },
  { key: "AlgebraicGeometry",    label: "AlgebraicGeometry",    color: "#6040ff" },
  { key: "Geometry",             label: "Geometry",             color: "#cc60cc" },
  { key: "MeasureTheory",        label: "MeasureTheory",        color: "#8000ff" },
  { key: "Probability",          label: "Probability",          color: "#0000cc" },
  { key: "Combinatorics",        label: "Combinatorics",        color: "#cc2020" },
  { key: "Order",                label: "Order",                color: "#804000" },
  { key: "Logic",                label: "Logic",                color: "#0080ff" },
  { key: "SetTheory",            label: "SetTheory",            color: "#cc6060" },
  { key: "AlgebraicTopology",    label: "AlgebraicTopology",    color: "#5030dd" },
  { key: "RepresentationTheory", label: "RepresentationTheory", color: "#ff0000" },
  { key: "ModelTheory",          label: "ModelTheory",          color: "#808080" },
  { key: "InformationTheory",    label: "InformationTheory",    color: "#9000ff" },
  { key: "Computability",        label: "Computability",        color: "#88bb00" },
  { key: "Dynamics",             label: "Dynamics",             color: "#008040" },
  { key: "Tactic",               label: "Tactic",               color: "#404080" },
  { key: "Data",                 label: "Data",                 color: "#555555" },
];

const LOD_DESCRIPTIONS = [
  { range: "< 0.3x", desc: "Dots only, no edges or labels" },
  { range: "0.3-0.8x", desc: "Circles, selected node edges only" },
  { range: "0.8-1.8x", desc: "Circles + outline, names on large nodes" },
  { range: "1.8-4x", desc: "Names + kinds, all edges in viewport" },
  { range: "> 4x", desc: "Full info, doc string on selected node" },
];

const KIND_ICON = {
  theorem: "*", lemma: "*", axiom: "*",
  def: "o", structure: "o", opaque: "o",
  class: "#", instance: "#",
};

export class Legend extends EventTarget {
  constructor(containerEl, graphData, camera, renderer) {
    super();
    this.container = containerEl;
    this.graphData = graphData;
    this.camera = camera;
    this.renderer = renderer;
    this.collapsed = false;

    this._totalEdges = 0;
    this._loadedEdges = 0;

    this._buildDom();
    this._statsInterval = setInterval(() => this._updateStats(), 1000);
  }

  _buildDom() {
    this.container.innerHTML = `
      <div id="legend-header">
        <span id="legend-title">Legend</span>
        <button id="legend-collapse-btn" title="Collapse">&#8212;</button>
      </div>
      <div id="legend-body">
        <div id="legend-edge-toggle">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;">
            <input type="checkbox" id="edge-toggle-checkbox" checked>
            Show edges at low zoom
          </label>
        </div>
        <div id="legend-topic-panel">
          <div id="legend-topic-title" style="font-size:11px;font-weight:600;opacity:0.6;margin-bottom:4px;letter-spacing:0.04em;">Topic Focus</div>
          <div id="legend-topic-list"></div>
          <button id="legend-topic-clear" style="display:none;margin-top:4px;font-size:11px;padding:2px 8px;cursor:pointer;">Clear</button>
        </div>
        <div id="legend-categories"></div>
        <div id="legend-kinds">
          ${Object.entries(KIND_ICON).map(([kind, icon]) =>
            `<span class="kind-icon-item"><span class="kind-icon">${icon}</span>${kind}</span>`
          ).join("")}
        </div>
        <div id="legend-stats">
          <div class="stat-row"><span id="stat-visible-nodes">0</span> / <span id="stat-total-nodes">0</span> nodes visible</div>
          <div class="stat-row"><span id="stat-loaded-edges">0</span> / <span id="stat-total-edges">0</span> edges loaded</div>
          <div class="stat-row">LOD <span id="stat-lod">0</span> &middot; <span id="stat-scale">1.00x</span></div>
        </div>
        <details id="lod-explainer">
          <summary>LOD info</summary>
          <ul id="lod-list">
            ${LOD_DESCRIPTIONS.map((l, i) =>
              `<li><strong>LOD ${i}</strong> (${l.range}): ${l.desc}</li>`
            ).join("")}
          </ul>
        </details>
      </div>
    `;

    this._els = {
      body: this.container.querySelector("#legend-body"),
      collapseBtn: this.container.querySelector("#legend-collapse-btn"),
      categories: this.container.querySelector("#legend-categories"),
      visibleNodes: this.container.querySelector("#stat-visible-nodes"),
      totalNodes: this.container.querySelector("#stat-total-nodes"),
      loadedEdges: this.container.querySelector("#stat-loaded-edges"),
      totalEdges: this.container.querySelector("#stat-total-edges"),
      lod: this.container.querySelector("#stat-lod"),
      scale: this.container.querySelector("#stat-scale"),
      topicList: this.container.querySelector("#legend-topic-list"),
      topicClear: this.container.querySelector("#legend-topic-clear"),
      edgeToggle: this.container.querySelector("#edge-toggle-checkbox"),
    };

    for (const topic of TOPICS) {
      const btn = document.createElement("button");
      btn.className = "legend-topic-btn";
      btn.dataset.key = topic.key;
      btn.title = "Focus " + topic.key;
      btn.innerHTML = '<span class="topic-dot" style="background:' + topic.color + '"></span>' + topic.label;
      btn.addEventListener("click", () => {
        const isActive = btn.classList.contains("active");
        this._els.topicList.querySelectorAll(".legend-topic-btn").forEach(b => b.classList.remove("active"));
        if (isActive) {
          this._els.topicClear.style.display = "none";
          this.dispatchEvent(new CustomEvent("topic-clear"));
        } else {
          btn.classList.add("active");
          this._els.topicClear.style.display = "inline-block";
          this.dispatchEvent(new CustomEvent("topic-focus", { detail: topic.key }));
        }
      });
      this._els.topicList.appendChild(btn);
    }

    this._els.topicClear.addEventListener("click", () => {
      this._els.topicList.querySelectorAll(".legend-topic-btn").forEach(b => b.classList.remove("active"));
      this._els.topicClear.style.display = "none";
      this.dispatchEvent(new CustomEvent("topic-clear"));
    });

    this._els.edgeToggle.addEventListener("change", (e) => {
      this.dispatchEvent(new CustomEvent("edge-toggle", { detail: e.target.checked }));
    });

    this._els.collapseBtn.addEventListener("click", () => this._toggleCollapse());
  }

  setCategories(categories) {
    this._els.categories.innerHTML = "";
    for (const cat of categories) {
      const item = document.createElement("div");
      item.className = "legend-cat-item";
      item.innerHTML =
        '<span class="legend-color-swatch" style="background:' + cat.color + '"></span>' +
        '<span class="legend-cat-name">' + this._escape(cat.namespace) + '</span>' +
        '<span class="legend-cat-count">' + cat.count + '</span>';
      item.addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("namespace-toggle", { detail: cat.namespace }));
      });
      this._els.categories.appendChild(item);
    }
  }

  update() {
    this._els.lod.textContent = this.renderer.getCurrentLOD();
    this._els.scale.textContent = this.camera.scale.toFixed(2) + "x";
  }

  setEdgeProgress(loaded, total) {
    this._loadedEdges = loaded;
    this._totalEdges = total;
    this._els.loadedEdges.textContent = loaded.toLocaleString();
    this._els.totalEdges.textContent = total.toLocaleString();
  }

  _updateStats() {
    const bounds = this.camera.getViewportBounds();
    const visible = this.graphData.queryViewport(bounds).length;
    this._els.visibleNodes.textContent = visible.toLocaleString();
    this._els.totalNodes.textContent = this.graphData.nodeCount.toLocaleString();
    this.update();
  }

  _toggleCollapse() {
    this.collapsed = !this.collapsed;
    this._els.body.hidden = this.collapsed;
    this._els.collapseBtn.textContent = this.collapsed ? "+" : "\u2014";
  }

  destroy() {
    clearInterval(this._statsInterval);
  }

  _escape(str) {
    const div = document.createElement("div");
    div.textContent = str != null ? str : "";
    return div.innerHTML;
  }
}
