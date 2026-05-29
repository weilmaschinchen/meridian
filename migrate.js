#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// meridian/migrate.js — Schema-Migration-Runner für Meridian
//
// Verwendung:
//   node meridian/migrate.js up          — alle ausstehenden Migrations anwenden
//   node meridian/migrate.js status      — zeige angewendete/ausstehende Migrations
//   node meridian/migrate.js create <name> — neue Migration-Datei erstellen
//
// Migrations liegen in meridian/migrations/<timestamp>_<name>.js
// Jede Migration exportiert: { up(db), down(db), description }

'use strict';

var fs = require('fs');
var path = require('path');
var Database = require('better-sqlite3');

var DB_PATH = process.env.DB_PATH || process.env.MERIDIAN_DB_PATH || path.join(__dirname, '..', 'data', 'cra.db');
var MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function openDb() {
  var db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meridian_migrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      checksum    TEXT
    )
  `);
}

function getApplied(db) {
  return new Set(db.prepare('SELECT name FROM meridian_migrations').all().map(r => r.name));
}

function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.match(/^\d{14}_.*\.js$/))
    .sort();
}

function checksum(filePath) {
  var crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
}

function cmdUp(args) {
  var db = openDb();
  ensureMigrationsTable(db);
  var applied = getApplied(db);
  var files = getMigrationFiles();
  var pending = files.filter(f => !applied.has(f));

  if (pending.length === 0) {
    console.log('[meridian-migrate] Alle Migrations angewendet. Nichts zu tun.');
    db.close();
    return;
  }

  var dryRun = args.includes('--dry');
  if (dryRun) console.log('[meridian-migrate] DRY RUN — keine Änderungen');

  for (var file of pending) {
    var filePath = path.join(MIGRATIONS_DIR, file);
    var migration = require(filePath);
    console.log('[meridian-migrate] Applying: ' + file);
    if (migration.description) console.log('  → ' + migration.description);

    if (!dryRun) {
      var runMigration = db.transaction(function() {
        migration.up(db);
        db.prepare(
          'INSERT INTO meridian_migrations (name, checksum) VALUES (?, ?)'
        ).run(file, checksum(filePath));
      });
      try {
        runMigration();
        console.log('  ✓ OK');
      } catch(e) {
        console.error('  ✗ FEHLER: ' + e.message);
        console.error('  Migration gestoppt. DB-Zustand konsistent (Transaktion gerollt zurück).');
        db.close();
        process.exit(1);
      }
    }
  }

  if (!dryRun) console.log('[meridian-migrate] ' + pending.length + ' Migration(s) angewendet.');
  db.close();
}

function cmdStatus() {
  var db = openDb();
  ensureMigrationsTable(db);
  var applied = getApplied(db);
  var files = getMigrationFiles();

  if (files.length === 0) {
    console.log('[meridian-migrate] Keine Migrations gefunden in: ' + MIGRATIONS_DIR);
    db.close();
    return;
  }

  console.log('\nMeridian Migrations Status');
  console.log('─'.repeat(60));
  for (var file of files) {
    var status = applied.has(file) ? '✓ applied' : '○ pending';
    console.log('  ' + status + '  ' + file);
  }
  console.log('─'.repeat(60));
  console.log('  Applied: ' + applied.size + ' / ' + files.length);
  console.log();
  db.close();
}

function cmdCreate(args) {
  var name = args.find(a => !a.startsWith('-'));
  if (!name) {
    console.error('Verwendung: node meridian/migrate.js create <name>');
    process.exit(1);
  }
  var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  var ts = new Date().toISOString().replace(/[-T:Z.]/g, '').slice(0, 14);
  var fileName = ts + '_' + slug + '.js';
  var filePath = path.join(MIGRATIONS_DIR, fileName);

  if (!fs.existsSync(MIGRATIONS_DIR)) fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });

  var template = [
    "// meridian/migrations/" + fileName,
    "// " + name,
    "",
    "'use strict';",
    "",
    "module.exports = {",
    "  description: '" + name + "',",
    "",
    "  up: function(db) {",
    "    // TODO: Schema-Änderung",
    "    // db.exec(`ALTER TABLE ... ADD COLUMN ...`);",
    "  },",
    "",
    "  down: function(db) {",
    "    // TODO: Rollback (optional, für Entwicklung)",
    "  }",
    "};",
  ].join('\n');

  fs.writeFileSync(filePath, template);
  console.log('[meridian-migrate] Erstellt: ' + filePath);
}

// ── CLI-Dispatch ───────────────────────────────────────────────────

var cmd = process.argv[2];
var args = process.argv.slice(3);

switch (cmd) {
  case 'up':     cmdUp(args); break;
  case 'status': cmdStatus(); break;
  case 'create': cmdCreate(args); break;
  default:
    console.log('Verwendung: node meridian/migrate.js <up|status|create> [options]');
    console.log('  up [--dry]       Ausstehende Migrations anwenden');
    console.log('  status           Status aller Migrations anzeigen');
    console.log('  create <name>    Neue Migration-Datei erstellen');
    process.exit(1);
}
