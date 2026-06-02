; SPDX-License-Identifier: Apache-2.0
; rule-arch-16-schema-slug.scm
; Tree-sitter Query für CREATE SCHEMA mit Tenant-Schema-Namen
; Pattern-Only – cross-cutting: gilt für .sql-DDL-Dateien
; 
; Tenant-Schema-Name muss /^tenant_[a-z0-9_]+$/ matchen.
; Reservierte Namen: tenant_platform, tenant_staging, tenant_test, tenant_system, tenant_mysql.
; Verletzung: Großbuchstaben, Bindestriche oder reservierte Slugs.
;
; Matched string-literal in CREATE SCHEMA statements:
((sql_create_schema) @capture
  (identifier) @schema_name
  (#match? @schema_name "(^tenant_(platform|staging|test|system|mysql)$|[A-Z]|-)"))
