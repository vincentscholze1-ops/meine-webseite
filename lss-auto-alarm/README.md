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

Im Popup der Erweiterung steht oben die Version (aktuell **v3.0.0**).

## Das Panel (unten links auf der Hauptseite)

- **Start / Stopp**: Bot ein- und ausschalten. **⚙** öffnet die Einstellungen, **▾** klappt das Panel ein.
- **aktiv / letzte Stunde / nächste Prüfung**: aktualisiert sich sofort, sobald sich im Spiel etwas ändert.
- **Jetzt prüfen**: sofort einen Durchgang starten, ohne auf den Countdown zu warten.
- **Diagnose**: Probelauf ohne Alarmierung – zeigt, was der Bot sieht und schicken würde.
- **Vom Bot alarmiert**: alle Einsätze, zu denen der Bot Fahrzeuge geschickt hat.
  Punkt: 🔴 offen · 🟡 Anfahrt · 🟢 vor Ort, 📅 = geplanter Einsatz. Ein Klick öffnet den Einsatz.
- **Protokoll** (aufklappbar): was der Bot getan oder warum er etwas übersprungen hat.

## Einstellungen

Alles wird sofort gespeichert. Oben steht in einem Satz, was der Bot mit den aktuellen Einstellungen tut.

1. **Welche Einsätze?** – Verbandseinsätze, Events, eigene und Verbands-Sicherheitswachen an-/abwählen.
2. **Was wird geschickt?** – Anzahl mit − / + einstellen, Fahrzeugtypen per Klick wählen
   (oder Schnellwahl: Löschfahrzeug, RTW, Streifenwagen, GKW). Für geplante Einsätze kann
   eine eigene Auswahl eingestellt werden.
3. **Grenzen** – gleichzeitig beteiligt, pro Stunde, pro Prüfung, maximale Entfernung, Reserve, Prüfintervall.
4. **Filter** – Mindest-Credits, Einsätze ohne bekannte Credits, Einsätze nach Namen überspringen.

Credits gibt es im Leitstellenspiel nur, wenn dein Fahrzeug **vor Abschluss am Einsatzort** ist.
Die wichtigsten Stellschrauben sind daher **Maximale Entfernung** und **Reserve**.
