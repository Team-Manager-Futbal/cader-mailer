# Bezpečnosť

## Model oprávnení

| Akcia | member | admin | kde sa kontroluje |
|---|---|---|---|
| Vidieť vlastné kampane, príjemcov, pokusy | ✓ | ✓ (všetky) | RLS `campaigns_select`, `recipients_select` |
| Vytvoriť/upraviť koncept | ✓ (vlastný, s prideleným odosielateľom) | ✓ (vlastný) | RLS insert/update + `can_use_sender` |
| Zmeniť stav, potvrdiť, naplánovať | ✓ (vlastné) | ✓ (pause/cancel všetkých) | RPC `campaign_confirm`, `campaign_set_status` |
| Rýchlosť nad limit pre členov | ✗ | ✓ (do limitu odosielateľa) | `campaign_confirm` |
| Testovací e-mail | len na vlastnú adresu alebo allowlist | to isté | Edge Function `send-test` |
| Odosielatelia, heslá, limity, odblokovanie | ✗ | ✓ | RLS + `sender-admin` (`requireCaller({admin})`) |
| Pozvánky, roly, deaktivácia | ✗ | ✓ | `admin-users` + RPC `admin_update_profile` |
| Pridať na zoznam odhlásených | ✓ | ✓ | RLS `suppression_insert` |
| Odstrániť zo zoznamu odhlásených, výmaz (GDPR) | ✗ | ✓ | RLS / RPC `admin_erase_contact` |
| Audit log | ✗ | ✓ | RLS `audit_logs_select` |

- Roly sú v `public.profiles`, nie v `user_metadata` (tú si používateľ vie meniť sám).
- Nový auth používateľ je **neaktívny**. Pomocné funkcie `is_active_user()` a `is_admin()` vyžadujú `active = true`, takže deaktivovaný účet nevidí nič. Deaktivácia navyše zablokuje účet v Supabase Auth (ban), čím zneplatní relácie.
- Nie je možné odobrať rolu admin poslednému adminovi ani sám sebe.
- Stavové stĺpce (`status`, `confirmed_at`, `credential_set`, `blocked_until` …) nemajú pre `authenticated` UPDATE oprávnenie na úrovni stĺpcov. Meniť sa dajú len cez kontrolované RPC.
- Všetky `SECURITY DEFINER` funkcie majú `set search_path = ''` a samy overujú `auth.uid()`. Funkcie fronty sú spustiteľné **len** rolou `service_role`. `anon` nemá prístup k žiadnej tabuľke ani funkcii.

Všetko vyššie pokrývajú automatické testy v `tests/db/db.test.ts`.

## Tajomstvá

| Tajomstvo | Kde je | Kde nikdy nie je |
|---|---|---|
| SMTP heslá | `sender_secrets` ako AES-256-GCM šifrotext (AAD = id odosielateľa). Bez grantov a bez RLS politík, takže je dostupné len pre service_role. | Prehliadač, odpovede API, logy, Git |
| `SENDER_SECRET_KEY` (32 B) | Supabase Edge Function secrets | DB, Git, frontend |
| `CRON_SECRET` | Edge Function secrets + Supabase Vault | Migrácie, `cron.job` text, Git |
| service_role kľúč | Automaticky v Edge Functions | Frontend, GitHub, Vault |
| Publishable key | Frontend (verejný) | Zámerne verejný, bezpečnosť zabezpečuje RLS |

SMTP príkazy s prihlasovacími údajmi sa nikdy nelogujú. Chyby obsahujú len skrátenú, prečistenú odpoveď servera (max. 300 znakov). Logy `process-queue` obsahujú iba agregované počty, žiadne adresy ani obsah.

## Hrozby a opatrenia

| Hrozba | Opatrenie |
|---|---|
| Neprihlásený číta dáta alebo spúšťa odosielanie | RLS bez politík pre `anon`. `process-queue` vyžaduje `x-cron-secret`, ostatné funkcie JWT aktívneho používateľa. |
| Člen pošle z cudzej schránky alebo podvrhne `From` | `From` je vždy adresa uloženého odosielateľa. Člen môže použiť len pridelených (RLS + kontrola v `campaign_confirm` a `send-test`). Reply-To určuje admin pri odosielateľovi. |
| Duplicitné odoslanie pri súbežnom crone | `pg_advisory_xact_lock` na odosielateľa, `FOR UPDATE SKIP LOCKED`, `lease_token`, unikátne indexy. Overené testom so súbežnými transakciami. |
| Pád po prijatí SMTP, pred zápisom do DB | `unknown_outcome`, žiadne automatické opakovanie, rozhoduje človek. |
| Obchádzanie limitov poskytovateľa | Limity v DB nastavuje len admin. Pri odmietnutí sa odosielateľ zablokuje a kampane pozastavia. Nie je žiadna rotácia schránok. |
| Injection cez importované dáta | Len čistý text (React escapuje, `dangerouslySetInnerHTML` je zakázané lintom). Hlavičky odstraňujú CR/LF a adresy sa validujú. CSV export chráni pred formula injection (`'=…`). |
| Enumerácia odhlasovacích tokenov | Token má ~244 bitov náhodnosti. Odpoveď je rovnaká pre platný aj neplatný token. GET nič nerobí (náhľady odkazov). |
| Open redirect / CORS | `ALLOWED_ORIGINS` allowlist a pevný `SITE_URL` pre pozvánky. |
| Ukradnutá relácia v prehliadači | Supabase relácia je v `localStorage` (vyžaduje to knižnica). Inak sa tam neukladá nič citlivé. Na stránke je `referrer: no-referrer` a `noindex`. |

## GDPR a oslovovanie – predpoklady a limity

- Kontaktné údaje sú osobné údaje: ukladajú sa iba v Supabase (EU región odporúčaný) a vidí ich len vlastník kampane a admin.
- Pri každej kampani sa zaznamená pôvod/právny základ, poznámka, kto a kedy potvrdil.
- Výmaz: admin v Kontaktoch → „Vymazať údaje (GDPR)“ odstráni všetky záznamy príjemcu. Adresa zostane na zozname odhlásených (oprávnený záujem nekontaktovať znova).
- Aplikácia **nerieši** spracovanie bounce správ, doby uchovávania (treba ich určiť interne a mazať staré kampane) ani posúdenie zákonnosti konkrétneho zoznamu.
- Žiadny tracking pixel ani sledovanie kliknutí.
