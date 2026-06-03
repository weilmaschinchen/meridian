// SPDX-License-Identifier: Apache-2.0
// meridian/core/hooks.js — Lightweight Hook-Registry (OSS).
// Ermöglicht Enterprise-Modulen, Verhalten im OSS-Kern zu erweitern,
// ohne dass der Kern enterprise/ direkt kennt (ADR-0038).
//
// Dependency-Richtung: core ← lib ← enterprise ← deploy/cra-plus
// Enterprise registriert Hooks beim Start via enterprise/loader.js.
// OSS-Kern ruft Hooks auf — falls nicht registriert: Default-Verhalten.
'use strict';

var _hooks = Object.create(null);

// register(name, fn) — Hook registrieren.
// name: 'itil.classify' | 'cmdb.resolveSync' | 'sbom.generate' |
//       'art23.trigger' | 'audit.logDecision'
function register(name, fn) {
  if (typeof fn !== 'function') throw new Error('[hooks] ' + name + ': fn muss eine Funktion sein');
  _hooks[name] = fn;
}

// get(name) → fn | null
function get(name) { return _hooks[name] || null; }

// call(name, args[], defaultValue) → result synchron
// Gibt defaultValue zurück wenn Hook nicht registriert.
function call(name, args, defaultValue) {
  var fn = _hooks[name];
  if (!fn) return defaultValue !== undefined ? defaultValue : null;
  return fn.apply(null, Array.isArray(args) ? args : [args]);
}

// reset() — nur für Tests
function reset() { _hooks = Object.create(null); }

module.exports = { register: register, get: get, call: call, reset: reset };
