package com.vnkhoado.cordova.changeappinfo;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.util.Log;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * RuntimeIconChanger.java
 *
 * Android native implementation — optimised for OutSystems MABS.
 *
 * MABS constraints respected:
 *   - No custom Gradle dependencies (only android.* and org.json.*)
 *   - Reads ICON_CDN_URL from Cordova preferences.getString() which maps
 *     directly to the value set in OutSystems Extensibility Configurations
 *   - Activity-alias strategy: aliases are injected at build time by
 *     hooks/android/register-icon-aliases.js; we only enable/disable them here
 *   - API 21+ (Android 5.0) minimum — matches MABS minimum
 *   - DONT_KILL_APP flag so icon switches without forcing the user to restart
 *
 * Alias naming convention (must match the hook):
 *   <packageName>.MainActivity_<iconName>
 */
public class RuntimeIconChanger extends CordovaPlugin {

    private static final String TAG      = "RuntimeIconChanger";
    private static final String PREF_KEY = "RIC_currentIcon";
    private static final int    TIMEOUT  = 15_000; // ms

    private String cdnJsonUrl = "";
    // Simple in-memory cache — cleared when plugin is destroyed
    private final List<JSONObject> cachedIcons = new ArrayList<>();

    // MARK: - execute() dispatch

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException {
        // MABS stores preference keys in lowercase
        cdnJsonUrl = preferences.getString("icon_cdn_url",
                     preferences.getString("ICON_CDN_URL", ""));

        switch (action) {
            case "isSupported":
                cb.success(true);         // always true on Android API 21+
                return true;

            case "getIconList":
                getIconList(cb);
                return true;

            case "changeIcon":
                if (args.isNull(0)) { cb.error("iconName is required"); return true; }
                changeIcon(args.getString(0), cb);
                return true;

            case "resetToDefault":
                changeIcon("default", cb);
                return true;

            case "getCurrentIcon":
                getCurrentIcon(cb);
                return true;

            default:
                return false;
        }
    }

    // MARK: - Actions

    private void getIconList(final CallbackContext cb) {
        if (cdnJsonUrl.isEmpty()) {
            cb.error("ICON_CDN_URL not configured. Add it to OutSystems Extensibility Configurations.");
            return;
        }
        if (!cachedIcons.isEmpty()) {
            cb.success(listToJsonArray(cachedIcons));
            return;
        }
        cordova.getThreadPool().execute(() -> {
            try {
                List<JSONObject> icons = fetchIconList();
                cachedIcons.clear();
                cachedIcons.addAll(icons);
                cb.success(listToJsonArray(icons));
            } catch (Exception e) {
                cb.error("getIconList failed: " + e.getMessage());
            }
        });
    }

    private void changeIcon(final String iconName, final CallbackContext cb) {
        if (iconName == null || iconName.trim().isEmpty()) {
            cb.error("iconName must be a non-empty string");
            return;
        }
        cordova.getThreadPool().execute(() -> {
            try {
                // Validate icon exists in CDN list (unless switching to 'default')
                if (!"default".equals(iconName)) {
                    List<JSONObject> icons = cachedIcons.isEmpty() ? fetchIconList() : cachedIcons;
                    if (cachedIcons.isEmpty()) {
                        cachedIcons.addAll(icons);
                    }
                    boolean found = false;
                    for (JSONObject icon : icons) {
                        if (iconName.equals(icon.optString("name"))) { found = true; break; }
                    }
                    if (!found) {
                        cb.error("Icon '" + iconName + "' not found in CDN list.");
                        return;
                    }
                }

                switchAlias(iconName);
                getPrefs().edit().putString(PREF_KEY, iconName).apply();
                cb.success("Icon changed to " + iconName);

            } catch (Exception e) {
                cb.error("changeIcon failed: " + e.getMessage());
            }
        });
    }

    private void getCurrentIcon(final CallbackContext cb) {
        cb.success(getPrefs().getString(PREF_KEY, "default"));
    }

    // MARK: - Package Manager alias switching

    /**
     * Enable the activity-alias for targetName, disable all others.
     * Aliases were injected into AndroidManifest by the build hook.
     */
    private void switchAlias(String targetName) {
        Context ctx     = cordova.getActivity().getApplicationContext();
        PackageManager pm = ctx.getPackageManager();
        String pkg      = ctx.getPackageName();

        // Collect all known alias names
        List<String> aliases = new ArrayList<>();
        aliases.add(pkg + ".MainActivity_default");
        for (JSONObject icon : cachedIcons) {
            String n = icon.optString("name", "");
            if (!n.isEmpty() && !"default".equals(n)) {
                aliases.add(pkg + ".MainActivity_" + n);
            }
        }

        String targetAlias = pkg + ".MainActivity_" + targetName;

        for (String alias : aliases) {
            int state = alias.equals(targetAlias)
                    ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
            try {
                pm.setComponentEnabledSetting(
                        new ComponentName(pkg, alias),
                        state,
                        PackageManager.DONT_KILL_APP);
            } catch (SecurityException se) {
                // Alias not declared in manifest — skip silently
                Log.w(TAG, "Alias not found or not accessible: " + alias);
            }
        }
    }

    // MARK: - Network helpers (no external dependencies)

    private List<JSONObject> fetchIconList() throws Exception {
        if (cdnJsonUrl.isEmpty()) throw new Exception("ICON_CDN_URL not configured");

        URL url = new URL(cdnJsonUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(TIMEOUT);
        conn.setReadTimeout(TIMEOUT);
        conn.setRequestProperty("Accept", "application/json");
        conn.connect();

        int code = conn.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK) {
            throw new Exception("CDN HTTP " + code);
        }

        InputStream is = conn.getInputStream();
        BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        br.close();
        conn.disconnect();

        JSONObject root = new JSONObject(sb.toString());
        JSONArray arr = root.getJSONArray("icons");
        List<JSONObject> result = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            result.add(arr.getJSONObject(i));
        }
        return result;
    }

    // MARK: - Utilities

    private JSONArray listToJsonArray(List<JSONObject> list) {
        JSONArray arr = new JSONArray();
        for (JSONObject o : list) arr.put(o);
        return arr;
    }

    private SharedPreferences getPrefs() {
        return cordova.getActivity().getSharedPreferences("RuntimeIconChanger", Context.MODE_PRIVATE);
    }
}
