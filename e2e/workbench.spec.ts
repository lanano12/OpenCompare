import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test as base } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

const test = base.extend<{ workspace: string; desktop: ElectronApplication }>({
  // Playwright requires an object pattern even for fixtures without dependencies.
  // eslint-disable-next-line no-empty-pattern
  workspace: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'opencompare-e2e-'))
    try {
      await use(dir)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  },
  desktop: async ({ workspace }, use) => {
    const profile = join(workspace, 'profile')
    await mkdir(profile)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ language: 'en' }))
    const app = await _electron.launch({
      args: ['-r', resolve('e2e/isolate-protocol.cjs'), '.', `--user-data-dir=${profile}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' }
    })
    try {
      await use(app)
    } finally {
      await app.close()
    }
  }
})

async function newComparison(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'New comparison' }).click()
  return page.getByRole('dialog')
}

test('navigates off-screen differences and keeps both panes aligned while scrolling', async ({
  workspace, desktop
}) => {
  const page = await desktop.firstWindow()
  const dialog = await newComparison(page)
  for (const side of ['Left', 'Right']) {
    const path = join(workspace, side + '.txt')
    const lines = Array.from({ length: 240 }, (_, index) => 'common line ' + index)
    lines[2] = side + ' first change'
    lines[180] = side + ' distant change'
    await writeFile(path, lines.join('\n'))
    await dialog.getByLabel(side + ' path').fill(path)
  }
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click()

  const near = page.locator('[data-diff-row="2"]')
  const far = page.locator('[data-diff-row="180"]')
  await expect(near).toHaveCount(2)
  await expect(far).toHaveCount(2)
  for (const row of await near.all()) await expect(row).toBeInViewport()
  for (const row of await far.all()) await expect(row).not.toBeInViewport()

  await page.getByRole('button', { name: 'Next difference' }).press('Enter')
  for (const row of await far.all()) await expect(row).toBeInViewport()
  await page.getByRole('button', { name: 'Previous difference' }).click()
  for (const row of await near.all()) await expect(row).toBeInViewport()

  // A navigation jump positions both panes directly. Wheel only the left pane
  // to exercise the independent scroll-event synchronization as well.
  await near.first().hover()
  await page.mouse.wheel(0, 440)
  for (const row of await near.all()) await expect(row).not.toBeInViewport()
  const aligned = page.locator('[data-diff-row="25"]')
  await expect(aligned).toHaveCount(2)
  for (const row of await aligned.all()) await expect(row).toBeInViewport()
  await expect.poll(() => aligned.evaluateAll(rows => {
    const [left, right] = rows.map(row => row.getBoundingClientRect().top)
    return Math.abs(left - right)
  })).toBeLessThanOrEqual(1)
})

test('resolves a three-way conflict and writes the merged file through Electron', async ({
  workspace, desktop
}) => {
  const page = await desktop.firstWindow()
  const dialog = await newComparison(page)
  await dialog.getByRole('tab', { name: '3-way merge' }).click()
  for (const side of ['base', 'ours', 'theirs']) {
    const path = join(workspace, side + '.txt')
    const footer = side === 'theirs' ? 'updated footer' : 'original footer'
    await writeFile(path, ['header', 'choice: ' + side, 'unchanged', footer, ''].join('\n'))
    await dialog.getByLabel(side, { exact: true }).fill(path)
  }
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click()

  const save = page.getByRole('button', { name: 'Export merged text' })
  await expect(save).toBeDisabled()
  const toolbar = page.locator('[data-shell-level="view-toolbar"]')
  await toolbar.getByRole('button', { name: 'Accept Ours' }).click()
  await expect(save).toBeEnabled()

  // Supply the native chooser's answer. The actual IPC and file write still run.
  const output = join(workspace, 'merged.txt')
  await desktop.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, output)
  await save.click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved to' })).toContainText(output)
  expect(await readFile(output, 'utf8')).toBe('header\nchoice: ours\nunchanged\nupdated footer\n')
})
