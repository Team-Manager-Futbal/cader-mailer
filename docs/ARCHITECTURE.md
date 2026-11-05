# Architektúra

## Komponenty

| Časť | Kde beží | Úloha |
|---|---|---|
| React aplikácia | GitHub Pages (statické súbory, verejné) | UI, import a náhľad v prehliadači, volania Supabase s JWT používateľa |
| PostgreSQL + RLS | Supabase | Dáta, oprávnenia, celá logika fronty v SQL funkciách (atomicky) |
| Edge Functions | Supabase (Deno) | Operácie, ktoré potrebujú tajomstvá: SMTP, šifrovanie hesiel, pozvánky |
| pg_cron + pg_net | Supabase | Každú minútu zavolá `process-queue` s `x-cron-secret` z Vaultu |
| SMTP | Seznam `smtp.seznam.cz:465` (implicitné TLS) | Prijatie správy na odoslanie |

### Prečo takto

- GitHub Pages je statický a verejný, takže **nesmie** poznať SMTP heslá ani service_role kľúč. Do prehliadača ide len publishable key, ktorý je bezpečný iba vďaka RLS na každej tabuľke.
- Celá logika prideľovania práce je v SQL (`claim_due_recipients`, `finish_attempt`). Súbežné behy aj pády workera sa tak riešia transakciami a zámkami, nie kódom v TypeScripte.
- SMTP je za rozhraním `MailTransport` (`supabase/functions/_shared/sender.ts`). SMTP klient (`_shared/smtp.ts`) dostáva socket zvonku, takže ten istý kód beží v Deno (Edge Functions), v Node (prípadný záložný worker) aj v testoch.

## Presná cesta naplánovanej správy

1. Používateľ uloží koncept (`campaigns`, `status = draft`) a importuje príjemcov cez RPC `campaign_set_recipients`. Server znova overí formát, odstráni duplicity (unikátny index `(campaign_id, email_normalized)`) a vynechá odhlásené adresy.
2. Na stránke kontroly zvolí čas (Bratislava → UTC v prehliadači; čas, ktorý neexistuje, sa odmietne a dvojznačný čas sa výslovne označí), rýchlosť a právny základ a potvrdí. RPC `campaign_confirm` znova overí vlastníka, pridelenie odosielateľa, pripravenosť odosielateľa (aktívny, heslo, úspešný test), limity rýchlosti a čas v budúcnosti. Nastaví `status = scheduled`.
3. **pg_cron** každú minútu pošle `POST /functions/v1/process-queue` s hlavičkou `x-cron-secret`. Funkcia ju porovná v konštantnom čase s `CRON_SECRET`, inak vráti 401.
4. `claim_due_recipients(20, 300)` v jednej transakcii:
   - zmení vypršané leasy (`processing` a `lease_until < now()`) na **`unknown_outcome`**, nie späť do fronty,
   - spustí kampane, ktorým nastal čas (`scheduled → processing`), a uzavrie hotové,
   - ak je globálne odosielanie vypnuté, skončí,
   - pre každého pripraveného a neblokovaného odosielateľa vezme `pg_advisory_xact_lock` (súbežné behy sa pri počítaní limitov zoradia za sebou) a spočíta voľnú kapacitu z `send_attempts` za poslednú minútu, hodinu a 24 h,
   - pre každú kampaň (`FOR UPDATE SKIP LOCKED`) označí odhlásených ako `skipped_unsubscribed`, uplatní rýchlosť kampane a vyberie príjemcov `FOR UPDATE SKIP LOCKED`,
   - každého vybraného prepne na `processing` s náhodným `lease_token` a `lease_until = now() + 5 min` a vloží riadok `send_attempts` (`in_progress`).
5. Pre každého prideleného príjemcu funkcia:
   - zavolá `recipient_still_sendable` (lease je stále náš, kampaň nie je pozastavená/zrušená, adresa nie je odhlásená); ak nie, `release_unsent`,
   - zostaví text (`composeMessage`; chýbajúce pole = `permanent_failure` bez SMTP) a MIME (jeden `To`, UTF-8, `List-Unsubscribe` + `List-Unsubscribe-Post`),
   - pošle cez SMTP (jedno spojenie na odosielateľa a beh, `RSET` medzi chybami),
   - zapíše výsledok cez `finish_attempt` (kontroluje `lease_token`).
6. Výsledky:
   - `250` po DATA → `accepted_by_smtp` (**nie** doručené).
   - 4xx bez textu o limite → `temporary_failure`, nový pokus o 5, 10 a 20 min, potom `permanent_failure`.
   - Limit, blokovanie, politika, zlé heslo alebo odmietnutý odosielateľ → odosielateľ je **zablokovaný**, všetky jeho kampane sú **pozastavené** a nič sa neopakuje automaticky. Admin musí odblokovať.
   - Spojenie spadlo **po** odoslaní obsahu, alebo worker spadol a lease vypršal → `unknown_outcome`, rozhodne človek.
   - 5xx na príjemcu → `permanent_failure`.

## Čas a odhady

- V DB je všetko `timestamptz` (UTC). UI zobrazuje `Europe/Bratislava`.
- Vybraný čas 08:00 znamená, že kampaň sa **začne spracúvať najskôr** v najbližšom behu cronu po 08:00. Spracovanie trvá pri 2/min približne 100 minút na 200 príjemcov a ovplyvnia ho aj hodinové a denné limity. UI ukazuje odhad s upozornením, že nie je zaručený.

## Obmedzenia poskytovateľov

- **Seznam** nezverejňuje presné limity a neodporúča hromadné rozosielky z bežných schránok. Predvolené limity (2/min, 60/h, 200/24 h) sú opatrná poistka, nie schválená priepustnosť. Upravte ich až po skúsenostiach alebo po potvrdení od Seznamu.
- **Supabase Edge Functions:** podľa dokumentácie Supabase sú odchádzajúce porty 25 a 587 blokované. Port 465 (implicitné TLS) by mal fungovať cez `Deno.connectTls`, ale **musí sa overiť v nasadenom projekte** tlačidlom „Otestovať pripojenie“ (SETUP_CHECKLIST F5). STARTTLS (587) zámerne nie je podporovaný.
- Limit trvania funkcie: beh `process-queue` sa sám ukončí po ~120 s a nedokončených vráti do fronty. Lease (300 s) je dlhší ako beh.

## Záložný worker (ak port 465 zo Supabase nefunguje)

Ak F5 hlási sieťovú chybu alebo timeout, Edge Functions nemôžu posielať SMTP. Kód je na to pripravený, ale záložný worker **nie je nasadený**, pretože to zatiaľ nebolo potrebné overiť:

1. `_shared/smtp.ts`, `mime.ts`, `template.ts` a `crypto.ts` sú nezávislé od runtime. Node worker potrebuje len `Connector` nad `tls.connect` (asi 15 riadkov).
2. Worker volá tie isté RPC ako `process-queue` (`claim_due_recipients` → `recipient_still_sendable` → SMTP → `finish_attempt`) so service_role kľúčom vo svojom úložisku tajomstiev.
3. Možnosti hostingu: súkromný repozitár s GitHub Actions (`schedule` každých 5 minút, ale GitHub cron je nepresný a môže meškať aj desiatky minút) alebo malý Node proces (Fly.io, Render, VPS) spúšťaný každú minútu.
4. Cron v Supabase sa v tom prípade odplánuje (`select cron.unschedule('cader-process-queue')`), aby nebežali dva odosielacie mechanizmy.
