// @ts-check
// Registration review-step E2E: boots its own isolated server (temp DB and
// uploads folder, free port — the same isolation contract as test_api.py),
// walks the form through validation -> review -> edit -> confirm, and checks
// the confirmation pass shows a real Reg ID.  The real registrations.db is
// never touched.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

// package.json is type:commonjs — Playwright transpiles this file to CJS, so
// __dirname exists here and import.meta must not appear anywhere.
const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (
        srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let server;
/** @type {string} */
let base = '';
/** @type {string} */
let tmp = '';

test.beforeAll(async () => {
  const port = await freePort();
  tmp = mkdtempSync(path.join(tmpdir(), 'bgmi_pw_'));
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    BGMI_DB: path.join(tmp, 'test.db'),
    BGMI_UPLOADS: path.join(tmp, 'uploads'),
    BGMI_NOTIFY_POLL: '3600',       // keep the worker quiet during the run
  };
  server = spawn(process.env.PYTHON || 'python',
    [path.join(ROOT, 'server.py')],
    { env, cwd: ROOT, stdio: 'ignore' });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) break;
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('isolated test server did not start');
});

test.afterAll(() => {
  if (server && server.exitCode === null) server.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('review step gates the submit and confirmation shows the Reg ID',
  async ({ page }) => {
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    // real submission + bounded retries deserve a little headroom
    test.setTimeout(60000);

    await page.goto(base + '/');
    await expect(page.locator('#teamForm')).toBeVisible();

    const stamp = Date.now() % 1000000;
    const tag = ('PW' + stamp.toString(36)).slice(0, 5).toUpperCase();
    await page.fill('#teamName', 'QA Squad ' + stamp);
    await page.fill('#teamTag', tag);
    await page.fill('#guildName', 'QA Guild');
    await page.fill('#capIgn', 'QACap');
    await page.fill('#capUid', '10000001');
    await page.fill('#capEmail', `qa${stamp}@example.com`);
    await page.fill('#capPhone', '9812345678');
    for (const [n, uid] of [[2, '20000001'], [3, '20000002'],
                            [4, '20000003']]) {
      const row = page.locator(`[data-player="${n}"] input`);
      await row.nth(0).fill('QAPlayer' + n);
      await row.nth(1).fill(uid);
    }
    // the custom checkboxes are 0x0 opacity-hidden — click the visible label
    // and assert the underlying input actually toggled
    await page.locator('label.tc-option', { has: page.locator('#agreeRules') })
      .click();
    await page.locator('label.tc-option', { has: page.locator('#agreeFairPlay') })
      .click();
    await expect(page.locator('#agreeRules')).toBeChecked();
    await expect(page.locator('#agreeFairPlay')).toBeChecked();
    await page.click('#regSubmit');

    // validation passed -> review step appears, nothing has been sent
    await expect(page.locator('#regReview')).toBeVisible();
    await expect(page.locator('#teamForm')).toBeHidden();
    await expect(page.locator('#reviewList')).toContainText('QA Squad');
    await expect(page.locator('#reviewList')).toContainText('QACap');

    // back to edit keeps every entry
    await page.click('#reviewBack');
    await expect(page.locator('#teamForm')).toBeVisible();
    await expect(page.locator('#teamName')).toHaveValue('QA Squad ' + stamp);

    // submit again, confirm for real
    await page.click('#regSubmit');
    await expect(page.locator('#regReview')).toBeVisible();
    await page.click('#reviewConfirm');

    // confirmation pass carries the real Reg ID (placeholder is BGMI26-0000)
    await expect(page.locator('#confRegCode'))
      .toHaveText(/^BGMI26-\d{4}$/, { timeout: 15000 });
    await expect(page.locator('#confRegCode')).not.toHaveText('BGMI26-0000');
    await expect(page.locator('#confTeamId'))
      .toHaveText(/^CSM-BG-[A-Z0-9]{4,}$/);
    expect(pageErrors).toEqual([]);
  });

test('public pages render and the new nav links resolve', async ({ page }) => {
  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  for (const p of ['/', '/rules', '/schedule', '/teams', '/status',
                   '/about', '/privacy']) {
    const resp = await page.goto(base + p);
    expect(resp ? resp.status() : 0, p).toBe(200);
  }

  // nav carries the new destinations
  await page.goto(base + '/');
  await expect(page.locator('.nav-link[href="/rules"]')).toBeAttached();
  await expect(page.locator('.nav-link[href="/schedule"]')).toBeAttached();

  // /rules serves the curated content
  await page.goto(base + '/rules');
  await expect(page.locator('.reg-note-deco').first())
    .toContainText('HOUSE RULES');

  // /schedule is gated: unpublished shows the fallback panel, not a blank
  await page.goto(base + '/schedule');
  await expect(page.locator('#schedOff')).toBeVisible({ timeout: 10000 });
  expect(pageErrors).toEqual([]);
});
