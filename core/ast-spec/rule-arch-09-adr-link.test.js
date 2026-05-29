// rule-arch-09-adr-link.test.js
// Tests für die Cross-Cutting-Regel ADR-Bezug bei Architektur-Änderungen

const goodPRTitles = [
  "feat(auth): JwtVerifier hardening (ADR-0014)",
  "refactor(events): split series-engine (ADR-0028)"
];

const badPRTitles = [
  "refactor: split modules",
  "feat: new auth flow"
];

// Pseudo-Heuristik: Prüft, ob der PR-Titel einen ADR-Verweis enthält,
// wenn architektur-relevante Dateien geändert wurden.
function runRule(prTitle, changedFiles) {
  // Diese Implementierung ist ein Platzhalter.
  // Die echte CRA-Detector-Heuristik prüft auch Commit-Messages und
  // analysiert die geänderten Dateien auf Pattern wie *Repository, *Service, etc.
  const hasArchChange = changedFiles && changedFiles.some(f =>
    f.includes('Repository') || f.includes('Service') || f.includes('Strategy')
  );
  const hasAdrRef = /\bADR-\d{4}\b/.test(prTitle);
  if (hasArchChange && !hasAdrRef) {
    return { passed: false, message: "Architektur-Änderung ohne ADR-Verweis im PR-Titel." };
  }
  return { passed: true };
}

// Einfache Assertions (manuell auszuführen)
