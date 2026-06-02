// SPDX-License-Identifier: Apache-2.0
// admin/cra/cra-rules.js — Regel-Engine: laden, validieren, speichern
var fs = require('fs');
var path = require('path');

// MERIDIAN_RULES_PATH erlaubt es Betreibern, eigene Regeln einzuhängen. Ohne ENV
// bleibt der Standard-Pfad data/cra-rules.json (backward-kompatibel).
var RULES_PATH = process.env.MERIDIAN_RULES_PATH || path.join(__dirname, '..', '..', 'data', 'cra-rules.json');
// Gebündelte generische Default-Regeln (im Meridian-Image vorhanden, wenn data/cra-rules.json fehlt).
var DEFAULT_RULES_PATH = path.join(__dirname, '..', '..', 'meridian', 'default-rules.json');
var warnedFallback = false;

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (e) {
    // Fallback: gebündelte Default-Regeln (z. B. Meridian-Container ohne eigene Regeldatei).
    try {
      var def = JSON.parse(fs.readFileSync(DEFAULT_RULES_PATH, 'utf8'));
      if (!warnedFallback) {
        console.warn('[CRA/Rules] ' + RULES_PATH + ' nicht gefunden — nutze gebündelte Default-Regeln. Eigene Regeln via MERIDIAN_RULES_PATH setzen.');
        warnedFallback = true;
      }
      return def;
    } catch (e2) {
      if (!warnedFallback) {
        console.error('[CRA/Rules] Laden fehlgeschlagen (weder ' + RULES_PATH + ' noch Default):', e.message);
        warnedFallback = true;
      }
      return null;
    }
  }
}

function saveRules(rules) {
  if (!rules || !rules.pipeline || !Array.isArray(rules.risk_patterns)) {
    return { ok: false, error: 'Ungueltige Regelstruktur' };
  }

  // Validierung
  var p = rules.pipeline;
  if (typeof p.block_threshold !== 'number' || p.block_threshold < 1 || p.block_threshold > 100) {
    return { ok: false, error: 'block_threshold muss zwischen 1 und 100 liegen' };
  }
  if (typeof p.approval_ttl_min !== 'number' || p.approval_ttl_min < 5 || p.approval_ttl_min > 1440) {
    return { ok: false, error: 'approval_ttl_min muss zwischen 5 und 1440 liegen' };
  }

  for (var i = 0; i < rules.risk_patterns.length; i++) {
    var rp = rules.risk_patterns[i];
    if (!rp.pattern || !rp.message || !rp.severity) {
      return { ok: false, error: 'Risk-Pattern ' + (i + 1) + ': pattern, message und severity sind Pflicht' };
    }
    // Regex-Validierung
    try { new RegExp(rp.pattern, 'i'); } catch (e) {
      return { ok: false, error: 'Risk-Pattern ' + rp.id + ': Ungueltiger Regex: ' + e.message };
    }
    if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(rp.severity)) {
      return { ok: false, error: 'Risk-Pattern ' + rp.id + ': severity muss CRITICAL/HIGH/MEDIUM/LOW sein' };
    }
    if (typeof rp.score !== 'number' || rp.score < 0 || rp.score > 50) {
      return { ok: false, error: 'Risk-Pattern ' + rp.id + ': score muss zwischen 0 und 50 liegen' };
    }
  }

  // Meta aktualisieren
  rules._meta = rules._meta || {};
  rules._meta.updated = new Date().toISOString().split('T')[0];

  try {
    var tmpPath = RULES_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(rules, null, 2), 'utf8');
    fs.renameSync(tmpPath, RULES_PATH);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Speichern fehlgeschlagen: ' + e.message };
  }
}

module.exports = { loadRules, saveRules };
