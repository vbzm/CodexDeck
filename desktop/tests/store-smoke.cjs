const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { defaultSettings } = require('../dist/config.js');
const { loadConfiguration, saveConfiguration } = require('../dist/store.js');

app.whenReady().then(async () => {
  const file = path.join(os.tmpdir(), `codexdeck-store-test-${process.pid}.json`);
  const workspace = os.homedir();
  const settings = defaultSettings(workspace);
  const token = 'test-token-abcdefghijklmnopqrstuvwxyz';
  let exitCode = 0;
  try {
    await saveConfiguration(file, { settings, token });
    const raw = await fs.readFile(file, 'utf8');
    assert.equal(raw.includes(token), false);
    assert.deepEqual(await loadConfiguration(file, workspace), { settings, token });
    const updated = { ...settings, gatewayPort: 8877 };
    await saveConfiguration(file, { settings: updated, token });
    assert.deepEqual(await loadConfiguration(file, workspace), { settings: updated, token });
    const exposed = { ...settings, gatewayHost: '0.0.0.0' };
    await saveConfiguration(file, { settings: exposed, token: 'short' });
    assert.deepEqual(await loadConfiguration(file, workspace), { settings: exposed, token: 'short' });
    await saveConfiguration(file, { settings: exposed, token: '' });
    assert.deepEqual(await loadConfiguration(file, workspace), { settings: exposed, token: '' });
    console.log('配置加密与读取验证通过');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    await fs.rm(file, { force: true });
  }
  app.exit(exitCode);
}).catch((error) => { console.error(error); app.exit(1); });
