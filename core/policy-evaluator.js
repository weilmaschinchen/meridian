// SPDX-License-Identifier: Apache-2.0
// meridian/core/policy-evaluator.js — built-in Gate-4-Evaluator (OSS).
//
// Konsumiert den input-JSON-Contract v1.0 (enterprise/policy-engine/input-contract.md).
// Parität-Baseline: dieselben Regeln die OPA/Rego im Enterprise-Modus ausführt.
// Konfiguration über cra-rules.json §policy (optional; Defaults greifen wenn fehlt).
//
// Verwendung:
//   var evaluator = require('./policy-evaluator');
//   var result = evaluator.evaluate(input, config);
//   // result: { allow, decision, violations, reason }
'use strict';

var SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
var BLAST_RANK    = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

// evaluate() — wertet den input-Contract gegen die konfigurierten Regeln aus.
// input:  Objekt nach input-contract.md v1.0
// config: optionaler Policy-Abschnitt aus cra-rules.json (oder {})
// returns: { allow: bool, decision: 'APPROVED'|'BLOCKED', violations: string[], reason: string }
function evaluate(input, config) {
  var cfg = config || {};
  var violations = [];

  var approverCount  = Array.isArray(input.approvers) ? input.approvers.length : 0;
  var severityRank   = SEVERITY_RANK[input.severity]  || 0;
  var blastRank      = BLAST_RANK[input.blast_radius] || 0;
  var minApprovers   = cfg.min_approvers_default || 1;
  var minApproversCritical = cfg.min_approvers_critical || 2;
  var criticalThreshold    = SEVERITY_RANK[cfg.four_eyes_severity_threshold || 'CRITICAL'] || 4;
  var blastThreshold       = BLAST_RANK[cfg.four_eyes_blast_threshold || 'HIGH'] || 3;

  // Regel: four_eyes_critical — CRITICAL-Severity verlangt Vier-Augen
  if (severityRank >= criticalThreshold && approverCount < minApproversCritical) {
    violations.push('four_eyes_critical');
  }

  // Regel: four_eyes_kritis — KRITIS-Flag verlangt Vier-Augen
  if (input.kritis_flag && approverCount < minApproversCritical) {
    violations.push('four_eyes_kritis');
  }

  // Regel: four_eyes_blast — Hoher Blast-Radius verlangt Vier-Augen
  if (blastRank >= blastThreshold && approverCount < minApproversCritical) {
    violations.push('four_eyes_blast');
  }

  // Regel: change_window — außerhalb Change-Window ohne Emergency-Override
  if (!input.change_window_active && !input.emergency_override_ok) {
    violations.push('change_window');
  }

  // Regel: emergency_approval — Emergency-Change braucht mindestens einen Approver
  if (input.change_type === 'emergency' && approverCount < minApprovers) {
    violations.push('emergency_approval');
  }

  var allow    = violations.length === 0;
  var decision = allow ? 'APPROVED' : 'BLOCKED';
  var reason   = allow
    ? 'All policy rules passed'
    : 'Policy violations: ' + violations.join(', ');

  return { allow: allow, decision: decision, violations: violations, reason: reason };
}

// buildInput() — baut input-Objekt aus bestehendem CRA-Analyse-Ergebnis.
// Hilfsfunktion für die spätere Gate-4-Integration in cra-analyzer.js (E2).
function buildInput(rfcOpts, analysisResult, rulesConfig) {
  var rc = rulesConfig || {};
  var kritisRepos = rc.kritis_repos || [];
  var repo = rfcOpts.repoName || '';

  // B2: CMDB-Werte direkt über rfcOpts durchreichen (E6-Integration)
  var blastRadius  = rfcOpts.blast_radius !== undefined ? rfcOpts.blast_radius : 'LOW';
  var kritisFlag   = rfcOpts.kritis_flag  !== undefined ? rfcOpts.kritis_flag
                   : kritisRepos.some(function(r) { return r === repo; });

  return {
    change_id:            rfcOpts.rfcId || '',
    repo:                 repo,
    branch:               rfcOpts.branch || 'main',
    domain:               rfcOpts.domain || 'devops',
    change_type:          rfcOpts.change_type || 'standard',
    severity:             analysisResult.riskLevel || 'LOW',
    risk_score:           analysisResult.riskScore || 0,
    approvers:            rfcOpts.approvers || [],
    change_window_active: isChangeWindowActive(rc.change_windows || []),
    emergency_override_ok: !!rfcOpts.emergency_override_ok,
    kritis_flag:          kritisFlag,
    blast_radius:         blastRadius
  };
}

// isChangeWindowActive() — Q3: vollständige Cron-Auswertung.
// windows: Array von { cron_start, duration_h, applies_to? }
// Gibt true zurück wenn: (a) kein Window konfiguriert ODER (b) now in aktivem Window liegt.
// Gibt false zurück wenn Windows konfiguriert sind und now in KEINEM liegt.
function isChangeWindowActive(windows) {
  if (!windows || windows.length === 0) return true;
  var now = new Date();
  return windows.some(function(w) { return _isWithinWindow(w, now); });
}

// _isWithinWindow — prüft ob `now` in einem einzelnen Change-Window liegt.
// window.cron_start: Cron-Ausdruck (5 Felder: min hour dom month dow)
// window.duration_h: Dauer in Stunden
function _isWithinWindow(window, now) {
  var durationMs = (window.duration_h || 1) * 3600 * 1000;
  var lastStart  = _lastCronOccurrence(window.cron_start, now);
  if (!lastStart) return false;
  return now.getTime() - lastStart.getTime() <= durationMs;
}

// _parseCronPart — parst ein Cron-Feld in Array von Werten oder null (=wildcard).
function _parseCronPart(part) {
  if (part === '*') return null;
  if (/^\d+$/.test(part)) return [parseInt(part, 10)];
  if (/^\d+-\d+$/.test(part)) {
    var r = part.split('-').map(Number), vals = [];
    for (var i = r[0]; i <= r[1]; i++) vals.push(i);
    return vals;
  }
  if (/^(\d+,)+\d+$/.test(part)) return part.split(',').map(Number);
  return null;
}

function _matches(val, parsed) { return parsed === null || parsed.indexOf(val) !== -1; }

// _lastCronOccurrence — findet letzten Auslösezeitpunkt vor `now` (max. 7 Tage zurück).
function _lastCronOccurrence(cronExpr, now) {
  if (!cronExpr) return null;
  var parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  var cMin = _parseCronPart(parts[0]);
  var cHr  = _parseCronPart(parts[1]);
  var cDom = _parseCronPart(parts[2]);
  var cMon = _parseCronPart(parts[3]);
  var cDow = _parseCronPart(parts[4]);

  // Suche rückwärts in 1-Minuten-Schritten (max. 7 Tage = 10080 Minuten)
  var candidate = new Date(now.getTime());
  candidate.setSeconds(0, 0);
  for (var i = 0; i < 10080; i++) {
    if (_matches(candidate.getUTCMinutes(), cMin) &&
        _matches(candidate.getUTCHours(),   cHr)  &&
        _matches(candidate.getUTCDate(),    cDom) &&
        _matches(candidate.getUTCMonth() + 1, cMon) &&
        _matches(candidate.getUTCDay(),     cDow)) {
      return new Date(candidate.getTime());
    }
    candidate.setTime(candidate.getTime() - 60000);
  }
  return null;
}

module.exports = { evaluate: evaluate, buildInput: buildInput,
                   isChangeWindowActive: isChangeWindowActive, _lastCronOccurrence: _lastCronOccurrence };
