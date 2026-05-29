// SPDX-License-Identifier: Apache-2.0
// meridian/lib/plugins.js — optionaler Loader für nicht-OSS-Plugins.
//
// Kern-Module dürfen NICHT hart auf betreiber-spezifische Module (z. B. Reporting-
// oder Identity-Plugins) requiren — die liegen außerhalb des OSS-Cores. Stattdessen:
//
//   var myPlugin = plugins.load('my-plugin');
//   if (myPlugin) { ... }   // immer guarden
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

// loadEnabled() — lädt alle in MERIDIAN_PLUGINS (kommasepariert) gelisteten Plugins.
// Der Core kennt so KEINE konkreten Plugin-Namen; Routen/Init bringen die Plugins selbst mit
// (Konvention: optionales mod.init() und mod.handleRoute(req,res,url,ctx)).
function loadEnabled() {
  var names = (process.env.MERIDIAN_PLUGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var out = [];
  names.forEach(function (n) { var m = load(n); if (m) out.push({ name: n, mod: m }); });
  return out;
}

module.exports = { load: load, loadEnabled: loadEnabled };
