const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

// ── Géolocalisation bureau ──
const BUREAU_LAT   =  5.344125;
const BUREAU_LNG   = -4.010596;
const BUREAU_RAYON = 100; // mètres

// ── Horaires de travail ──
const HEURE_DEBUT = 9;  // 09h00 — retard si arrivée après
const HEURE_FIN   = 17; // 17h00 — départ prévu

function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const app = express();
const PORT = process.env.PORT || 3000;

// Faire confiance au proxy Railway pour les cookies secure
app.set('trust proxy', 1);

// ── Connexion PostgreSQL ──
// Pas de SSL pour les connexions internes Railway (.railway.internal)
const isInternalRailway = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('.railway.internal');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isInternalRailway ? false : (process.env.DATABASE_URL ? { rejectUnauthorized: false } : false)
});

// ── Initialisation des tables ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id        TEXT PRIMARY KEY,
      nom       TEXT NOT NULL,
      prenom    TEXT NOT NULL,
      poste     TEXT DEFAULT '',
      service   TEXT DEFAULT '',
      nom_complet TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id       TEXT PRIMARY KEY,
      nom      TEXT NOT NULL,
      login    TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role     TEXT DEFAULT 'superviseur',
      actif    BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS pointages (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      nom         TEXT,
      prenom      TEXT,
      nom_complet TEXT,
      poste       TEXT,
      service     TEXT,
      date        TEXT,
      heure       TEXT,
      type        TEXT,
      retard      BOOLEAN DEFAULT false,
      photo       TEXT,
      source      TEXT,
      timestamp   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS demandes (
      id             TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL,
      nom            TEXT,
      service        TEXT,
      type           TEXT,
      date_debut     TEXT,
      date_fin       TEXT,
      heure          TEXT,
      motif          TEXT,
      tel            TEXT DEFAULT '',
      pieces_jointes JSONB DEFAULT '[]',
      statut         TEXT DEFAULT 'en_attente',
      commentaire    TEXT DEFAULT '',
      traite_par     TEXT,
      traite_at      TIMESTAMPTZ,
      source         TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL COLLATE "default",
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
  `);

  // Synchroniser les noms dans les pointages si un agent a été renommé
  await pool.query(`
    UPDATE pointages p
    SET prenom      = a.prenom,
        nom         = a.nom,
        nom_complet = a.nom_complet
    FROM agents a
    WHERE p.agent_id = a.id
      AND (p.prenom != a.prenom OR p.nom != a.nom)
  `);

  // Créer le compte admin par défaut s'il n'existe pas
  const { rows } = await pool.query("SELECT id FROM users WHERE login = 'admin'");
  if (rows.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(
      "INSERT INTO users (id, nom, login, password, role, actif) VALUES ($1, $2, $3, $4, $5, $6)",
      [Date.now().toString(), 'Administrateur', 'admin', hash, 'admin', true]
    );
    console.log('  Compte admin créé (login: admin / mdp: admin123)');
  }
}

const server = http.createServer(app);
const io = new Server(server);

// ── Middleware ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Sessions PostgreSQL ──
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'gestion-qualite-mafa-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// ── Middleware de protection ──
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ erreur: "Accès réservé à l'administrateur." });
}
function requireSuperviseur(req, res, next) {
  const token = req.query.token || req.headers['x-superviseur-token'];
  if (token === SUPERVISEUR_TOKEN) return next();
  res.status(403).json({ erreur: 'Accès refusé.' });
}

const SUPERVISEUR_TOKEN = process.env.SUPERVISEUR_TOKEN || '613f01aaac557e34545efc1c73c5337e';

app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────
// ROUTES API
// ──────────────────────────────────────────

// Infos serveur
app.get('/api/infos', (req, res) => {
  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  res.json({ url: `${base}/badge` });
});


// ── Agents ──
app.get('/api/agents', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM agents ORDER BY nom');
  res.json(rows);
});

app.post('/api/agents', async (req, res) => {
  const { id, nom, prenom, poste, service } = req.body;
  if (!id || !nom || !prenom) return res.status(400).json({ erreur: 'Champs manquants' });
  const agent = {
    id: id.toUpperCase(), nom: nom.toUpperCase(), prenom,
    poste: poste || '', service: service || '',
    nom_complet: `${prenom} ${nom.toUpperCase()}`
  };
  await pool.query(
    `INSERT INTO agents (id, nom, prenom, poste, service, nom_complet)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET nom=$2, prenom=$3, poste=$4, service=$5, nom_complet=$6`,
    [agent.id, agent.nom, agent.prenom, agent.poste, agent.service, agent.nom_complet]
  );
  const { rows } = await pool.query('SELECT * FROM agents ORDER BY nom');
  io.emit('agents-mis-a-jour', rows);
  res.json({ ok: true, agent });
});

app.delete('/api/agents/:id', async (req, res) => {
  await pool.query('DELETE FROM agents WHERE id = $1', [req.params.id.toUpperCase()]);
  const { rows } = await pool.query('SELECT * FROM agents ORDER BY nom');
  io.emit('agents-mis-a-jour', rows);
  res.json({ ok: true });
});

// ── Pointages ──
app.get('/api/pointages', async (req, res) => {
  let query = 'SELECT * FROM pointages WHERE 1=1';
  const params = [];
  if (req.query.date)    { params.push(req.query.date);    query += ` AND date = $${params.length}`; }
  if (req.query.agentId) { params.push(req.query.agentId); query += ` AND agent_id = $${params.length}`; }
  query += ' ORDER BY timestamp DESC';
  const { rows } = await pool.query(query, params);
  res.json(rows.map(rowToPointage));
});

app.get('/api/pointages/today', async (req, res) => {
  const today = new Date().toLocaleDateString('fr-FR');
  const { rows } = await pool.query(
    'SELECT * FROM pointages WHERE date = $1 ORDER BY timestamp DESC', [today]
  );
  res.json(rows.map(rowToPointage));
});


app.delete('/api/pointages/:id', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM pointages WHERE id = $1', [req.params.id]);
  io.emit('stats-update');
  res.json({ ok: true });
});

// ── Stats ──
app.get('/api/stats', async (req, res) => {
  const today = new Date().toLocaleDateString('fr-FR');
  const { rows: agents }   = await pool.query('SELECT id FROM agents');
  const { rows: pointages } = await pool.query(
    'SELECT * FROM pointages WHERE date = $1', [today]
  );
  const presents = new Set(pointages.filter(p => p.type === 'entree').map(p => p.agent_id));
  const retards  = pointages.filter(p => {
    if (p.type !== 'entree') return false;
    const [h, m] = p.heure.split(':').map(Number);
    return h > HEURE_DEBUT || (h === HEURE_DEBUT && m > 0);
  }).length;
  const { rows: derniers } = await pool.query(
    'SELECT * FROM pointages WHERE date = $1 ORDER BY timestamp DESC LIMIT 5', [today]
  );
  res.json({
    date: today,
    totalAgents: agents.length,
    presents: presents.size,
    absents: Math.max(0, agents.length - presents.size),
    retards,
    derniersPointages: derniers.map(rowToPointage)
  });
});

// ── Statut du jour pour un agent ──
app.get('/api/statut-jour/:agentId', async (req, res) => {
  const today = new Date().toLocaleDateString('fr-FR');
  const { rows } = await pool.query(
    'SELECT type FROM pointages WHERE agent_id = $1 AND date = $2',
    [req.params.agentId.toUpperCase(), today]
  );
  res.json({
    aEntree: rows.some(p => p.type === 'entree'),
    aSortie: rows.some(p => p.type === 'sortie')
  });
});

// ── Badgeage ──
app.post('/api/badger', async (req, res) => {
  const { agentId, photo, source } = req.body;
  if (!agentId) return res.status(400).json({ erreur: 'ID agent manquant' });

  // Validation géolocalisation
  const { lat, lng } = req.body;
  if (lat == null || lng == null) {
    return res.status(403).json({
      erreur: 'Localisation requise. Activez le GPS et autorisez la localisation.',
      geoRequired: true
    });
  }
  const distance = distanceMetres(parseFloat(lat), parseFloat(lng), BUREAU_LAT, BUREAU_LNG);
  if (distance > BUREAU_RAYON) {
    return res.status(403).json({
      erreur: `Vous devez être au bureau pour badger (vous êtes à ${Math.round(distance)} m).`,
      geoFailed: true,
      distance: Math.round(distance)
    });
  }

  const { rows: agentRows } = await pool.query(
    'SELECT * FROM agents WHERE id = $1', [agentId.toUpperCase()]
  );
  if (!agentRows.length) return res.status(404).json({ erreur: 'Agent non trouvé' });
  const agent = agentRows[0];

  const today = new Date().toLocaleDateString('fr-FR');
  const heure = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  const { rows: duJour } = await pool.query(
    'SELECT * FROM pointages WHERE agent_id = $1 AND date = $2', [agent.id, today]
  );
  const aEntree = duJour.some(p => p.type === 'entree');
  const aSortie = duJour.some(p => p.type === 'sortie');

  // Départ déjà enregistré → journée terminée, aucun badgeage possible
  if (aSortie)
    return res.json({ ok: false, message: "Vous avez déjà enregistré votre départ aujourd'hui. Bonne soirée !" });

  // Arrivée déjà enregistrée → prochain badge = départ uniquement
  const type = aEntree ? 'sortie' : 'entree';

  // Protection anti-doublon : délai minimum de 60 s entre entrée et sortie
  if (type === 'sortie') {
    const derniereEntree = duJour.find(p => p.type === 'entree');
    if (derniereEntree) {
      const diffSec = (Date.now() - new Date(derniereEntree.timestamp).getTime()) / 1000;
      if (diffSec < 60) {
        return res.status(400).json({
          ok: false,
          message: 'Votre arrivée vient d\'être enregistrée. Réessayez dans quelques instants.'
        });
      }
    }
  }
  const [h, m] = heure.split(':').map(Number);
  const retard = type === 'entree' && (h > HEURE_DEBUT || (h === HEURE_DEBUT && m > 0));
  const pointageId = Date.now().toString();

  // Photo stockée en base64 dans la DB
  let photoData = null;
  if (photo && photo.startsWith('data:image')) photoData = photo;

  await pool.query(
    `INSERT INTO pointages (id, agent_id, nom, prenom, nom_complet, poste, service, date, heure, type, retard, photo, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [pointageId, agent.id, agent.nom, agent.prenom,
     agent.nom_complet || `${agent.prenom} ${agent.nom}`,
     agent.poste, agent.service || '', today, heure, type, retard, photoData, source || 'web']
  );

  const pointage = {
    id: pointageId, agentId: agent.id, nom: agent.nom, prenom: agent.prenom,
    nom_complet: agent.nom_complet, poste: agent.poste, service: agent.service,
    date: today, heure, type, retard, photo: photoData
  };

  io.emit('nouveau-pointage', pointage);
  io.emit('stats-update');

  res.json({
    ok: true, type, retard, photo: photoData,
    agent: { nom: agent.nom, prenom: agent.prenom, nom_complet: agent.nom_complet, poste: agent.poste },
    heure
  });
});

// ─────────────────────────────────────────
// AUTHENTIFICATION
// ─────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE login = $1 AND actif = true', [login]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ erreur: 'Identifiant ou mot de passe incorrect.' });
  req.session.user = { id: user.id, nom: user.nom, login: user.login, role: user.role };
  res.json({ ok: true, role: user.role, nom: user.nom });
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

app.post('/api/changer-mdp', requireAuth, async (req, res) => {
  const { ancien, nouveau } = req.body;
  if (!nouveau || nouveau.length < 6)
    return res.status(400).json({ erreur: 'Minimum 6 caractères requis.' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
  if (!rows.length || !bcrypt.compareSync(ancien, rows[0].password))
    return res.status(401).json({ erreur: 'Ancien mot de passe incorrect.' });
  await pool.query('UPDATE users SET password = $1 WHERE id = $2',
    [bcrypt.hashSync(nouveau, 10), req.session.user.id]);
  res.json({ ok: true });
});

app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, nom, login, role, actif FROM users');
  res.json(rows);
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { nom, login, password, role } = req.body;
  if (!login || !password || !nom)
    return res.status(400).json({ erreur: 'Champs manquants.' });
  const { rows } = await pool.query('SELECT id FROM users WHERE login = $1', [login]);
  if (rows.length) return res.status(400).json({ erreur: 'Ce login existe déjà.' });
  await pool.query(
    'INSERT INTO users (id, nom, login, password, role, actif) VALUES ($1,$2,$3,$4,$5,$6)',
    [Date.now().toString(), nom, login, bcrypt.hashSync(password, 10), role || 'superviseur', true]
  );
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (req.session.user.id === req.params.id)
    return res.status(400).json({ erreur: 'Impossible de supprimer votre propre compte.' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
// DEMANDES
// ─────────────────────────────────────────

app.post('/api/demandes', async (req, res) => {
  const { agentId, nom, service, type, dateDebut, dateFin, heure, motif, tel, piecesJointes, source } = req.body;
  if (!agentId || !nom || !type || !dateDebut || !motif)
    return res.status(400).json({ erreur: 'Champs obligatoires manquants.' });

  const demandeId = Date.now().toString();

  // Pièces jointes stockées en JSONB (base64)
  const pj = Array.isArray(piecesJointes)
    ? piecesJointes.map(p => ({ nom: p.nom, data: p.data }))
    : [];

  await pool.query(
    `INSERT INTO demandes
       (id, agent_id, nom, service, type, date_debut, date_fin, heure, motif, tel,
        pieces_jointes, statut, commentaire, source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'en_attente','',$12,NOW())`,
    [demandeId, agentId.toUpperCase(), nom, service || '', type, dateDebut,
     dateFin || null, heure || null, motif, tel || '', JSON.stringify(pj), source || 'web']
  );

  const { rows } = await pool.query('SELECT * FROM demandes WHERE id = $1', [demandeId]);
  const demande = rowToDemande(rows[0]);
  io.emit('nouvelle-demande', demande);
  res.json({ ok: true, demande });
});

app.get('/api/demandes', requireAuth, async (req, res) => {
  let query = 'SELECT * FROM demandes WHERE 1=1';
  const params = [];
  if (req.query.statut) { params.push(req.query.statut); query += ` AND statut = $${params.length}`; }
  query += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(query, params);
  res.json(rows.map(rowToDemande));
});

app.patch('/api/demandes/:id', requireAuth, requireAdmin, async (req, res) => {
  const { statut, commentaire } = req.body;
  const { rows } = await pool.query(
    `UPDATE demandes SET statut = COALESCE($1, statut),
       commentaire = COALESCE($2, commentaire),
       traite_par = $3, traite_at = NOW()
     WHERE id = $4 RETURNING *`,
    [statut || null, commentaire !== undefined ? commentaire : null,
     req.session.user.nom, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ erreur: 'Demande introuvable.' });
  const demande = rowToDemande(rows[0]);
  io.emit('demande-mise-a-jour', demande);
  res.json({ ok: true, demande });
});

app.delete('/api/demandes/:id', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM demandes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Télécharger une pièce jointe depuis la DB
app.get('/api/demandes/:id/pj/:index', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT pieces_jointes FROM demandes WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ erreur: 'Demande introuvable.' });
  const pj = (rows[0].pieces_jointes || [])[parseInt(req.params.index)];
  if (!pj || !pj.data) return res.status(404).json({ erreur: 'Fichier introuvable.' });
  const base64 = pj.data.replace(/^data:[^;]+;base64,/, '');
  const mimeMatch = pj.data.match(/^data:([^;]+);base64,/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const buf = Buffer.from(base64, 'base64');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(pj.nom)}"`);
  res.send(buf);
});

// ─────────────────────────────────────────
// SUPERVISEUR
// ─────────────────────────────────────────

app.get('/api/superviseur/stats', requireSuperviseur, async (req, res) => {
  const today = new Date().toLocaleDateString('fr-FR');
  const { rows: agents }   = await pool.query('SELECT id FROM agents');
  const { rows: pointages } = await pool.query('SELECT * FROM pointages WHERE date = $1', [today]);
  const presents = new Set(pointages.filter(p => p.type === 'entree').map(p => p.agent_id));
  const retards  = pointages.filter(p => {
    if (p.type !== 'entree') return false;
    const [h, m] = p.heure.split(':').map(Number);
    return h > HEURE_DEBUT || (h === HEURE_DEBUT && m > 0);
  }).length;
  res.json({ totalAgents: agents.length, presents: presents.size, absents: Math.max(0, agents.length - presents.size), retards });
});

app.get('/api/superviseur/agents', requireSuperviseur, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM agents ORDER BY nom');
  res.json(rows);
});

app.get('/api/superviseur/pointages-today', requireSuperviseur, async (req, res) => {
  const today = new Date().toLocaleDateString('fr-FR');
  const { rows } = await pool.query(
    'SELECT * FROM pointages WHERE date = $1 ORDER BY timestamp DESC', [today]
  );
  res.json(rows.map(rowToPointage));
});

app.get('/api/superviseur/pointages', requireSuperviseur, async (req, res) => {
  let query = 'SELECT * FROM pointages WHERE 1=1';
  const params = [];
  if (req.query.date) { params.push(req.query.date); query += ` AND date = $${params.length}`; }
  query += ' ORDER BY timestamp DESC';
  const { rows } = await pool.query(query, params);
  res.json(rows.map(rowToPointage));
});

app.get('/api/superviseur/demandes', requireSuperviseur, async (req, res) => {
  let query = 'SELECT * FROM demandes WHERE 1=1';
  const params = [];
  if (req.query.statut)  { params.push(req.query.statut);  query += ` AND statut = $${params.length}`; }
  if (req.query.service) { params.push(req.query.service); query += ` AND service = $${params.length}`; }
  query += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(query, params);
  res.json(rows.map(rowToDemande));
});

// Stub tunnel-info (pas de tunnel sur Railway — URL publique fixe)
app.get('/api/tunnel-info', (req, res) => {
  const base = process.env.PUBLIC_URL || '';
  res.json({
    badge:    base ? `${base}/badge`    : null,
    demandes: base ? `${base}/demandes` : null,
    actif:    !!base
  });
});

app.get('/api/public-url', requireAuth, (req, res) => {
  const base = process.env.PUBLIC_URL || '';
  res.json({
    urlLocale:   `${base}/demandes`,
    urlPublique: base ? `${base}/demandes` : null,
    tunnel:      !!base
  });
});

// ─────────────────────────────────────────
// PAGES
// ─────────────────────────────────────────
app.get('/login',            (_, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/badge',            (_, res) => res.sendFile(path.join(__dirname, 'public', 'badge.html')));
app.get('/affichage',        (_, res) => res.sendFile(path.join(__dirname, 'public', 'affichage.html')));
app.get('/demandes',         (_, res) => res.sendFile(path.join(__dirname, 'public', 'demandes.html')));
app.get('/affichage-mobile', (_, res) => res.sendFile(path.join(__dirname, 'public', 'affichage-mobile.html')));
app.get('/superviseur',      (_, res) => res.sendFile(path.join(__dirname, 'public', 'superviseur.html')));
app.get('/admin', requireAuth, (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => req.session && req.session.user ? res.redirect('/admin') : res.redirect('/login'));

// ── WebSocket ──
io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

// ── Helpers de conversion lignes DB → objets ──
function rowToPointage(r) {
  // Recalcul dynamique du retard selon HEURE_DEBUT (ignore la valeur stockée)
  let retard = false;
  if (r.type === 'entree' && r.heure) {
    const [h, m] = r.heure.split(':').map(Number);
    retard = h > HEURE_DEBUT || (h === HEURE_DEBUT && m > 0);
  }
  return {
    id: r.id, agentId: r.agent_id, nom: r.nom, prenom: r.prenom,
    nom_complet: r.nom_complet, poste: r.poste, service: r.service,
    date: r.date, heure: r.heure, type: r.type, retard,
    photo: r.photo, source: r.source, timestamp: r.timestamp
  };
}

function rowToDemande(r) {
  return {
    id: r.id, agentId: r.agent_id, nom: r.nom, service: r.service,
    type: r.type, dateDebut: r.date_debut, dateFin: r.date_fin,
    heure: r.heure, motif: r.motif, tel: r.tel,
    piecesJointes: r.pieces_jointes || [],
    statut: r.statut, commentaire: r.commentaire,
    traitePar: r.traite_par, traiteAt: r.traite_at,
    source: r.source, createdAt: r.created_at
  };
}

// ── Démarrage ──
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n  Serveur démarré sur le port ${PORT}`);
    console.log(`  Admin    : /admin`);
    console.log(`  Badge    : /badge`);
    console.log(`  Demandes : /demandes\n`);
  });
}).catch(err => {
  console.error('Erreur initialisation DB:', err.message);
  process.exit(1);
});
