/**
 * frontend/engine/graph.js
 * =========================
 * 前端圖形資料管理：TypedArray 節點儲存、四叉樹空間索引、GraphData 主 API。
 *
 * 設計目標：10 萬+ 節點時仍保持低記憶體佔用與快速空間查詢。
 * 節點座標／半徑／種類索引存於單一 Float32Array（NODE_STRIDE = 4），
 * 避免為每個節點建立物件造成的 GC 壓力。
 */

// ── 常數 ────────────────────────────────────────────────────────────────

export const NODE_STRIDE = 4; // [x, y, r, kindIndex]

/** kind 字串 <-> 數值索引的雙向映射（用於壓縮進 TypedArray） */
export const KIND_LIST = [
  "theorem", "def", "lemma", "structure",
  "class", "instance", "axiom", "opaque", "other",
];
const KIND_TO_INDEX = new Map(KIND_LIST.map((k, i) => [k, i]));

function kindToIndex(kind) {
  return KIND_TO_INDEX.has(kind) ? KIND_TO_INDEX.get(kind) : KIND_TO_INDEX.get("other");
}

function indexToKind(i) {
  return KIND_LIST[i] ?? "other";
}

// ═══════════════════════════════════════════════════════════════════════
// Quadtree — 從 quadtree.json 載入的靜態空間索引（唯讀查詢結構）
// ═══════════════════════════════════════════════════════════════════════

export class Quadtree {
  /**
   * @param {object} data 解析後的 quadtree.json
   *   形如 { bounds: [x,y,w,h], nodes: string[], children: [...] }
   */
  constructor(data) {
    this.root = data ?? { bounds: [0, 0, 0, 0], nodes: [], children: [] };
  }

  /**
   * 查詢與 bounds 相交的所有節點 id。
   * @param {{x:number,y:number,w:number,h:number}} bounds
   * @returns {string[]}
   */
  query(bounds) {
    const result = [];
    this._queryNode(this.root, bounds, result);
    return result;
  }

  _queryNode(node, bounds, result) {
    if (!node || !this._intersects(node.bounds, bounds)) return;
    if (node.nodes && node.nodes.length) {
      for (let i = 0; i < node.nodes.length; i++) result.push(node.nodes[i]);
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        this._queryNode(node.children[i], bounds, result);
      }
    }
  }

  _intersects(nodeBounds, queryBounds) {
    const [nx, ny, nw, nh] = nodeBounds;
    const { x: qx, y: qy, w: qw, h: qh } = queryBounds;
    return !(qx > nx + nw || qx + qw < nx || qy > ny + nh || qy + qh < ny);
  }

  /**
   * 查詢以 (cx, cy) 為中心、半徑 r 的圓形範圍內所有節點 id。
   * 內部先用包圍方形做粗篩（相交測試很快），再由呼叫端做精確距離判斷。
   * @returns {string[]}
   */
  queryRadius(cx, cy, r) {
    return this.query({ x: cx - r, y: cy - r, w: r * 2, h: r * 2 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GraphData — 前端記憶體中的圖形資料主體
// ═══════════════════════════════════════════════════════════════════════

export class GraphData {
  constructor() {
    /** @type {Float32Array} */
    this.nodeBuffer = new Float32Array(0);
    /** @type {string[]} 與 nodeBuffer 索引對齊 */
    this.nodeIds = [];
    /** @type {Map<string, number>} nodeId -> nodeBuffer 索引 */
    this.nodeIndex = new Map();
    /** @type {Map<string, {short_name:string, ns:string, kind:string}>} */
    this.nodeAttrs = new Map();

    /** @type {Quadtree|null} */
    this.quadtree = null;

    /** 邊清單：{s, d} 物件陣列（累積自所有已載入的 chunk） */
    this.edges = [];
    /** @type {Set<string>} 已載入過的 chunk 檔名，避免重複載入 */
    this._loadedChunks = new Set();

    /** @type {Map<string, object>} 節點詳情快取（按 namespace slug 載入） */
    this._nodeDetailCache = new Map();
    /** @type {Set<string>} 已載入的 namespace slug */
    this._loadedNsSlugs = new Set();

    /** @type {Map<string, {in:string[], out:string[]}>} 鄰接表（若有預先提供） */
    this.adjacency = null;

    this.meta = null; // graph_meta.json 的頂層欄位（除 nodes 外）
  }

  // ── 載入 ────────────────────────────────────────────────────────────

  /**
   * 載入 graph_meta.json，建立 nodeBuffer + quadtree。
   * @param {string} metaUrlOrData 可為 URL 字串，或已解析的物件（供測試/串流載入器使用）
   */
  async loadMeta(metaUrlOrData) {
    const data = typeof metaUrlOrData === "string"
      ? await (await fetch(metaUrlOrData)).json()
      : metaUrlOrData;

    this.setMeta(data);
    return data;
  }

  /**
   * 由已解析的 graph_meta 物件填充內部結構（供 loader.js 的串流解析器呼叫）。
   */
  setMeta(data) {
    const nodes = data.nodes || [];
    const n = nodes.length;

    this.nodeBuffer = new Float32Array(n * NODE_STRIDE);
    this.nodeIds = new Array(n);
    this.nodeIndex = new Map();
    this.nodeAttrs = new Map();

    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const off = i * NODE_STRIDE;
      this.nodeBuffer[off] = node.x;
      this.nodeBuffer[off + 1] = node.y;
      this.nodeBuffer[off + 2] = node.r;
      this.nodeBuffer[off + 3] = kindToIndex(node.kind);

      this.nodeIds[i] = node.id;
      this.nodeIndex.set(node.id, i);
      this.nodeAttrs.set(node.id, {
        short_name: node.short,
        ns: node.ns,
        kind: node.kind,
      });
    }

    this.meta = {
      build_hash: data.build_hash,
      build_time: data.build_time,
      lean_version: data.lean_version,
      mathlib_version: data.mathlib_version,
      node_count: data.node_count ?? n,
      edge_count: data.edge_count ?? 0,
    };

    // quadtree.json 通常單獨載入；若 meta 內含 quadtree 欄位也支援直接使用
    if (data.quadtree) {
      this.quadtree = new Quadtree(data.quadtree);
    }
  }

  /** 載入並設置四叉樹（通常從 index/quadtree.json 取得）。 */
  async loadQuadtree(quadtreeUrlOrData) {
    const data = typeof quadtreeUrlOrData === "string"
      ? await (await fetch(quadtreeUrlOrData)).json()
      : quadtreeUrlOrData;
    this.quadtree = new Quadtree(data);
    return data;
  }

  /**
   * 載入一個邊資料塊，追加到 edges。
   * @param {string} chunkUrl
   * @returns {Promise<number>} 本次新增的邊數
   */
  async loadEdgeChunk(chunkUrl) {
    if (this._loadedChunks.has(chunkUrl)) return 0;
    const res = await fetch(chunkUrl);
    if (!res.ok) throw new Error(`載入邊資料塊失敗：${chunkUrl} (${res.status})`);
    const data = await res.json();
    const newEdges = data.edges || [];
    for (let i = 0; i < newEdges.length; i++) this.edges.push(newEdges[i]);
    this._loadedChunks.add(chunkUrl);
    return newEdges.length;
  }

  /**
   * 直接以已解析的邊陣列追加（供 loader.js 在 fetch 後呼叫，避免重複 fetch）。
   */
  appendEdges(chunkKey, edgeArray) {
    if (this._loadedChunks.has(chunkKey)) return 0;
    for (let i = 0; i < edgeArray.length; i++) this.edges.push(edgeArray[i]);
    this._loadedChunks.add(chunkKey);
    return edgeArray.length;
  }

  /**
   * 載入節點詳情（按命名空間分檔），快取後續查詢。
   * @param {string} nsSlugOrUrl 命名空間 slug（將拼接 baseUrl）或完整 URL
   * @param {string} [baseUrl] 若 nsSlugOrUrl 為 slug，需提供 data/ 的 base URL
   */
  async loadNodeDetail(nsSlugOrUrl, baseUrl) {
    const url = baseUrl ? `${baseUrl}/nodes/${nsSlugOrUrl}.json` : nsSlugOrUrl;
    const slugKey = baseUrl ? nsSlugOrUrl : url;
    if (this._loadedNsSlugs.has(slugKey)) return;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`載入節點詳情失敗：${url} (${res.status})`);
    const data = await res.json();
    for (const detail of data.nodes || []) {
      this._nodeDetailCache.set(detail.id, detail);
    }
    this._loadedNsSlugs.add(slugKey);
  }

  /** 直接置入單筆節點詳情（供 API 模式的 loader 呼叫，繞過命名空間整檔載入）。 */
  setNodeDetail(nodeId, detail) {
    this._nodeDetailCache.set(nodeId, detail);
  }

  /** 設置預計算鄰接表（adjacency.json），供 getNeighbors 快速查詢。 */
  setAdjacency(adjacency) {
    this.adjacency = adjacency;
  }

  // ── 查詢 ────────────────────────────────────────────────────────────

  /**
   * 取得節點的輕量屬性（座標 + short_name + kind + ns）。
   * @returns {{id:string, x:number, y:number, r:number, kind:string, short_name:string, ns:string}|null}
   */
  getNodeAttr(nodeId) {
    const i = this.nodeIndex.get(nodeId);
    if (i === undefined) return null;
    const off = i * NODE_STRIDE;
    const attr = this.nodeAttrs.get(nodeId);
    return {
      id: nodeId,
      x: this.nodeBuffer[off],
      y: this.nodeBuffer[off + 1],
      r: this.nodeBuffer[off + 2],
      kind: indexToKind(this.nodeBuffer[off + 3]),
      short_name: attr?.short_name ?? nodeId.split(".").pop(),
      ns: attr?.ns ?? "",
    };
  }

  /** 取得節點完整詳情（含 doc_string 等），若尚未載入則回傳 null。 */
  getNodeDetail(nodeId) {
    return this._nodeDetailCache.get(nodeId) ?? null;
  }

  /** 是否已快取此節點的完整詳情。 */
  hasNodeDetail(nodeId) {
    return this._nodeDetailCache.has(nodeId);
  }

  /**
   * 取得節點的直接鄰居。優先使用預載的 adjacency 表；
   * 若無，則即時掃描 edges（較慢，適合小型圖或未提供 adjacency 時的回退）。
   */
  getNeighbors(nodeId) {
    if (this.adjacency && this.adjacency[nodeId]) {
      return this.adjacency[nodeId];
    }
    const out = [];
    const inn = [];
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      if (e.s === nodeId) out.push(e.d);
      else if (e.d === nodeId) inn.push(e.s);
    }
    return { in: inn, out };
  }

  /** 視口內所有節點 id（委派 Quadtree）。 */
  queryViewport(bounds) {
    if (!this.quadtree) return [];
    return this.quadtree.query(bounds);
  }

  /**
   * 找出螢幕座標 (sx, sy) 下命中的節點 id（若有）。
   * @param {number} sx
   * @param {number} sy
   * @param {import('./camera.js').Camera} camera
   * @returns {string|null}
   */
  hitTest(sx, sy, camera) {
    if (!this.quadtree) return null;
    const [wx, wy] = camera.screenToWorld(sx, sy);
    const tolerance = 30 / camera.scale; // 30px 螢幕容差換算為世界座標
    const candidates = this.quadtree.queryRadius(wx, wy, tolerance);

    let bestId = null;
    let bestDist = Infinity;

    for (const id of candidates) {
      const i = this.nodeIndex.get(id);
      if (i === undefined) continue;
      const off = i * NODE_STRIDE;
      const nx = this.nodeBuffer[off];
      const ny = this.nodeBuffer[off + 1];
      const nr = this.nodeBuffer[off + 2];
      const dist = Math.hypot(wx - nx, wy - ny);
      const hitRadius = Math.max(nr, 4) / camera.scale + 4 / camera.scale;
      if (dist < hitRadius && dist < bestDist) {
        bestDist = dist;
        bestId = id;
      }
    }
    return bestId;
  }

  /** 所有節點 id 所屬的頂層命名空間清單（去重）。 */
  listNamespaces() {
    const set = new Set();
    for (const attr of this.nodeAttrs.values()) set.add(attr.ns);
    return Array.from(set).sort();
  }

  get nodeCount() {
    return this.nodeIds.length;
  }

  get loadedEdgeCount() {
    return this.edges.length;
  }

  get totalEdgeCount() {
    return this.meta?.edge_count ?? this.edges.length;
  }
}
