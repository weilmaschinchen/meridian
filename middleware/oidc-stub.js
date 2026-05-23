// meridian/middleware/oidc-stub.js
// OIDC-Authentifizierungs-Middleware für Meridian (Phase 1 Stub)
//
// Feature-Flag: MERIDIAN_AUTH_ENABLED=1 aktiviert echte OIDC-Prüfung
//               MERIDIAN_AUTH_ENABLED=0 (Default) — Stub, alle Requests erlaubt (Dev-Mode)
//
// Konfiguration (ENV):
//   MERIDIAN_AUTH_ENABLED     — 0|1 (Default: 0)
//   MERIDIAN_OIDC_ISSUER      — z.B. https://auth.example.com/realms/meridian
//   MERIDIAN_OIDC_AUDIENCE    — Client-ID
//   MERIDIAN_API_TOKENS       — Komma-separierte API-Tokens für CI/CD (Fallback)
//   MERIDIAN_DEFAULT_TENANT   — Default Tenant wenn kein Tenant im Token
//
// RBAC-Rollen (im Token als claim "meridian_roles" oder "roles"):
//   viewer        — Lesend (GET)
//   submitter     — Change Records einreichen (POST /api/v1/changes)
//   reviewer      — LLM-Review starten, Findings kommentieren
//   cab-member    — CAB-Abstimmung (POST .../approve, .../reject)
//   change-manager — alle CAB + Config-Änderungen
//   admin         — alles

'use strict';

var AUTH_ENABLED = process.env.MERIDIAN_AUTH_ENABLED === '1';
var OIDC_ISSUER  = process.env.MERIDIAN_OIDC_ISSUER  || '';
var OIDC_AUD     = process.env.MERIDIAN_OIDC_AUDIENCE || 'meridian';
var DEFAULT_TENANT = process.env.MERIDIAN_DEFAULT_TENANT || 'default';

// API-Tokens für CI/CD (Bearer statt OIDC JWT)
var API_TOKENS = (process.env.MERIDIAN_API_TOKENS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// RBAC: welche Methoden + Pfad-Präfixe brauchen welche Mindest-Rolle
var ROLE_HIERARCHY = ['viewer', 'submitter', 'reviewer', 'cab-member', 'change-manager', 'admin'];

var ROUTE_ROLES = [
  // Admin-only
  { method: 'PATCH', path: '/api/v1/config',    role: 'change-manager' },
  { method: 'POST',  path: '/api/v1/config/tenants', role: 'admin' },
  // CAB
  { method: 'POST',  path: '/approve',           role: 'cab-member' },
  { method: 'POST',  path: '/reject',            role: 'cab-member' },
  // Submitter
  { method: 'POST',  path: '/api/v1/changes',    role: 'submitter' },
  { method: 'POST',  path: '/api/cra/analyze',   role: 'submitter' },
  // Viewer (alle GET)
  { method: 'GET',   path: '/',                  role: 'viewer' },
];

// ── Haupt-Middleware ───────────────────────────────────────────────

function authMiddleware(req, res, next) {
  if (!AUTH_ENABLED) {
    // Dev-Mode: anonymer Admin
    req.meridianUser = {
      sub:    'dev-user',
      roles:  ['admin'],
      tenant: DEFAULT_TENANT,
      auth:   'dev-stub',
    };
    return next();
  }

  var authHeader = req.headers['authorization'] || '';

  // 1. API-Token (CI/CD Fallback)
  if (authHeader.startsWith('Bearer ') && API_TOKENS.length > 0) {
    var token = authHeader.slice(7);
    if (API_TOKENS.includes(token)) {
      req.meridianUser = {
        sub:    'api-token',
        roles:  ['submitter'],
        tenant: req.headers['x-meridian-tenant'] || DEFAULT_TENANT,
        auth:   'api-token',
      };
      return next();
    }
  }

  // 2. OIDC JWT
  if (authHeader.startsWith('Bearer ') && OIDC_ISSUER) {
    var jwt = authHeader.slice(7);
    return verifyOidcToken(jwt, function(err, claims) {
      if (err) return unauthorized(res, err.message);
      req.meridianUser = {
        sub:    claims.sub,
        email:  claims.email,
        name:   claims.name,
        roles:  extractRoles(claims),
        tenant: claims.meridian_tenant || req.headers['x-meridian-tenant'] || DEFAULT_TENANT,
        auth:   'oidc',
      };

      var roleErr = checkRouteRole(req);
      if (roleErr) return forbidden(res, roleErr);
      next();
    });
  }

  // Kein Auth-Header
  if (!authHeader) return unauthorized(res, 'Authorization-Header fehlt');
  return unauthorized(res, 'Ungültiges Auth-Format');
}

// ── OIDC Token Verify (Stub — Phase 1 ohne echte Crypto) ──────────
// Phase 2: ersetzen durch jose oder openid-client Library
function verifyOidcToken(jwt, cb) {
  if (!OIDC_ISSUER) return cb(new Error('MERIDIAN_OIDC_ISSUER nicht konfiguriert'));

  try {
    var parts = jwt.split('.');
    if (parts.length !== 3) return cb(new Error('Kein gültiges JWT-Format'));

    var payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    // Minimale Validierung (STUB — kein Signatur-Check in Phase 1)
    // WICHTIG: In Produktion MUSS die Signatur via OIDC Discovery + JWKS geprüft werden
    // Phase 2 implementiert echten RS256/ES256 Verify via jose-Library

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return cb(new Error('Token abgelaufen'));
    }
    if (payload.iss && payload.iss !== OIDC_ISSUER) {
      return cb(new Error('Token Issuer ungültig: ' + payload.iss));
    }
    if (OIDC_AUD) {
      var aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(OIDC_AUD)) return cb(new Error('Token Audience ungültig'));
    }

    cb(null, payload);
  } catch(e) {
    cb(new Error('JWT-Parse-Fehler: ' + e.message));
  }
}

// ── RBAC ───────────────────────────────────────────────────────────

function checkRouteRole(req) {
  var userRoles = req.meridianUser && req.meridianUser.roles || [];
  var maxRole = getMaxRole(userRoles);

  for (var rule of ROUTE_ROLES) {
    var methodMatch = rule.method === '*' || req.method === rule.method;
    var pathMatch = req.path && req.path.includes(rule.path);
    if (methodMatch && pathMatch) {
      if (!hasRole(maxRole, rule.role)) {
        return 'Rolle ' + rule.role + ' erforderlich für ' + req.method + ' ' + req.path;
      }
    }
  }
  return null;
}

function hasRole(userRole, requiredRole) {
  return ROLE_HIERARCHY.indexOf(userRole) >= ROLE_HIERARCHY.indexOf(requiredRole);
}

function getMaxRole(roles) {
  var max = -1;
  var maxRole = 'viewer';
  for (var r of roles) {
    var idx = ROLE_HIERARCHY.indexOf(r);
    if (idx > max) { max = idx; maxRole = r; }
  }
  return maxRole;
}

function extractRoles(claims) {
  // Unterstütze verschiedene OIDC-Provider-Konventionen
  if (Array.isArray(claims.meridian_roles)) return claims.meridian_roles;
  if (Array.isArray(claims.roles)) return claims.roles;
  // Keycloak realm_access
  if (claims.realm_access && Array.isArray(claims.realm_access.roles)) {
    return claims.realm_access.roles.filter(r => ROLE_HIERARCHY.includes(r));
  }
  return ['viewer']; // Default: nur lesen
}

// ── Helper ─────────────────────────────────────────────────────────

function unauthorized(res, msg) {
  res.status(401).json({ error: 'Unauthorized', message: msg,
    hint: 'Bearer-Token im Authorization-Header setzen.' });
}

function forbidden(res, msg) {
  res.status(403).json({ error: 'Forbidden', message: msg });
}

/**
 * requireRole(role) — Express-Middleware der eine Mindest-Rolle prüft
 * Verwendung: app.post('/api/v1/changes', authMiddleware, requireRole('submitter'), handler)
 */
function requireRole(requiredRole) {
  return function(req, res, next) {
    if (!req.meridianUser) return unauthorized(res, 'Nicht authentifiziert');
    var userMaxRole = getMaxRole(req.meridianUser.roles || []);
    if (!hasRole(userMaxRole, requiredRole)) {
      return forbidden(res, 'Rolle ' + requiredRole + ' erforderlich, vorhanden: ' + userMaxRole);
    }
    next();
  };
}

/**
 * requireTenant(tenantId) — prüft ob User Zugriff auf diesen Tenant hat
 */
function requireTenant(tenantId) {
  return function(req, res, next) {
    if (!req.meridianUser) return unauthorized(res, 'Nicht authentifiziert');
    var userRoles = req.meridianUser.roles || [];
    var isAdmin = userRoles.includes('admin');
    var userTenant = req.meridianUser.tenant;

    if (!isAdmin && userTenant !== tenantId && userTenant !== '*') {
      return forbidden(res, 'Kein Zugriff auf Tenant: ' + tenantId);
    }
    next();
  };
}

module.exports = {
  authMiddleware:  authMiddleware,
  requireRole:     requireRole,
  requireTenant:   requireTenant,
  AUTH_ENABLED:    AUTH_ENABLED,
  ROLE_HIERARCHY:  ROLE_HIERARCHY,
};
