# Julbudget 2026

Lösenordsskyddad budgetöversikt för julen. Sidan är statisk (GitHub Pages) och
allt innehåll är krypterat i webbläsaren med AES-256-GCM – utan lösenord syns
varken namn, belopp eller kvitton.

## Så funkar det

| Fil | Publiceras? | Vad |
|---|---|---|
| `budget.json` | nej | budget, personer och alla utgifter (klartext) |
| `kvitton/` | nej | originalkvitton |
| `.losenord.json` | nej | lösenorden + nyckel för kvitton |
| `src/app.html` | ja | sidans mall |
| `build.mjs` | ja | krypterar och bygger |
| `index.html`, `k/*.bin` | ja | den krypterade sidan och krypterade kvitton |

```bash
node build.mjs --check   # kontrollera budget.json
node build.mjs           # bygg index.html + k/
git add -A && git commit -m "Uppdatera julbudgeten" && git push
```

## Två vyer

- **Full** – allt.
- **Delad** – utgifter med `"hemlig": true` visas som *Hemlig present* utan
  butik, beskrivning eller kvitto. Belopp och mottagare finns kvar så att
  summorna stämmer.

Vilket lösenord man skriver avgör vilken vy man får. En länk som slutar på
`#l=<lösenord>` öppnar sidan direkt och kommer ihåg lösenordet på enheten.

## En utgift i budget.json

```json
{
  "datum": "2026-11-20",
  "butik": "Prisma",
  "beskrivning": "Lego",
  "belopp": 39.90,
  "kategori": "present",
  "till": ["adam"],
  "status": "köpt",
  "kvitto": "kvitton/prisma-2026-11-20.jpg",
  "hemlig": false,
  "anteckning": ""
}
```

- `kategori`: `present`, `mat`, `dekoration` eller `ovrigt`
- `till`: en eller flera personer (beloppet delas lika), eller utelämnas för mat/dekor
- `status`: `köpt` (standard) eller `planerad`
- `kvitto`: en fil eller en lista; samma kvitto kan delas av flera rader
- Nya personer läggs till i `personer` med en `grupp` (Familj, Gudbarn, Övriga)
