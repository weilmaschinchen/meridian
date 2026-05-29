// admin/cra/fp-embeddings.js — Phase 1.4 (CRA-Strategie 2026-04-25)
//
// False-Positive-Pattern-Lernen via nomic-embed-text:
// 1. User markiert tool_finding als FP im Dashboard → markAsFp(findingId, note)
// 2. Wir holen Text-Repraesentation des Findings, berechnen Embedding via
//    Mac-Ollama (Tailscale 100.109.108.63:11434, nomic-embed-text)
// 3. Embedding wird als 768-dim Float32-BLOB in cra_fp_patterns persistiert
// 4. Bei neuen Findings ruft Klassifikator findFpMatch(text) → wenn cosine ≥ 0.9
//    → Finding wird auto-IGNORE markiert, hit_count erhoeht
//
// Optimierungen fuer N>1000 Patterns:
// - In-Memory-Cache aller Embeddings beim Server-Start (1000 * 768 * 4 = ~3MB)
// - Cache-Invalidierung bei jedem markAsFp/delete

var craDb = require('./cra-db');
var http = require('http');
var url = require('url');

var OLLAMA_HOST = process.env.OLLAMA_HOST || '100.109.108.63:11434';
var EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
var FP_SIMILARITY_THRESHOLD = parseFloat(process.env.FP_SIMILARITY_THRESHOLD || '0.9');

// In-Memory-Cache: Array<{id, embedding: Float32Array, text}>
var patternCache = null;

// ── Embedding API (Ollama) ────────────────────────────────────────────────
function ollamaEmbed(text) {
  return new Promise(function(resolve) {
    var payload = JSON.stringify({ model: EMBED_MODEL, prompt: String(text || '').substring(0, 8000) });
    var parts = OLLAMA_HOST.split(':');
    var opts = {
      hostname: parts[0],
      port: parseInt(parts[1] || '11434'),
      path: '/api/embeddings',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15000
    };
    var req = http.request(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try {
          var data = JSON.parse(body);
          if (res.statusCode !== 200 || !Array.isArray(data.embedding)) {
            return resolve({ ok: false, error: 'HTTP ' + res.statusCode + ': ' + body.substring(0, 200) });
          }
          resolve({ ok: true, embedding: data.embedding });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

// ── Encoding: Array<Number> ↔ BLOB (Float32) ──────────────────────────────
function embeddingToBlob(arr) {
  var buf = Buffer.alloc(arr.length * 4);
  for (var i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4);
  return buf;
}

function blobToFloat32(blob) {
  var len = blob.length / 4;
  var arr = new Float32Array(len);
  for (var i = 0; i < len; i++) arr[i] = blob.readFloatLE(i * 4);
  return arr;
}

// ── Cosine Similarity ─────────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  var dot = 0, nA = 0, nB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ── Cache-Management ──────────────────────────────────────────────────────
function loadCache() {
  var rows = craDb.all('SELECT id, text, embedding_blob FROM cra_fp_patterns');
  patternCache = rows.map(function(r) {
    return { id: r.id, text: r.text, embedding: blobToFloat32(r.embedding_blob) };
  });
  return patternCache;
}

function invalidateCache() {
  patternCache = null;
}

function ensureCache() {
  if (patternCache === null) loadCache();
  return patternCache;
}

// ── Text-Repraesentation eines Findings (was wir embedden) ────────────────
function findingToText(f) {
  return [f.tool, f.rule_id, f.message || '', f.file_path].filter(Boolean).join(' | ');
}

// ── Public API ────────────────────────────────────────────────────────────
async function markAsFp(findingId, note, createdBy) {
  var f = craDb.get(
    'SELECT id, tool, rule_id, file_path, line_no, tool_severity, message FROM tool_findings WHERE id = ?',
    [findingId]
  );
  if (!f) return { ok: false, error: 'Finding nicht gefunden: ' + findingId };

  var text = findingToText(f);
  var emb = await ollamaEmbed(text);
  if (!emb.ok) return { ok: false, error: 'Embedding-Fehler: ' + emb.error };

  var blob = embeddingToBlob(emb.embedding);
  craDb.run(
    `INSERT INTO cra_fp_patterns (text, embedding_blob, embedding_dim, source_finding_id, created_by, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [text, blob, emb.embedding.length, findingId, createdBy || 'admin-dashboard', String(note || '').substring(0, 500)]
  );
  // Auch das Original-Finding als IGNORE markieren
  craDb.run(
    `UPDATE tool_findings SET status = 'ignored', ai_severity = 'IGNORE',
       ai_reason = ?, classified_by = 'fp-pattern-seed', classified_at = datetime('now','localtime')
     WHERE id = ?`,
    ['FP-Seed durch User: ' + (note || '(keine Notiz)'), findingId]
  );
  craDb.saveCraDb();
  invalidateCache();
  return { ok: true, finding_id: findingId, embedding_dim: emb.embedding.length };
}

async function findFpMatch(text) {
  var emb = await ollamaEmbed(text);
  if (!emb.ok) return { ok: false, error: emb.error, match: null };

  var queryVec = new Float32Array(emb.embedding);
  var patterns = ensureCache();
  if (!patterns.length) return { ok: true, match: null, scanned: 0 };

  var bestSim = -1;
  var bestPattern = null;
  for (var i = 0; i < patterns.length; i++) {
    var sim = cosineSimilarity(queryVec, patterns[i].embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestPattern = patterns[i];
    }
  }

  if (bestSim >= FP_SIMILARITY_THRESHOLD) {
    // Hit-Counter erhoehen (lazy, kein invalidate)
    try {
      craDb.run(
        "UPDATE cra_fp_patterns SET hit_count = hit_count + 1, last_hit_at = datetime('now','localtime') WHERE id = ?",
        [bestPattern.id]
      );
    } catch (e) { /* ok */ }
    return {
      ok: true,
      scanned: patterns.length,
      match: { pattern_id: bestPattern.id, similarity: bestSim, text: bestPattern.text }
    };
  }
  return { ok: true, scanned: patterns.length, best_similarity: bestSim, match: null };
}

// Convenience: Klassifikator ruft tryAutoIgnoreByFp(finding) → wenn match, marked schon
async function tryAutoIgnoreByFp(f) {
  var text = findingToText(f);
  var res = await findFpMatch(text);
  if (!res.ok || !res.match) return res;
  // Finding markieren
  craDb.run(
    `UPDATE tool_findings SET status = 'ignored', ai_severity = 'IGNORE',
       ai_confidence = ?, ai_reason = ?,
       classified_by = 'fp-pattern-match', classified_at = datetime('now','localtime')
     WHERE id = ?`,
    [res.match.similarity,
     'Match auf FP-Pattern #' + res.match.pattern_id + ' (sim=' + res.match.similarity.toFixed(3) + ')',
     f.id]
  );
  return res;
}

function getStats() {
  var count = craDb.get('SELECT COUNT(*) as cnt FROM cra_fp_patterns');
  var topHits = craDb.all(
    'SELECT id, text, hit_count, created_at, last_hit_at FROM cra_fp_patterns ORDER BY hit_count DESC LIMIT 20'
  );
  return {
    total_patterns: count ? count.cnt : 0,
    threshold: FP_SIMILARITY_THRESHOLD,
    cache_loaded: patternCache !== null,
    cache_size: patternCache ? patternCache.length : 0,
    top_hits: topHits
  };
}

function deletePattern(id) {
  craDb.run('DELETE FROM cra_fp_patterns WHERE id = ?', [id]);
  craDb.saveCraDb();
  invalidateCache();
  return { ok: true, deleted_id: id };
}

module.exports = {
  markAsFp: markAsFp,
  findFpMatch: findFpMatch,
  tryAutoIgnoreByFp: tryAutoIgnoreByFp,
  getStats: getStats,
  deletePattern: deletePattern,
  // Helpers exportiert fuer Tests
  cosineSimilarity: cosineSimilarity,
  embeddingToBlob: embeddingToBlob,
  blobToFloat32: blobToFloat32,
  loadCache: loadCache,
  invalidateCache: invalidateCache
};
