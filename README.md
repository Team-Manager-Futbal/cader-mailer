# Cader Mailer

Interný nástroj tímu Cader na **individuálne** e-mailové oslovovanie (napr. futbalových klubov, typicky 50–200 kontaktov na kampaň). Každý príjemca dostane samostatný e-mail s jedným `To`, s identifikáciou odosielateľa a bezplatným odhlásením.

- **Frontend:** React + TypeScript + Tailwind, statický web na GitHub Pages (len prihlásení používatelia).
- **Backend:** Supabase – Auth (len na pozvánku), PostgreSQL s RLS, Edge Functions (SMTP, admin akcie, fronta), pg_cron.
- **Odosielanie:** SMTP cez SSL/TLS (Seznam `smtp.seznam.cz:465`) **len zo servera**. Heslá sú zašifrované (AES-256-GCM) a nikdy nejdú do prehliadača ani do Gitu.

> **Stav:** kód, migrácie a testy sú hotové a overené lokálne. Skutočné SMTP spojenie zo Supabase, cron a doručenie testovacej správy **ešte neboli overené**. Overíte ich podľa [docs/SETUP_CHECKLIST.md](docs/SETUP_CHECKLIST.md). Kým to neurobíte, považujte odosielanie za neoverené.

## Architektúra

```
 Prehliadač (GitHub Pages, verejný JS)          Supabase
 ┌──────────────────────────┐   JWT + RLS    ┌───────────────────────────────────────────┐
 │ React app (HashRouter)    │──────────────▶│ PostgREST / RPC  ── RLS na každej tabuľke │
 │ publishable key           │               │                                           │
 │ ŽIADNE tajomstvá          │──────────────▶│ Edge Functions:                           │
 └──────────────────────────┘   JWT         │   admin-users, sender-admin, send-test    │
                                             │   unsubscribe (verejná, len POST)         │
 Príjemca ── klik na odkaz ──▶ /#/odhlasenie │                                           │
                                             │ pg_cron (1×/min) ─▶ process-queue         │
                                             │   (x-cron-secret z Vaultu)                │
                                             │        │ claim_due_recipients()          │
                                             │        │ FOR UPDATE SKIP LOCKED, limity   │
                                             │        ▼                                  │
                                             │   SMTP/TLS 465 ─────────────────────────────▶ smtp.seznam.cz
                                             └───────────────────────────────────────────┘
```

Podrobnosti: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Bezpečnosť: [docs/SECURITY.md](docs/SECURITY.md). Prevádzka: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Čo aplikácia vie

- **Prihlásenie len na pozvánku**, roly `admin` / `member` uložené v databáze, obnova hesla, odhlásenie, deaktivácia účtu.
- **Kampane:** koncept → kontrola → naplánovanie (čas v `Europe/Bratislava`, ošetrený prechod letného/zimného času) alebo spustenie hneď. Pozastavenie, pokračovanie, zrušenie a návrat do konceptu sa uplatňujú priamo vo fronte na serveri.
- **Import kontaktov:** vloženie textu (nový riadok, čiarka, bodkočiarka, „Meno <email>“, tabuľka z Excelu), `.csv`, `.xlsx`. Mapovanie stĺpcov `email`, `meno`, `klub`, `pozicia` (aj slovenské varianty hlavičiek). Náhľad s počtom platných, neplatných, duplicitných a odhlásených. Server všetko overí znova.
- **Text a náhľad:** polia `{meno}`, `{klub}`, `{pozicia}` s náhradnou hodnotou `{meno|pán tréner}`. Náhľad pre konkrétneho príjemcu a upozornenia na chýbajúce údaje. Len čistý text, nikdy HTML z importu.
- **Testovací e-mail:** presne jedna správa označená `[TEST]` na vlastnú adresu (alebo adresu schválenú adminom) po potvrdení.
- **Odhlásenie:** každá správa kampane má hlavičky `List-Unsubscribe` + RFC 8058 `List-Unsubscribe-Post` (Gmail a ďalší zobrazia vlastné tlačidlo „Odhlásiť“) s nepredvídateľným tokenom. Viditeľný odkaz v texte je voliteľný (`{odhlasenie}` v pätičke, potvrdenie tlačidlom, takže náhľady odkazov ho nespustia). Tímový zoznam odhlásených sa kontroluje pri importe aj tesne pred každým odoslaním.
- **Bezpečné odosielanie:** limity za minútu, hodinu a 24 h na odosielateľa (nastavuje admin), globálna núdzová brzda, atomické prideľovanie (žiadne duplicitné pokusy pri súbežných behoch). Pri odmietnutí poskytovateľom (limit, blokovanie, zlé heslo) sa odosielateľ automaticky zastaví. Neistý výsledok (`unknown_outcome`) sa nikdy neopakuje automaticky.
- **Administrácia:** pozvánky, roly, pridelenie odosielateľov, správa SMTP schránok (heslo, test pripojenia, limity, odblokovanie), nastavenia a audit log.

**Čo aplikácia nerobí:** nepotvrdzuje doručenie do schránky („Prijaté SMTP serverom“ ≠ doručené). Nespracúva bounce správy, nemá tracking pixel ani HTML newslettre a neobchádza limity poskytovateľa.

## Lokálny vývoj

Potrebujete Node.js 22+, npm a (pre DB testy) Docker.

```bash
npm install
cp .env.example .env.local      # doplňte VITE_SUPABASE_URL a VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev                     # http://localhost:5173/cader-mailer/
```

Pri lokálnom vývoji pridajte `http://localhost:5173` do `ALLOWED_ORIGINS` a `http://localhost:5173/cader-mailer/` do Redirect URLs v Supabase Auth.

## Testy a kontroly

```bash
npm run lint          # ESLint (zakazuje aj dangerouslySetInnerHTML)
npm run typecheck     # TypeScript strict
npm test              # unit testy: import, šablóny, časové pásmo/DST, MIME, SMTP klient (mock), šifrovanie
npm run build         # produkčný build

# DB testy: migrácie, RLS, oprávnenia, import, fronta, súbežné workery, pause/cancel,
# limity, unknown_outcome, odhlásenie. Bežia proti dočasnej lokálnej databáze:
docker run -d --rm --name cader-mailer-testdb -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
npm run test:db
docker stop cader-mailer-testdb

# Edge Functions (Deno) type-check:
cd supabase/functions && npx deno@2 check */index.ts
```

CI (`.github/workflows/ci.yml`) spúšťa všetko vyššie. **CI nikdy neposiela e-maily**, SMTP je v testoch nahradené skriptovaným falošným serverom.

## Nasadenie (prehľad)

Presný postup krok za krokom aj s overením je v **[docs/SETUP_CHECKLIST.md](docs/SETUP_CHECKLIST.md)**. Stručne:

1. **Supabase projekt** → `npx supabase link --project-ref <ref>` → `npx supabase db push` (migrácie zo `supabase/migrations`).
2. **Tajomstvá funkcií:** `npx supabase secrets set SENDER_SECRET_KEY=… CRON_SECRET=… SITE_URL=… ALLOWED_ORIGINS=…`
3. **Funkcie:** `npx supabase functions deploy` (nastavenie `verify_jwt` je v `supabase/config.toml`).
4. **Auth:** vypnúť verejnú registráciu, nastaviť Site URL a Redirect URL na adresu GitHub Pages, nastaviť vlastné SMTP pre pozvánky.
5. **Prvý admin:** vytvoriť používateľa v Supabase Dashboard a spustiť bootstrap SQL (nižšie).
6. **GitHub Pages:** v repozitári nastaviť premenné `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` a Pages zdroj „GitHub Actions“.
7. **Cron:** spustiť `supabase/sql/cron.sql` (tajomstvá idú do Vaultu, nie do súboru).
8. **Odosielateľ:** v aplikácii pridať `jakub.kelemen@caderapp.com`, uložiť heslo, otestovať pripojenie, aktivovať.
9. **Test a pilot:** testovacia správa na vlastnú adresu, potom 2–5 vlastných adries, až potom ostrá kampaň.

### Bootstrap prvého admina

V Supabase Dashboard → **Authentication → Users → Add user → Create new user** zadajte e-mail a heslo (zaškrtnite „Auto Confirm User“). Potom v **SQL Editore**:

```sql
update public.profiles
   set role = 'admin', active = true
 where lower(email) = lower('jakub.kelemen@caderapp.com');
-- Overenie (má vrátiť 1 riadok s role = admin, active = true):
select email, role, active from public.profiles where role = 'admin';
```

V aplikácii neexistuje žiadna cesta „staň sa adminom“. Nový používateľ (aj omylom zaregistrovaný) je predvolene **neaktívny**. Aktivuje ho až pozvánka od admina alebo tento SQL krok.

## Štruktúra repozitára

```
src/                         frontend (stránky, komponenty, lib)
supabase/migrations/         schéma, RLS, RPC funkcie, audit
supabase/functions/          Edge Functions + _shared (SMTP klient, MIME, šifrovanie, šablóny)
supabase/sql/cron.sql        naplánovanie fronty (spúšťa sa ručne, tajomstvá z Vaultu)
tests/db/                    integračné testy databázy
fixtures/                    vzorový CSV (len adresy example.com)
docs/                        SETUP_CHECKLIST, SECURITY, OPERATIONS, ARCHITECTURE
```

## Právne upozornenie

Aplikácia je určená na zákonné profesionálne oslovovanie, nie na spam. Pred každou kampaňou overte pôvod adries a právny základ (zákon č. 452/2021 Z. z. o elektronických komunikáciách, GDPR) aj podmienky poskytovateľa schránky. Aplikácia vynúti výber právneho základu a potvrdenie, ale **nerozhoduje za vás, či je oslovenie zákonné**.
