// ELLX Wetter-Server: holt METAR/TAF von der offiziellen aviationweather.gov Data API
// (NOAA/FAA) und NOTAMs von der autorouter.aero API (Eurocontrol EAD/INO-Daten).
// Start: npm install && npm start   (Node.js >= 18 wegen eingebautem fetch)
//
// Für die NOTAM-API werden zwei Umgebungsvariablen benötigt:
//   AUTOROUTER_CLIENT_ID     = deine autorouter-Account-E-Mail-Adresse
//   AUTOROUTER_CLIENT_SECRET = dein autorouter-Account-Passwort
//
// WICHTIG: Laut autorouter-Doku muss der API-Zugriff für deinen Account zusätzlich erst
// von autorouter selbst freigeschaltet werden (Support-Ticket auf autorouter.aero stellen,
// "API access" anfordern) – ein reiner Account reicht für die OAuth2-Anmeldung nicht aus.
// Quelle: https://www.autorouter.aero/wiki/api/authentication/

import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: erlaubt nur der App auf GitHub Pages, diesen Server anzufragen
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://p28a.github.io');
  res.header('Access-Control-Allow-Methods', 'GET');
  next();
});

// Offizielle NOAA/FAA Aviation Weather Center Data API (kein API-Key nötig)
const METAR_URL = 'https://aviationweather.gov/api/data/metar?ids=ELLX&format=json';
const TAF_URL = 'https://aviationweather.gov/api/data/taf?ids=ELLX&format=json';

// --- autorouter.aero NOTAM-API ---------------------------------------------------
const AUTOROUTER_API = 'https://api.autorouter.aero/v1.0';
const AUTOROUTER_CLIENT_ID = process.env.AUTOROUTER_CLIENT_ID;
const AUTOROUTER_CLIENT_SECRET = process.env.AUTOROUTER_CLIENT_SECRET;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Führt fn() bis zu maxAttempts mal aus, mit kurzer Pause dazwischen. Gibt beim letzten
// Fehlschlag den Fehler weiter (wird von den aufrufenden .catch()-Stellen abgefangen).
async function withRetry(fn, maxAttempts = 2, delayMs = 500) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function fetchJson(url) {
  return withRetry(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'ellx-wx-app/1.0', 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  });
}

// Zwischengespeicherter OAuth2-Token (client_credentials-Flow), da Tokens laut Doku
// 1h gültig sind und nur begrenzt viele gleichzeitig ausgestellt werden dürfen (aktuell
// max. 20) – wir dürfen also nicht bei jedem Request einen neuen anfordern.
let autorouterToken = null; // { accessToken, expiresAt }

// Läuft bereits eine Token-Anfrage, teilen sich alle wartenden Aufrufer dieselbe
// Promise, statt selbst eine eigene HTTP-Anfrage an /oauth2/token zu schicken. Ohne das
// fordern z.B. die drei parallelen NOTAM-Requests der Briefing-Seite (ELLX/EBBU/
// Alternate) bei abgelaufenem Token jeweils einen EIGENEN neuen Token an, statt sich
// einen zu teilen – über mehrere App-Aufrufe (und Render-Neustarts, die
// autorouterToken im RAM auf null zurücksetzen) summiert sich das schnell auf das
// autorouter-Limit von 20 gleichzeitig aktiven Tokens ("too many active access
// tokens").
let tokenRequestPromise = null;

async function requestAutorouterToken() {
  if (!AUTOROUTER_CLIENT_ID || !AUTOROUTER_CLIENT_SECRET) {
    throw new Error('AUTOROUTER_CLIENT_ID / AUTOROUTER_CLIENT_SECRET sind nicht gesetzt.');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: AUTOROUTER_CLIENT_ID,
    client_secret: AUTOROUTER_CLIENT_SECRET,
  });
  const res = await fetch(`${AUTOROUTER_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    const desc = data && data.error_description ? data.error_description : `HTTP ${res.status}`;
    throw new Error(`autorouter-Login fehlgeschlagen: ${desc}`);
  }
  // Sicherheitspuffer von 60s, damit der Token nicht mitten in einem Request abläuft
  const expiresAt = Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000;
  autorouterToken = { accessToken: data.access_token, expiresAt };
  return autorouterToken.accessToken;
}

// Liefert einen gültigen Token, fordert nur bei Bedarf (abgelaufen/keiner vorhanden) einen
// neuen an. forceRefresh wird nach einem 403 (ungültiger Token) genutzt.
async function getAutorouterToken(forceRefresh = false) {
  if (!forceRefresh && autorouterToken && Date.now() < autorouterToken.expiresAt) {
    return autorouterToken.accessToken;
  }
  if (forceRefresh) {
    // Ein erzwungener Refresh darf nicht auf eine evtl. bereits laufende reguläre
    // Anfrage warten, die noch den (gerade als ungültig erkannten) alten Token liefern
    // könnte - stattdessen wird eine frische Anfrage gestartet.
    tokenRequestPromise = null;
  }
  if (!tokenRequestPromise) {
    tokenRequestPromise = requestAutorouterToken().finally(() => {
      tokenRequestPromise = null;
    });
  }
  return tokenRequestPromise;
}

// Grober Nachbau der Q-Code-Subject-Gruppe (2./3. Buchstabe des Q-Codes) für die
// gängigsten Bewegungsflächen-NOTAMs, passend zu den Kategorien, die die App fürs
// Sortieren nutzt (RWY/TWY, NAV, FAC, PROC, OBST). Unbekannte Codes werden unverändert
// als Badge durchgereicht, statt eine falsche Kategorie zu erfinden.
const Q_SUBJECT_LABELS = {
  MR: 'RWY', MN: 'APRON', MX: 'TWY', MP: 'STAND', MK: 'STAND', MD: 'DECL DIST',
  MW: 'RWY WIP', MS: 'MARKING', MH: 'HELIPAD', MT: 'THR',
  NB: 'NAV (NDB)', NV: 'NAV (VOR)', ND: 'NAV (DME)', NT: 'NAV (TACAN)', NM: 'NAV (MKR)',
  NN: 'NAV (GNSS)', NL: 'NAV (LOC)', NG: 'NAV (GP)',
  FA: 'AD', FF: 'FIRE/RESCUE', FU: 'FUEL', FM: 'METEO', FL: 'LIGHTING',
  IC: 'PROC (ILS)', IN: 'PROC', PA: 'PROC',
  OB: 'OBST', OL: 'OBST (LGT)',
  AC: 'ATC', CA: 'ATC', CM: 'COMM',
};

function qSubjectLabel(code23) {
  if (!code23) return null;
  const key = String(code23).trim().toUpperCase();
  return Q_SUBJECT_LABELS[key] || key || null;
}

function unixToNotamDate(sec) {
  if (sec === null || sec === undefined) return null;
  const d = new Date(sec * 1000);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = months[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd} ${mon} ${yyyy} ${hh}:${mm}`;
}

// PERM-Erkennung: autorouter setzt für unbefristete NOTAMs eine sehr weit in der Zukunft
// liegende endvalidity (Default-Obergrenze ist 2^32-1). Alles jenseits von ~20 Jahren ab
// jetzt wird als "PERM" statt als konkretes Datum angezeigt.
function endValidityText(endvalidity) {
  const twentyYearsFromNow = Math.floor(Date.now() / 1000) + 20 * 365 * 24 * 3600;
  if (!endvalidity || endvalidity > twentyYearsFromNow) return 'PERM';
  return unixToNotamDate(endvalidity) + 'Z';
}

// Baut aus einer autorouter-NOTAM-Zeile das von der App erwartete "raw"-Textformat:
// "{ID}/{YY} Active {Start}Z → {Ende}Z {Beschreibung}" (siehe renderNotamList in index.html)
function formatAutorouterNotam(row) {
  const idPart = `${row.series || ''}${String(row.number || '').padStart(4, '0')}/${String(row.year || '').padStart(2, '0')}`;
  const startText = unixToNotamDate(row.startvalidity) + 'Z';
  const endText = endValidityText(row.endvalidity);
  const desc = (row.iteme || '').replace(/\s+/g, ' ').trim();
  const raw = `${idPart} Active ${startText} → ${endText} ${desc}`;

  const categories = [];
  const subjLabel = qSubjectLabel(row.code23);
  if (subjLabel) categories.push(subjLabel);

  return { categories, raw };
}

// Holt alle NOTAMs für einen ICAO-/FIR-Code von autorouter (mit Pagination), gefiltert auf
// aktuell/zukünftig gültige (startvalidity = jetzt) und ohne vom Nutzer unterdrückte NOTAMs.
async function fetchAutorouterNotams(icao, attempt = 1) {
  const token = await getAutorouterToken();
  const nowSec = Math.floor(Date.now() / 1000);
  const limit = 100;
  let offset = 0;
  let total = Infinity;
  const rows = [];

  while (offset < total && rows.length < 500) {
    const url = `${AUTOROUTER_API}/notam?itemas=${encodeURIComponent(JSON.stringify([icao]))}` +
      `&offset=${offset}&limit=${limit}&startvalidity=${nowSec}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });

    if (res.status === 403 && attempt === 1) {
      // Token ungültig/abgelaufen -> einmal neu anfordern und den kompletten Abruf wiederholen
      await getAutorouterToken(true);
      return fetchAutorouterNotams(icao, attempt + 1);
    }
    if (!res.ok) throw new Error(`autorouter NOTAM-Abruf fehlgeschlagen -> HTTP ${res.status}`);

    const data = await res.json();
    total = typeof data.total === 'number' ? data.total : (data.rows || []).length;
    rows.push(...(data.rows || []));
    offset += limit;
    if (!data.rows || !data.rows.length) break; // Sicherheitsnetz gegen Endlosschleifen
  }

  return rows
    .filter(r => !r.suppressed)
    .map(formatAutorouterNotam);
}
// -----------------------------------------------------------------------------------

app.get('/api/wx/ellx', async (req, res) => {
  try {
    const [metarResult, tafResult] = await Promise.all([
      fetchJson(METAR_URL).then(data => ({ ok: true, data })).catch(err => ({ ok: false, err })),
      fetchJson(TAF_URL).then(data => ({ ok: true, data })).catch(err => ({ ok: false, err })),
    ]);

    // aviationweather.gov liefert ein Array (meist mit 1 Eintrag für den aktuellsten Report)
    let metar = null, metarError = null;
    if (!metarResult.ok) {
      metarError = 'METAR-Abruf fehlgeschlagen: ' + metarResult.err.message;
    } else if (!Array.isArray(metarResult.data) || !metarResult.data.length) {
      metarError = 'Kein aktuelles METAR für ELLX verfügbar.';
    } else {
      metar = metarResult.data[0].rawOb;
    }

    let taf = null, tafError = null;
    if (!tafResult.ok) {
      tafError = 'TAF-Abruf fehlgeschlagen: ' + tafResult.err.message;
    } else if (!Array.isArray(tafResult.data) || !tafResult.data.length) {
      tafError = 'Kein aktuelles TAF für ELLX verfügbar.';
    } else {
      taf = tafResult.data[0].rawTAF;
    }

    if (!metar && !taf) {
      return res.status(502).json({
        error: 'Konnte METAR/TAF nicht von aviationweather.gov abrufen.',
        metarError,
        tafError,
      });
    }

    res.json({
      icao: 'ELLX',
      metar,
      metarError,
      taf,
      tafError,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Abruf fehlgeschlagen', details: err.message });
  }
});

// Generische NOTAM-Route für beliebige ICAO-/FIR-Codes, z.B. /api/notams/EBBU (Brussels FIR)
app.get('/api/notams/:icao', async (req, res) => {
  const icao = String(req.params.icao || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) {
    return res.status(400).json({ error: 'Ungültiger ICAO-/FIR-Code' });
  }
  try {
    const notams = await fetchAutorouterNotams(icao);
    res.json({
      icao,
      notams,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Abruf fehlgeschlagen', details: err.message });
  }
});

app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
