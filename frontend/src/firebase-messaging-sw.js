/* Filled by scripts/ensure-firebase-config.js on start/build. */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
try {
  firebase.messaging();
} catch (e) {
  /* config is injected at build time */
}
