'use strict';
// Desktop notifications. Windows: native toast through PowerShell's WinRT bridge (no modules
// needed, Windows 10/11). macOS: osascript. Linux: notify-send when present.
// The dashboard also receives every notification over SSE (in-app + browser notifications).
const { spawn } = require('child_process');

// The AppUserModelID of Windows PowerShell; toasts show "Windows PowerShell" as their source
// unless the installer registered Claude Command Center's own shortcut AUMID.
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const CCC_AUMID = 'ClaudeCommandCenter.Dashboard';

const xmlEsc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function windowsScript({ title, body, url, aumid, silent }) {
  const xml = `<toast activationType="protocol" launch="${xmlEsc(url || '')}" duration="short">`
    + `<visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text>`
    + `<text placement="attribution">Claude Command Center</text></binding></visual>`
    + (silent ? '<audio silent="true"/>' : '<audio src="ms-winsoundevent:Notification.Default"/>')
    + '</toast>';
  // Single-quoted PowerShell string: double any single quote.
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  return [
    "$ErrorActionPreference='Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml(${q(xml)})`,
    '$t = New-Object Windows.UI.Notifications.ToastNotification $x',
    // An unregistered AppUserModelID makes Windows drop the toast silently, so use ours only
    // when the installer registered it; otherwise show it as Windows PowerShell.
    `$id = if (Test-Path ${q('HKCU:\\Software\\Classes\\AppUserModelId\\' + aumid)}) { ${q(aumid)} } else { ${q(PS_AUMID)} }`,
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($t)',
  ].join('; ');
}

function encodePs(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

/** Build the OS command for a notification (exported for tests). */
function commandFor(platform, n) {
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePs(windowsScript(n))]];
  }
  if (platform === 'darwin') {
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return ['osascript', ['-e', `display notification "${esc(n.body)}" with title "${esc(n.title)}" subtitle "Claude Command Center"`]];
  }
  return ['notify-send', ['-a', 'Claude Command Center', n.title, n.body]];
}

class Notifier {
  constructor({ platform = process.platform, getConfig, log = () => {}, runner } = {}) {
    this.platform = platform;
    this.getConfig = getConfig || (() => ({}));
    this.log = log;
    this.runner = runner || defaultRunner;
    this.lastSentAt = 0;
    this.sent = [];
  }

  /** n: { kind, title, body, url } -> whether an OS notification was sent */
  send(n) {
    const cfg = this.getConfig().notifications || {};
    if (cfg.desktop === false) return false;
    const now = Date.now();
    if (now - this.lastSentAt < 1500 && n.kind !== 'attention') return false; // simple anti-spam
    this.lastSentAt = now;
    const [cmd, args] = commandFor(this.platform, { ...n, aumid: CCC_AUMID, silent: cfg.sound === false });
    try {
      this.runner(cmd, args);
      this.sent.push({ ...n, at: now });
      if (this.sent.length > 50) this.sent.shift();
      return true;
    } catch (e) {
      this.log('notify failed: ' + e.message);
      return false;
    }
  }
}

function defaultRunner(cmd, args) {
  const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: false });
  p.on('error', () => { /* tool missing (e.g. no notify-send): dashboard still shows it */ });
  p.unref();
}

module.exports = { Notifier, commandFor, windowsScript, CCC_AUMID, PS_AUMID };
