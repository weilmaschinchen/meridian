; SPDX-License-Identifier: Apache-2.0
; arch-06: Migrations-SQL mit PII-Spalte aber kein passendes Erase-Statement
; Cross-File-Check: Prüft ob zu einer CREATE TABLE mit PII-Spalte (email, phone, iban, tax_id, birthdate, address)
; das entsprechende <context>/erase.ts eine Lösch-Funktion für die Tabelle bereitstellt.
; Die Tree-Sitter-Query kann diese Cross-File-Beziehung nicht darstellen, daher dient diese Datei nur als Dokumentation.
; Tatsächliche Prüfung: ts-morph-Script (LO-P3-tsmorph) liest migrations/*.sql und erase.ts und vergleicht.
; Platzhalter-Query (nicht aktiv):
; (
;   (create_table_statement
;     (table_reference) @table
;     (column_definition (column_name) @col
;       (#match? @col "^(email|phone|iban|tax_id|birthdate|address)$")))
; ) @match
;
; Die Query würde Zeilen matchen, aber nicht gewährleisten, dass erase.ts existiert.
; siehe docs/architecture/charter.md (P8) und ADR-0014.
