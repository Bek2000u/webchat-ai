import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DesktopUpdates, type DesktopUpdateStatus, type NativeUpdater } from "../../src/desktop/updates.js";

class FakeUpdater extends EventEmitter implements NativeUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  check = async () => { this.emit("update-available", { version: "0.3.0" }); };
  download = async () => { this.emit("download-progress", { percent: 25 }); this.emit("update-downloaded", { version: "0.3.0" }); };
  async checkForUpdates() { this.checks++; return this.check(); }
  async downloadUpdate() { this.downloads++; return this.download(); }
  quitAndInstall(silent?: boolean, restart?: boolean) { this.installs.push([silent, restart]); }
}

test("release checks only discover; download and install require explicit actions", async () => {
  const updater = new FakeUpdater(), events: DesktopUpdateStatus[] = [];
  const updates = new DesktopUpdates(updater, "0.2.0", undefined, value => events.push(value));
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.throws(() => updates.install(), /not been downloaded/);
  const available = await updates.check();
  assert.equal(available.state, "available");
  assert.equal(available.version, "0.3.0");
  assert.equal(updater.downloads, 0);
  assert.deepEqual(updater.installs, []);
  const downloaded = await updates.download();
  assert.equal(downloaded.state, "downloaded");
  assert.equal(downloaded.percent, 100);
  assert.deepEqual(events.map(event => event.state), ["checking", "available", "downloading", "downloading", "downloaded"]);
  updates.install();
  assert.deepEqual(updater.installs, [[false, true]]);
  await updates.check();
  assert.equal(updater.checks, 1, "A staged download must not be replaced by a second check");
});

test("concurrent update checks/downloads use one native operation", async () => {
  const updater = new FakeUpdater();
  let checked!: () => void, downloaded!: () => void;
  updater.check = () => new Promise<void>(done => { checked = () => { updater.emit("update-available", { version: "0.3.0" }); done(); }; });
  updater.download = () => new Promise<void>(done => { downloaded = () => { updater.emit("update-downloaded", { version: "0.3.0" }); done(); }; });
  const updates = new DesktopUpdates(updater, "0.2.0", undefined, () => {});
  const first = updates.check(), second = updates.check();
  assert.equal(first, second);
  assert.equal(updater.checks, 1);
  checked();
  await first;
  const one = updates.download(), two = updates.download();
  assert.equal(one, two);
  assert.equal(updater.downloads, 1);
  downloaded();
  await one;
});

test("development and smoke never contact the update server", async () => {
  for (const reason of ["unpackaged", "smoke"] as const) {
    const updater = new FakeUpdater();
    const updates = new DesktopUpdates(updater, "0.2.0", reason, () => {});
    assert.equal((await updates.check()).state, "disabled");
    assert.equal((await updates.download()).state, "disabled");
    assert.equal(updater.checks, 0);
    assert.equal(updater.downloads, 0);
    assert.throws(() => updates.install());
  }
});

test("update failures expose a stable code without URLs, paths or credentials", async () => {
  const updater = new FakeUpdater();
  updater.check = async () => { throw Error("https://private.test/?token=secret C:\\private"); };
  const updates = new DesktopUpdates(updater, "0.2.0", undefined, () => {});
  assert.deepEqual(await updates.check(), { state: "error", currentVersion: "0.2.0", error: "check" });
  updater.check = async () => { updater.emit("update-available", { version: "0.3.0" }); };
  await updates.check();
  updater.download = async () => { updater.emit("error", Error("private download detail")); throw Error("secret"); };
  assert.equal((await updates.download()).error, "download");
});

test("no-update result clears a previous candidate", async () => {
  const updater = new FakeUpdater();
  const updates = new DesktopUpdates(updater, "0.2.0", undefined, () => {});
  await updates.check();
  updater.check = async () => { updater.emit("update-not-available", { version: "0.2.0" }); };
  const result = await updates.check();
  assert.equal(result.state, "idle");
  assert.equal(result.version, undefined);
});
