# APITRON — ghid de performanță maximă

Toate cifrele de mai jos sunt măsurate (Node v22, Xeon 2 nuclee, benchmark
pereche-întrețesut față de JSON nativ, mediana a 15 runde). **Raportul este
TRON/JSON — sub 1.00 înseamnă că TRON e mai rapid.**

---

## 1. Alege modul corect — asta contează cel mai mult

| situație | folosește | decode | encode | round-trip | tokeni |
|---|---|---:|---:|---:|---:|
| API intern (ambele capete codul tău) | **`defineSchema`** | 0.40–0.87x | 0.66–0.93x | 0.57–0.91x | 11–61% |
| Prompt LLM / consumator terț | **`encode`/`decode`** | 0.45–0.77x | 0.97–1.77x | 0.76–1.22x | 26–61% |
| Date numerice/columnare | **`decodeColumnar`** | ~0.30x | — | — | 35% |
| Payload sub ~1 KB | **JSON simplu** | — | — | — | 0% |

Diferența dintre modul cu schemă și cel auto-descriptiv este **cea mai mare
optimizare disponibilă** — mai mare decât orice reglaj fin. Modul cu schemă
câștigă pe toate axele, la orice dimensiune.

---

## 2. PRELOAD o singură dată, la pornirea aplicației

Greșeala numărul unu este să compilezi schema la fiecare cerere. `defineSchema`
face muncă reală: rezolvă ordinea câmpurilor, tabelele de enum, calea și
**compilează constructorul de rând cu `new Function`**. Fă asta o singură dată.

```js
// schemas.js — modul la nivel de aplicație, evaluat o singură dată
const { defineSchema } = require('apitron');

exports.users = defineSchema({
  id: 'users.v1',
  fields: ['id', 'name', 'role', 'region', 'score', 'active'],
  enums: {
    role: ['admin', 'user', 'editor'],
    region: ['us-east-1', 'eu-west-1'],
    active: [false, true],
  },
  path: '$.data',
});
```

```js
// handler — per cerere, doar encode/decode
const { users } = require('./schemas');
app.get('/users', (req, res) => {
  res.type('text/plain').send(users.encode({ meta: {...}, data: rows }));
});
```

**Efect măsurat** (envelope, 25 de rânduri): decode 1.21x → **0.63x**,
encode 2.49x → **0.90x**. Pe payload-uri mici, compilarea per-cerere e diferența
dintre a pierde și a câștiga.

---

## 3. Declară `enums` pentru coloanele cu puține valori distincte

Orice coloană de string/boolean cu cardinalitate mică (status, rol, regiune,
tip, flag-uri) devine un întreg pe fir.

```js
enums: { status: ['ok', 'retried', 'failed'], active: [false, true] }
```

Trei efecte simultane:
1. **Mai puțini tokeni** — `events-10k`: 38% → **42%**.
2. **Decode mai rapid** — nu se mai alocă string-uri pentru coloana aceea.
3. **Deblochează WASM** — o coloană de tip dicționar este un întreg pe fir, deci
   un tabel cu string-uri devine eligibil pentru scanerul WASM. `tabular-10k`
   este *respins* de WASM fără dicționare și **acceptat** cu ele.

**Restricție:** valorile din `enums` trebuie să fie string sau boolean.
Valorile numerice sunt respinse explicit — ar fi ambigue cu indicii de dicționar
și s-ar decoda ca `undefined`.

---

## 4. Nu codifica payload-uri mici

`encode()` are deja un prag de 1 KB și returnează JSON simplu sub el; `decode()`
îl citește transparent. Nu-l dezactiva fără motiv.

| rânduri | JSON | decode | round-trip |
|---:|---:|---:|---:|
| 5 | 0.5 KB | 4.80x | 5.16x |
| 25 | 2.1 KB | 1.21x | 1.70x |
| 100 | 8.4 KB | **0.78x** | 1.16x |
| 1000 | 86 KB | **0.68x** | **1.01x** |
| 10000 | 881 KB | **0.67x** | **0.94x** |

(Modul auto-descriptiv. Cu schemă preîncărcată pragul dispare — vezi §1.)

---

## 5. Când datele sunt numerice, ia banda columnară

Cea mai rapidă cale din bibliotecă. Nu construiește deloc obiecte JS.

**Atenție:** trebuie emis cu `encodeColumnar()`. Ieșirea implicită a lui
`encode()` conține declarații `table` (corp JSON simplu), pe care scanerul WASM
nu le acceptă — `decodeColumnar` va returna `undefined` pentru ea.

```js
const wire = encodeColumnar(rows);            // server
const col  = decodeColumnar(wire, /* copy */ true);   // client
if (col) {
  // acces row-major: valoarea coloanei c din rândul r
  const v = col.tape[r * col.cols + c];
} else {
  const obj = decode(wire);   // nu era eligibil, cale normală
}
```

**~0.30x față de `JSON.parse`** (de ~3.3 ori mai rapid). `copy: true` detașează
banda din memoria WASM — fără el, următorul apel de decode o invalidează.

---

## 6. Reține că `table: 'nested'` schimbă viteza pe tokeni

Implicit (`table: true`) tabelizează doar rândurile plate: câștig pur, și mai
rapid și mai puțini tokeni. `'nested'` acceptă și rânduri cu obiecte imbricate —
mai rapid, dar formele interioare își pierd compresia proprie.

Măsurat pe `nested-500`: round-trip 2.47x → **0.89x**, dar tokenii scad de la
**26% → 11%**. Alege în funcție de ce plătești: latență sau tokeni.

---

## 7. Detalii de runtime care contează

- **`new Function`** — trampolina și constructorii de rând îl folosesc. Sub un
  CSP strict fără `unsafe-eval` biblioteca revine automat la scaner
  (`parseFast`), ~1.1–1.5x. Funcționează corect, doar mai lent.
- **WASM este opțional.** În Node se încarcă singur. În browser trimite tu
  binarul: `setWasmBinary(await (await fetch('/parserTron2.wasm')).arrayBuffer())`.
  Fără el nimic nu se strică — dispecerul pur și simplu nu ia calea WASM.
- **Trimite `Content-Type: text/plain`** (sau un tip propriu, ex.
  `application/vnd.tron`). Nu `application/json` — corpul poate conține un
  preambul care nu e JSON valid.
- **Compresia HTTP se aplică în continuare.** TRON reduce octeții *înainte* de
  gzip/brotli; câștigurile se compun, dar mai puțin decât liniar.
- **Nu re-encoda ce nu s-a schimbat.** Răspunsurile cacheabile se codifică o
  dată; costul de encode dispare complet și rămâne doar câștigul la decode.

---

## 8. Listă de verificare

- [ ] `defineSchema` apelat o singură dată, la pornire, nu per cerere
- [ ] `enums` declarate pentru toate coloanele categorice și booleene
- [ ] Payload-urile sub ~1 KB rămân JSON (pragul implicit se ocupă)
- [ ] `encodeColumnar` + `decodeColumnar` folosite împreună acolo unde datele sunt numerice
- [ ] `Content-Type` setat pe `text/plain`, nu `application/json`
- [ ] În browser: `setWasmBinary` apelat, sau acceptat conștient fallback-ul
- [ ] Măsoară cu propriile date înainte de a te baza pe aceste cifre

---

## 9. Metodologie (ca să poți reproduce)

Benchmark-ul naiv dădea rezultate contradictorii — două căi de cod identice
difereau cu 43% — pentru că rularea mai multor decodoare în același proces face
inline cache-urile V8 polimorfe. Cifrele de aici sunt măsurate cu:

- **un proces copil per set de date**, ca V8 să optimizeze pentru o singură formă;
- **pereche întrețesută** față de echivalentul JSON nativ (A/B/A/B, cu ordinea
  alternată), ca ambele părți să vadă aceleași condiții;
- **mediana a 15 runde**.

Milisecundele absolute depind de mașină; **rapoartele** sunt semnalul.

Corectitudinea: **220.118 verificări** adversariale și fuzz pe suita completă,
plus 22 de teste dedicate modului cu schemă și 1.500 de round-trip-uri fuzz — 0
eșecuri.
