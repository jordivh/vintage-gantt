# Stap 3 — gerichte live-queries (development, geen productieakkoord)

## Stap-2-bevestiging

De gebruiker heeft handmatig bevestigd: “Ik heb stap 2 handmatig getest en bevestig dat het werkt.” Vastgelegd in docs/convex-phase-2.md als user-reported resultaat. Dit is geen bewijs voor stap 3 en geen productieakkoord voor stap 3.

## Wijzigingen

Nieuwe src/convex/plannerReads.ts met aparte catalog-, calendars-, people-, plans- en snapshots-queries. Bedrijf uitsluitend uit de sessie, inclusief verwijderde gebruikers, tijdelijk wachtwoord en bedrijfsstatus. Catalog bevat metadata van projecten, versies en baselines, maar geen taakdocumenten of snapshots. Plans leest met by_company_project_version alleen benoemde versies plus legacy taken zonder versionId. Assignments worden via by_company_task gelezen. Snapshots via by_company_baseline en alleen voor gekozen baseline.

src/lib/planner-read-policy.ts bepaalt de benodigde dekking:
- /dashboard en /reports/margins: actieve versies van actieve reguliere projecten voor cross-project overload, plus gekozen versie van het geopende project; gekozen baseline-snapshots.
- /projects: actieve versies van reguliere projecten, inclusief archief voor de portfolio-weergave; geen oude taakversies/snapshots.
- /capacity: actieve versies van actieve reguliere projecten, kalenders, verlof, resources en toewijzingen; geen snapshots.
- /calendars en /resources: alle reguliere versies zijn hier WEL nodig voor bestaande impactpreviews/kalenderherberekeningen; geen baseline-snapshots.
- Account, auth, bedrijfsgebruikers en landing: geen planning-subscriptions. De nog bestaande provider kan lokale data behouden zolang een draft pending is; dat is geen extra databasequery.
- Dupliceren en verwijderen van een niet-geladen versie vragen expliciet de projectgeschiedenis op; melding om na laden de actie opnieuw uit te voeren. Eenmalig geladen geschiedenis blijft deze providersessie beschikbaar. Metadata omvat nog alle versies/baselines voor menu's en moduscontroles.

Bedrijfsledenlijst alleen op /company/users; elders zelflid + bedrijfsmetadata. Bestaande bedrijven doen niet meer automatisch de ensureCompany-volledige audit bij iedere start; echte provisioning/migratie blijft behouden.

## Opslagveiligheid en live updates

Gedeeltelijke dekking staat expliciet in guards van workspace-changes.ts; server leest/checkt dezelfde project/versie/snapshotrange binnen saveChanges. De stap-2-volledige guard blijft ondersteund. Niet geladen records worden niet als verwijderingen gestuurd. Nooit relation repair uitvoeren alsof de subset de gehele bedrijfsdatabase is. Dependency-id's worden uit bestaande links behouden bij het genereren van delta's; sortOrder blijft uit de opgeslagen rij behouden en wordt bij echte herordening expliciet bijgewerkt.

De bestaande live-resultaten worden verwerkt wanneer lokale toestand clean is. Dirty/pending/blocked invoer en gefocuste editors blokkeren rehydratatie; focusout zorgt dat uitgestelde clean updates opnieuw bekeken worden. Een save met verouderde calculation-inputs blijft transactioneel conflicteren; draft behouden met de stap-2-downloadmelding. Een benodigde versiewissel vraagt eerst data; incomplete sets mogen niet als berekeningsinput worden opgeslagen.

Zeldzame destructieve acties verkrijgen expliciet een volledige basis en vergelijken geladen rows, waarna de server de volledige fingerprint tijdens opslag opnieuw controleert. Vooraf lezen alleen is dus NIET de bescherming. Deze routes en destructive-integritychecks blijven breder lezen dan gewone live-schermen.

## Verification

Na definitieve codewijzigingen: bun convex dev --once, bun tsc -b --noEmit en volledige bun test geslaagd. 512 pass, 0 fail, 37 bestanden, 5439 assertions. Testpipeline via expliciet bash pipefail, exit 0.

Nieuwe src/lib/planner-reads.test.ts:
- routebeleid houdt actieve cross-projectplannen en sluit onzichtbare histories uit;
- catalog heeft geen tasks; versie-/baselinequery levert alleen gekozen rows;
- scoped save behoudt niet geladen versies, baseline-snapshots, assignments en andere projecten;
- stale scoped planning geeft conflict, edits in verschillende projecten blijven behouden;
- vreemde bedrijfs-id's leveren geen plan-/snapshotrows;
- computeResourceLoads en buildOverloadIndex geven EXACT dezelfde uitkomsten op scoped actieve data en op de oude volledige dataset (incl. verlof/resourcecalendar);
- reproduceerbare resultaatgroottevergelijking.

Bestaande suites: planning, dependencies, marges, kritisch pad, versies, portfolio/marginberekeningen, capaciteit/verlof/overload, verwijdering en bedrijfsisolatie blijven groen. De bestaande raw-concurrencytests blijven zonder testhelper-fresh-read draaien.

## Voor/na vergelijking — geen databasebyteclaim

Zelfde lokale fixture voor beide queries: 4 projecten (2 actief, 1 archief, 1 template), 2 versies per project, 125 taken per versie, 1000 toewijzingen, 500 baseline-snapshots, kalender/resource/verlof. SHA-256: 740f7b83188a1f4baf05109e0fb9a5f0d2df5458a08265e4231a68a7e59ad4c2.

Oude getState: 1000 tasks, 500 snapshots, 456313 UTF-8 JSON-resultaatbytes.
Gerichte actieve p/q-read zonder baseline: 250 tasks, 0 snapshots, 86769 UTF-8 bytes voor de samengevoegde lokale resultaten (incl. dekking/metadata).

Dit zijn lokale functieresultaten/returned payloads, NIET database-I/O, realtime netwerkgebruik, facturatie of live Usage. Queries lezen soms aanvullende metadata die niet returned wordt. Cache/invalidation en gebruikershandelingen beïnvloeden echte I/O. Geen gemeten besparing of percentage geclaimd. Geen vergelijkbare afgebakende Usage-waarden toegankelijk; meetprocedure uit stap 1 blijft noodzakelijk.

## Browsercontrole en release

Opnieuw Chromium geprobeerd met aanwezige Playwright. Launch mislukt met libglib-2.0.so.0 ontbreekt, exit 127 van Chromium/exit 1 van opdracht. Geen wijzigingen aan systeembibliotheken. Twee echte browsersessies, visuele loading/versie-/baselinewissels en draftbewaring zijn NIET door de agent geverifieerd. User confirmation van stap 2 niet hergebruiken als stap-3-pass.

Nog handmatig op development controleren: verschillende projecten/versies/baselines, baselineverwijdering na on-demand laden, archiefportfolio, capaciteit/week-maand/verlof, overload na wijziging in ander project, calendar-impactpreviews, clean tweede sessie updates, dirty tweede sessie conflict en draftdownload. Expliciet eerste load en routewissel tijdens pending save testen. De mogelijkheid om history te laden geeft voorlopig een retry-melding, geen automatisch hervatte actie. Alle gegevens zijn nog beschikbaar via beveiligde queries; geen gegevens verwijderd.

Geen productie-release uitgevoerd. Vraag expliciet akkoord voordat stap 3 naar productie gaat; laat ontbrekende browser- en Usage-controles zichtbaar in de releasebeslissing.

## Terugdraaibaar

Stap-3-scope: nieuwe plannerReads.ts/planner-read-policy.ts/planner-reads.test.ts en dit verslag; edits in planner.ts (scoped guard), schema.ts (additieve company/project/version-index), workspace-changes.ts (coverage), calendar-store.tsx (subscriptions/partial verwerking), Dashboard.tsx (baseline request), companies.ts (optionele ledenlijst), account-recovery.test.ts (expliciet leeg args-object). Generated code alleen door Convex-codegen.

Rollback naar stap 2: herstel deze edits, laat stap-2-save/conflictcontrole intact, verwijder nieuwe stap-3-bestanden, regenereer met convex dev --once en typecheck/test. Geen live data verwijderen of planningsregels wijzigen nodig. Verwijdering van de extra index is optioneel. Handmatige stap-2-bevestiging behouden. Nog brede getState voor zeldzame operationele reads en audits blijft voor rollback/backward compatibility beschikbaar, niet als standaard live subscription.
