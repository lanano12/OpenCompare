/* global require */
// A normal launch registers opencompare:// globally, outside the Electron profile.
// Prevent the test process from replacing the user's installed protocol handler.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('electron').app.setAsDefaultProtocolClient = () => true
