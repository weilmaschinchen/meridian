// SPDX-License-Identifier: Apache-2.0
// meridian/lib/plugins.js — optionaler Loader für nicht-OSS-Plugins.
//
// Kern-Module dürfen NICHT hart auf betreiber-spezifische Module (z. B.
// lights-out, qwen-client) requiren — die liegen außerhalb des OSS-Cores.
// Stattdessen:
//
//   var lightsOut = plugins.load('lights-out-api', function () { return require('./lights-out-api'); });
//   if (lightsOut) { ... }   // immer guarden
//
// Auflösungsreihenfolge:
//   1) MERIDIAN_PLUGINS_DIR/<name>   (z. B. deploy/cra-plus — CRA Plus / Enterprise)
//   2) fallbackFn()                  (lokaler require, solange das Modul noch im Core liegt)
//   3) null                          (OSS / Plugin nicht vorhanden → Feature deaktiviert)
'use strict';

var path = require('path');

function load(name, fallbackFn) {
  var dir = process.env.MERIDIAN_PLUGINS_DIR;
  if (dir) {
    try {
      return require(path.resolve(dir, name));
    } catch (e) {
      if (e && e.code !== 'MODULE_NOT_FOUND') {
        console.error('[meridian/plugins] Fehler beim Laden von ' + name + ' aus ' + dir + ':', e.message);
      }
      // weiter zum Fallback
    }
  }
  if (typeof fallbackFn === 'function') {
    try { return fallbackFn(); } catch (e) { return null; }
  }
  return null;
}

module.exports = { load: load };
