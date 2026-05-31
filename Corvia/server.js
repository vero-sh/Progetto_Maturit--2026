require('dotenv').config();
const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // modulo SQLite integrato in Node.js 22+
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');
const Groq = require('groq-sdk');

const app = express();
const PORT = 3000;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Database ─────────────────────────────────────────────────────────────────
// DatabaseSync crea automaticamente il file se non esiste
const db = new DatabaseSync('database.sqlite');

// Creiamo le tabelle se non esistono ancora
db.exec(`
  CREATE TABLE IF NOT EXISTS utenti (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nome      TEXT    NOT NULL,
    email     TEXT    NOT NULL UNIQUE,
    password  TEXT    NOT NULL,
    eta       INTEGER NOT NULL,
    sesso     TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS misurazioni (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    peso      REAL    NOT NULL,
    altezza   REAL    NOT NULL,
    bmi       REAL    NOT NULL,
    bmr       INTEGER NOT NULL,
    data      TEXT    NOT NULL,
    nota      TEXT,
    FOREIGN KEY (user_id) REFERENCES utenti(id)
  );
`);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'salute2026secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // sessione dura 24 ore
}));

// Middleware: blocca le rotte protette se non si è loggati
function autenticato(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ errore: 'Devi fare login prima' });
  }
  next();
}

// ── Calcoli salute ────────────────────────────────────────────────────────────
function calcolaBMI(peso, altezza) {
  const altezzaMetri = altezza / 100;
  return parseFloat((peso / (altezzaMetri * altezzaMetri)).toFixed(1));
}

// Formula di Mifflin-St Jeor per il metabolismo basale
function calcolaBMR(peso, altezza, eta, sesso) {
  const base = (10 * peso) + (6.25 * altezza) - (5 * eta);
  if (sesso === 'M') return Math.round(base + 5);
  return Math.round(base - 161);
}

// ── API: Autenticazione ───────────────────────────────────────────────────────
app.post('/api/registrazione', async (req, res) => {
  const { nome, email, password, eta, sesso } = req.body;

  if (!nome || !email || !password || !eta || !sesso) {
    return res.status(400).json({ errore: 'Tutti i campi sono obbligatori' });
  }

  // Hash della password: non salviamo mai la password in chiaro
  const hash = await bcrypt.hash(password, 10);

  try {
    const stmt = db.prepare(
      'INSERT INTO utenti (nome, email, password, eta, sesso) VALUES (?, ?, ?, ?, ?)'
    );
    const result = stmt.run(nome, email, hash, parseInt(eta), sesso);
    req.session.userId = Number(result.lastInsertRowid);
    res.json({ successo: true, nome });
  } catch (err) {
    console.error('Errore registrazione:', err.message);
    if (err.message && err.message.includes('UNIQUE')) {
      res.status(400).json({ errore: 'Email già registrata' });
    } else {
      res.status(500).json({ errore: `Errore server: ${err.message}` });
    }
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const utente = db.prepare('SELECT * FROM utenti WHERE email = ?').get(email);

  if (!utente) {
    return res.status(401).json({ errore: 'Email o password errati' });
  }

  const ok = await bcrypt.compare(password, utente.password);
  if (!ok) {
    return res.status(401).json({ errore: 'Email o password errati' });
  }

  req.session.userId = Number(utente.id);
  res.json({ successo: true, nome: utente.nome });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ successo: true });
});

app.get('/api/utente', autenticato, (req, res) => {
  const utente = db.prepare(
    'SELECT id, nome, email, eta, sesso FROM utenti WHERE id = ?'
  ).get(req.session.userId);
  res.json(utente);
});

// ── API: Misurazioni ──────────────────────────────────────────────────────────
app.post('/api/misurazioni', autenticato, (req, res) => {
  const { peso, altezza, nota } = req.body;

  if (!peso || !altezza) {
    return res.status(400).json({ errore: 'Peso e altezza sono obbligatori' });
  }

  const utente = db.prepare('SELECT * FROM utenti WHERE id = ?').get(req.session.userId);
  const bmi = calcolaBMI(peso, altezza);
  const bmr = calcolaBMR(peso, altezza, utente.eta, utente.sesso);
  const data = new Date().toISOString().split('T')[0]; // formato YYYY-MM-DD

  const stmt = db.prepare(
    'INSERT INTO misurazioni (user_id, peso, altezza, bmi, bmr, data, nota) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(req.session.userId, peso, altezza, bmi, bmr, data, nota || null);

  res.json({ successo: true, id: Number(result.lastInsertRowid), bmi, bmr });
});

app.get('/api/misurazioni', autenticato, (req, res) => {
  const misurazioni = db.prepare(
    'SELECT * FROM misurazioni WHERE user_id = ? ORDER BY data DESC, id DESC'
  ).all(req.session.userId);
  res.json(misurazioni);
});

app.delete('/api/misurazioni/:id', autenticato, (req, res) => {
  db.prepare('DELETE FROM misurazioni WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.session.userId);
  res.json({ successo: true });
});

// ── API: Chat IA ─────────────────────────────────────────────────────────────
function categoriaBmiStr(bmi) {
  if (bmi < 18.5) return 'sottopeso';
  if (bmi < 25)   return 'normopeso';
  if (bmi < 30)   return 'sovrappeso';
  return 'obesità';
}

app.post('/api/chat', autenticato, async (req, res) => {
  const { messaggio, cronologia } = req.body;
  if (!messaggio) return res.status(400).json({ errore: 'Messaggio vuoto' });

  const utente = db.prepare('SELECT * FROM utenti WHERE id = ?').get(req.session.userId);

  const prima = db.prepare(
    'SELECT * FROM misurazioni WHERE user_id = ? ORDER BY data ASC, id ASC LIMIT 1'
  ).get(req.session.userId);

  const ultima = db.prepare(
    'SELECT * FROM misurazioni WHERE user_id = ? ORDER BY data DESC, id DESC LIMIT 1'
  ).get(req.session.userId);

  let contestoSalute;
  if (!prima) {
    contestoSalute = `Nome: ${utente.nome}, età: ${utente.eta} anni, sesso: ${utente.sesso === 'M' ? 'maschio' : 'femmina'}. Non ha ancora inserito misurazioni.`;
  } else if (prima.id === ultima.id) {
    contestoSalute = `Nome: ${utente.nome}, età: ${utente.eta} anni, sesso: ${utente.sesso === 'M' ? 'maschio' : 'femmina'}. BMI: ${ultima.bmi} 
    (${categoriaBmiStr(ultima.bmi)}), peso: ${ultima.peso} kg, altezza: ${ultima.altezza} cm, metabolismo basale: ${ultima.bmr} kcal/giorno.`;
  } else {
    contestoSalute = `Nome: ${utente.nome}, età: ${utente.eta} anni, sesso: ${utente.sesso === 'M' ? 'maschio' : 'femmina'}. BMI iniziale: ${prima.bmi} (${categoriaBmiStr(prima.bmi)}), 
    peso iniziale: ${prima.peso} kg. BMI attuale: ${ultima.bmi} (${categoriaBmiStr(ultima.bmi)}), peso attuale: ${ultima.peso} kg, altezza: ${ultima.altezza} cm, 
    metabolismo basale attuale: ${ultima.bmr} kcal/giorno.`;
  }

  const systemPrompt = `Il tuo nome è Corvi. Sei l'assistente IA dell'app Corvia per il monitoraggio della salute. Se ti chiedono come ti chiami, rispondi solo "Corvi". 
  Rispondi sempre in italiano in modo amichevole, pratico e motivante. Considera sempre i dati aggiornati dell'utente, non quelli iniziali. Dati dell'utente: ${contestoSalute}`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        ...(cronologia || []).slice(-20),
        { role: 'user', content: messaggio }
      ],
      max_tokens: 1024
    });
    res.json({ risposta: completion.choices[0].message.content });
  } catch (err) {
    console.error('Errore Groq:', err.message);
    res.status(500).json({ errore: `Errore API: ${err.message}` });
  }
});

// ── Pagine HTML ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Avvio server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server avviato su http://localhost:${PORT}`);
});
