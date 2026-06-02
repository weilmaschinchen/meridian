// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// Pseudo runRule: Prüft alle migrations/*.sql auf PII-Spalten
// und sucht passende Erase-Funktion in erase.ts
function runRule(contextDir) {
  const migrationsDir = join(contextDir, 'migrations');
  const eraseFile = join(contextDir, 'erase.ts');
  const findings = [];
  const sqlFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
  for (const sqlFile of sqlFiles) {
    const sqlPath = join(migrationsDir, sqlFile);
    const sqlContent = readFileSync(sqlPath, 'utf8');
    const regex = /CREATE\s+TABLE\s+(\w+)\s*\(([^)]*)\)/gi;
    let match;
    while ((match = regex.exec(sqlContent)) !== null) {
      const table = match[1];
      const body = match[2];
      if (/\b(?:email|phone|iban|tax_id|birthdate|address)\b/.test(body)) {
        let hasErase = false;
        if (existsSync(eraseFile)) {
          const eraseContent =
