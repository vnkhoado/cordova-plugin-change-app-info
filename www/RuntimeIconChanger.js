/**
 * RuntimeIconChanger.js
 * Cordova plugin JS interface for changing app icon at runtime.
 * Icons are loaded from a CDN JSON file defined in config.xml.
 *
 * JSON format expected from CDN:
 * {
 *   "icons": [
 *     { "name": "default", "resource": "https://cdn.example.com/icons/default.png" },
 *     { "name": "christmas", "resource": "https://cdn.example.com/icons/christmas.png" }
 *   ]
 * }
 */

var exec = require('cordova/exec');

var RuntimeIconChanger = {

  /**
   * Fetch the icon list from the CDN JSON URL configured in config.xml,
   * then return the parsed array to the success callback.
   * @param {Function} successCallback - called with Array<{name, resource}>
   * @param {Function} errorCallback
   */
  getIconList: function (successCallback, errorCallback) {
    exec(successCallback, errorCallback, 'RuntimeIconChanger', 'getIconList', []);
  },

  /**
   * Change the app icon to the one matching `iconName`.
   * The native side downloads the PNG from the CDN URL (1024x1024)
   * and applies it as the alternate icon.
   * @param {string} iconName  - must match a `name` in the CDN JSON
   * @param {Function} successCallback
   * @param {Function} errorCallback
   */
  changeIcon: function (iconName, successCallback, errorCallback) {
    exec(successCallback, errorCallback, 'RuntimeIconChanger', 'changeIcon', [iconName]);
  },

  /**
   * Reset to the default app icon (the one shipped with the build).
   * @param {Function} successCallback
   * @param {Function} errorCallback
   */
  resetToDefault: function (successCallback, errorCallback) {
    exec(successCallback, errorCallback, 'RuntimeIconChanger', 'resetToDefault', []);
  },

  /**
   * Get the name of the currently active icon.
   * @param {Function} successCallback - called with string (icon name or 'default')
   * @param {Function} errorCallback
   */
  getCurrentIcon: function (successCallback, errorCallback) {
    exec(successCallback, errorCallback, 'RuntimeIconChanger', 'getCurrentIcon', []);
  }
};

module.exports = RuntimeIconChanger;
