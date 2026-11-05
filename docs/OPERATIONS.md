# Prevádzka

## Núdzové zastavenie všetkého odosielania

- **Najrýchlejšie:** aplikácia → Nastavenia → „Vypnúť všetko odosielanie“. Ďalší beh fronty už nič nepridelí. Správy práve odosielané v tom istom behu (max. pár) ešte dobehnú.
- **Bez aplikácie (SQL Editor):** `update public.app_settings set sending_enabled = false;`
- **Úplne zastaviť plánovač:** `select cron.unschedule('cader-process-queue');` (znova zapnete spustením `supabase/sql/cron.sql`).

Jednu kampaň zastavíte tlačidlom „Pozastaviť“ alebo „Zrušiť“ v jej detaile. Už prijaté správy sa nedajú vrátiť.

## Kontrola chýb

- **Detail kampane → Príjemcovia:** filter podľa stavu, stĺpec Detail obsahuje prečistenú SMTP odpoveď. „Export CSV“ stiahne prehľad.
- **SQL:**
  ```sql
  -- posledné pokusy
  select a.created_at, a.outcome, a.smtp_code, a.error_category, a.error
    from send_attempts a order by a.id desc limit 50;
  -- čo je vo fronte
  select state, count(*) from campaign_recipients group by 1;
  -- behy cronu
  select status, start_time, return_message from cron.job_run_details order by start_time desc limit 20;
  select status_code, content::text, created from net._http_response order by created desc limit 20;
  ```
- **Logy funkcií:** Supabase Dashboard → Edge Functions → process-queue → Logs. Obsahujú len súhrnné počty.

## Neistý výsledok (`unknown_outcome`)

Vzniká, keď sa spojenie prerušilo po odoslaní obsahu správy alebo keď worker spadol počas odosielania (vypršal lease). Nevieme, či server správu prijal.

1. V schránke odosielateľa (Seznam webmail → Odoslané) vyhľadajte príjemcu.
2. V detaile kampane pri príjemcovi zvoľte:
   - **„Odišlo“**: správa je v Odoslaných, označí sa ako prijatá.
   - **„Neodišlo, nechať tak“**: ukončí sa bez ďalšieho pokusu.
   - **„Poslať znova“**: vráti sa do fronty. Použite len ak ste si istý, že správa neodišla, inak príjemca dostane duplikát.

Aplikácia tieto prípady nikdy nerieši automaticky.

## Odosielateľ zablokovaný / kampane automaticky pozastavené

Stane sa, keď SMTP vráti odpoveď o limite, blokovaní, politike alebo zlom hesle.

1. Odosielatelia → prečítajte „Odosielanie zastavené“ (kategória a odpoveď servera).
2. Zlé heslo: „Zmeniť heslo“ → „Otestovať pripojenie“.
3. Limit alebo blokovanie: prihláste sa do webmailu Seznamu a skontrolujte upozornenia, prípadne kontaktujte podporu. **Neprepínajte na inú schránku kvôli obchádzaniu limitu.** Zvážte nižšie limity.
4. Až potom „Odblokovať“ a v pozastavených kampaniach „Pokračovať“. Správy zadržané po bloku sa pokúsia odoslať znova, každá raz.

## Obnova po výpadku

- **Supabase alebo funkcia nedostupná:** nič sa nestratí. Pridelení príjemcovia s vypršaným leasom prejdú do `unknown_outcome` a zvyšok čaká vo fronte. Po obnove cron pokračuje sám.
- **Cron nebeží** (kampane stoja v „Naplánovaná“ po čase): skontrolujte `cron.job_run_details` a `net._http_response`. Kód 401 znamená nesúlad `CRON_SECRET` a Vaultu.

## Rotácia tajomstiev

- **SMTP heslo:** zmeňte ho v Sezname → Odosielatelia → „Zmeniť heslo“ → „Otestovať pripojenie“.
- **CRON_SECRET:** `npx supabase secrets set CRON_SECRET=<nové>` a v SQL `select vault.update_secret((select id from vault.secrets where name = 'cader_cron_secret'), '<nové>');`.
- **SENDER_SECRET_KEY:** zmena kľúča zneplatní všetky uložené heslá. Postup: vypnite odosielanie → nastavte nový kľúč → `npx supabase functions deploy` → pri každom odosielateľovi znova „Nastaviť heslo“ a „Otestovať“ → zapnite odosielanie.
- **service_role / publishable kľúče:** podľa návodu Supabase (Project Settings → API Keys). Po zmene publishable key aktualizujte premennú v GitHube a spustite deploy Pages.

## Žiadosti o odhlásenie a výmaz

- Odhlásenie e-mailom alebo telefonicky: Kontakty → „Pridať na zoznam odhlásených“ (dôvod „Ručne“ alebo „Námietka“). Platí okamžite pre všetky kampane vrátane bežiacich.
- Výmaz údajov: Kontakty → vyhľadať → „Vymazať údaje (GDPR)“ (admin). Adresa zostane len na zozname odhlásených.
- Odstránenie zo zoznamu odhlásených (admin) robte len s preukázateľným novým súhlasom.

## Údržba

- Staré kampane (podľa internej doby uchovávania) možno zmazať v SQL: `delete from campaigns where status in ('completed','cancelled') and completed_at < now() - interval '12 months';`. Príjemcovia a pokusy sa zmažú kaskádovo. Najprv cez SQL zmeňte stav, pretože RLS z aplikácie dovolí zmazať len koncepty.
- `send_attempts` sa používa na počítanie limitov za 24 h, staršie riadky možno mazať.
