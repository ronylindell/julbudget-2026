#!/usr/bin/env node
// Bygger den publicerade julbudgeten.
//
//   node build.mjs            läs budget.json + kvitton/, skriv index.html och k/*.bin
//   node build.mjs --check    validera bara, skriv ingenting
//
// Allt som publiceras är krypterat (AES-256-GCM, nyckel från lösenord via
// PBKDF2-SHA256). Klartext (budget.json, kvitton/, .losenord.json) är gitignorerad.
//
// Två vyer byggs, var och en med sitt eget lösenord:
//   full   – allt
//   delad  – utgifter med "hemlig": true visas som "Hemlig present" utan butik,
//            beskrivning eller kvitto. Belopp och mottagare finns kvar så att
//            summorna stämmer.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = new URL('.', import.meta.url).pathname;
const CHECK_ONLY = process.argv.includes('--check');
const ITER = 310000;

const p = (...a) => join(ROOT, ...a);
const fail = (msg) => { console.error('FEL: ' + msg); process.exitCode = 1; };
const warn = (msg) => console.warn('OBS: ' + msg);

// ---------- läs och validera ----------
const budget = JSON.parse(readFileSync(p('budget.json'), 'utf8'));
const katIds = new Set(budget.kategorier.map(k => k.id));
const perIds = new Set();
for (const per of budget.personer) {
  if (perIds.has(per.id)) fail(`personen "${per.id}" finns två gånger`);
  perIds.add(per.id);
  if (!budget.grupper.includes(per.grupp)) fail(`${per.namn}: okänd grupp "${per.grupp}" (lägg till den i "grupper")`);
}

const utgifter = budget.utgifter.map((u, i) => {
  const ref = `utgift #${i + 1} (${u.beskrivning ?? '?'})`;
  const till = u.till == null ? [] : Array.isArray(u.till) ? u.till : [u.till];
  if (typeof u.belopp !== 'number' || !(u.belopp >= 0)) fail(`${ref}: belopp måste vara ett tal ≥ 0`);
  if (!katIds.has(u.kategori)) fail(`${ref}: okänd kategori "${u.kategori}"`);
  for (const t of till) if (!perIds.has(t)) fail(`${ref}: okänd person "${t}" (lägg till i "personer")`);
  if (u.datum && !/^\d{4}-\d{2}-\d{2}$/.test(u.datum)) fail(`${ref}: datum ska vara ÅÅÅÅ-MM-DD`);
  const status = u.status ?? 'köpt';
  if (!['köpt', 'planerad'].includes(status)) fail(`${ref}: status ska vara "köpt" eller "planerad"`);
  const kvitton = u.kvitto == null ? [] : Array.isArray(u.kvitto) ? u.kvitto : [u.kvitto];
  for (const k of kvitton) if (!existsSync(p(k))) fail(`${ref}: kvittot "${k}" finns inte`);
  return {
    id: i + 1,
    datum: u.datum ?? null,
    butik: u.butik ?? '',
    beskrivning: u.beskrivning ?? '',
    belopp: Math.round(u.belopp * 100) / 100,
    kategori: u.kategori,
    till,
    status,
    hemlig: !!u.hemlig,
    anteckning: u.anteckning ?? '',
    kvitton,
  };
});

// Kvitton i mappen som ingen utgift pekar på – bra att se när nya lagts in.
const used = new Set(utgifter.flatMap(u => u.kvitton).map(k => basename(k)));
const loose = readdirSync(p('kvitton')).filter(f => !f.startsWith('.') && f !== 'LÄS MIG.txt' && !used.has(f));
if (loose.length) warn(`kvitton som inte är kopplade till någon utgift:\n  ${loose.join('\n  ')}`);

if (process.exitCode) process.exit(1);

// Sammanfattning i terminalen
const sum = (arr) => arr.reduce((s, u) => s + u.belopp, 0);
const kopt = sum(utgifter.filter(u => u.status === 'köpt'));
const plan = sum(utgifter.filter(u => u.status === 'planerad'));
console.log(`${utgifter.length} utgifter · köpt ${kopt.toFixed(2)} € · planerat ${plan.toFixed(2)} € · kvar ${(budget.maxbudget - kopt).toFixed(2)} € av ${budget.maxbudget} €`);
if (CHECK_ONLY) process.exit(0);

// ---------- lösenord ----------
const pwFile = p('.losenord.json');
let secrets;
if (existsSync(pwFile)) {
  secrets = JSON.parse(readFileSync(pwFile, 'utf8'));
} else {
  const gen = () => {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    const b = crypto.randomBytes(12);
    return [0, 4, 8].map(o => [...b.subarray(o, o + 4)].map(x => a[x % a.length]).join('')).join('-');
  };
  secrets = { full: gen(), delad: gen(), kvittonyckel: crypto.randomBytes(32).toString('base64') };
  writeFileSync(pwFile, JSON.stringify(secrets, null, 2) + '\n');
  console.log(`Nya lösenord skapade i .losenord.json\n  full:  ${secrets.full}\n  delad: ${secrets.delad}`);
}
const master = Buffer.from(secrets.kvittonyckel, 'base64');

// ---------- kvitton ----------
mkdirSync(p('k'), { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'julkvitto-'));
const receiptInfo = new Map(); // sökväg -> {fil, nyckel, typ, namn}
const IMG = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff']);

for (const k of new Set(utgifter.flatMap(u => u.kvitton))) {
  const ext = extname(k).toLowerCase();
  let data, typ;
  if (IMG.has(ext)) {
    // Skala ner och gör om till JPEG (HEIC från iPhone visas inte i alla webbläsare).
    const out = join(tmp, crypto.randomUUID() + '.jpg');
    execFileSync('sips', ['-Z', '1800', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', p(k), '--out', out], { stdio: 'ignore' });
    data = readFileSync(out); typ = 'image/jpeg';
  } else if (ext === '.pdf') {
    data = readFileSync(p(k)); typ = 'application/pdf';
  } else {
    fail(`kvittot "${k}" har ett format som inte stöds (${ext})`); continue;
  }
  // Deterministisk nyckel per innehåll -> samma kvitto ger samma fil, ingen onödig git-ändring.
  const h = crypto.createHmac('sha256', master).update(data).digest();
  const key = h.subarray(0, 32);
  const iv = crypto.createHash('sha256').update(h).digest().subarray(0, 12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]);
  const fil = crypto.createHash('sha256').update(enc).digest('hex').slice(0, 20) + '.bin';
  writeFileSync(p('k', fil), enc);
  receiptInfo.set(k, { fil, nyckel: key.toString('base64'), typ, namn: basename(k) });
}
rmSync(tmp, { recursive: true, force: true });
const keep = new Set([...receiptInfo.values()].map(r => r.fil));
for (const f of readdirSync(p('k'))) if (!keep.has(f)) unlinkSync(p('k', f));
if (process.exitCode) process.exit(1);

// ---------- vyer ----------
const secretReceipts = new Set(utgifter.filter(u => u.hemlig).flatMap(u => u.kvitton));
function view(name) {
  const delad = name === 'delad';
  return {
    vy: name,
    byggd: new Date().toISOString(),
    titel: budget.titel,
    maxbudget: budget.maxbudget,
    kategorier: budget.kategorier,
    grupper: budget.grupper,
    personer: budget.personer,
    utgifter: utgifter.map(u => {
      const kv = u.kvitton.filter(k => !(delad && secretReceipts.has(k))).map(k => receiptInfo.get(k));
      if (delad && u.hemlig) {
        return { ...u, beskrivning: 'Hemlig present', butik: '', anteckning: '', kvitton: [] };
      }
      return { ...u, kvitton: kv };
    }),
  };
}

function encrypt(obj, pw) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pw, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}

const bundles = [encrypt(view('full'), secrets.full), encrypt(view('delad'), secrets.delad)];
const tpl = readFileSync(p('src', 'app.html'), 'utf8');
const html = tpl
  .replace('/*__ITER__*/', String(ITER))
  .replace('/*__BUNDLES__*/', JSON.stringify(bundles));
writeFileSync(p('index.html'), html);
console.log(`Byggt: index.html + ${keep.size} krypterade kvitton i k/`);
