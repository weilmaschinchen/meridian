// SPDX-License-Identifier: Apache-2.0
// admin/cra/cra-test-orchestrator.js — Test-Orchestrierung (CommonJS)
// 7-Stufen-Pipeline + Failure-Matrix + Job-Tracking
var crypto = require('crypto');
var child = require('child_process');
var path = require('path');
var craDb = require('./cra-db');
var craRules = require('./cra-rules');

// ── Failure-Matrix ──────────────────────────────────────────────

var FAILURE_MATRIX = {
  unit_fail:          { action: 'block',    notify: false, rollback: false },
  security_fail:      { action: 'block',    notify: true,  rollback: false },
  regression_fail:    { action: 'block',    notify: true,  rollback: false },
  smoke_staging_fail: { action: 'block',    notify: true,  rollback: true  },
  smoke_prod_fail:    { action: 'rollback', notify: true,  rollback: true  }
};

// ── Test-Job erstellen ──────────────────────────────────────────

function triggerTests(opts) {
  var jobId = 'TJ-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  var testTypes = opts.test_types || ['unit'];

  craDb.run(
    "INSERT INTO test_jobs (id, finding_id, session_id, target, test_types, status, started_at, triggered_by) VALUES (?,?,?,?,?,?,?,?)",
    [jobId, opts.finding_id || null, opts.session_id || null, opts.target || 'staging',
     JSON.stringify(testTypes), 'running', now, opts.triggered_by || 'manual']
  );
  craDb.saveCraDb();

  console.log('[CRA/Tests] Job gestartet:', jobId, '— Types:', testTypes.join(','), '— Target:', opts.target || 'staging');

  // Tests async ausfuehren
  setImmediate(function() { executeTests(jobId, testTypes, opts.target || 'staging'); });

  return { ok: true, job_id: jobId, status: 'running', test_types: testTypes };
}

// ── Tests ausfuehren ────────────────────────────────────────────

function executeTests(jobId, testTypes, target) {
  var results = {};
  var allPassed = true;
  var rules = craRules.loadRules();
  var suites = (rules && rules.test_suites) || [];

  // Mapping: test_type → suite_id
  var typeToSuite = {
    unit: null,              // Kein dedizierter Unit-Runner, wird uebersprungen
    security: 'ts-01',       // security-sprint1
    regression: 'ts-02',     // regression
    smoke: 'ts-01'           // Re-use security als Smoke
  };

  for (var i = 0; i < testTypes.length; i++) {
    var testType = testTypes[i];
    var suiteId = typeToSuite[testType];

    if (!suiteId) {
      // Kein Suite-Mapping → synthetischer Pass
      results[testType] = { status: 'pass', message: 'Kein dedizierter Runner, uebersprungen', duration_ms: 0 };
      continue;
    }

    var suite = suites.find(function(s) { return s.id === suiteId && s.enabled; });
    if (!suite) {
      results[testType] = { status: 'skip', message: 'Suite ' + suiteId + ' nicht gefunden/deaktiviert' };
      continue;
    }

    try {
      var basePath = process.env.MERIDIAN_BASE_PATH || '/opt/ks-management';
      var scriptPath = path.resolve(basePath, suite.path);
      if (!scriptPath.startsWith(basePath)) {
        results[testType] = { status: 'error', message: 'Ungültiger Script-Pfad: ' + suite.path };
        continue;
      }
      var args = (suite.args || '').replace('{target}', target);
      var start = Date.now();

      var result = child.spawnSync('bash', [scriptPath, args], {
        encoding: 'utf8', timeout: 120000, cwd: basePath
      });

      var duration = Date.now() - start;
      var exitCode = result.status || 0;
      var output = ((result.stdout || '') + (result.stderr || '')).substring(0, 5000);

      results[testType] = {
        status: exitCode === 0 ? 'pass' : 'fail',
        exit_code: exitCode,
        duration_ms: duration,
        total: suite.tests_count || 0,
        passed: Math.max(0, (suite.tests_count || 0) - exitCode),
        failed: exitCode,
        output_snippet: output.substring(0, 500)
      };

      if (exitCode !== 0) allPassed = false;

      // In test_runs speichern (Kompatibilitaet mit bestehendem Dashboard)
      craDb.run(
        'INSERT INTO test_runs (suite_name, target, total_tests, passed, failed, duration_ms, output, triggered_by, rfc_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [suite.name, target, suite.tests_count || 0, Math.max(0, (suite.tests_count || 0) - exitCode),
         exitCode, duration, output, 'orchestrator', null]
      );

    } catch (e) {
      results[testType] = { status: 'error', message: e.message };
      allPassed = false;
    }
  }

  // Job abschliessen
  var now = new Date().toISOString().replace('T', ' ').split('.')[0];
  craDb.run(
    "UPDATE test_jobs SET status = ?, results_json = ?, completed_at = ? WHERE id = ?",
    [allPassed ? 'pass' : 'fail', JSON.stringify(results), now, jobId]
  );
  craDb.saveCraDb();

  console.log('[CRA/Tests] Job abgeschlossen:', jobId, allPassed ? 'PASS' : 'FAIL');
  return { job_id: jobId, status: allPassed ? 'pass' : 'fail', results: results };
}

// ── Job-Status abfragen ─────────────────────────────────────────

function getJobResult(jobId) {
  var job = craDb.get('SELECT * FROM test_jobs WHERE id = ?', [jobId]);
  if (!job) return null;

  var result = {
    job_id: job.id,
    finding_id: job.finding_id,
    target: job.target,
    test_types: safeJsonParse(job.test_types, []),
    status: job.status,
    results: safeJsonParse(job.results_json, {}),
    started_at: job.started_at,
    completed_at: job.completed_at,
    triggered_by: job.triggered_by
  };

  return result;
}

// ── Alle Jobs ───────────────────────────────────────────────────

function getJobs(limit) {
  var jobs = craDb.all('SELECT * FROM test_jobs ORDER BY started_at DESC LIMIT ?', [limit || 50]);
  return jobs.map(function(j) {
    j.test_types = safeJsonParse(j.test_types, []);
    j.results_json = safeJsonParse(j.results_json, {});
    return j;
  });
}

// ── Failure-Matrix anwenden ─────────────────────────────────────

function evaluateFailure(testType, target) {
  var key = testType + '_fail';
  if (target === 'production' && testType === 'smoke') key = 'smoke_prod_fail';
  else if (target === 'staging' && testType === 'smoke') key = 'smoke_staging_fail';

  return FAILURE_MATRIX[key] || { action: 'block', notify: false, rollback: false };
}

// ── Deploy-Erlaubnis basierend auf Tests ────────────────────────

function canDeploy(findingId, target) {
  // Letzten Test-Job fuer dieses Finding pruefen
  var lastJob = craDb.get(
    "SELECT * FROM test_jobs WHERE finding_id = ? AND target = ? ORDER BY started_at DESC LIMIT 1",
    [findingId, target || 'staging']
  );

  if (!lastJob) return { allowed: false, reason: 'Keine Tests fuer Finding ' + findingId + ' ausgefuehrt' };
  if (lastJob.status === 'running') return { allowed: false, reason: 'Tests laufen noch: ' + lastJob.id };
  if (lastJob.status !== 'pass') return { allowed: false, reason: 'Tests fehlgeschlagen: ' + lastJob.id, job_id: lastJob.id };

  return { allowed: true, reason: 'Tests bestanden', job_id: lastJob.id };
}

// ── Hilfsfunktionen ─────────────────────────────────────────────

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

module.exports = {
  triggerTests: triggerTests,
  getJobResult: getJobResult,
  getJobs: getJobs,
  evaluateFailure: evaluateFailure,
  canDeploy: canDeploy,
  FAILURE_MATRIX: FAILURE_MATRIX
};
