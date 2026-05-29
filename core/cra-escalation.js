// admin/cra/cra-escalation.js — Eskalations-Management (CommonJS)
// Routing, SLA-Tracking, Email/SMS Channels
var crypto = require('crypto');
var craDb = require('./cra-db');

// ── Eskalations-Routen ──────────────────────────────────────────

var ESCALATION_ROUTES = {
  severity_critical:     { channel: 'sms',   sla_minutes: 15  },
  post_deploy_failure:   { channel: 'sms',   sla_minutes: 15  },
  rollback_triggered:    { channel: 'email', sla_minutes: 60  },
  review_loop_exceeded:  { channel: 'email', sla_minutes: 240 },
  cra_api_unreachable:   { channel: 'email', sla_minutes: 60  },
  session_timeout:       { channel: 'email', sla_minutes: 240 },
  default:               { channel: 'email', sla_minutes: 1440 }
};

// ── Eskalation erstellen ────────────────────────────────────────

function escalate(opts) {
  var triggerType = opts.trigger || 'default';
  var route = ESCALATION_ROUTES[triggerType] || ESCALATION_ROUTES.default;
  var escId = 'ESC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];

  var payload = {
    escalation_id: escId,
    finding_id: opts.finding_id || null,
    session_id: opts.session_id || null,
    trigger: triggerType,
    severity: opts.severity || null,
    context: opts.context || {},
    recommended_action: opts.recommended_action || null,
    timestamp: now
  };

  craDb.run(
    "INSERT INTO escalations (id, finding_id, session_id, trigger_type, severity, channel, sla_minutes, payload_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [escId, opts.finding_id || null, opts.session_id || null, triggerType,
     opts.severity || null, route.channel, route.sla_minutes,
     JSON.stringify(payload), 'open', now]
  );
  craDb.saveCraDb();

  console.log('[CRA/Escalation]', escId, triggerType, '→', route.channel, '(SLA:', route.sla_minutes, 'Min)');

  // Notifications ausschliesslich via Dashboard + Claude Code Output
  // Keine Email/SMS — Admin nutzt CRA Dashboard (/cra → Eskalationen)

  // Hook-Event loggen
  craDb.run(
    'INSERT INTO hook_events (hook_name, event_type, repo_name, rfc_id, details) VALUES (?,?,?,?,?)',
    ['escalation', triggerType, null, opts.finding_id || null, escId + ' → ' + route.channel + ' (SLA ' + route.sla_minutes + 'min)']
  );
  craDb.saveCraDb();

  return { ok: true, escalation_id: escId, channel: route.channel, sla_minutes: route.sla_minutes };
}

// Email/SMS entfernt — Kommunikation nur via Dashboard + Claude Code Output

// ── Eskalation bestätigen ───────────────────────────────────────

function acknowledge(escId) {
  var esc = craDb.get('SELECT * FROM escalations WHERE id = ?', [escId]);
  if (!esc) return { ok: false, error: 'Eskalation nicht gefunden' };
  if (esc.status !== 'open') return { ok: false, error: 'Bereits bestaetigt: ' + esc.status };

  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  craDb.run("UPDATE escalations SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?", [now, escId]);
  craDb.saveCraDb();
  return { ok: true, escalation_id: escId };
}

// ── Alle Eskalationen ───────────────────────────────────────────

function getAll(limit) {
  return craDb.all('SELECT * FROM escalations ORDER BY created_at DESC LIMIT ?', [limit || 50]);
}

// ── Offene Eskalationen ─────────────────────────────────────────

function getOpen() {
  return craDb.all("SELECT * FROM escalations WHERE status = 'open' ORDER BY created_at DESC");
}

// ── Routen abrufen ──────────────────────────────────────────────

function getRoutes() {
  return ESCALATION_ROUTES;
}

module.exports = {
  escalate: escalate,
  acknowledge: acknowledge,
  getAll: getAll,
  getOpen: getOpen,
  getRoutes: getRoutes,
  ESCALATION_ROUTES: ESCALATION_ROUTES
};
