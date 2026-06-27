/**
 * frontend/ui/search-worker.js
 * ==============================
 * Web Worker：在背景執行 Fuse.js 模糊搜尋與 BFS 最短路徑查找，
 * 避免大量計算阻塞主執行緒。
 *
 * 透過 importScripts 從 CDN 載入 Fuse.js（Worker 環境不支援 <script> 標籤）。
 * 若 CDN 無法連線（離線、網路限制等），降級為簡單子字串比對，
 * 確保搜尋功能不會完全失效。
 */

let fuseAvailable = false;
try {
  importScripts("https://cdn.jsdelivr.net/npm/fuse.js/dist/fuse.min.js");
  fuseAvailable = typeof Fuse !== "undefined";
} catch (err) {
  // CDN 載入失敗：保持 fuseAvailable = false，後續搜尋走子字串比對降級路徑
  console.warn("[search-worker] Fuse.js 載入失敗，降級為子字串搜尋：", err.message);
}

let fuse = null;
let rawIndex = [];

/** 降級用：簡單子字串比對 + 粗略分數，模擬 Fuse 的回傳格式（{item, score}）。 */
function fallbackSearch(query, limit) {
  const q = query.toLowerCase();
  const scored = [];
  for (const item of rawIndex) {
    const name = (item.short_name || "").toLowerCase();
    const id = (item.id || "").toLowerCase();
    let score = null;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 0.1;
    else if (name.includes(q)) score = 0.3;
    else if (id.includes(q)) score = 0.5;
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit);
}

self.onmessage = ({ data }) => {
  switch (data.type) {
    case "init": {
      rawIndex = data.index || [];
      if (fuseAvailable) {
        fuse = new Fuse(rawIndex, {
          keys: ["short_name", "id", "doc_short", "module"],
          threshold: 0.3,
          includeScore: true,
        });
      }
      self.postMessage({ type: "ready", degraded: !fuseAvailable });
      break;
    }

    case "search": {
      const limit = data.limit || 30;
      const results = fuse
        ? fuse.search(data.query, { limit })
        : fallbackSearch(data.query, limit);
      self.postMessage({ type: "results", results, query: data.query });
      break;
    }

    case "bfs": {
      const path = bfsShortestPath(data.srcId, data.dstId, data.adjacency);
      self.postMessage({ type: "path", path, srcId: data.srcId, dstId: data.dstId });
      break;
    }

    default:
      break;
  }
};

/**
 * 沿 'out' 方向 BFS 查找最短路徑。
 * @param {string} srcId
 * @param {string} dstId
 * @param {Record<string, {in:string[], out:string[]}>} adjacency
 * @returns {string[]|null}
 */
function bfsShortestPath(srcId, dstId, adjacency) {
  if (srcId === dstId) return [srcId];
  if (!adjacency[srcId] || !adjacency[dstId]) return null;

  const visited = new Map([[srcId, null]]);
  const queue = [srcId];
  let qi = 0;

  while (qi < queue.length) {
    const node = queue[qi++];
    const neighbors = adjacency[node]?.out || [];
    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.set(next, node);
      if (next === dstId) {
        const path = [next];
        let cur = node;
        while (cur !== null) {
          path.push(cur);
          cur = visited.get(cur);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}
