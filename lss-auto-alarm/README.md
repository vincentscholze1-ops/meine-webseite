# LSS Verbands-Bot (Chrome-Erweiterung)

Schickt im [Leitstellenspiel](https://www.leitstellenspiel.de) automatisch eine vorher festgelegte
Fahrzeugauswahl zu Verbandseinsätzen, um dort mitzuverdienen. Die lukrativsten Einsätze kommen zuerst.

> ⚠️ Vollautomatisches Spielen verstößt gegen die Spielregeln des Leitstellenspiels.
> Nutzung auf eigenes Risiko – der Account kann gesperrt werden.

## Installation

1. In Chrome `chrome://extensions` öffnen und oben rechts den **Entwicklermodus** einschalten.
2. **Entpackte Erweiterung laden** → den Ordner `lss-auto-alarm` auswählen.
3. Hauptseite `https://www.leitstellenspiel.de/` neu laden. Unten links erscheint das Bot-Panel.
4. Zuerst in den Einstellungen die Fahrzeugauswahl und die Grenzen festlegen, dann **Start**.

Der Bot läuft nur, solange die Hauptseite in einem Tab offen ist (bei mehreren Tabs arbeitet nur einer).

## Ablauf pro Durchgang

1. Verbandseinsätze aus der Liste lesen. Einsätze, bei denen du schon beteiligt bist, werden übersprungen.
2. Filter anwenden (Mindest-Credits, Ausschluss nach Name) und nach Durchschnitts-Credits sortieren.
3. Für jeden Einsatz die Einsatzseite laden, die nächstgelegenen freien Fahrzeuge der Auswahl
   nehmen, Entfernung und Reserve prüfen und alarmieren.
4. Übersprungene Einsätze (zu weit, keine Fahrzeuge) werden 10 Minuten lang nicht erneut geprüft.

## Grenzen (Standardwerte)

| Einstellung | Standard | Zweck |
| --- | --- | --- |
| Prüfintervall | 60 s (± 30 %) | wie oft die Liste geprüft wird |
| Max. pro Durchgang | 3 | nicht alles auf einmal |
| Max. gleichzeitig beteiligt | 10 | Obergrenze für parallele Verbandseinsätze |
| Max. pro Stunde | 40 | Obergrenze für Alarmierungen |
| Max. Entfernung | 15 km | weit entfernte Einsätze sind oft vor deiner Ankunft fertig |
| Reserve | 3 | so viele passende Fahrzeuge bleiben für eigene Einsätze frei |
| Mindest-Credits | 0 | z.B. 1000, um nur lukrative Einsätze anzufahren |
| Stopp nach Fehlern | 3 | z.B. wenn du ausgeloggt wirst |

Credits gibt es im Leitstellenspiel nur, wenn dein Fahrzeug **vor Abschluss am Einsatzort** ist.
Die wichtigsten Stellschrauben sind daher **Max. Entfernung** und **Reserve**.
