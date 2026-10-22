package site.fysh.bus;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.text.format.DateFormat;
import android.util.TypedValue;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * Home-screen widget: the next buses at the stops in your nearest group, one line per route and direction,
 * same rules as the web page (picked routes, walk time, how many routes).
 * Times read like the wall board ("5 min", "Due", "Go now"), so it refreshes itself once a minute while the
 * screen is on (a non-waking alarm: an asleep phone isn't woken for it).
 */
public class BusWidget extends AppWidgetProvider {
    static final String PREFS = "yeg", REFRESH = "site.fysh.bus.REFRESH";

    static void refresh(Context c) {
        c.sendBroadcast(new Intent(REFRESH).setClass(c, BusWidget.class));
    }

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        update(c, goAsync());
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, android.os.Bundle opts) {
        update(c, goAsync()); // resized: fit as many lines as the new size holds
    }

    @Override
    public void onDisabled(Context c) {
        c.getSystemService(AlarmManager.class).cancel(tick(c)); // last widget removed
    }

    private static PendingIntent tick(Context c) {
        return PendingIntent.getBroadcast(c, 1, new Intent(REFRESH).setClass(c, BusWidget.class), PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onReceive(Context c, Intent i) {
        if (REFRESH.equals(i.getAction())) update(c, goAsync());
        else super.onReceive(c, i);
    }

    private static void update(Context c, PendingResult done) {
        new Thread(() -> {
            try {
                AppWidgetManager m = AppWidgetManager.getInstance(c);
                int[] ids = m.getAppWidgetIds(new ComponentName(c, BusWidget.class));
                for (int id : ids) {
                    // Height in portrait is MAX_HEIGHT. Like Samsung's weather widget the text never grows:
                    // the next bus is big (~40 dp line), the rest small (~26 dp each); a taller widget fits more buses.
                    int h = m.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110) - 16;
                    m.updateAppWidget(id, build(c, 1 + Math.max(0, h - 40) / 26));
                }
                if (ids.length > 0) c.getSystemService(AlarmManager.class)
                    .set(AlarmManager.RTC, (System.currentTimeMillis() / 60000 + 1) * 60000, tick(c));
            } catch (Exception e) {
                android.util.Log.w("yeg", "widget update failed: " + e);
            } finally {
                done.finish();
            }
        }).start();
    }

    private static RemoteViews build(Context c, int budget) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget);
        v.removeAllViews(R.id.rows);
        v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(c, 0,
            new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));

        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        List<JSONObject> stops = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(p.getString("stops", "[]"));
            for (int i = 0; i < a.length(); i++) stops.add(a.getJSONObject(i));
        } catch (Exception e) {
            android.util.Log.w("yeg", "saved stops unreadable: " + e);
        }
        if (stops.isEmpty()) {
            v.addView(R.id.rows, note(c, "Open the app and save a stop to see it here."));
            return v;
        }

        String group = nearestGroup(c, stops, p.getString("group", ""));
        int extra = 0; // weather minutes on top of each walk time, as on the page
        try {
            extra = new JSONObject(get(MainActivity.SITE + "api/weather")).optInt("extra");
        } catch (Exception e) {
            android.util.Log.w("yeg", "weather: " + e);
        }
        // Like the ETR board: one list of the next buses at all your stops, soonest first, no stop names.
        List<long[]> order = new ArrayList<>(); // {leave time, index into deps}
        List<JSONObject> deps = new ArrayList<>();
        boolean offline = false;
        java.util.Set<String> alerts = new java.util.LinkedHashSet<>(); // ETS: stop closed or moved, use #1457
        for (JSONObject s : stops) {
            if (!group.isEmpty() && !group.equals(s.optString("group"))) continue;
            try {
                offline |= departures(p, s, extra, deps, order, alerts);
            } catch (Exception e) {
                v.addView(R.id.rows, note(c, s.optString("name") + ": couldn't load (" + e.getMessage() + ")"));
                budget--;
            }
        }
        order.sort((x, y) -> Long.compare(x[0], y[0]));
        // One line per route and direction, its next bus: routes 1 and 2 both show, a second 1 doesn't
        // (nor the same bus at two of your stops; the stop you'd leave for first wins).
        java.util.Set<String> seen = new java.util.HashSet<>();
        order.removeIf(o -> { JSONObject d = deps.get((int) o[1]); return !seen.add(d.optString("route") + "|" + d.optString("headsign")); });
        for (String a : alerts) {
            if (budget <= 1) break;
            RemoteViews n = note(c, a);
            n.setTextColor(R.id.text, 0xFFF1D892); // the page's warning yellow
            v.addView(R.id.rows, n);
            budget--;
        }
        if (offline && budget > 1) {
            v.addView(R.id.rows, note(c, "No connection: scheduled times."));
            budget--;
        }
        if (order.isEmpty() && budget > 0) v.addView(R.id.rows, note(c, "No buses in the next 3 hours."));
        java.text.DateFormat clock = DateFormat.getTimeFormat(c);
        long now = System.currentTimeMillis() / 1000;
        boolean first = true;
        for (long[] o : order.subList(0, Math.max(0, Math.min(budget, order.size())))) {
            JSONObject d = deps.get((int) o[1]);
            long leave = o[0] - now, m = Math.round(leave / 60.0);
            boolean walking = d.optBoolean("walking");
            String when = walking && leave < 30 ? "Go" : m <= 0 ? "Due" : m < 60 ? m + "m" : clock.format(o[0] * 1000);
            String route = d.optString("route").replaceFirst("^0+(?=\\w)", ""), head = d.optString("headsign");
            if (head.startsWith(route + " ")) head = head.substring(route.length() + 1);
            RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.widget_row);
            row.setTextViewText(R.id.route, route);
            row.setTextViewText(R.id.head, head);
            row.setTextViewText(R.id.times, when);
            float text = first ? 22 : 14; // the next bus big, the rest small
            first = false;
            row.setTextViewTextSize(R.id.route, TypedValue.COMPLEX_UNIT_DIP, text * 0.9f);
            row.setTextViewTextSize(R.id.head, TypedValue.COMPLEX_UNIT_DIP, text);
            row.setTextViewTextSize(R.id.times, TypedValue.COMPLEX_UNIT_DIP, text * 1.25f);
            row.setTextColor(R.id.times, d.optBoolean("live") ? 0xFF8EE06A : 0xFFDDDDDD); // green = live, as on the board
            v.addView(R.id.rows, row);
        }
        return v;
    }

    /** The group of the saved stop nearest the phone; the app's current tab when the phone can't say where it is. */
    private static String nearestGroup(Context c, List<JSONObject> stops, String fallback) {
        Location me = null;
        if (c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            LocationManager lm = c.getSystemService(LocationManager.class);
            for (String provider : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(provider);
                if (l != null && (me == null || l.getTime() > me.getTime())) me = l;
            }
        }
        // ponytail: last known fix only, often null in the background without background-location permission;
        // a live fix would need that permission plus a foreground service.
        if (me == null) return fallback;
        String best = fallback;
        float bestM = Float.MAX_VALUE;
        float[] d = new float[1];
        for (JSONObject s : stops) {
            if (s.optString("group").isEmpty() || !s.has("lat")) continue;
            Location.distanceBetween(me.getLatitude(), me.getLongitude(), s.optDouble("lat"), s.optDouble("lon"), d);
            if (d[0] < bestM) { bestM = d[0]; best = s.optString("group"); }
        }
        return best;
    }

    /**
     * One stop's buses, filtered like the page (my routes, walk time, how many), added as {leave time, index}.
     * Offline it falls back to the stop's saved 30 h timetable, as the page does, and returns true.
     */
    private static boolean departures(SharedPreferences p, JSONObject s, int extra, List<JSONObject> deps, List<long[]> order,
                                      java.util.Set<String> alerts) throws Exception {
        String id = Uri.encode(s.optString("id")), key = "tt:" + s.optString("id");
        JSONObject tt = new JSONObject(p.getString(key, "{}"));
        JSONArray all;
        long now;
        boolean offline = false;
        try {
            JSONObject r = new JSONObject(get(MainActivity.SITE + "api/stops/" + id + "/departures?n=30"));
            now = r.getLong("now");
            all = r.getJSONArray("departures");
            JSONArray al = r.optJSONArray("alerts");
            for (int i = 0; al != null && i < al.length(); i++) {
                JSONObject a = al.getJSONObject(i);
                JSONArray use = a.optJSONArray("use");
                // one line on the widget, so "use #1457" goes first where the end may be cut off
                alerts.add((use != null && use.length() > 0 ? "Use #" + use.getJSONObject(0).optString("code") + ": " : "") + a.optString("head"));
            }
            if (tt.optLong("to") - now < 12 * 3600) try { // same 12 h top-up rule as the page
                p.edit().putString(key, get(MainActivity.SITE + "api/stops/" + id + "/timetable?hours=30")).apply();
            } catch (Exception e) {
                android.util.Log.w("yeg", "timetable: " + e);
            }
        } catch (Exception e) {
            JSONArray rows = tt.optJSONArray("rows");
            if (rows == null) throw e;
            offline = true;
            now = System.currentTimeMillis() / 1000;
            all = new JSONArray();
            for (int i = 0; i < rows.length(); i++) {
                JSONArray t = rows.getJSONArray(i); // [time, route, headsign, color, text_color]
                if (t.getLong(0) < now - 30) continue;
                all.put(new JSONObject().put("time", t.getLong(0)).put("route", t.getString(1)).put("headsign", t.getString(2))
                    .put("color", t.optString(3)).put("text_color", t.optString(4)).put("live", false));
            }
        }
        long walk = s.optLong("walk", 0) > 0 ? (s.optLong("walk") + extra) * 60 : 0;
        // the server's clock, not the phone's, decides what has left; shift so the phone's "now" lines up
        long skew = System.currentTimeMillis() / 1000 - now;
        JSONArray only = s.optJSONArray("only");
        int left = s.optInt("n", 3);
        for (int i = 0; i < all.length() && left > 0; i++) {
            JSONObject d = all.getJSONObject(i);
            if (only != null && !only.toString().contains("\"" + d.optString("route") + "\"")) continue;
            if (walk > 0 && d.getLong("time") - walk < now) continue;
            d.put("walking", walk > 0);
            order.add(new long[]{d.getLong("time") - walk + skew, deps.size()});
            deps.add(d);
            left--;
        }
        return offline;
    }

    private static RemoteViews note(Context c, String text) {
        RemoteViews t = new RemoteViews(c.getPackageName(), R.layout.widget_stop);
        t.setTextViewText(R.id.text, text);
        return t;
    }

    private static String get(String url) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setConnectTimeout(4000);
        h.setReadTimeout(4000);
        h.setRequestProperty("User-Agent", "YEGBus-Android/1"); // Cloudflare turns away blank and library agents
        try {
            if (h.getResponseCode() != 200) throw new Exception("HTTP " + h.getResponseCode());
            try (InputStream in = h.getInputStream()) {
                return new String(in.readAllBytes(), "UTF-8");
            }
        } finally {
            h.disconnect();
        }
    }
}
