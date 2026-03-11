/**
 * RuntimeIconChanger.js
 * Cordova plugin JS interface for changing app icon at runtime.
 *
 * MABS / OutSystems usage:
 *   Set ICON_CDN_URL via Extensibility Configurations > preferences > global.
 *
 * CDN JSON format:
 *   {
 *     "icons": [
 *       { "name": "default",   "resource": "https://cdn.example.com/icons/default.png" },
 *       { "name": "christmas", "resource": "https://cdn.example.com/icons/christmas.png" }
 *     ]
 *   }
 *
 * All images must be PNG 1024x1024px, CORS-enabled, publicly accessible.
 */

/* global cordova */
'use strict';

var exec = require('cordova/exec');
var SERVICE = 'RuntimeIconChanger';

var RuntimeIconChanger = {

  /**
   * Fetch the icon list from the CDN JSON URL configured in preferences.
   * @param {Function} successCallback  called with Array<{name:string, resource:string}>
   * @param {Function} errorCallback    called with error string
   */
  getIconList: function (successCallback, errorCallback) {
    exec(successCallback, errorCallback, SERVICE, 'getIconList', []);
  },

  /**
   * Change the app launcher icon to the one identified by iconName.
   * The icon must exist in the CDN JSON list.
   * @param {string}   iconName
   * @param {Function} successCallback
   * @param {Function} errorCallback
   */
  changeIcon: function (iconName, successCallback, errorCallback) {
    if (!iconName || typeof iconName !== 'string') {
      if (typeof errorCallback === 'function') {
        errorCallback('iconName must be a non-empty string');
      }
      return;
    }
    exec(successCallback, errorCallback, SERVICE, 'changeIcon', [iconName]);
  },

  /**
   * Reset the launcher icon to the default (bundled) icon.
   * @param {Function} successCallback
   * @param {Function} errorCallback
   */
  resetToDefault: function (successCallback, errorCallback) {
    exec(successCallback, errorCallback, SERVICE, 'resetToDefault', []);
  },

  /**
   * Get the name of the currently active icon.
   * Returns 'default' if no alternate icon is active.
   * @param {Function} successCallback  called with string
   * @param {Function} errorCallback
   */
  getCurrentIcon: function (successCallback, errorCallback) {
    exec(successCallback, errorCallback, SERVICE, 'getCurrentIcon', []);
  },

  /**
   * Check whether the device supports runtime icon switching.
   * iOS requires 10.3+; Android requires API 21+.
   * @param {Function} successCallback  called with boolean
   * @param {Function} errorCallback
   */
  isSupported: function (successCallback, errorCallback) {
    exec(successCallback, errorCallback, SERVICE, 'isSupported', []);
  }
};

module.exports = RuntimeIconChanger;
