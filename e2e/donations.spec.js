import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const operation = { id: '11111111-2222-4333-8444-555555555555', serviceType: 'DOACAO', amount: 2500, provider: 'BRAVOPAY', status: 'PENDING', pix: { copyPaste: 'PIX-DE-TESTE-SEM-VALOR', expiresAt: '2027-01-01T00:00:00Z' } };

async function setup(page) {
  let status = 'PENDING';
  const calls = [];
  await page.route('**/api/catalog', route => route.fulfill({ json: { paymentsMode: 'BRAVOPAY', donationsEnabled: true, beneficiary: 'ORIN PAY YECNOLOGIA', donations: { min: 500, max: 100000 } } }));
  await page.route('**/api/services', route => { calls.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] }); return route.fulfill({ status: 201, json: { ...operation, amount: calls.at(-1).body.amount } }); });
  await page.route(`**/api/services/${operation.id}`, route => route.fulfill({ json: { ...operation, status } }));
  await page.route(`**/api/services/${operation.id}/qr`, route => route.fulfill({ status: 503 }));
  await page.goto('/');
  await expect(page.locator('#donation-form')).toBeVisible();
  return { calls, paid: () => { status = 'PAID'; } };
}

test('doação pede só valor, aguarda backend e confirma com mensagem correta', async ({ page }) => {
  const app = await setup(page);
  await page.getByRole('radio', { name: 'R$ 25', exact: true }).check();
  await page.getByRole('button', { name: 'GERAR PIX PARA DOAR' }).click();
  expect(app.calls[0].body).toEqual({ serviceType: 'DOACAO', amount: 2500 });
  await expect(page.locator('#status')).toHaveText('Aguardando confirmação do pagamento.');
  await expect(page.locator('#pix-code')).toHaveValue(operation.pix.copyPaste);
  await expect(page.locator('#pix .beneficiary')).toHaveText('ORIN PAY YECNOLOGIA');
  await expect(page.locator('#qr-note')).toContainText('Copia e Cola');
  await page.locator('#new').click();
  await expect(page.locator('#error')).toContainText('Aguarde a confirmação');
  await page.reload();
  await expect(page.locator('#payment')).toBeVisible();
  expect(app.calls).toHaveLength(1);
  app.paid(); await page.locator('#refresh').click();
  await expect(page.locator('#status')).toHaveText('Doação recebida! Muito obrigado por ajudar nossos animais.');
  await expect(page.locator('#pix')).toBeHidden();
});

test('valor livre, acessibilidade e responsividade', async ({ page }, testInfo) => {
  const app = await setup(page);
  await page.getByRole('radio', { name: 'Outro valor', exact: true }).check();
  await page.locator('#custom-amount').fill('4,99');
  await page.locator('#generate').click();
  await expect(page.locator('#error')).toContainText('R$ 5,00');
  expect(app.calls).toHaveLength(0);
  await page.locator('#custom-amount').fill('12,35');
  await page.route('**/__test_axe.js', route => route.fulfill({ contentType: 'text/javascript', body: readFileSync(require.resolve('axe-core/axe.min.js')) }));
  await page.addScriptTag({ url: '/__test_axe.js' });
  const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(item => item.id));
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('donation.png'), fullPage: true });
  await page.locator('#generate').click();
  expect(app.calls[0].body.amount).toBe(1235);
});

test('galeria carrega fotos reais, aviso fica no rodape e valores continuam selecionaveis', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const app = await setup(page);
  await expect(page.locator('main .transparency')).toHaveCount(0);
  await expect(page.locator('footer .transparency')).toContainText('Se o recebedor for diferente, não conclua o pagamento.');
  await expect(page.locator('footer .beneficiary')).toHaveText('ORIN PAY YECNOLOGIA');
  await expect(page.getByRole('heading', { name: 'Eles precisam de cuidado e acolhimento 🐾' })).toBeVisible();
  const gallery = page.locator('.gallery');
  const images = gallery.locator('img');
  await expect(images).toHaveCount(4);
  expect(await gallery.evaluate(node => !!(node.compareDocumentPosition(document.querySelector('.donation')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth > 0)).toBe(true);
    expect(await image.getAttribute('alt')).toBeTruthy();
    expect(Number(await image.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(await image.getAttribute('height'))).toBeGreaterThan(0);
    const response = await page.request.get(await image.getAttribute('src'));
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/webp');
  }
  const columns = () => page.locator('.gallery-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  expect(await columns()).toBe(testInfo.project.name === 'mobile' ? 2 : 4);
  await page.getByRole('link', { name: 'Ir para as opções de doação' }).click();
  await expect(page.locator('#donation-title')).toBeFocused();
  for (const amount of ['10', '25', '50', '100', '200']) {
    const radio = page.getByRole('radio', { name: `R$ ${amount}`, exact: true });
    await radio.check(); await expect(radio).toBeChecked();
  }
  expect(app.calls).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('gallery.png'), fullPage: true });
  await page.setViewportSize({ width: 768, height: 1024 });
  expect(await columns()).toBe(2);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await columns()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
