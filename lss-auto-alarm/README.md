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

Im Popup der Erweiterung steht oben die Version (aktuell **v3.1.0**).

## Das Panel (unten links auf der Hauptseite)

- **Verschieben**: am roten Kopf festhalten und ziehen. Die Position wird gemerkt;
  Doppelklick auf den Kopf setzt sie zurück.
- **Starten / Stoppen**: Bot ein- und ausschalten. **⚙** öffnet die Einstellungen, **▾** klappt das Panel ein.
- **aktiv / letzte Stunde / nächste Prüfung**: aktualisiert sich sofort, sobald sich im Spiel etwas ändert.
- **Jetzt prüfen**: sofort einen Durchgang starten, ohne auf den Countdown zu warten.
- **Diagnose**: Probelauf ohne Alarmierung – zeigt, was der Bot sieht und schicken würde.
- **Vom Bot alarmiert**: alle Einsätze, zu denen der Bot Fahrzeuge geschickt hat, mit Status
  (offen / Anfahrt / vor Ort) und Credits. 📅 = geplanter Einsatz. Ein Klick öffnet den Einsatz.
- **Protokoll** (aufklappbar): was der Bot getan oder warum er etwas übersprungen hat.

## Einstellungen

Alles wird sofort gespeichert. Oben steht in einem Satz, was der Bot mit den aktuellen Einstellungen tut.

1. **Welche Einsätze?** – Verbandseinsätze, Events, eigene und Verbands-Sicherheitswachen an-/abwählen.
2. **Was wird geschickt?** – Anzahl mit − / + einstellen, Fahrzeugtypen per Klick wählen
   (oder Schnellwahl: Löschfahrzeug, RTW, Streifenwagen, GKW). Für geplante Einsätze kann
   eine eigene Auswahl eingestellt werden.
3. **Entfernung & Reserve** – maximale Entfernung, Reserve für eigene Einsätze, Prüfintervall.
4. **Filter** – Mindest-Credits, Einsätze ohne bekannte Credits, Einsätze nach Namen überspringen.

Mengen-Obergrenzen (gleichzeitig, pro Stunde, pro Prüfung) gibt es standardmäßig keine.
Wer sie doch möchte, findet sie unter **Erweitert** (ganz links = unbegrenzt).

Credits gibt es im Leitstellenspiel nur, wenn dein Fahrzeug **vor Abschluss am Einsatzort** ist.
Die wichtigsten Stellschrauben sind daher **Maximale Entfernung** und **Reserve**.
