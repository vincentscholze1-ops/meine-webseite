# LSS Auto-Alarmierung (Chrome-Erweiterung)

Wählt im [Leitstellenspiel](https://www.leitstellenspiel.de) beim Öffnen eines Einsatzes
automatisch passende freie Fahrzeuge aus, nächstgelegene zuerst. Alarmiert wird per
**Alt+A** oder über den Knopf im kleinen Panel unten rechts.

## Installation

1. Ordner `lss-auto-alarm` herunterladen (oder das Repo klonen).
2. In Chrome `chrome://extensions` öffnen.
3. Oben rechts den **Entwicklermodus** einschalten.
4. **Entpackte Erweiterung laden** → den Ordner `lss-auto-alarm` auswählen.
5. Leitstellenspiel neu laden und einen Einsatz öffnen.

## Woher weiß die Erweiterung, was gebraucht wird?

In dieser Reihenfolge:

1. **Fehlmeldung im Einsatz** („Zusätzlich benötigte Fahrzeuge: 2 Löschfahrzeuge, 1 Drehleiter …“).
2. **Einsatzanforderung** aus `/einsaetze.json` (bei frischen Einsätzen, wird 24 h zwischengespeichert).
3. **Standard** (voreingestellt: 1 Löschfahrzeug).

Sind schon Fahrzeuge auf Anfahrt, aber noch keine Fehlmeldung da, wird nichts angehakt.
Fahrzeuge, die du (oder eine AAO) schon angehakt hast, werden angerechnet.

## Tastenkürzel

| Kürzel | Aktion |
| --- | --- |
| Alt+A | Alarmieren (optional: „Alarmieren und nächster Einsatz“) |
| Alt+R | Auswahl neu berechnen |

## Einstellungen

Klick auf das Erweiterungs-Symbol → schnelle Schalter. Unter **Weitere Einstellungen** kannst du
die Fahrzeugkategorien (welcher Text in der Fehlmeldung welche Fahrzeugtypen bedeutet),
die Wunsch-Reihenfolge der Typen und die Kürzel anpassen.

## Hinweis

Die Erweiterung hakt nur Fahrzeuge an. Das Alarmieren bleibt bewusst ein Tastendruck von dir:
Vollautomatische Bots, die ohne Zutun Einsätze abarbeiten, verstoßen gegen die Spielregeln
des Leitstellenspiels und können zur Sperrung des Accounts führen.
