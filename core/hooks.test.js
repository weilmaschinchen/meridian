// SPDX-License-Identifier: Apache-2.0
// hooks.test.js — node --test
'use strict';
var assert = require('assert').strict;
var test   = require('node:test');
var hooks  = require('./hooks');

test('register + get: Hook abrufbar nach Registrierung', function() {
  hooks.reset();
  hooks.register('test.hook', function() { return 42; });
  assert.equal(typeof hooks.get('test.hook'), 'function');
  hooks.reset();
});

test('get: null wenn nicht registriert', function() {
  hooks.reset();
  assert.equal(hooks.get('nonexistent'), null);
});

test('call: ruft Hook auf und gibt Ergebnis zurück', function() {
  hooks.reset();
  hooks.register('math.add', function(a, b) { return a + b; });
  assert.equal(hooks.call('math.add', [3, 4]), 7);
  hooks.reset();
});

test('call: gibt defaultValue zurück wenn kein Hook', function() {
  hooks.reset();
  assert.equal(hooks.call('missing', [], 'DEFAULT'), 'DEFAULT');
});

test('call: gibt null zurück wenn kein Hook + kein Default', function() {
  hooks.reset();
  assert.equal(hooks.call('missing', []), null);
});

test('register: wirft bei nicht-Funktion', function() {
  hooks.reset();
  assert.throws(function() { hooks.register('bad', 'not-a-fn'); }, /muss eine Funktion/);
  hooks.reset();
});

test('reset: löscht alle registrierten Hooks', function() {
  hooks.register('temp.hook', function() {});
  hooks.reset();
  assert.equal(hooks.get('temp.hook'), null);
});
