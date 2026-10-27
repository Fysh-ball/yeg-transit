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
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.location.Location;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.format.DateFormat;
import android.util.TypedValue;
import android.view.View;
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
                    // In portrait the size is MIN_WIDTH x MAX_HEIGHT. The text never grows: a bigger widget shows more.
                    android.os.Bundle o = m.getAppWidgetOptions(id);
                    m.updateAppWidget(id, build(c, o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250),
                        o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110)));
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

    private static RemoteViews build(Context c, int w, int h) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // Settings > Widget. Card: the app's lead card, cream on green in dark, colours as the app's Look and Colours.
        // Ring (glass): see-through with shadowed white text and the badge in a ring, as Android can't blur the wallpaper.
        String look = p.getString("look", "");
        boolean night = (c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        boolean glass = p.getString("widget", "card").equals("ring"), dark = look.isEmpty() ? night : look.endsWith("dark");
        int fg = glass ? 0xFFFFFFFF : dark ? 0xFFF3EEE2 : 0xFF002114; // dark: cream on green, softer than white
        int chip = glass ? 0xFFF2F2F2 : dark ? 0xFF9FF5C6 : fg, chipText = glass ? 0xFF17694A : dark ? 0xFF00391F : 0xFF9FF5C6;
        RemoteViews v = new RemoteViews(c.getPackageName(), glass ? R.layout.widget_glass : R.layout.widget);
        if (!glass) v.setInt(R.id.root, "setBackgroundResource", dark ? R.drawable.widget_bg_dark : R.drawable.widget_bg_light);
        for (int id : new int[]{R.id.stop, R.id.clock, R.id.big, R.id.dest, R.id.then}) v.setTextColor(id, fg);
        // When it was drawn, not a live clock: Android can stop our redraws (battery saver), and a ticking clock
        // over frozen minutes passed 5:29 p.m. times off as current at 2:30 a.m. (2026-10-24).
        v.setTextViewText(R.id.clock, DateFormat.format(DateFormat.is24HourFormat(c) ? "H:mm" : "h:mm", System.currentTimeMillis()));
        v.removeAllViews(R.id.rows);
        v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(c, 0,
            new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));
        // Small (2x1): badge and time. Medium (4x1): plus where it goes. Tall: stop, clock, wave and rows to fill it,
        // from the top (stretched, the rest used to float in the middle), then your other groups if there's room.
        boolean tall = h >= 100, wide = w >= 200;
        int room = tall ? h - 140 : 0; // dp under the hero: a row takes 34, 50 with its stop's name, a group heading 26
        v.setInt(R.id.root, "setGravity", tall ? android.view.Gravity.TOP : android.view.Gravity.CENTER_VERTICAL);
        v.setViewVisibility(R.id.bar, View.GONE); // until there's a bus
        v.setViewVisibility(R.id.hero, View.GONE);
        if (!glass) v.setViewVisibility(R.id.wave, View.GONE); // the ring widget has no wave
        v.setViewVisibility(R.id.dest, wide || tall ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.then, wide || tall ? View.VISIBLE : View.GONE);

        List<JSONObject> stops = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(p.getString("stops", "[]"));
            for (int i = 0; i < a.length(); i++) stops.add(a.getJSONObject(i));
        } catch (Exception e) {
            android.util.Log.w("yeg", "saved stops unreadable: " + e);
        }
        if (stops.isEmpty()) {
            v.addView(R.id.rows, alone(note(c, "Open the app and save a stop to see it here.", fg)));
            return v;
        }

        String group = nearestGroup(c, stops, p.getString("group", ""));
        JSONObject wx = new JSONObject(); // extra: weather minutes on top of each walk time, as on the page
        try {
            wx = new JSONObject(get(MainActivity.SITE + "api/weather"));
        } catch (Exception e) {
            android.util.Log.w("yeg", "weather: " + e);
        }
        int extra = wx.optInt("extra");
        // By the clock: the temperature, plus a word when the weather matters: now ("Snowy sidewalks"), else "Rain later".
        String why = wx.optString("why"), word = why.isEmpty() ? wx.optString("soon") : why.substring(0, 1).toUpperCase() + why.substring(1);
        if (!wx.isNull("temp") && wx.has("temp")) word = wx.optInt("temp") + "\u00b0" + (word.isEmpty() ? "" : " \u00b7 " + word);
        v.setTextViewText(R.id.wx, word);
        v.setTextColor(R.id.wx, fg);
        v.setViewVisibility(R.id.wx, word.isEmpty() ? View.GONE : View.VISIBLE);
        // Like the ETR board: one list of the next buses at all your stops, soonest first.
        List<long[]> order = new ArrayList<>(); // {leave time, index into deps}
        List<JSONObject> deps = new ArrayList<>();
        boolean offline = false;
        java.util.Set<String> alerts = new java.util.LinkedHashSet<>(); // ETS: stop closed or moved, use #1457
        int here = 0; // stops in this group: more than one, and each row says its stop
        String blocked = blocked(c); // Android keeping us off the network, which looks like no connection
        boolean failed = false, walking = false, picked = false; // for the empty message: why there's nothing to show
        for (JSONObject s : stops) {
            if (!group.isEmpty() && !group.equals(s.optString("group"))) continue;
            here++;
            walking |= s.optLong("walk", 0) > 0;
            picked |= s.has("only");
            try {
                offline |= departures(c, p, s, extra, deps, order, alerts, 0);
            } catch (Exception e) {
                android.util.Log.w("yeg", s.optString("name") + ": " + e);
                if (!blocked.isEmpty()) { offline = true; continue; } // said once below, not per stop
                failed = true;
                v.addView(R.id.rows, note(c, s.optString("name") + ": can't load, and no saved timetable yet.", fg));
                room -= 34;
            }
        }
        java.util.Map<String, List<Long>> then = collapse(deps, order);
        for (String a : alerts) {
            if (room < 34) break;
            RemoteViews n = note(c, a, fg);
            n.setTextColor(R.id.text, glass || dark ? 0xFFF1D892 : 0xFF6B4F00); // the page's warning yellow
            v.addView(R.id.rows, n);
            room -= 34;
        }
        if (offline && !blocked.isEmpty()) { // say it even when there's no room: it's why the times are wrong
            RemoteViews n = note(c, blocked + " Tap to allow it.", fg);
            n.setInt(R.id.text, "setMaxLines", 2);
            n.setBoolean(R.id.text, "setSingleLine", false);
            n.setOnClickPendingIntent(R.id.text, PendingIntent.getActivity(c, 2, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + c.getPackageName())), PendingIntent.FLAG_IMMUTABLE));
            v.addView(R.id.rows, n);
            room -= 50;
        } else if (offline && room >= 34) {
            v.addView(R.id.rows, note(c, online(c) ? "Live times are down right now: scheduled times." : "No connection: scheduled times.", fg));
            room -= 34;
        }
        if (order.isEmpty()) { // the same words as the page, plus the walk: a bus you can't reach isn't shown
            if (!failed && !(offline && !blocked.isEmpty())) v.addView(R.id.rows, alone(note(c, walking
                ? "No bus you can still walk to in the next 3 hours." : picked ? "No buses on your routes in the next 3 hours."
                : "No buses in the next 3 hours.", fg)));
            return v;
        }
        long now = System.currentTimeMillis() / 1000;
        // The next bus, big, with the wave that fills over its last 15 minutes (a still picture: widgets can't animate).
        JSONObject d = deps.get((int) order.get(0)[1]);
        long leave = order.get(0)[0] - now;
        v.setViewVisibility(R.id.hero, View.VISIBLE);
        v.setViewVisibility(R.id.bar, tall ? View.VISIBLE : View.GONE);
        float fill = Math.min(1f, Math.max(0.04f, 1 - leave / 900f)); // over its last 15 minutes
        if (glass) v.setImageViewBitmap(R.id.cookie, ring(c, route(d), tall ? 76 : 52, fill, fg));
        else {
            v.setViewVisibility(R.id.wave, tall ? View.VISIBLE : View.GONE);
            v.setImageViewBitmap(R.id.cookie, badge(c, route(d), 1, tall ? 56 : 44, chip, chipText));
        }
        v.setTextViewText(R.id.big, when(c, d, leave, true));
        v.setTextViewTextSize(R.id.big, TypedValue.COMPLEX_UNIT_SP, glass ? 30 : tall ? 34 : 28);
        v.setTextViewText(R.id.dest, head(d));
        StringBuilder next = new StringBuilder(); // "then 13, 25 min", or the stop when there's no later bus
        List<Long> later = then.get(d.optString("route") + "|" + d.optString("headsign"));
        for (int i = 1; i < Math.min(3, later.size()); i++)
            next.append(i == 1 ? "then " : ", ").append(Math.max(0, Math.round((later.get(i) - now) / 60.0)));
        String stop = d.optString("stop"), more = later.size() > 1 ? next + " min" : tall ? "" : stop;
        if (here > 1 && !more.equals(stop)) more = more.isEmpty() ? stop : stop + " \u00b7 " + more;
        // Not live (timetable, or ETS's feed stalled): say so on the hero itself, as a small widget has no room for notes.
        if (!d.optBoolean("live")) more = more.isEmpty() ? "Not live" : "Not live \u00b7 " + more;
        v.setTextViewText(R.id.then, glass && !more.isEmpty() ? "\u00b7 " + more : more);
        v.setTextViewText(R.id.stop, here > 1 ? (group.isEmpty() ? here + " stops" : group) : stop);
        if (tall && !glass) v.setImageViewBitmap(R.id.wave, wave(c, w - 28, fill, chip));
        int rowH = here > 1 ? 50 : 34;
        // Each stop's next bus first, then the soonest of the rest: ten routes at a transit centre used to fill the
        // rows and hide your other stop's only bus under a "2 stops" heading (2026-10-24).
        java.util.Set<String> seen = new java.util.HashSet<>(java.util.Collections.singleton(d.optString("sid")));
        List<long[]> rest = order.subList(1, order.size()), pick = new ArrayList<>();
        for (long[] o : rest) if (seen.add(deps.get((int) o[1]).optString("sid"))) pick.add(o);
        for (long[] o : rest) if (!pick.contains(o)) pick.add(o);
        pick = new ArrayList<>(pick.subList(0, Math.min(pick.size(), Math.max(0, room / rowH))));
        pick.sort((x, y) -> Long.compare(x[0], y[0]));
        for (long[] o : pick) {
            v.addView(R.id.rows, row(c, deps.get((int) o[1]), o[0] - now, here > 1, glass, dark, fg, chip, chipText));
            room -= rowH;
        }
        // Room left: your other groups (Home, Work...), each under its name, the same way.
        java.util.Set<String> others = new java.util.LinkedHashSet<>();
        for (JSONObject s : stops) if (!s.optString("group").isEmpty() && !s.optString("group").equals(group)) others.add(s.optString("group"));
        for (String g : others) {
            if (group.isEmpty() || room < 26 + 34) break;
            List<JSONObject> gd = new ArrayList<>();
            List<long[]> go = new ArrayList<>();
            int n = 0;
            for (JSONObject s : stops) {
                if (!g.equals(s.optString("group"))) continue;
                n++;
                try {
                    departures(c, p, s, extra, gd, go, new java.util.HashSet<>(), 300);
                } catch (Exception e) {
                    android.util.Log.w("yeg", g + " " + s.optString("name") + ": " + e);
                }
            }
            collapse(gd, go);
            if (go.isEmpty()) continue;
            RemoteViews head = note(c, g, fg);
            v.addView(R.id.rows, head);
            room -= 26;
            for (long[] o : go) {
                if (room < (n > 1 ? 50 : 34)) break;
                v.addView(R.id.rows, row(c, gd.get((int) o[1]), o[0] - now, n > 1, glass, dark, fg, chip, chipText));
                room -= n > 1 ? 50 : 34;
            }
        }
        return v;
    }

    /** Soonest first, one line per route and direction: routes 1 and 2 both show, a second 1 doesn't (nor the same
     *  bus at two of your stops; the stop you'd leave for first wins). Returns each line's times, for "then". */
    private static java.util.Map<String, List<Long>> collapse(List<JSONObject> deps, List<long[]> order) {
        order.sort((x, y) -> Long.compare(x[0], y[0]));
        java.util.Map<String, List<Long>> then = new java.util.HashMap<>();
        order.removeIf(o -> { JSONObject d = deps.get((int) o[1]);
            List<Long> t = then.computeIfAbsent(d.optString("route") + "|" + d.optString("headsign"), k -> new ArrayList<>());
            t.add(o[0]); return t.size() > 1; });
        return then;
    }

    /** One bus under the hero; with its stop's name small underneath when the group has several stops. */
    private static RemoteViews row(Context c, JSONObject r, long leave, boolean stop, boolean glass, boolean dark, int fg, int chip, int chipText) {
        RemoteViews row = new RemoteViews(c.getPackageName(), glass ? R.layout.widget_row : R.layout.widget_row_m);
        if (!glass) row.setInt(R.id.row, "setBackgroundResource", dark ? R.drawable.widget_row_dark : R.drawable.widget_row_light);
        row.setImageViewBitmap(R.id.badge, badge(c, route(r), 0, 26, chip, chipText));
        CharSequence head = head(r);
        if (stop) {
            android.text.SpannableString s = new android.text.SpannableString(head + "\n" + r.optString("stop"));
            s.setSpan(new android.text.style.RelativeSizeSpan(.8f), head.length() + 1, s.length(), 0);
            s.setSpan(new android.text.style.ForegroundColorSpan(fg & 0xB3FFFFFF), head.length() + 1, s.length(), 0);
            head = s;
        }
        row.setTextViewText(R.id.head, head);
        row.setTextViewText(R.id.times, when(c, r, leave, false));
        row.setTextColor(R.id.head, fg);
        row.setTextColor(R.id.times, r.optBoolean("live") ? fg : fg & 0xB3FFFFFF); // faded = scheduled, not live
        return row;
    }

    private static String route(JSONObject d) {
        return d.optString("route").replaceFirst("^0+(?=\\w)", "");
    }

    private static String head(JSONObject d) {
        String route = route(d), head = d.optString("headsign");
        return head.startsWith(route + " ") ? head.substring(route.length() + 1) : head;
    }

    /** "3 min", "Due", "Go now" (or "Go" on a row), or the clock time past an hour; the "min" small. With a walk it
     *  counts to leaving, so it says so: an unlabelled "8 min" read as the bus, where the app said "Bus in 19 min" (2026-10-26). */
    private static CharSequence when(Context c, JSONObject d, long leave, boolean big) {
        long m = Math.round(leave / 60.0);
        boolean walking = d.optBoolean("walking");
        if (walking && leave < 30) return big ? "Go now" : "Go";
        if (m <= 0) return "Due";
        if (m >= 60) {
            String t = DateFormat.getTimeFormat(c).format(new java.util.Date((System.currentTimeMillis() / 1000 + leave) * 1000));
            return walking ? "Leave at " + t : t;
        }
        String pre = walking ? "Leave in " : "";
        android.text.SpannableString s = new android.text.SpannableString(pre + m + " min");
        if (big) { // rows: one size
            s.setSpan(new android.text.style.RelativeSizeSpan(.5f), s.length() - 4, s.length(), 0);
            if (walking) s.setSpan(new android.text.style.RelativeSizeSpan(.5f), 0, pre.length(), 0);
        }
        return s;
    }

    /** A route badge as a picture: shape 0 = row pill, 1 = Material cookie, 2 = Glass rounded square. */
    private static Bitmap badge(Context c, String text, int shape, int sizeDp, int bg, int fg) {
        float dp = c.getResources().getDisplayMetrics().density;
        Paint t = new Paint(Paint.ANTI_ALIAS_FLAG);
        t.setTypeface(Typeface.create("sans-serif", Typeface.BOLD)); // DEFAULT_BOLD drew thin with Samsung's font
        t.setColor(fg);
        t.setTextAlign(Paint.Align.CENTER);
        t.setTextSize(sizeDp * dp * (shape == 0 ? .5f : text.length() > 3 ? .3f : .36f));
        int H = Math.round(sizeDp * dp), W = shape == 0 ? Math.max(Math.round(H * 1.4f), Math.round(t.measureText(text) + 14 * dp)) : H;
        Bitmap b = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas k = new Canvas(b);
        Paint f = new Paint(Paint.ANTI_ALIAS_FLAG);
        f.setColor(bg);
        if (shape == 1) { // nine soft bumps, like the app's cookie.svg
            Path path = new Path();
            float r = H / 2f;
            for (int i = 0; i <= 180; i++) {
                double a = i * Math.PI / 90, rr = r * (.9 + .1 * Math.cos(9 * a));
                if (i == 0) path.moveTo((float) (r + rr), r); else path.lineTo((float) (r + rr * Math.cos(a)), (float) (r + rr * Math.sin(a)));
            }
            k.drawPath(path, f);
        } else k.drawRoundRect(0, 0, W, H, H * .32f, H * .32f, f);
        k.drawText(text, W / 2f, H / 2f - (t.descent() + t.ascent()) / 2, t);
        return b;
    }

    /** The ring widget's badge: the route inside a ring filled to f, like the wave. */
    private static Bitmap ring(Context c, String text, int sizeDp, float f, int fg) {
        float dp = c.getResources().getDisplayMetrics().density, S = sizeDp * dp, sw = (sizeDp > 60 ? 6 : 5) * dp;
        Bitmap b = Bitmap.createBitmap(Math.round(S), Math.round(S), Bitmap.Config.ARGB_8888);
        Canvas k = new Canvas(b);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(sw);
        p.setStrokeCap(Paint.Cap.ROUND);
        android.graphics.RectF o = new android.graphics.RectF(sw / 2, sw / 2, S - sw / 2, S - sw / 2);
        p.setColor(0x2EFFFFFF);
        k.drawOval(o, p);
        p.setColor(0xFF9FF5C6); // the app's mint
        k.drawArc(o, -90, 360 * f, false, p);
        Paint t = new Paint(Paint.ANTI_ALIAS_FLAG);
        t.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        t.setColor(fg);
        t.setTextAlign(Paint.Align.CENTER);
        t.setTextSize(S * (text.length() > 3 ? .24f : .32f));
        t.setShadowLayer(4 * dp, 0, dp, 0xCC000000);
        k.drawText(text, S / 2, S / 2 - (t.descent() + t.ascent()) / 2, t);
        return b;
    }

    /** The app's wave as a picture: filled to f with waves that flatten toward the tip, then the track line. */
    private static Bitmap wave(Context c, int wDp, float f, int color) {
        float dp = c.getResources().getDisplayMetrics().density;
        int W = Math.max(1, Math.round(wDp * dp)), H = Math.round(14 * dp);
        Bitmap b = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas k = new Canvas(b);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeCap(Paint.Cap.ROUND);
        float mid = H / 2f, x0 = 3 * dp, end = x0 + f * (W - 6 * dp), amp = f >= 1 ? 0 : 4 * dp;
        p.setStrokeWidth(3.5f * dp);
        p.setColor(color & 0x40FFFFFF);
        if (end < W - x0) k.drawLine(end, mid, W - x0, mid, p);
        p.setStrokeWidth(4.5f * dp);
        p.setColor(color);
        Path path = new Path();
        path.moveTo(x0, mid);
        for (float x = x0; x <= end; x += dp)
            path.lineTo(x, mid + amp * (float) (Math.pow(1 - (x - x0) / (end - x0 + 1), .85) * Math.sin((x - x0) / (5 * dp))));
        k.drawPath(path, p);
        return b;
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
    private static boolean departures(Context c, SharedPreferences p, JSONObject s, int extra, List<JSONObject> deps, List<long[]> order,
                                      java.util.Set<String> alerts, int maxAge) throws Exception {
        String id = Uri.encode(s.optString("id")), key = "tt:" + s.optString("id");
        JSONObject tt = new JSONObject(p.getString(key, "{}"));
        JSONArray all;
        long now;
        boolean offline = false;
        try {
            // maxAge > 0 (your other groups): reuse the last answer that young, so they cost a call per 5 min, not per minute
            JSONObject r = new JSONObject(p.getString("live:" + s.optString("id"), "{\"phone\":0}"));
            if (maxAge <= 0 || System.currentTimeMillis() / 1000 - r.getLong("phone") > maxAge) {
                r = new JSONObject(get(MainActivity.SITE + "api/stops/" + id + "/departures?n=30"));
                r.put("phone", System.currentTimeMillis() / 1000); // when it came, for the clock skew below
                if (maxAge > 0) p.edit().putString("live:" + s.optString("id"), r.toString()).apply();
            }
            // a reused answer: the server's "now" moved on by as long as the phone's has since it came
            now = r.getLong("now") + System.currentTimeMillis() / 1000 - r.getLong("phone");
            all = r.getJSONArray("departures");
            if (r.optLong("live_age") > 120) { // ETS's feed stalled: its last predictions aren't live any more, as the page says
                alerts.add("Times may be out of date (last live " + DateFormat.getTimeFormat(c)
                    .format(new java.util.Date((now - r.optLong("live_age")) * 1000)) + ").");
                for (int i = 0; i < all.length(); i++) all.getJSONObject(i).put("live", false);
            }
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
            android.util.Log.w("yeg", "stop " + id + ", using the saved timetable: " + e);
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
            d.put("walking", walk > 0).put("stop", s.optString("name")).put("sid", s.optString("id"));
            order.add(new long[]{d.getLong("time") - walk + skew, deps.size()});
            deps.add(d);
            left--;
        }
        return offline;
    }

    /** Why Android won't let the widget fetch while the app is closed, or "" when it would: then it's really offline. */
    private static String blocked(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        if (pm.isPowerSaveMode() && !pm.isIgnoringBatteryOptimizations(c.getPackageName()))
            return "Battery saver stops live times here.";
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class); // Data saver only limits metered networks
        if (cm.isActiveNetworkMetered() && cm.getRestrictBackgroundStatus() == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED)
            return "Data saver stops live times here.";
        return "";
    }

    /** The phone has a working internet connection, so a failed fetch is our end. */
    private static boolean online(Context c) {
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
        return nc != null && nc.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private static RemoteViews alone(RemoteViews note) { // the only thing on the widget: in the middle
        note.setInt(R.id.text, "setGravity", android.view.Gravity.CENTER);
        return note;
    }

    private static RemoteViews note(Context c, String text, int color) {
        RemoteViews t = new RemoteViews(c.getPackageName(), R.layout.widget_stop);
        t.setTextViewText(R.id.text, text);
        t.setTextColor(R.id.text, color);
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
