# Stap 2 — gerichte opslag, nog NIET vrijgegeven

## Handmatige bevestiging door de gebruiker

De gebruiker bevestigt in deze conversatie: “Ik heb stap 2 handmatig getest en bevestig dat het werkt.” Deze bevestiging is vastgelegd als door de gebruiker gerapporteerd testresultaat, niet als een door de agent uitgevoerde browsertest. Er zijn geen nadere testgevallen, meetwaarden of browserdetails aangeleverd. De gebruiker heeft akkoord gegeven voor stap 3; dit is geen akkoord voor een productie-release van stap 3.

## Status en scope

Applicatie-opslag aangepast; stap 3 (opsplitsen live queries) niet uitgevoerd. De brede getState-query blijft aanwezig. Geen abonnement/databasedienst gewijzigd. Geen bestaande klantgegevens verwijderd of migraties van planningsregels uitgevoerd. Backendfuncties/indexen zijn op development bijgewerkt met `bun convex dev --once`; dit is geen productie-release.

Verplichte vrijgavecontrole met twee echte browsersessies NIET uitgevoerd: Playwright Chromium faalt bij starten door ontbrekende `libglib-2.0.so.0`. Geen systeeminstellingen gewijzigd. Ook client-hydratatie, conflictmelding, draftdownload en directe acties zijn daardoor niet via de echte UI geverifieerd. Niet als afgeronde samenwerking/release presenteren.

## Implementatie

- `src/lib/workspace-changes.ts`: deterministische vergelijking per record, delta's met before/after en SHA-256-vingerafdrukken van planningsinputs.
- `src/convex/planner.ts`: `saveChanges` schrijft alleen delta's. Controle van oorspronkelijke records, projectinputs, relaties en writes binnen één Convex-transactie. Normale saves lezen betrokken projecten plus gedeelde kalender/resourcegegevens, niet alle tien bedrijfstabellen. Alle versies van een betrokken project worden conservatief gecontroleerd: gelijktijdige wijzigingen binnen hetzelfde project kunnen ook bij verschillende taken een conflict geven.
- `src/convex/schema.ts`: bedrijfs-/record-id-indexen en gerichte indexen voor projectdependencies, taskassignments en baselinesnapshots. Indexen verhogen ook opslag-/writekosten; geen netto factureringsbesparing gemeten.
- `replaceState`: bestaande werkruimtes vereisen een actuele volledige fingerprint, in dezelfde transactie gecontroleerd. Alleen eerste opslag in een werkelijk lege werkruimte mag zonder basis. Geen onbeschermde legacy-overschrijfroute.
- Bestaande delete-/hide-mutaties vereisen eveneens een actuele basis. Die zeldzamere routes blijven een volledige bedrijfscontrole lezen; gewone wijzigingen gebruiken het delta-pad. Destructieve delta's doen ook een volledige integriteitscontrole.
- `src/lib/calendar-store.tsx`: delta-opslag vanaf bevestigde basis, blokkeren van retry na geweigerde save, lokale input/queue behouden, blijvende melding met JSON-draftdownload, beforeunload-waarschuwing. Clean stores mogen resultaten van de bestaande live-query verwerken; niet over lokale/pending input heen hydrateren. Cross-project optimizer-inputs worden aanvullend guarded. Dit is nog geen uitgebreide conflictresolver of automatische rebase.
- Bestaande sequential backendtestfixtures gebruiken `src/lib/convex-test-workspace.ts` om expliciete legacy-bases mee te geven. De concurrencytests gebruiken raw convex-test: geen vooraf opnieuw lezen dat stale snapshots zou verbergen.
- Ambient Bun-testtype uitgebreid voor de werkelijk gebruikte `toThrow`-assertie; geen suppressies toegevoegd.

## Regressies en checks

`bun convex dev --once` geslaagd na backendcorrecties. Na laatste clientcorrectie: `bun tsc -b --noEmit && bun test` geslaagd, 505 pass / 0 fail / 36 bestanden, 5412 assertions. Gefilterde testoutput via expliciet bash pipefail, exit 0.

Regressies in `src/lib/concurrency-baseline.test.ts`:
- A's taakwijziging blijft bewaard wanneer B een andere taak in een ander project opslaat vanuit een oude snapshot.
- Dezelfde taak geeft conflict; A blijft opgeslagen, B's inputobject intact.
- Veranderde ongewijzigde calculation-input blokkeert alle samenhangende writes.
- Echte dependency-recalculation slaat beide beïnvloede taken samen op.
- Delete tegenover edit in beide richtingen: geen onbedoeld wissen of opnieuw creëren.
- Geen onbeschermde full-replace of stale full-replace.
- Delta bedrijfsisolatie en verplicht planning read-set.
- Bestaande planning/critical-path/marges/versies/portfolio/capaciteit/isolatiesuites blijven groen.

Backendtests bewijzen géén WebSocket-delivery of correct clientgedrag in twee echte browsers. Broncodeasserties voor draftbehoud zijn geen browserbewijs.

## Vergelijking met stap 1

Dezelfde deterministische fixture: 2 projecten, 4 versies, 500 taken, 1 kalender; SHA-256 `22634c8f3a673453d2611386f2308596c6e4bc1743e81abfa112f863b3fdef5f`. Voorheen verloor A zijn wijziging bij B's unrelated save. Nu blijven beide wijzigingen in de backend behouden. No-op delta: geen veranderingen en geen projectguards; geen 507-row vergelijkingsronde zoals de oude save.

Geen vergelijkbare vóór/na-databasebytes of Usage-totalen beschikbaar. GEEN gemeten besparingspercentage, speedup of factureringsdaling geclaimd. De brede subscription kan nog steeds herlezen. De minimale fixture heeft geen capaciteit-/baselinegegevens; bestaande correctness-tests dekken die apart, niet hun live verbruik.

## Vrijgavevoorwaarden en beperkingen

1. Twee echte browsersessies op development met afzonderlijke testaccounts binnen één bedrijf: clean live updates, edits in verschillende projecten, dezelfde taak, typen terwijl remote update binnenkomt, save tijdens typing, delete versus edit, pending input tijdens routewissel en draftdownload.
2. Clean versus dirty hydration en eerste load testen: geen empty/old-state autosave. Directe serveracties (templateaanmaak, deleteproject/resource/calendar/task) na pending saves en daarna nog een wijziging testen.
3. Conflict-handling heeft momenteel een bewuste stop: geen automatische overwrite/retry/rebase. Input blijft op scherm en kan als JSON gedownload worden; herladen alleen na veiligstellen en review. Tijdelijke netwerkfouten stoppen ook saves; herstelworkflow nog niet browsergecontroleerd.
4. Oude clients zonder expected-basis worden geweigerd op bestaande werkruimtes. Rollback naar onbeschermde backend is onveilig zolang meerdere gebruikers werken.
5. Geen productieafschermingsaudit of echte Usage-nulmeting. Blijf de afgebakende meetprocedure uit `docs/convex-phase-1-baseline.md` gebruiken.

## Afzonderlijk terugdraaibaar

Functionele scope: planner.ts, schema.ts, calendar-store.tsx, workspace-changes.ts. Testscope: concurrency-baseline.test.ts, convex-test-workspace.ts, sequential fixture-imports in de betrokken tests/benchmark, workspace-save.test.ts-asserties en src/types/bun-test.d.ts. Documentatie dit bestand; stap-1-verslag blijft historische nulmeting. Geen dataremoval nodig om de wijziging terug te draaien. Nieuwe indexen zijn additief. Terugdraaien vereist opnieuw codegen/typecheck/tests; de oude gegevensverliesbug komt dan terug en mag niet als veilige multi-useroplossing gelden.
