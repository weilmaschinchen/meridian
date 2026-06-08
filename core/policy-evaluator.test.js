// SPDX-License-Identifier: Apache-2.0
// policy-evaluator.test.js — tests for meridian/core/policy-evaluator.js
// Run: node --test meridian/core/policy-evaluator.test.js
'use strict';

var assert   = require('assert').strict;
var test     = require('node:test');
var path     = require('path');
var fs       = require('fs');
var evaluate = require('./policy-evaluator').evaluate;

// ── Fixtures laden ────────────────────────────────────────────────────────
var FIXTURES_DIR = path.join(__dirname, '../../enterprise/policy-engine/fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

// ── Fixture-basierte Tests ────────────────────────────────────────────────

test('APPROVED: standard low-risk change im Change-Window', function() {
  var f = loadFixture('approved-standard.json');
  var r = evaluate(f, {});
  assert.equal(r.decision, f._expect.decision);
  assert.deepEqual(r.violations, f._expect.violations);
  assert.ok(r.allow);
});

test('BLOCKED: CRITICAL-Change mit nur einem Approver (NIS-2 four_eyes_critical)', function() {
  var f = loadFixture('blocked-critical-single-approver.json');
  var r = evaluate(f, {});
  assert.equal(r.decision, f._expect.decision);
  assert.ok(r.violations.includes('four_eyes_critical'));
  assert.ok(!r.allow);
});

test('BLOCKED: Normal-Change außerhalb Change-Window ohne Emergency-Override', function() {
  var f = loadFixture('blocked-outside-change-window.json');
  var r = evaluate(f, {});
  assert.equal(r.decision, f._expect.decision);
  assert.ok(r.violations.includes('change_window'));
  assert.ok(!r.allow);
});

test('BLOCKED: KRITIS-Flag + hoher Blast-Radius mit einem Approver', function() {
  var f = loadFixture('blocked-kritis-single-approver.json');
  var r = evaluate(f, {});
  assert.equal(r.decision, f._expect.decision);
  assert.ok(r.violations.includes('four_eyes_kritis'));
  assert.ok(r.violations.includes('four_eyes_blast'));
  assert.ok(!r.allow);
});

test('APPROVED: Emergency-Override erlaubt Change außerhalb Window', function() {
  var f = loadFixture('approved-emergency-override.json');
  var r = evaluate(f, {});
  assert.equal(r.decision, f._expect.decision);
  assert.deepEqual(r.violations, f._expect.violations);
  assert.ok(r.allow);
});

// ── Unit-Tests der Einzel-Regeln ──────────────────────────────────────────

test('four_eyes_critical: zwei Approver reichen', function() {
  var r = evaluate({
    severity: 'CRITICAL', approvers: ['a', 'b'],
    kritis_flag: false, blast_radius: 'LOW',
    change_window_active: true, emergency_override_ok: false,
    change_type: 'standard'
  }, {});
  assert.ok(!r.violations.includes('four_eyes_critical'));
});

test('four_eyes_critical: kein Approver wird BLOCKED', function() {
  var r = evaluate({
    severity: 'CRITICAL', approvers: [],
    kritis_flag: false, blast_radius: 'LOW',
    change_window_active: true, emergency_override_ok: false,
    change_type: 'standard'
  }, {});
  assert.ok(r.violations.includes('four_eyes_critical'));
});

test('HIGH-Severity braucht standardmäßig keinen zweiten Approver', function() {
  var r = evaluate({
    severity: 'HIGH', approvers: ['a'],
    kritis_flag: false, blast_radius: 'LOW',
    change_window_active: true, emergency_override_ok: false,
    change_type: 'standard'
  }, {});
  assert.equal(r.decision, 'APPROVED');
});

test('Konfig: four_eyes_severity_threshold=HIGH zieht Vier-Augen-Pflicht vor', function() {
  var r = evaluate({
    severity: 'HIGH', approvers: ['a'],
    kritis_flag: false, blast_radius: 'LOW',
    change_window_active: true, emergency_override_ok: false,
    change_type: 'standard'
  }, { four_eyes_severity_threshold: 'HIGH' });
  assert.ok(r.violations.includes('four_eyes_critical'));
});

test('change_window: Emergency-Override entsperrt blocked Window', function() {
  var r = evaluate({
    severity: 'LOW', approvers: ['a'],
    kritis_flag: false, blast_radius: 'LOW',
    change_window_active: false, emergency_override_ok: true,
    change_type: 'emergency'
  }, {});
  assert.ok(!r.violations.includes('change_window'));
  assert.equal(r.decision, 'APPROVED');
});

test('emergency_approval: Emergency-Change ohne Approver BLOCKED', function() {
  var r = evaluate({
    severity: 'HIGH', approvers: [],
    kritis_flag: false, blast_radius: 'LOW',
    change_window_active: true, emergency_override_ok: true,
    change_type: 'emergency'
  }, {});
  assert.ok(r.violations.includes('emergency_approval'));
});

test('Mehrere Violations werden alle gemeldet', function() {
  var r = evaluate({
    severity: 'CRITICAL', approvers: [],
    kritis_flag: true, blast_radius: 'CRITICAL',
    change_window_active: false, emergency_override_ok: false,
    change_type: 'emergency'
  }, {});
  assert.ok(r.violations.includes('four_eyes_critical'));
  assert.ok(r.violations.includes('four_eyes_kritis'));
  assert.ok(r.violations.includes('four_eyes_blast'));
  assert.ok(r.violations.includes('change_window'));
  assert.ok(r.violations.includes('emergency_approval'));
  assert.equal(r.decision, 'BLOCKED');
});
