; rule-arch-15-pflicht-ts – Pflicht-TS-File als .js (ADR-0027)
; Diese Regel wirkt auf Datei-Pfad-Ebene im CRA-Detector.
; Kein Tree-sitter-Einsatz, da die Prüfung ausschließlich über die
; Pfadmuster läuft.
;
; Betroffene Pflichtpfade:
;   modules/<ctx>/port.js
;   modules/<ctx>/domain/types.js
;   modules/<ctx>/infrastructure/repository.js
;   modules/<ctx>/policies/*.js
;   modules/<ctx>/index.js
;
