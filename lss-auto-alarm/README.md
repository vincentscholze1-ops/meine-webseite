# LSS Verbands-Bot (Chrome-Erweiterung)

Schickt im [Leitstellenspiel](https://www.leitstellenspiel.de) automatisch eine vorher festgelegte
Fahrzeugauswahl zu Verbandseinsätzen, Events und geplanten Einsätzen (Sicherheitswachen).
Die lukrativsten Einsätze kommen zuerst.

> ⚠️ Vollautomatisches Spielen verstößt gegen die Spielregeln des Leitstellenspiels.
> Nutzung auf eigenes Risiko – der Account kann gesperrt werden.

## Installation / Update

1. `chrome://extensions` öffnen, oben rechts **Entwicklermodus** einschalten.
2. Bei einem Update: die alte Version **entfernen** und den alten Ordner löschen.
3. ZIP entpacken. Wähle den Ordner, in dem `manifest.json` **direkt** liegt.
4. **Entpackte Erweiterung laden** → diesen Ordner wählen.
5. `https://www.leitstellenspiel.de/` mit F5 neu laden.

Im Popup der Erweiterung steht oben die Version (aktuell **v4.0.0**, steht auch im Kopf des Panels).

## Das Panel (auf der Hauptseite)

- **Verschieben**: am roten Kopf ziehen. **Größe ändern**: am Griff unten rechts ziehen. Ab etwa 600 px
  Breite wird das Panel zweispaltig. Position und Größe werden gemerkt; **Doppelklick auf den Kopf**
  setzt beides zurück. **▾** klappt das Panel ein.
- **📊** öffnet die Auswertung, **⚙** die Einstellungen.
- **Starten / Stoppen** und darunter die **Tempo-Knöpfe**:

  | Stufe | Prüfung | Einsätze je Prüfung | Pause zwischen Alarmierungen |
  | --- | --- | --- | --- |
  | 🐢 Gemütlich | alle ~2 min | höchstens 2 | ~6 s |
  | 🚗 Normal | jede Minute | höchstens 5 | ~3 s |
  | 🚀 Schnell | alle ~25 s | alle passenden | ~1 s |

  Werden die Werte in den Einstellungen von Hand geändert, zeigt das Panel „eigenes Tempo“.
- **Kennzahlen**: Einsätze aktiv, Alarmierungen der letzten 60 min, Credits heute (aus der Auswertung),
  Countdown bis zur nächsten Prüfung.
- **Fuhrpark-Auslastung**: Anteil deiner einsatzbereiten Fahrzeuge, die unterwegs oder im Einsatz sind,
  mit Einstufung (✓ entspannt < 60 %, ⚠ ausgelastet ab 60 %, ⛔ am Limit ab 85 %), dazu die Verteilung nach
  Funkstatus (frei, Anfahrt, vor Ort, Transport, nicht verfügbar) und wie viele Fahrzeuge gerade für den
  Bot fahren. Quelle: `/api/vehicles` des Spiels, alle 90 s und nach jeder Prüfung neu geladen.
- **Deine Fahrzeugauswahl**: wie viele Fahrzeuge deiner Auswahl frei sind; der weiße Strich markiert die Reserve.
- **Alarmierungen · 60 min**: Säulen in 5-Minuten-Abschnitten. Mit der Maus über Balken und Säulen
  fahren zeigt die genauen Werte.
- **Jetzt prüfen**, **Diagnose** (Probelauf ohne Alarmierung), **Vom Bot alarmiert** (Status je Einsatz,
  Klick öffnet ihn) und das aufklappbare **Protokoll**.

## Auswertung

Über **📊 Auswertung** im Panel oder im Popup der Erweiterung öffnet sich die Auswertung als **eigene Seite**
in einem neuen Tab. Sie zeigt:

- **vom Bot alarmiert**, **erfolgreich abgeschlossen** (mit Quote), **Credits erhalten**, **Ø Credits je Einsatz**
- wie viele Einsätze noch laufen, ohne Credits endeten oder abgebrochen wurden
- **alle Verbandseinsätze mit deiner Beteiligung** laut Credits-Übersicht, auch von Hand alarmierte,
  sowie Verbands-Event-Belohnungen
- Credits pro Tag und eine Liste der Einsätze mit Status und tatsächlich erhaltenen Credits
- Zeitraum wählbar: Heute, 7 Tage, 30 Tage, Alles

Die Zahlen kommen aus deiner **Credits-Übersicht** im Spiel (`/credits`). Dort steht für jeden
abgeschlossenen Verbandseinsatz eine Buchung „[Verband] Einsatzname“. Der Bot ordnet die Buchungen über
Einsatzname und Zeitraum seinen Alarmierungen zu. „Erfolgreich“ heißt: Für den Einsatz ist eine
Gutschrift eingegangen. Kommt 45 Minuten nach Einsatzende keine Buchung, zählt er als „ohne Credits“
(z.B. weil das Fahrzeug zu spät ankam).

Zum Abrufen neuer Credits muss die Hauptseite des Leitstellenspiels in einem Tab offen sein (ohne
Spiel-Tab zeigt die Auswertung den zuletzt gespeicherten Stand). Die Credits-Übersicht wird beim Öffnen der Auswertung abgerufen und, während der Bot läuft, alle
10 Minuten, solange noch Gutschriften erwartet werden. Gespeichert werden die letzten 60 Tage.
Gezählt wird erst ab Version 3.4 – frühere Alarmierungen sind nicht erfasst.

## Einstellungen

Alles wird sofort gespeichert. Oben steht in einem Satz, was der Bot mit den aktuellen Einstellungen tut.

1. **Welche Einsätze?** – Verbandseinsätze, Events, eigene und Verbands-Sicherheitswachen an-/abwählen.
2. **Was wird geschickt?** – Anzahl mit − / + einstellen und aus **allen 192 Fahrzeugtypen** wählen
   (nach Wachentyp gruppiert, mit Suchfeld, oder Schnellwahl: Löschfahrzeug, RTW, Streifenwagen, GKW).
   Gespeichert und erkannt wird jeder Typ über seine **feste Typ-ID** (die kleine Zahl am Knopf) – wie du
   Fahrzeuge oder Typen im Spiel benannt hast, spielt keine Rolle. Fehlt ein ganz neuer Typ, kann seine
   Typ-ID von Hand eingegeben werden. Für geplante Einsätze kann eine eigene Auswahl eingestellt werden.
3. **Tempo** – die drei Stufen (Gemütlich / Normal / Schnell) oder eigene Werte per Zahleingabe:
   Abfrage-Intervall (Sekunden, mind. 20), Pause zwischen zwei Alarmierungen und Alarmierungen pro
   Stunde (leer = unbegrenzt).
4. **Entfernung & Reserve** – maximale Entfernung und Reserve für eigene Einsätze.
5. **Filter** – Mindest-Credits, Einsätze ohne bekannte Credits, Einsätze nach Namen überspringen.

Weitere Obergrenzen (gleichzeitig, pro Prüfung) gibt es standardmäßig keine.
Wer sie doch möchte, findet sie unter **Erweitert** (ganz links = unbegrenzt).

Credits gibt es im Leitstellenspiel nur, wenn dein Fahrzeug **vor Abschluss am Einsatzort** ist.
Die wichtigsten Stellschrauben sind daher **Maximale Entfernung** und **Reserve**.
