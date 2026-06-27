/**
 * frontend/engine/loader.js
 * ============================
 * 分塊資料載入排程器：管理 graph_meta.json、邊資料塊、節點詳情的
 * 漸進式載入，確保使用者盡快看到圖形。
 *
 * 載入優先級：
 *   1（立即）   graph_meta.json -> 建立節點，圖形可見
 *   2（當前視口） 當前視口對應的 edges chunk
 *   3（鄰近視口） 視口周圍 2x 範圍的 edges chunks
 *   4（背景）   其餘所有 edges chunks
 *   5（按需）   節點詳情，使用者點擊節點後才載入
 */

// ═══════════════════════════════════════════════════════════════════════
// PriorityQueue — 簡單二元堆積（最小堆，priority 越小越優先）
// ═══════════════════════════════════════════════════════════════════════

export class PriorityQueue {
  constructor() {
    this._heap = []; // {item, priority, id}
    this._idIndex = new Map(); // id -> heap 索引（供 reprioritize 使用）
  }

  get size() {
    return this._heap.length;
  }

  /**
   * @param {*} item
   * @param {number} priority 數字越小越優先
   * @param {string} [id] 可選的唯一識別碼，供 reprioritize 查找
   */
  push(item, priority, id) {
    const node = { item, priority, id };
    this._heap.push(node);
    const idx = this._heap.length - 1;
    if (id !== undefined) this._idIndex.set(id, idx);
    this._bubbleUp(idx);
  }

  pop() {
    if (this._heap.length === 0) return undefined;
    const top = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = last;
      this._reindex(0);
      this._bubbleDown(0);
    }
    if (top.id !== undefined) this._idIndex.delete(top.id);
    return top.item;
  }

  /** 動態調整某個 id 對應項目的優先級（視口變化時呼叫）。 */
  reprioritize(id, newPriority) {
    const idx = this._idIndex.get(id);
    if (idx === undefined) return false;
    const node = this._heap[idx];
    const oldPriority = node.priority;
    node.priority = newPriority;
    if (newPriority < oldPriority) this._bubbleUp(idx);
    else this._bubbleDown(idx);
    return true;
  }

  has(id) {
    return this._idIndex.has(id);
  }

  _reindex(idx) {
    const node = this._heap[idx];
    if (node && node.id !== undefined) this._idIndex.set(node.id, idx);
  }

  _swap(i, j) {
    [this._heap[i], this._heap[j]] = [this._heap[j], this._heap[i]];
    this._reindex(i);
    this._reindex(j);
  }

  _bubbleUp(idx) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this._heap[parent].priority <= this._heap[idx].priority) break;
      this._swap(parent, idx);
      idx = parent;
    }
  }

  _bubbleDown(idx) {
    const n = this._heap.length;
    while (true) {
      let smallest = idx;
      const left = idx * 2 + 1;
      const right = idx * 2 + 2;
      if (left < n && this._heap[left].priority < this._heap[smallest].priority) smallest = left;
      if (right < n && this._heap[right].priority < this._heap[smallest].priority) smallest = right;
      if (smallest === idx) break;
      this._swap(idx, smallest);
      idx = smallest;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 工具：sessionStorage 快取（容量不足時靜默跳過）
// ═══════════════════════════════════════════════════════════════════════

function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 配額不足或其他錯誤：靜默跳過快取
  }
}

/** 帶重試（指數退避：500ms, 1000ms）的 fetch + JSON 解析。 */
async function fetchJsonWithRetry(url, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = 500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * 串流解析大型 JSON（graph_meta.json > 10MB 時使用）。
 * 簡化策略：仍整體讀取 body 為文字後一次性 JSON.parse（瀏覽器原生無串流 JSON 解析器），
 * 但以 ReadableStream 分段讀取以便回報下載進度；解析完成後一次性 emit 完成事件。
 */
async function fetchJsonStreaming(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentLength = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !contentLength) {
    return await res.json();
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, contentLength);
  }

  const blob = new Blob(chunks);
  const text = await blob.text();
  return JSON.parse(text);
}

// ═══════════════════════════════════════════════════════════════════════
// DataLoader
// ═══════════════════════════════════════════════════════════════════════

const MAX_CONCURRENT_FETCHES = 4;
const STREAM_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10MB

export class DataLoader extends EventTarget {
  /**
   * @param {string} baseUrl data/ 目錄的 URL（結尾不含斜線）
   * @param {import('./graph.js').GraphData} graphData
   */
  constructor(baseUrl, graphData) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.graphData = graphData;

    this._queue = new PriorityQueue();
    this._activeFetches = 0;
    this._chunkIndex = []; // [{file, ns_range}]
    this._chunksTotal = 0;
    this._chunksLoaded = 0;
    this._edgesLoaded = 0;
    this._edgesTotal = 0;
    this._metaLoaded = false;
    this._startTime = 0;

    /** API 模式：若偵測到後端可用，節點詳情/鄰居改走 API。 */
    this._apiMode = false;
    this._apiBase = null;
  }

  get progress() {
    return {
      metaLoaded: this._metaLoaded,
      chunksLoaded: this._chunksLoaded,
      chunksTotal: this._chunksTotal,
      edgesLoaded: this._edgesLoaded,
      edgesTotal: this._edgesTotal,
    };
  }

  /** 啟動載入序列。 */
  async start() {
    this._startTime = performance.now();

    // ── 偵測後端 API ───────────────────────────────────────────────
    await this._detectApi();

    // ── Priority 1：graph_meta.json ──────────────────────────────────
    try {
      const metaUrl = `${this.baseUrl}/graph_meta.json`;
      const cached = cacheGet(metaUrl);
      let metaData;

      if (cached) {
        metaData = cached;
      } else {
        const headRes = await fetch(metaUrl, { method: "HEAD" }).catch(() => null);
        const size = headRes ? Number(headRes.headers.get("content-length")) || 0 : 0;

        if (size > STREAM_THRESHOLD_BYTES) {
          metaData = await fetchJsonStreaming(metaUrl, (received, total) => {
            this.dispatchEvent(new CustomEvent("download-progress", {
              detail: { url: metaUrl, received, total },
            }));
          });
        } else {
          metaData = await fetchJsonWithRetry(metaUrl);
        }
        cacheSet(metaUrl, metaData);
      }

      this.graphData.setMeta(metaData);
      this._emitMetaParseProgress(metaData);

      // 四叉樹索引（獨立文件）
      const qtUrl = `${this.baseUrl}/index/quadtree.json`;
      const qtCached = cacheGet(qtUrl);
      const qtData = qtCached || await fetchJsonWithRetry(qtUrl);
      if (!qtCached) cacheSet(qtUrl, qtData);
      await this.graphData.loadQuadtree(qtData);

      this._metaLoaded = true;
      this._edgesTotal = metaData.edge_count || 0;

      this.dispatchEvent(new CustomEvent("meta-loaded", {
        detail: { nodeCount: this.graphData.nodeCount, edgeTotal: this._edgesTotal },
      }));
    } catch (err) {
      this.dispatchEvent(new CustomEvent("error", { detail: { url: "graph_meta.json", error: err } }));
      return;
    }

    // ── 鄰接表（供 getNeighbors 快速查詢；API 模式下可省略） ───────────
    if (!this._apiMode) {
      try {
        const adjUrl = `${this.baseUrl}/index/adjacency.json`;
        const cached = cacheGet(adjUrl);
        const adjacency = cached || await fetchJsonWithRetry(adjUrl);
        if (!cached) cacheSet(adjUrl, adjacency);
        this.graphData.setAdjacency(adjacency);
      } catch {
        // 鄰接表非必要：缺失時 getNeighbors 會回退到掃描 edges
      }
    }

    // ── Priority 4：載入 chunks/index.json，將所有 chunk 排入背景佇列 ──
    try {
      const idxUrl = `${this.baseUrl}/chunks/index.json`;
      const cached = cacheGet(idxUrl);
      this._chunkIndex = cached || await fetchJsonWithRetry(idxUrl);
      if (!cached) cacheSet(idxUrl, this._chunkIndex);
      this._chunksTotal = this._chunkIndex.length;

      this._chunkIndex.forEach((chunk, i) => {
        this._queue.push({ type: "edge-chunk", chunk, index: i }, 4, `chunk:${i}`);
      });

      this._drainQueue();
    } catch (err) {
      this.dispatchEvent(new CustomEvent("error", { detail: { url: "chunks/index.json", error: err } }));
    }
  }

  /** 嘗試偵測後端 API（fetch /api/stats 成功且回傳 JSON 才算偵測到）。 */
  async _detectApi() {
    const candidates = [this.baseUrl.replace(/\/data\/?$/, ""), ""];
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/api/stats`, { method: "GET" });
        const contentType = res.headers.get("content-type") || "";
        // 純靜態主機（如 GitHub Pages）對不存在的路徑可能回傳 200 + HTML
        // （例如 SPA fallback 設定），單看 res.ok 不夠保險，需確認是 JSON。
        if (res.ok && contentType.includes("application/json")) {
          this._apiMode = true;
          this._apiBase = base;
          return;
        }
      } catch {
        // 忽略，嘗試下一個候選
      }
    }
    this._apiMode = false;
  }

  /** 視口更新：重排邊資料載入優先級（與 bounds 相交的 chunks 移到前端）。 */
  onViewportChange(bounds, camera) {
    if (!this._chunkIndex.length) return;

    // 簡化策略：chunk 是依 namespace 排序而非空間排序，因此用「視口內可見節點
    // 所屬 ns」與 chunk.ns_range 是否相交來判斷優先級，而非精確幾何相交。
    const visibleIds = this.graphData.queryViewport(bounds);
    const visibleNs = new Set();
    for (const id of visibleIds) {
      const attr = this.graphData.getNodeAttr(id);
      if (attr) visibleNs.add(attr.ns);
    }

    this._chunkIndex.forEach((chunk, i) => {
      const id = `chunk:${i}`;
      if (!this._queue.has(id)) return; // 已載入，不在佇列中

      const [lo, hi] = chunk.ns_range || ["", ""];
      let priority = 4; // 預設：背景
      for (const ns of visibleNs) {
        if (ns >= lo && ns <= hi) {
          priority = 2; // 當前視口相關
          break;
        }
      }
      this._queue.reprioritize(id, priority);
    });

    this._drainQueue();
  }

  /** 按需載入節點詳情（先查快取，無則 fetch；API 模式優先走 API）。 */
  async loadNodeDetail(nodeId) {
    if (this.graphData.hasNodeDetail(nodeId)) {
      return this.graphData.getNodeDetail(nodeId);
    }

    if (this._apiMode) {
      const url = `${this._apiBase}/api/node/${encodeURIComponent(nodeId)}`;
      const detail = await fetchJsonWithRetry(url);
      this.graphData.setNodeDetail(nodeId, detail);
      return detail;
    }

    const attr = this.graphData.getNodeAttr(nodeId);
    if (!attr) return null;
    const slug = attr.ns.replace(/\./g, "_").replace(/\//g, "_") || "_root";
    await this.graphData.loadNodeDetail(slug, this.baseUrl);
    return this.graphData.getNodeDetail(nodeId);
  }

  /** 取得節點鄰居（API 模式優先走 API，否則用本地 adjacency / edges 掃描）。 */
  async loadNeighbors(nodeId) {
    if (this._apiMode) {
      const url = `${this._apiBase}/api/node/${encodeURIComponent(nodeId)}/neighbors`;
      return await fetchJsonWithRetry(url);
    }
    return this.graphData.getNeighbors(nodeId);
  }

  // ── 內部：佇列消化 ─────────────────────────────────────────────────

  _drainQueue() {
    while (this._activeFetches < MAX_CONCURRENT_FETCHES && this._queue.size > 0) {
      const task = this._queue.pop();
      if (!task) break;
      this._activeFetches++;
      this._processTask(task).finally(() => {
        this._activeFetches--;
        this._drainQueue();
        this._checkAllLoaded();
      });
    }
  }

  async _processTask(task) {
    if (task.type !== "edge-chunk") return;
    const url = `${this.baseUrl}/chunks/${task.chunk.file}`;
    try {
      const cached = cacheGet(url);
      const data = cached || await fetchJsonWithRetry(url);
      if (!cached) cacheSet(url, data);

      const edges = data.edges || [];
      const added = this.graphData.appendEdges(url, edges);
      this._edgesLoaded += added;
      this._chunksLoaded++;

      this.dispatchEvent(new CustomEvent("chunk-loaded", {
        detail: {
          chunkIndex: task.index,
          totalChunks: this._chunksTotal,
          edgesLoaded: this._edgesLoaded,
          edgesTotal: this._edgesTotal,
        },
      }));
    } catch (err) {
      this.dispatchEvent(new CustomEvent("error", { detail: { url, error: err } }));
    }
  }

  _checkAllLoaded() {
    if (this._chunksLoaded >= this._chunksTotal && this._queue.size === 0 && this._activeFetches === 0) {
      const duration = performance.now() - this._startTime;
      this.dispatchEvent(new CustomEvent("all-loaded", { detail: { duration } }));
    }
  }

  _emitMetaParseProgress(metaData) {
    const total = (metaData.nodes || []).length;
    const step = 1000;
    for (let i = step; i < total; i += step) {
      this.dispatchEvent(new CustomEvent("parse-progress", { detail: { parsed: i, total } }));
    }
    this.dispatchEvent(new CustomEvent("parse-progress", { detail: { parsed: total, total } }));
  }

  // ── Service Worker 整合（可選） ────────────────────────────────────

  /** 若瀏覽器支援，註冊 Service Worker 以支援離線快取。 */
  async registerServiceWorker(swUrl = "./sw.js") {
    if (!("serviceWorker" in navigator)) return false;
    try {
      await navigator.serviceWorker.register(swUrl);
      return true;
    } catch (err) {
      this.dispatchEvent(new CustomEvent("error", { detail: { url: swUrl, error: err } }));
      return false;
    }
  }
}
