package site.fysh.bus;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** The app is yegbus.com in a WebView; the page hands its saved stops to the widget through YegApp.sync. */
public class MainActivity extends Activity {
    static final String SITE = "https://yegbus.com/";
    private WebView web;
    private String geoOrigin;
    private GeolocationPermissions.Callback geoCallback;
    private volatile boolean ours = true; // the page on screen is yegbus.com: only it may write the widget's stops

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(0xFF17694A);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false); // the page never needs the phone's files or other apps' content
        s.setAllowContentAccess(false);
        web.addJavascriptInterface(new Bridge(), "YegApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                ours = url.startsWith(SITE); // a load shouldOverrideUrlLoading never sees (a POST) can't use the bridge
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (SITE.startsWith(u.getScheme() + "://" + u.getHost() + "/")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u)); // sms:, OpenStreetMap credits, anything off-site
                } catch (Exception e) {
                    android.util.Log.w("yeg", "no app for " + u + ": " + e.getMessage());
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    cb.invoke(origin, SITE.startsWith(origin), false); // only our own page gets the location
                    return;
                }
                geoOrigin = origin;
                geoCallback = cb;
                requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION}, 1);
            }
        });
        setContentView(web);
        if (state == null || web.restoreState(state) == null) web.loadUrl(SITE);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (geoCallback == null) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        geoCallback.invoke(geoOrigin, ok, false);
        geoCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        BusWidget.refresh(this); // leaving the app: the widget shows what you just looked at
    }

    class Bridge {
        @JavascriptInterface
        public void sync(String stops, String group) {
            if (!ours) return;
            getSharedPreferences(BusWidget.PREFS, MODE_PRIVATE).edit()
                .putString("stops", stops).putString("group", group).apply();
        }

        @JavascriptInterface
        public void look(String look) { // "material-dark", "glass-light"...: the widget dresses like the app
            if (!ours) return;
            getSharedPreferences(BusWidget.PREFS, MODE_PRIVATE).edit().putString("look", look).apply();
        }

        @JavascriptInterface
        public void widget(String style) { // "card" (like the app) or "ring" (clear)
            if (!ours) return;
            getSharedPreferences(BusWidget.PREFS, MODE_PRIVATE).edit().putString("widget", style).apply();
        }

        @JavascriptInterface
        public String stops() {
            if (!ours) return "[]";
            return getSharedPreferences(BusWidget.PREFS, MODE_PRIVATE).getString("stops", "[]");
        }
    }
}
