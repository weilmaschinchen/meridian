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
    kritis_flag:          kritisRepos.some(function(r) { return r === repo; }),
    blast_radius:         rfcOpts.blast_radius || 'LOW'
  };
}

// isChangeWindowActive() — prüft ob aktueller Zeitpunkt in einem Change-Window liegt.
// windows: Array von { cron_start, duration_h } (aus cra-rules.json)
// Gibt true zurück wenn kein Window konfiguriert (fail-open: kein Window = immer aktiv).
function isChangeWindowActive(windows) {
  if (!windows || windows.length === 0) return true;
  // Vereinfachte Implementierung für E1: Windows noch nicht ausgewertet → fail-open.
  // Vollständige Cron-Auswertung kommt mit E3 (itil-change Change-Window-Engine).
  return true;
}

module.exports = { evaluate: evaluate, buildInput: buildInput, isChangeWindowActive: isChangeWindowActive };
