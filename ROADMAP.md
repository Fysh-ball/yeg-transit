# yeg-transit roadmap

Free, open-source Edmonton-region arrivals app: pick your stops, see the next buses/LRT live,
and fall back to scheduled times plus "text your stop to 31100" when the phone has no data.
A hobby, hosted on our own box, with no service promise.

Project complete: a rider can install the web app or the Android app, save stops, see live
arrivals, put an Android home-screen widget up, and still get scheduled times offline; it runs
on our box at a public address, and Edmonton Transit Riders has been told about it.

1. [x] Server: ETS GTFS into SQLite, live TripUpdates every 30 s, stop search/near/departures/timetable API.
2. [x] Web app: saved stops, live board, offline scheduled times, SMS 31100 button, installable PWA.
3. [x] Phone-width check and real-device test.
4. [x] Deploy on our box behind a public hostname (City of Edmonton open data credit in the app).
5. [x] Wall board mode: full-screen, large type, for an old tablet or phone on the wall.
6. [ ] Draft the heads-up email to Edmonton Transit Riders for the user to send (draft kept out of the repo; the user sends it).
7. [x] Saved trips with a transfer: live "on track / tight / likely missed, next one at ..." warning.
8. [x] Stop side and landmark: "northbound, east side of 97 St, next to Dollarama" (direction from GTFS shapes,
   landmark from OpenStreetMap within ~40 m, shown only when found).
9. [x] Android app wrapping the web app, plus a home-screen widget (offline scheduled times since v14; real-bus check on the home screen 2026-10-22 07:30).
10. [x] "All buses by time" list per stop, next to "Buses to show" (grouped by route stays the default), from a parity check with ETR's Transit Tracker (v97).
11. [x] Wall board dims at night (10 or 11 pm to 6 am, or off): dark, low-contrast look; the copy says to turn the tablet's brightness down too, since a page can't (v97).
