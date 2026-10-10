# Convex — stap 1: gedeeltelijke nulmeting en gelijktijdigheid

## Scope

Alleen onderzoek en lokale tests. Geen wijzigingen aan applicatiecode, Convex-functies, schema, abonnement of databasedienst. Geen bestaande development- of productiegegevens gewijzigd of verwijderd. Nieuw: `src/lib/concurrency-baseline.test.ts` en dit verslag. Verwijderen van deze twee onderzoeksbestanden draait deze stap terug.

## Meettoegang

De begrensde opdracht `timeout 8s bunx --no-install convex logs --history 5 --success --jsonl` maakte verbinding met developmentdeployment `frugal-impala-110` van project `vintagegantt`, maar leverde geen uitvoeringsrecords op. Exitstatus 124: tijdslimiet, geen geslaagde byte-meting. Niet opnieuw blijven wachten.

Geen rechtstreekse toegang tot de Usage-totalen of een aangemeld dashboard. Geen meetwaarde voor databasebytes per functie, afgebakend Usage-verschil, productiegebruik of het aandeel van deze app in de eerder gemelde 2,29 GB gelezen / 10,29 MB geschreven. Die cijfers blijven door de gebruiker aangeleverde All Projects-totalen. Onbekend is niet nul.

## Reproduceerbare lokale diagnose

Interface: echte `planner.getState`-queries en `planner.replaceState`-mutaties via `convex-test`, met twee verschillende gebruikersidentiteiten binnen hetzelfde bedrijf. Geen echte browser- of authenticatiesessies en geen live subscriptions.

Dataset: 2 actieve projecten, 2 versies per project, 125 taken per versie: 500 taken, 4 versies, 1 kalender; totaal 507 records. Geen resources, assignments, dependencies of baselines in deze specifieke diagnosefixture. De bestaande suites dekken die gegevens afzonderlijk; deze fixture is geen volledige portfolio-/capaciteitsverbruiksmeting.

Fixture SHA-256: `22634c8f3a673453d2611386f2308596c6e4bc1743e81abfa112f863b3fdef5f`.

Payload: 147331 UTF-8 JSON-bytes. Dit is NIET gemeten database-I/O, netwerkverkeer of een factureringsmaat.

| Test | Werkelijke uitkomst |
|---|---|
| A wijzigt een taak; B doet daarna een expliciete query | B leest de opgeslagen wijziging. Eén record gewijzigd. Geen bewijs van automatische schermupdate. |
| A en B lezen dezelfde beginsituatie; A wijzigt project P; B slaat vanuit zijn oude snapshot een notitie in project Q op | Beide saves slagen. B's save wijzigt twee records: eigen notitie plus terugzetten van A's naam. A's wijziging verloren zonder conflictmelding. |
| Zelfde oude beginsituatie; beide wijzigen hetzelfde veld | Beide saves slagen; B's laatste save wint. |
| Identieke volledige payload opnieuw opslaan | 0 inserts, 0 updates, 0 deletes, 507 kept. Dit zegt niets over gelezen databasebytes. |

De diagnostische tests verwachten expliciet het huidige ONVEILIGE gedrag om het te reproduceren. Ze zijn geen gewenste acceptatiecriteria. In stap 2 moeten deze verwachtingen vervangen worden door assertions voor behoud van wijzigingen of expliciete conflictafhandeling.

## Schermupdates: codebevinding, niet browsergetest

`src/lib/calendar-store.tsx` abonneert zich op `getState`, maar de hydratatie-effect stopt wanneer `hydratedRef.current` al true is. Een nieuwe serveruitkomst wordt dus via dit pad niet opnieuw in de lokale planning verwerkt. De lokale opslagwachtrij coördineert alleen binnen één providerinstantie, niet tussen gebruikers.

Geen browserautomatisering beschikbaar via de aangeboden tools; geen visuele test met twee vensters uitgevoerd. WebSocket-aflevering, schermupdates, echte sessiewisseling en idle-verbruik blijven onbevestigd.

## Bedrijfsisolatie

Bestaande lokale tests met echte backendfuncties gecontroleerd: eigen gegevens per tabel, geen vreemde identifiers/namen in queryresultaten, geweigerde verwijzingen naar andere bedrijfsgegevens, sessie-afgeleide bedrijfsscope, geen writes zonder identiteit, geen wijziging van het andere bedrijf bij volledige saves, en geweigerde project-/resourceverwijdering buiten het eigen bedrijf. De bestaande tests mogen in hun eigen in-memory fixtures records verwijderen; live gegevens zijn niet aangeraakt.

Dit is geen productiebeveiligingsaudit of browserverificatie van alle routes.

## Checks na laatste testcodecorrectie

`bun tsc -b --noEmit && bun test`: exit 0; 500 tests geslaagd, 0 mislukt, 36 bestanden. Inclusief planning, kritisch pad, marges, versies, capaciteit, overbelasting en bedrijfsisolatie. De eerste typecheck vond twee fouten in het nieuwe testbestand; die zijn hersteld en de volledige check is opnieuw geslaagd. Geen backenddeploy of productiebuild uitgevoerd.

## Nog benodigde echte vóór/na-meting

Deze nulmeting is gedeeltelijk: lokale juistheid en overschrijfrisico zijn vastgelegd; databaseverbruik en twee-browserschermgedrag niet.

1. Kies in Usage alleen project `vintagegantt`, leg periode/tijdzone en beschikbare deploymentuitsplitsing vast. Noteer ontwikkeling en productie afzonderlijk waar mogelijk. Bewaar screenshots/exports van lees- en schrijfwaarden. Geen sleutels delen.
2. Gebruik voor en na dezelfde afzonderlijke testwerkruimte en dezelfde opgeslagen dataset met minimaal twee projecten, twee versies, afhankelijkheden, marges, baselines, medewerkers, verlof en toewijzingen. Geen bestaande klantgegevens wijzigen. Leg aantallen en een datasetfingerprint vast. De huidige minimale lokale fixture alleen volstaat niet voor capaciteitscontrole.
3. Leg een vast begin- en eindtijdstip vast. Geen overige tests, deploys of andere appwerkzaamheden binnen het meetvenster; documenteer onvermijdelijke achtergrondactiviteit. Laat Usage eerst bijwerken. Bij uitsluitend dagelijkse resolutie: reserveer een rustige meetdag; dagtotalen kunnen geen precieze bytes aan één klik toerekenen.
4. Voer één ronde uit: project P openen; taak wijzigen; opslag afwachten; P naar Q naar P; versie 1 naar 2 naar 1; portfolio openen; capaciteit met dezelfde week/maand en filters; daarna 15 minuten niets doen. Noteer handelingstijden, cold start en herhaalde opening afzonderlijk. Geen verzonnen per-functiebytes afleiden uit aantallen of payloadgrootte.
5. Indien uitvoeringsrecords beschikbaar komen: sommeer databaselees- en schrijfbytes per functie en meetvenster, cachehits apart; onderscheid databasebytes van return-/netwerkbytes. Anders rapporteer alleen afgebakende Usage-delta's en de beperkte toerekenbaarheid.
6. Twee echte sessies binnen hetzelfde bedrijf: beide openen beginsituatie; A wijzigt taak; controleer B zonder herladen; B wijzigt een andere taak vanuit oude weergave; controleer beide na herladen. Test hetzelfde veld apart. Tot bescherming bestaat alleen op wegwerp-/afzonderlijke testgegevens uitvoeren: verlies van wijzigingen is lokaal bewezen.
7. Tweede bedrijf: controleer lezen via navigatie/deep links en directe weigering van vreemde mutatie-id's; geen poging om echte gegevens te verwijderen. Gebruik geïsoleerde fixtures voor destructieve integriteitsgevallen.
8. Controleer per ronde taakdatums, afhankelijkheden, marges, float/kritisch pad, versies/baselines, portfoliototalen en dagelijkse capaciteits-/overbelastingscijfers. Bewaar voor/na-uitkomsten. Voor stap 2 ook meerdere door één planningedit beïnvloede taken en conflictafhandeling testen.

## Beslispunt

Niet doorgaan naar stap 2 zonder bevestiging. Gericht opslaan moet de volledige samenhangende planningswijziging bewaren en verouderde saves detecteren, zonder de huidige volledige bedrijfsreads. Geen verbruiksbesparing gemeten of geclaimd. Voor een echte verbruiksvergelijking zijn de ontbrekende Usage-waarden en live browserronde nog nodig.
