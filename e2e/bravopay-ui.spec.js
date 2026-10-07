import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
test.beforeEach(async ({ page }) => {
  await page.route('https://connect.facebook.net/**', route => route.abort());
  await page.route('https://www.facebook.com/**', route => route.abort());
});
const service = {
  id: '11111111-2222-4333-8444-555555555555', serviceType: 'CONSULTA', provider: 'BRAVOPAY', amount: 3000,
  currency: 'BRL', status: 'PENDING', paymentId: 'tx_ui_example', result: null,
  pix: { copyPaste: 'PIX-EXEMPLO-APENAS-PARA-TESTE-UI', expiresAt: '2026-10-06T12:30:00.000Z' }
};

async function setup(page, options = {}) {
  const calls = { posts: 0, gets: 0, status: 'PENDING' };
  await page.route('**/api/catalog', route => route.fulfill({ json: { paymentsMode: 'BRAVOPAY', prices: { CONSULTA: 3000, ABERTURA: 5000 } } }));
  await page.route('**/api/services', async route => {
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataJSON();
    expect(body).not.toHaveProperty('amount'); expect(body).not.toHaveProperty('status');
    calls.posts++;
    await route.fulfill({ status: 201, json: { ...service, pix: options.noPix ? null : service.pix } });
  });
  await page.route(`**/api/services/${service.id}`, async route => {
    expect(route.request().method()).toBe('GET'); calls.gets++;
    await route.fulfill({ json: { ...service, status: calls.status, pix: options.noPix ? null : service.pix } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Consultar atendimento', exact: true })).toBeVisible();
  await page.locator('#name').fill('Pessoa UI');
  await page.locator('#cpf').fill('52998224725');
  await page.getByRole('button', { name: 'Consultar atendimento', exact: true }).click();
  await expect(page.locator('#request-status')).toHaveText('Aguardando pagamento');
  return calls;
}

async function accessibility(page) {
  await page.route('**/__test_axe.js', route => route.fulfill({ contentType: 'text/javascript', body: readFileSync(require.resolve('axe-core/axe.min.js')) }));
  await page.addScriptTag({ url: '/__test_axe.js' });
  const violations = await page.evaluate(async () => (await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
  })).violations.map(item => item.id));
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('BRAVOPAY PENDING mostra PIX, textos corretos, acessibilidade e clipboard', async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedPix = text; } }, configurable: true });
  });
  await setup(page);
  await expect(page.getByRole('heading', { name: 'Pagamento via PIX' })).toBeVisible();
  await expect(page.locator('#pix-code')).toHaveValue(service.pix.copyPaste);
  await expect(page.locator('#pix-code')).toHaveAttribute('readonly', '');
  await expect(page.locator('#pix-amount')).toContainText('30,00');
  await expect(page.locator('#pix-expiration')).toContainText('06/10/2026');
  expect(await page.locator('body').innerText()).not.toMatch(/simulad|fictíci|protocolo de teste|dados de teste|não há boleto/i);
  await page.getByRole('button', { name: 'Copiar código PIX' }).click();
  await expect(page.locator('#copy-status')).toHaveText('Código PIX copiado.');
  expect(await page.evaluate(() => window.copiedPix)).toBe(service.pix.copyPaste);
  const storage = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
  for (const sensitive of [service.pix.copyPaste, '52998224725', 'Pessoa UI']) expect(storage).not.toContain(sensitive);
  await accessibility(page);
  await page.screenshot({ path: info.outputPath('pix-pending.png'), fullPage: true });
});

test('Polling a cada 5s confirma PAID, esconde PIX e nunca cria outra cobrança', async ({ page }) => {
  await page.clock.install();
  const calls = await setup(page);
  await page.clock.runFor(5000);
  await expect.poll(() => calls.gets).toBe(1);
  calls.status = 'PAID';
  await page.clock.runFor(5000);
  await expect(page.locator('#request-status')).toHaveText('Pagamento confirmado');
  await expect(page.locator('#pix-payment')).toBeHidden();
  await expect(page.locator('#pix-code')).toHaveValue('');
  const finalGets = calls.gets;
  await page.clock.runFor(20000);
  expect(calls.gets).toBe(finalGets); expect(calls.posts).toBe(1);
  await accessibility(page);
});

for (const [status, label] of [['FAILED', 'Não foi possível confirmar o pagamento'], ['EXPIRED', 'Pagamento expirado'], ['REFUNDED', 'Pagamento reembolsado']]) {
  test(`Polling encerra em ${status}`, async ({ page }) => {
    await page.clock.install(); const calls = await setup(page); calls.status = status;
    await page.clock.runFor(5000);
    await expect(page.locator('#request-status')).toHaveText(label);
    await expect(page.locator('#pix-payment')).toBeHidden();
    await page.clock.runFor(15000);
    expect(calls.gets).toBe(1); expect(calls.posts).toBe(1);
  });
}

test('Sem código retornado não inventa PIX ou QR', async ({ page }) => {
  await setup(page, { noPix: true });
  await expect(page.locator('#pix-payment')).toBeHidden();
  await expect(page.locator('canvas, img')).toHaveCount(0);
});

test('Polling encerra por timeout e permite atualização manual', async ({ page }) => {
  await page.clock.install(); const calls = await setup(page);
  await page.clock.fastForward(10 * 60 * 1000);
  await expect(page.locator('#polling-note')).toContainText('Atualização automática encerrada');
  const finalGets = calls.gets;
  await page.clock.runFor(20000); expect(calls.gets).toBe(finalGets);
  await page.getByRole('button', { name: 'Atualizar situação' }).click();
  await expect.poll(() => calls.gets).toBe(finalGets + 1);
  expect(calls.posts).toBe(1);
});

test('Nova solicitação encerra polling e falha de clipboard permite cópia manual', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Permission denied'); } }, configurable: true }); });
  const calls = await setup(page);
  await page.getByRole('button', { name: 'Copiar código PIX' }).click();
  await expect(page.locator('#copy-status')).toContainText('Copie o código selecionado');
  await expect(page.locator('#pix-code')).toBeFocused();
  await page.getByRole('button', { name: 'Nova solicitação' }).click();
  await page.clock.runFor(15000); expect(calls.gets).toBe(0); expect(calls.posts).toBe(1);
});
