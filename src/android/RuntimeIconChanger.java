package com.vnkhoado.cordova.changeappinfo;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * RuntimeIconChanger.java
 *
 * Android implementation for changing the app icon at runtime.
 *
 * Strategy (Android):
 *   Android does NOT support swapping launcher icons at runtime without a full restart.
 *   We use the "Activity Alias" approach:
 *     - AndroidManifest.xml declares multiple <activity-alias> entries (one per icon)
 *     - Each alias points to MainActivity with a different android:icon
 *     - At runtime we enable the desired alias and disable the others
 *
 * The hook hooks/android/register-icon-aliases.js auto-generates the manifest aliases
 * from the CDN JSON at build time.
 *
 * CDN JSON format:
 *   { "icons": [ { "name": "default", "resource": "https://..." }, ... ] }
 */
public class RuntimeIconChanger extends CordovaPlugin {

    private static final String TAG = "RuntimeIconChanger";
    private String cdnJsonUrl = "";
    private List<Map<String, String>> cachedIconList = new ArrayList<>();

    // MARK: - Plugin execute entry point

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        cdnJsonUrl = preferences.getString("ICON_CDN_URL", "");

        switch (action) {
            case "getIconList":
                getIconList(callbackContext);
                return true;
            case "changeIcon":
                String iconName = args.getString(0);
                changeIcon(iconName, callbackContext);
                return true;
            case "resetToDefault":
                resetToDefault(callbackContext);
                return true;
            case "getCurrentIcon":
                getCurrentIcon(callbackContext);
                return true;
            default:
                return false;
        }
    }

    // MARK: - Actions

    private void getIconList(final CallbackContext callbackContext) {
        if (cdnJsonUrl.isEmpty()) {
            callbackContext.error("ICON_CDN_URL is not configured in config.xml");
            return;
        }
        cordova.getThreadPool().execute(() -> {
            try {
                List<Map<String, String>> icons = fetchIconList(cdnJsonUrl);
                cachedIconList = icons;
                JSONArray result = iconListToJsonArray(icons);
                callbackContext.success(result);
            } catch (Exception e) {
                callbackContext.error("Failed to fetch icon list: " + e.getMessage());
            }
        });
    }

    private void changeIcon(final String iconName, final CallbackContext callbackContext) {
        if (iconName == null || iconName.isEmpty()) {
            callbackContext.error("Icon name is required");
            return;
        }
        cordova.getThreadPool().execute(() -> {
            try {
                // Resolve icon list (use cache or fetch)
                List<Map<String, String>> icons = cachedIconList.isEmpty()
                        ? fetchIconList(cdnJsonUrl)
                        : cachedIconList;

                Map<String, String> targetIcon = null;
                for (Map<String, String> icon : icons) {
                    if (iconName.equals(icon.get("name"))) {
                        targetIcon = icon;
                        break;
                    }
                }
                if (targetIcon == null) {
                    callbackContext.error("Icon '" + iconName + "' not found in CDN list");
                    return;
                }

                String resourceUrl = targetIcon.get("resource");

                // Download and save PNG to internal storage
                File iconFile = downloadIcon(iconName, resourceUrl);
                if (iconFile == null) {
                    callbackContext.error("Failed to download icon from CDN");
                    return;
                }

                // Switch to the activity alias that uses this icon name
                switchToAlias(iconName);

                // Persist current icon name
                cordova.getActivity().getPreferences(Context.MODE_PRIVATE)
                        .edit()
                        .putString("RuntimeIconChanger_currentIcon", iconName)
                        .apply();

                callbackContext.success("Icon changed to " + iconName);

            } catch (Exception e) {
                callbackContext.error("changeIcon error: " + e.getMessage());
            }
        });
    }

    private void resetToDefault(final CallbackContext callbackContext) {
        cordova.getThreadPool().execute(() -> {
            try {
                switchToAlias("default");
                cordova.getActivity().getPreferences(Context.MODE_PRIVATE)
                        .edit()
                        .remove("RuntimeIconChanger_currentIcon")
                        .apply();
                callbackContext.success("Icon reset to default");
            } catch (Exception e) {
                callbackContext.error("resetToDefault error: " + e.getMessage());
            }
        });
    }

    private void getCurrentIcon(final CallbackContext callbackContext) {
        String current = cordova.getActivity()
                .getPreferences(Context.MODE_PRIVATE)
                .getString("RuntimeIconChanger_currentIcon", "default");
        callbackContext.success(current);
    }

    // MARK: - Helpers

    /**
     * Fetches and parses the CDN JSON to build a list of {name, resource} maps.
     */
    private List<Map<String, String>> fetchIconList(String jsonUrl) throws Exception {
        URL url = new URL(jsonUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        conn.connect();

        InputStream is = conn.getInputStream();
        StringBuilder sb = new StringBuilder();
        byte[] buffer = new byte[4096];
        int bytesRead;
        while ((bytesRead = is.read(buffer)) != -1) {
            sb.append(new String(buffer, 0, bytesRead, "UTF-8"));
        }
        is.close();

        JSONObject jsonObj = new JSONObject(sb.toString());
        JSONArray iconsArray = jsonObj.getJSONArray("icons");
        List<Map<String, String>> result = new ArrayList<>();
        for (int i = 0; i < iconsArray.length(); i++) {
            JSONObject iconObj = iconsArray.getJSONObject(i);
            Map<String, String> map = new HashMap<>();
            map.put("name", iconObj.getString("name"));
            map.put("resource", iconObj.getString("resource"));
            result.add(map);
        }
        return result;
    }

    /**
     * Downloads a PNG from CDN and saves it to internal storage.
     * Returns the saved File, or null on failure.
     */
    private File downloadIcon(String name, String resourceUrl) {
        try {
            URL url = new URL(resourceUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.connect();

            InputStream is = conn.getInputStream();
            Bitmap bitmap = BitmapFactory.decodeStream(is);
            is.close();

            if (bitmap == null) return null;

            // Resize to 192x192 (xxxhdpi) as a safe maximum
            Bitmap resized = Bitmap.createScaledBitmap(bitmap, 192, 192, true);

            File iconDir = new File(cordova.getActivity().getFilesDir(), "RuntimeIcons");
            if (!iconDir.exists()) iconDir.mkdirs();

            File iconFile = new File(iconDir, name + ".png");
            FileOutputStream fos = new FileOutputStream(iconFile);
            resized.compress(Bitmap.CompressFormat.PNG, 100, fos);
            fos.flush();
            fos.close();

            return iconFile;
        } catch (Exception e) {
            Log.e(TAG, "downloadIcon error: " + e.getMessage());
            return null;
        }
    }

    /**
     * Enables the activity alias for the given icon name and disables all others.
     * Alias naming convention: <packageName>.MainActivity_<iconName>
     */
    private void switchToAlias(String targetIconName) {
        Context ctx = cordova.getActivity().getApplicationContext();
        PackageManager pm = ctx.getPackageManager();
        String packageName = ctx.getPackageName();

        // Build list of all known aliases from cached icon list + default
        List<String> allAliases = new ArrayList<>();
        allAliases.add(packageName + ".MainActivity_default");
        for (Map<String, String> icon : cachedIconList) {
            String n = icon.get("name");
            if (!"default".equals(n)) {
                allAliases.add(packageName + ".MainActivity_" + n);
            }
        }

        String targetAlias = packageName + ".MainActivity_" + targetIconName;

        for (String alias : allAliases) {
            int state = alias.equals(targetAlias)
                    ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
            try {
                pm.setComponentEnabledSetting(
                        new ComponentName(packageName, alias),
                        state,
                        PackageManager.DONT_KILL_APP
                );
            } catch (Exception e) {
                Log.w(TAG, "Could not set alias state for " + alias + ": " + e.getMessage());
            }
        }
    }

    private JSONArray iconListToJsonArray(List<Map<String, String>> icons) throws JSONException {
        JSONArray arr = new JSONArray();
        for (Map<String, String> icon : icons) {
            JSONObject obj = new JSONObject();
            obj.put("name", icon.get("name"));
            obj.put("resource", icon.get("resource"));
            arr.put(obj);
        }
        return arr;
    }
}
