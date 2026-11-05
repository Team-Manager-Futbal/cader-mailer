# Setup checklist – od nuly po overenú prevádzku

Každý krok má **Overenie**. Nepokračujte, kým overenie neprejde. Heslá a kľúče nikdy nevkladajte do chatu, issue, commitu ani do `.env` súborov v repozitári.

Nižšie sa používa adresa `https://mcjac0b.github.io/cader-mailer/`. Ak sa repozitár volá inak, upravte ju.

---

## A. GitHub

- [ ] **A1. Repozitár** `cader-mailer` existuje. Pri GitHub Free musí byť verejný (GitHub Pages). Celý kód a web treba považovať za verejné. Súkromné dáta chráni Supabase Auth + RLS.
  - Overenie: `git log` obsahuje iba kód. `git grep -iE "service_role|SENDER_SECRET_KEY=.|password=."` nenájde žiadne reálne hodnoty.
- [ ] **A2. Pages zdroj:** Settings → Pages → Build and deployment → Source = **GitHub Actions**.
- [ ] **A3. Premenné (nie tajomstvá):** Settings → Secrets and variables → Actions → **Variables**:
  - `VITE_SUPABASE_URL` = `https://<ref>.supabase.co`
  - `VITE_SUPABASE_PUBLISHABLE_KEY` = publishable (anon) key z Supabase → Project Settings → API Keys
  - Overenie: Actions → „Deploy to GitHub Pages“ → Run workflow → zelené. Stránka sa otvorí a ukáže prihlasovací formulár (nie hlášku „Aplikácia nie je nakonfigurovaná“).

## B. Supabase projekt a databáza

- [ ] **B1.** Vytvorte projekt na https://supabase.com (región EU, napr. Frankfurt). Uložte si *Project ref*.
- [ ] **B2. Migrácie:**
  ```bash
  npx supabase login
  npx supabase link --project-ref <ref>
  npx supabase db push
  ```
  - Overenie (SQL Editor): `select count(*) from public.app_settings;` → `1`. Ďalej `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r';` → všetky riadky `true`.

## C. Supabase Auth

- [ ] **C1.** Authentication → Sign In / Providers → **Allow new users to sign up = OFF** (iba pozvánky).
- [ ] **C2.** Authentication → URL Configuration:
  - Site URL = `https://mcjac0b.github.io/cader-mailer/`
  - Redirect URLs = `https://mcjac0b.github.io/cader-mailer/` (pre lokálny vývoj aj `http://localhost:5173/cader-mailer/`)
- [ ] **C3. SMTP pre Auth e-maily** (pozvánky, obnova hesla): Authentication → Emails → SMTP Settings. Vstavaný e-mail Supabase posiela len na adresy členov tímu projektu a má veľmi nízky limit. Môžete použiť Seznam (`smtp.seznam.cz`, 465, celá adresa ako používateľ). Je to oddelené od odosielania kampaní.
  - Overenie: v kroku F2 príde pozvánka na adresu mimo Supabase tímu.
- [ ] **C4. Prvý admin:** Authentication → Users → Add user → Create new user (e-mail + heslo, Auto Confirm). Potom v SQL Editore:
  ```sql
  update public.profiles set role = 'admin', active = true where lower(email) = lower('jakub.kelemen@caderapp.com');
  ```
  - Overenie: prihlásenie na GitHub Pages funguje. V menu je sekcia „Administrácia“.

## D. Edge Functions a tajomstvá

- [ ] **D1. Tajomstvá** (vygenerujte lokálne, nikam ich nevkladajte okrem príkazu):
  ```bash
  npx supabase secrets set \
    SENDER_SECRET_KEY="$(openssl rand -base64 32)" \
    CRON_SECRET="$(openssl rand -hex 32 | tee /dev/tty)" \
    SITE_URL="https://mcjac0b.github.io/cader-mailer/" \
    ALLOWED_ORIGINS="https://mcjac0b.github.io"
  ```
  `CRON_SECRET` sa vypíše raz (kvôli `tee`), budete ho potrebovať v E2. **`SENDER_SECRET_KEY` neskôr nemeňte.** Uložené SMTP heslá by sa stali nečitateľnými (pozri OPERATIONS.md, rotácia).
  - Overenie: `npx supabase secrets list` ukazuje všetky štyri mená (hodnoty sú skryté).
- [ ] **D2. Nasadenie:** `npx supabase functions deploy`
  - Overenie: Dashboard → Edge Functions ukazuje 5 funkcií. `process-queue` a `unsubscribe` majú vypnuté „Verify JWT“, ostatné zapnuté.
  - Overenie ochrany: `curl -i -X POST https://<ref>.supabase.co/functions/v1/process-queue` → **401**.

## E. Plánovač (cron)

- [ ] **E1.** Database → Extensions: zapnite `pg_cron` a `pg_net`.
- [ ] **E2.** SQL Editor, hodnoty vložte len tu:
  ```sql
  select vault.create_secret('https://<ref>.supabase.co', 'cader_project_url');
  select vault.create_secret('<CRON_SECRET z D1>', 'cader_cron_secret');
  ```
  Potom spustite celý obsah `supabase/sql/cron.sql`.
  - Overenie po 2–3 minútach:
    ```sql
    select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;   -- succeeded
    select status_code, content::text from net._http_response order by created desc limit 5;               -- 200 {"claimed":0,...}
    ```
    Kód `401` znamená, že `cader_cron_secret` sa nezhoduje s `CRON_SECRET`.

## F. Aplikácia: nastavenia, tím, odosielateľ

- [ ] **F1.** Nastavenia → **Verejná adresa aplikácie** = `https://mcjac0b.github.io/cader-mailer/` (tlačidlo „Použiť aktuálnu“). Skontrolujte pätičku (identifikácia Cader + `{odhlasenie}`). Odosielanie zatiaľ nechajte **VYPNUTÉ**.
- [ ] **F2.** Používatelia → pozvite člena tímu.
  - Overenie: pozvánka príde, člen si nastaví heslo a prihlási sa. Nevidí sekciu Administrácia ani kampane iných.
- [ ] **F3.** Odosielatelia → Pridať: `jakub.kelemen@caderapp.com`, poskytovateľ Seznam (465, SSL/TLS), používateľ = celá adresa. Limity nechajte 2/min, 60/h, 200/24 h.
- [ ] **F4.** „Nastaviť heslo“: heslo schránky. Pri 2FA na Sezname použite **aplikačné heslo**.
- [ ] **F5.** „Otestovať pripojenie“. Toto je **skutočný test portu 465 a prihlásenia z nasadeného prostredia Supabase**.
  - Výsledok „Pripojenie a prihlásenie … je v poriadku“ → pokračujte.
  - „Sieťová chyba / timeout“ → prostredie Edge Functions neumožňuje odchádzajúce SMTP na 465. Pozri ARCHITECTURE.md, časť *Záložný worker*. Kampane v tom prípade **nefungujú**, nepokračujte.
  - „Prihlásenie zlyhalo“ → nesprávne heslo, prípadne treba aplikačné heslo.
- [ ] **F6.** Zaškrtnite „Aktívny“ a v Používateľoch prideľte odosielateľa členom, ktorí ho majú používať.

## G. DNS a doručiteľnosť (caderapp.com)

DNS nemeňte naslepo a MX záznamy nechajte tak. Najprv zistite, čo tam je:

```bash
dig +short TXT caderapp.com            # SPF: má obsahovať include od Seznamu (podľa ich návodu pre Email Profi)
dig +short TXT _dmarc.caderapp.com     # DMARC: začnite s p=none a rua=mailto:<vaša adresa>
# DKIM: selektor a hodnotu nájdete v administrácii Seznam Email Profi; overte cez dig <selektor>._domainkey.caderapp.com TXT
```

- [ ] **G1.** SPF obsahuje odosielací server Seznamu (presnú hodnotu vezmite z dokumentácie Seznamu, nehádajte).
- [ ] **G2.** DKIM je zapnutý v Seznam Email Profi a záznam je v DNS.
- [ ] **G3.** DMARC existuje (aspoň `p=none` s reportmi).
  - Overenie: v teste H1 otvorte v Gmaile „Zobraziť originál“. SPF, DKIM a DMARC musia byť `PASS`.

## H. Prvé odoslanie

- [ ] **H1. Test na vlastnú adresu:** Nová kampaň → text s `{meno}` a `{klub}` → príjemca = vaša adresa → „Poslať test…“. Skontrolujte: príchod, odosielateľa, Reply-To, slovenské znaky v predmete aj texte, pätičku a odkaz na odhlásenie (na teste je zámerne neplatný).
- [ ] **H2. Pilot 2–5 vlastných/schválených adries:** Nastavenia → zapnite odosielanie. Vytvorte kampaň, naplánujte ju na čas o ~5 minút (napr. 08:00, ak je ráno) a potvrďte. Zatvorte prehliadač.
  - Overenie: po naplánovanom čase je kampaň „Odosiela sa“ a potom „Dokončená“, aj keď bol prehliadač zatvorený. Každý dostal **samostatný** e-mail (len svoj `To`, žiadne `Cc`/`Bcc`). V Odoslaných Seznamu je toľko správ, koľko príjemcov.
  - Overenie času: `select scheduled_at, started_at from campaigns order by created_at desc limit 1;` vráti UTC. 08:00 Bratislava = 07:00 UTC v zime, 06:00 UTC v lete.
- [ ] **H3. Odhlásenie:** v pilotnej správe kliknite na odkaz → „Odhlásiť sa“ → adresa je v Kontaktoch medzi odhlásenými. Nová kampaň s touto adresou ju pri importe odmietne.
- [ ] **H4. Pause/cancel:** pilot s 5 adresami pri rýchlosti 1/min → po prvej správe „Pozastaviť“ → ďalšie neodchádzajú. „Pokračovať“ → pokračuje. „Zrušiť“ → zvyšok je „Zrušené“.
- [ ] **H5.** Žiadna správa nezostala dlhšie ako ~5 minút v stave „Práve sa odosiela“. Žiadne duplicity v Odoslaných. Žiadne „Neistý výsledok“ (ak áno, pozri OPERATIONS.md).

## I. Pred prvým reálnym oslovením klubov

- [ ] Pôvod adries je zdokumentovaný a právny základ preverený (verejný firemný kontakt ≠ automatické povolenie pre každú osobnú adresu).
- [ ] Text identifikuje Cader, má Reply-To a odhlásenie.
- [ ] Prvá ostrá kampaň je malá (napr. 20–30 adries). Sledujte odpovede Seznamu. Pri automatickom zablokovaní **neobchádzajte limit** inými schránkami.

## Kontrolný zoznam „čo musí byť reálne potvrdené“

- [ ] Frontend beží na GitHub Pages.
- [ ] Prihlásenie a pozývanie funguje.
- [ ] Admin a člen majú správne oprávnenia (člen nevidí cudzie kampane ani admin sekciu).
- [ ] Import 50–200 adries prebehne bez duplicít (vzor: `fixtures/kontakty-priklad.csv`).
- [ ] Test pripojenia SMTP v aplikácii (F5) je zelený.
- [ ] Testovacia správa dorazí so správnym odosielateľom.
- [ ] Naplánovaná kampaň sa spustí bez otvoreného prehliadača.
- [ ] Každý príjemca dostal samostatný e-mail.
- [ ] Pause/cancel, odhlásenie a história fungujú.
- [ ] V GitHube ani vo verejnom JS nie sú SMTP heslá ani servisné kľúče (`grep -r service_role dist/` nič nenájde).
