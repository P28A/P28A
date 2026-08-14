// ELLX Wetter-Server: holt METAR/TAF von der offiziellen aviationweather.gov Data API
// (NOAA/FAA) und NOTAMs weiterhin von speedbird.online, stellt alles als JSON bereit.
// Start: npm install && npm start   (Node.js >= 18 wegen eingebautem fetch)

import express from 'express';
import * as cheerio from 'cheerio';

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

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function notamUrl(icao) {
  return `https://speedbird.online/airport_notam.php?airport=${icao}&date=${todayISO()}&view=Show`;
}

function parseNotams(html) {
  const $ = cheerio.load(html);
  const notams = [];
  $('.notam-card').each((i, el) => {
    const $el = $(el);
    const categories = [];
    $el.find('.nc-cat').each((j, catEl) => {
      const t = $(catEl).text().replace(/\s+/g, ' ').trim();
      if (t) categories.push(t);
    });
    const $clone = $el.clone();
    $clone.find('.notam-cats, .nc-cat').remove();
    const raw = $clone.text().replace(/\s+/g, ' ').trim();
    if (raw) notams.push({ categories, raw });
  });
  return notams;
}

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

async function fetchText(url) {
  return withRetry(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'ellx-wx-app/1.0' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.text();
  });
}

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
    const html = await fetchText(notamUrl(icao));
    const notams = parseNotams(html);
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
