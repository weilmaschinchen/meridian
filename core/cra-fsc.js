// SPDX-License-Identifier: Apache-2.0
// admin/cra/cra-fsc.js — Forward Schedule of Change Manager (CommonJS)
var craDb = require('./cra-db');

// ── ID-Generierung ──────────────────────────────────────────────
function generateFscId() {
  var now = new Date();
  var date = now.toISOString().split('T')[0];
  var seq = craDb.get(
    "SELECT COUNT(*) as c FROM fsc_windows WHERE id LIKE ?",
    ['FSC-' + date + '%']
  );
  var num = ((seq && seq.c) || 0) + 1;
  return 'FSC-' + date + '-' + String(num).padStart(3, '0');
}

// ── Aktuelles aktives Fenster ───────────────────────────────────
function getCurrent() {
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  var win = craDb.get(
    "SELECT * FROM fsc_windows WHERE status = 'active' AND starts_at <= ? AND ends_at > ? ORDER BY starts_at ASC LIMIT 1",
    [now, now]
  );
  if (win) {
    win.allowed_targets = safeJsonParse(win.allowed_targets, ['staging']);
    win.allowed_severities = safeJsonParse(win.allowed_severities, ['critical', 'high', 'medium']);
  }
  return win || null;
}

// ── Alle Fenster (optional gefiltert) ───────────────────────────
function getAll(opts) {
  opts = opts || {};
  var sql = 'SELECT * FROM fsc_windows';
  var params = [];
  var where = [];

  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.from) {
    where.push('ends_at >= ?');
    params.push(opts.from);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY starts_at DESC';
  if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  var rows = craDb.all(sql, params);
  rows.forEach(function(r) {
    r.allowed_targets = safeJsonParse(r.allowed_targets, ['staging']);
    r.allowed_severities = safeJsonParse(r.allowed_severities, ['critical', 'high', 'medium']);
  });
  return rows;
}

// ── Fenster erstellen ───────────────────────────────────────────
function create(data) {
  var err = validate(data);
  if (err) return { ok: false, error: err };

  var id = generateFscId();
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Automatische Status-Bestimmung
  var status = determineStatus(data.starts_at, data.ends_at);

  craDb.run(
    "INSERT INTO fsc_windows (id, type, starts_at, ends_at, allowed_targets, allowed_severities, max_findings, rollback_window_min, created_by, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [id, data.type || 'standard', data.starts_at, data.ends_at,
     JSON.stringify(data.allowed_targets || ['staging']),
     JSON.stringify(data.allowed_severities || ['critical', 'high', 'medium']),
     data.max_findings || 5, data.rollback_window_min || 30,
     data.created_by || 'admin', status, data.notes || null, now, now]
  );
  craDb.saveCraDb();
  console.log('[CRA/FSC] Fenster erstellt:', id, data.type, data.starts_at, '→', data.ends_at);
  return { ok: true, id: id, status: status };
}

// ── Fenster aktualisieren ───────────────────────────────────────
function update(id, data) {
  var existing = craDb.get('SELECT * FROM fsc_windows WHERE id = ?', [id]);
  if (!existing) return { ok: false, error: 'Fenster nicht gefunden: ' + id };

  // Geschlossene/abgebrochene Fenster nicht editieren
  if (existing.status === 'closed' || existing.status === 'cancelled') {
    return { ok: false, error: 'Fenster im Status ' + existing.status + ' kann nicht bearbeitet werden' };
  }

  var err = validate(data, true);
  if (err) return { ok: false, error: err };

  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  var sets = [];
  var params = [];

  if (data.type) { sets.push('type = ?'); params.push(data.type); }
  if (data.starts_at) { sets.push('starts_at = ?'); params.push(data.starts_at); }
  if (data.ends_at) { sets.push('ends_at = ?'); params.push(data.ends_at); }
  if (data.allowed_targets) { sets.push('allowed_targets = ?'); params.push(JSON.stringify(data.allowed_targets)); }
  if (data.allowed_severities) { sets.push('allowed_severities = ?'); params.push(JSON.stringify(data.allowed_severities)); }
  if (data.max_findings !== undefined) { sets.push('max_findings = ?'); params.push(data.max_findings); }
  if (data.rollback_window_min !== undefined) { sets.push('rollback_window_min = ?'); params.push(data.rollback_window_min); }
  if (data.status) { sets.push('status = ?'); params.push(data.status); }
  if (data.notes !== undefined) { sets.push('notes = ?'); params.push(data.notes); }

  if (sets.length === 0) return { ok: false, error: 'Keine Felder zum Aktualisieren' };

  sets.push('updated_at = ?');
  params.push(now);
  params.push(id);

  craDb.run('UPDATE fsc_windows SET ' + sets.join(', ') + ' WHERE id = ?', params);
  craDb.saveCraDb();
  console.log('[CRA/FSC] Fenster aktualisiert:', id);
  return { ok: true, id: id };
}

// ── Fenster abbrechen ───────────────────────────────────────────
function cancel(id) {
  var existing = craDb.get('SELECT * FROM fsc_windows WHERE id = ?', [id]);
  if (!existing) return { ok: false, error: 'Fenster nicht gefunden' };
  if (existing.status === 'closed' || existing.status === 'cancelled') {
    return { ok: false, error: 'Fenster bereits ' + existing.status };
  }

  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  craDb.run("UPDATE fsc_windows SET status = 'cancelled', updated_at = ? WHERE id = ?", [now, id]);
  craDb.saveCraDb();
  console.log('[CRA/FSC] Fenster abgebrochen:', id);
  return { ok: true };
}

// ── Status-Monitoring (wird regelmaessig aufgerufen) ────────────
function refreshStatuses() {
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  var changed = 0;

  // Scheduled → Active (Fenster hat begonnen)
  var toActivate = craDb.all(
    "SELECT id FROM fsc_windows WHERE status = 'scheduled' AND starts_at <= ? AND ends_at > ?",
    [now, now]
  );
  toActivate.forEach(function(w) {
    craDb.run("UPDATE fsc_windows SET status = 'active', updated_at = ? WHERE id = ?", [now, w.id]);
    console.log('[CRA/FSC] Fenster aktiviert:', w.id);
    changed++;
  });

  // Active → Closed (Fenster ist abgelaufen)
  var toClose = craDb.all(
    "SELECT id FROM fsc_windows WHERE status = 'active' AND ends_at <= ?",
    [now]
  );
  toClose.forEach(function(w) {
    craDb.run("UPDATE fsc_windows SET status = 'closed', updated_at = ? WHERE id = ?", [now, w.id]);
    console.log('[CRA/FSC] Fenster geschlossen:', w.id);
    changed++;
  });

  if (changed) craDb.saveCraDb();
  return changed;
}

// ── Regelpruefungen ─────────────────────────────────────────────

// Pruefen ob Deploy in aktuellem Fenster erlaubt ist
function canDeploy(target, severity) {
  // Test-Mode: nur Staging erlaubt
  var rules = craRules.loadRules();
  var autoFsc = rules && rules.auto_fsc;
  var testMode = autoFsc && autoFsc.test_mode;
  if (testMode && target !== 'staging') {
    return { allowed: false, reason: 'TEST-MODE aktiv: nur Staging-Deploys erlaubt', window: null, test_mode: true };
  }

  // Enforce-Window: Deploy nur innerhalb CET-Fenster
  if (autoFsc && autoFsc.enforce_window && target !== 'staging') {
    var tz2 = autoFsc.timezone || 'Europe/Berlin';
    var cetNow2 = new Date().toLocaleString('en-GB', { timeZone: tz2, hour12: false });
    var cetTP2 = cetNow2.split(', ')[1].split(':');
    var cetMin2 = parseInt(cetTP2[0]) * 60 + parseInt(cetTP2[1]);
    var ew2Start = (autoFsc.enforce_window.start_hour || 23) * 60 + (autoFsc.enforce_window.start_minute || 30);
    var ew2End = (autoFsc.enforce_window.end_hour || 4) * 60 + (autoFsc.enforce_window.end_minute || 30);
    var inWin2 = ew2Start > ew2End ? (cetMin2 >= ew2Start || cetMin2 < ew2End) : (cetMin2 >= ew2Start && cetMin2 < ew2End);
    if (!inWin2) {
      return { allowed: false, reason: 'Prod-Deploy nur zwischen ' + autoFsc.enforce_window.start_hour + ':' + String(autoFsc.enforce_window.start_minute).padStart(2,'0') + ' und ' + autoFsc.enforce_window.end_hour + ':' + String(autoFsc.enforce_window.end_minute).padStart(2,'0') + ' CET erlaubt' };
    }
  }

  var win = getCurrent();
  if (!win) return { allowed: false, reason: 'Kein aktives FSC-Fenster', window: null };

  // Target erlaubt?
  if (win.allowed_targets.indexOf(target) < 0) {
    return { allowed: false, reason: 'Target "' + target + '" nicht im aktuellen Fenster erlaubt', window: win };
  }

  // Severity erlaubt?
  if (severity && win.allowed_severities.indexOf(severity) < 0) {
    return { allowed: false, reason: 'Severity "' + severity + '" nicht im aktuellen Fenster erlaubt', window: win };
  }

  // Letzte Stunde? Kein neuer Deploy starten
  var endsAt = new Date(win.ends_at.replace(' ', 'T') + 'Z');
  var now = new Date();
  var remainingMin = (endsAt - now) / 60000;
  if (remainingMin < 60) {
    return { allowed: false, reason: 'Weniger als 60 Minuten im Fenster verbleibend (' + Math.round(remainingMin) + ' Min). Kein neuer Deploy.', window: win };
  }

  // Max Findings pro Fenster
  // Emergency-Fenster: max 1
  if (win.type === 'emergency') {
    var deployedInWindow = craDb.get(
      "SELECT COUNT(*) as c FROM hook_events WHERE event_type = 'deploy-prod' AND created_at >= ? AND created_at <= ?",
      [win.starts_at, win.ends_at]
    );
    if (deployedInWindow && deployedInWindow.c >= 1) {
      return { allowed: false, reason: 'Emergency-Fenster: maximal 1 Deploy, bereits ' + deployedInWindow.c + ' ausgefuehrt', window: win };
    }
  }

  return { allowed: true, reason: 'FSC-Fenster aktiv', window: win, remaining_min: Math.round(remainingMin) };
}

// Naechstes geplanenes Fenster
function getNext() {
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  var win = craDb.get(
    "SELECT * FROM fsc_windows WHERE status = 'scheduled' AND starts_at > ? ORDER BY starts_at ASC LIMIT 1",
    [now]
  );
  if (win) {
    win.allowed_targets = safeJsonParse(win.allowed_targets, ['staging']);
    win.allowed_severities = safeJsonParse(win.allowed_severities, ['critical', 'high', 'medium']);
  }
  return win || null;
}

// ── Hilfsfunktionen ─────────────────────────────────────────────

function validate(data, partial) {
  if (!partial) {
    if (!data.starts_at) return 'starts_at ist Pflicht';
    if (!data.ends_at) return 'ends_at ist Pflicht';
  }

  if (data.starts_at && data.ends_at) {
    var s = new Date(data.starts_at);
    var e = new Date(data.ends_at);
    if (isNaN(s.getTime())) return 'starts_at ist kein gueltiges Datum';
    if (isNaN(e.getTime())) return 'ends_at ist kein gueltiges Datum';
    if (e <= s) return 'ends_at muss nach starts_at liegen';
  }

  var validTypes = ['standard', 'emergency', 'maintenance'];
  if (data.type && validTypes.indexOf(data.type) < 0) {
    return 'type muss standard, emergency oder maintenance sein';
  }

  if (data.type === 'emergency' && data.max_findings && data.max_findings > 1) {
    return 'Emergency-Fenster: max_findings darf nicht groesser als 1 sein';
  }

  if (data.max_findings !== undefined && (data.max_findings < 1 || data.max_findings > 20)) {
    return 'max_findings muss zwischen 1 und 20 liegen';
  }

  if (data.rollback_window_min !== undefined && (data.rollback_window_min < 10 || data.rollback_window_min > 120)) {
    return 'rollback_window_min muss zwischen 10 und 120 liegen';
  }

  return null;
}

function determineStatus(startsAt, endsAt) {
  var now = new Date();
  var s = new Date(startsAt);
  var e = new Date(endsAt);
  if (now >= s && now < e) return 'active';
  if (now >= e) return 'closed';
  return 'scheduled';
}

// ── Auto-FSC: Fenster automatisch aus Schedules generieren ─────

var craRules = require('./cra-rules');

function autoGenerate() {
  var rules = craRules.loadRules();
  var config = rules && rules.auto_fsc;
  if (!config || !config.enabled) return { generated: false, reason: 'Auto-FSC deaktiviert' };

  // Enforce-Window: nur innerhalb erlaubter CET-Stunden
  var tz = config.timezone || 'Europe/Berlin';
  var cetNow = new Date().toLocaleString('en-GB', { timeZone: tz, hour12: false });
  var cetTimeParts = cetNow.split(', ')[1].split(':');
  var cetHourNow = parseInt(cetTimeParts[0]);
  var cetMinNow = parseInt(cetTimeParts[1]);
  var cetMinTotal = cetHourNow * 60 + cetMinNow;

  if (config.enforce_window) {
    var ewStart = (config.enforce_window.start_hour || 23) * 60 + (config.enforce_window.start_minute || 30);
    var ewEnd = (config.enforce_window.end_hour || 4) * 60 + (config.enforce_window.end_minute || 30);
    // Nacht-Fenster: start > end (z.B. 23:30 bis 04:30)
    var inWindow = ewStart > ewEnd
      ? (cetMinTotal >= ewStart || cetMinTotal < ewEnd)
      : (cetMinTotal >= ewStart && cetMinTotal < ewEnd);
    if (!inWindow) {
      return { generated: false, reason: 'Ausserhalb Enforce-Window (' + config.enforce_window.start_hour + ':' + String(config.enforce_window.start_minute).padStart(2,'0') + '-' + config.enforce_window.end_hour + ':' + String(config.enforce_window.end_minute).padStart(2,'0') + ' CET). Aktuell: ' + cetHourNow + ':' + String(cetMinNow).padStart(2,'0') };
    }
  }

  // Test-Mode: nur Staging-Targets erlaubt
  var testMode = config.test_mode || false;

  // Bereits aktives oder geplantes Fenster?
  var current = getCurrent();
  if (current) return { generated: false, reason: 'Aktives Fenster: ' + current.id };
  var next = getNext();
  if (next) return { generated: false, reason: 'Geplantes Fenster: ' + next.id };

  // Backlog pruefen (differenziert nach Severity)
  var backlogThreshold = config.backlog_threshold || 10;
  var openFindings = craDb.get("SELECT COUNT(*) as c FROM findings WHERE status = 'open'");
  var criticalFindings = craDb.get("SELECT COUNT(*) as c FROM findings WHERE status = 'open' AND (severity = 'CRITICAL' OR severity = 'HIGH')");
  var backlog = (openFindings && openFindings.c) || 0;
  var criticalBacklog = (criticalFindings && criticalFindings.c) || 0;
  // Critical/High Findings: Threshold 1 (sofortiges Fenster)
  // Normal Findings: Standard-Threshold
  if (criticalBacklog === 0 && backlog < backlogThreshold) {
    return { generated: false, reason: 'Backlog (' + backlog + ') unter Threshold (' + backlogThreshold + '), 0 Critical/High' };
  }
  if (criticalBacklog > 0) {
    console.log('[CRA/FSC] Critical/High Backlog: ' + criticalBacklog + ' — Fenster wird generiert');
  }

  // CET/CEST Zeit bestimmen
  var tz = config.timezone || 'Europe/Berlin';
  var now = new Date();
  var cetStr = now.toLocaleString('en-GB', { timeZone: tz, hour12: false });
  // Format: DD/MM/YYYY, HH:MM:SS
  var parts = cetStr.split(', ');
  var dateParts = parts[0].split('/');
  var timeParts = parts[1].split(':');
  var cetHour = parseInt(timeParts[0]);
  var cetDay = now.getDay(); // 0=So, 1=Mo, ...

  // Passenden Schedule finden
  var schedules = (config.schedules || []).filter(function(s) { return s.enabled; });
  var bestSchedule = null;
  var bestStartsAt = null;
  var bestEndsAt = null;

  for (var i = 0; i < schedules.length; i++) {
    var sched = schedules[i];
    if (!sched.days || sched.days.indexOf(cetDay) < 0) continue;

    // Naechsten Start-Zeitpunkt in CET berechnen
    var startHour = sched.start_hour || 22;
    var startMin = sched.start_minute || 0;
    var durationH = sched.duration_hours || 4;

    // Heute oder naechster passender Tag?
    var startDate = new Date(now);
    if (cetHour >= startHour + durationH) continue; // Fenster heute schon vorbei
    if (cetHour < startHour) {
      // Heute, aber Startzeit liegt noch in der Zukunft
    } else if (cetHour >= startHour && cetHour < startHour + durationH) {
      // Jetzt gerade im Fenster — sofort starten
    }

    // CET-Zeitstempel bauen (ISO fuer DB)
    // Verwende Date mit explizitem Offset
    var cetYear = parseInt(dateParts[2]);
    var cetMonth = parseInt(dateParts[1]) - 1;
    var cetDayNum = parseInt(dateParts[0]);

    // Start: heute um startHour:startMin CET
    var startLocal = new Date(cetYear, cetMonth, cetDayNum, startHour, startMin, 0);
    // Korrektur: toLocaleString gibt lokale Zeit, wir brauchen UTC
    var startUtcStr = localCetToUtc(cetYear, cetMonth, cetDayNum, startHour, startMin, tz);
    var endUtcStr = localCetToUtc(cetYear, cetMonth, cetDayNum, startHour + durationH, startMin, tz);

    if (!bestSchedule) {
      bestSchedule = sched;
      bestStartsAt = startUtcStr;
      bestEndsAt = endUtcStr;
    }
  }

  if (!bestSchedule) {
    return { generated: false, reason: 'Kein passender Schedule fuer heute (CET Tag ' + cetDay + ', Stunde ' + cetHour + ')' };
  }

  // Test-Mode: Targets auf Staging beschraenken
  var targets = bestSchedule.allowed_targets || ['staging'];
  if (testMode) {
    targets = targets.filter(function(t) { return t === 'staging'; });
    if (targets.length === 0) targets = ['staging'];
  }

  var windowType = bestSchedule.type || 'standard';
  var result = create({
    type: windowType,
    starts_at: bestStartsAt,
    ends_at: bestEndsAt,
    allowed_targets: targets,
    allowed_severities: bestSchedule.allowed_severities || ['critical', 'high', 'medium'],
    max_findings: Math.min(backlog, bestSchedule.max_findings || 5),
    created_by: 'auto-fsc',
    notes: 'Auto: ' + bestSchedule.name + (testMode ? ' [TEST-MODE]' : '') + ' — Backlog ' + backlog
  });

  if (result.ok) {
    console.log('[CRA/FSC] Auto-Fenster:', result.id, bestSchedule.name, bestStartsAt, '→', bestEndsAt, testMode ? '[TEST-MODE]' : '');
    craDb.run(
      'INSERT INTO hook_events (hook_name, event_type, details) VALUES (?,?,?)',
      ['auto-fsc', 'window-generated', result.id + ' — ' + bestSchedule.name + ' — Backlog: ' + backlog + (testMode ? ' [TEST-MODE]' : '')]
    );
    craDb.saveCraDb();
  }

  return { generated: result.ok, id: result.id, schedule: bestSchedule.name, backlog: backlog, test_mode: testMode, window: bestStartsAt + ' → ' + bestEndsAt };
}

// CET/CEST Ortszeit → UTC String (YYYY-MM-DD HH:MM:SS)
function localCetToUtc(year, month, day, hour, minute, tz) {
  // Erzeuge ein Datum in der Zielzone und konvertiere zu UTC
  // Trick: Erstelle UTC-Datum, pruefe Offset, korrigiere
  var guess = new Date(Date.UTC(year, month, day, hour, minute, 0));
  var cetCheck = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
  var utcCheck = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  var offsetMs = utcCheck - cetCheck;
  var corrected = new Date(guess.getTime() + offsetMs);
  return corrected.toISOString().replace('T', ' ').split('.')[0];
}

// Auto-FSC Config abrufen (fuer API/Dashboard)
function getAutoFscConfig() {
  var rules = craRules.loadRules();
  return (rules && rules.auto_fsc) || { enabled: false, schedules: [] };
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

module.exports = {
  getCurrent: getCurrent,
  getNext: getNext,
  getAll: getAll,
  create: create,
  update: update,
  cancel: cancel,
  canDeploy: canDeploy,
  refreshStatuses: refreshStatuses,
  autoGenerate: autoGenerate,
  getAutoFscConfig: getAutoFscConfig
};
