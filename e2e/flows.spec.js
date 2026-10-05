import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
async function accessibility(page) {
  await page.route('**/__test_axe.js', route => route.fulfill({
    contentType: 'text/javascript', body: readFileSync(require.resolve('axe-core/axe.min.js'))
  }));
  await page.addScriptTag({ url: '/__test_axe.js' });
  const violations = await page.evaluate(async () => (await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
  })).violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })));
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function confirm(page, request, amount) {
  const paymentId = await page.locator('#payment-id').textContent();
  const body = JSON.stringify({ eventId: randomUUID(), paymentId, status: 'PAID', amount, currency: 'BRL' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', 'sandbox-e2e-secret-only-for-ephemeral-tests').update(`${timestamp}.${body}`).digest('hex');
  const response = await request.post('/api/webhooks/sandbox', { data: body, headers: {
    'Content-Type': 'application/json', 'X-Sandbox-Timestamp': timestamp, 'X-Sandbox-Signature': signature
  } });
  expect(response.status()).toBe(200);
  await page.getByRole('button', { name: 'Atualizar situação' }).click();
  await expect(page.locator('#request-status')).toHaveText('Pagamento confirmado');
}

test('consulta, abertura, acessibilidade e responsividade', async ({ page, request }, testInfo) => {
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto('/?status=paid');
  await expect(page.getByRole('button', { name: 'Solicitar consulta' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Consulta e entrada para aposentadoria');
  await expect(page.getByRole('link', { name: 'inssnet@gmai.com' })).toHaveAttribute('href', 'mailto:inssnet@gmai.com');
  await expect(page.locator('footer')).toContainText('Responsável pelo serviço: MeuINSS.net');
  await expect(page.locator('footer')).toContainText('Este serviço não substitui os canais oficiais do INSS ou do gov.br.');
  await expect(page.locator('#service-fee')).toContainText('30,00');
  expect(await page.locator('body').innerText()).not.toMatch(/sandbox|homologa|ambiente de teste|simulad|fictíci/i);
  expect(await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(18);
  await accessibility(page);
  await page.screenshot({ path: testInfo.outputPath('initial.png'), fullPage: true });
  await page.locator('#name').fill('Pessoa de Teste');
  await page.locator('#cpf').fill('11111111111');
  await page.getByRole('button', { name: 'Solicitar consulta' }).click();
  await expect(page.getByRole('alert')).toContainText('CPF válido');
  await page.locator('#cpf').fill('529.982.247-25');
  await page.getByRole('button', { name: 'Solicitar consulta' }).click();
  await expect(page.locator('#request-status')).toHaveText('Aguardando pagamento');
  await page.evaluate(() => {
    localStorage.setItem('status', 'PAID');
    sessionStorage.setItem('status', 'PAID');
  });
  await page.reload();
  await expect(page.locator('#request-status')).toHaveText('Aguardando pagamento');
  await confirm(page, request, 3000);
  await expect(page.locator('#result')).toBeHidden();
  await accessibility(page);
  await page.getByRole('button', { name: 'Nova solicitação' }).click();
  await page.getByRole('radio', { name: /Iniciar atendimento/ }).check();
  await expect(page.locator('#description')).toBeVisible();
  await page.locator('#name').fill('Pessoa de Teste');
  await page.locator('#cpf').fill('529.982.247-25');
  await expect(page.locator('#service-fee')).toContainText('50,00');
  await page.locator('#description').fill('Teste de abertura de processo fictício.');
  await page.getByRole('button', { name: 'Iniciar atendimento' }).click();
  await expect(page.locator('#request-amount')).toContainText('50,00');
  await confirm(page, request, 5000);
  await expect(page.locator('#result')).toBeHidden();
  await accessibility(page);
  expect(errors).toEqual([]);
});

test('navegação por teclado mostra foco e permite criar solicitação', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#service-form')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ir para o conteúdo' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.locator('#name').fill('Pessoa de Teste');
  await page.locator('#cpf').fill('529.982.247-25');
  await page.locator('#name').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#cpf')).toBeFocused();
  expect(await page.locator('#cpf').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('Tab');
  await expect(page.locator('#submit')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#request')).toBeFocused();
});

test('resposta perdida e recarga reutilizam a mesma operação sem guardar CPF', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#service-form')).toBeVisible();
  await page.locator('#name').fill('Pessoa de Teste');
  await page.locator('#cpf').fill('529.982.247-25');
  let first;
  const keys = [];
  await page.route('**/api/services', async route => {
    keys.push(route.request().headers()['idempotency-key']);
    if (!first) {
      const response = await route.fetch();
      first = await response.json();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Solicitar consulta' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain('52998224725');
  expect(storage).not.toContain('529.982.247-25');
  expect(storage).not.toContain('Pessoa de Teste');
  expect(await page.evaluate(() => sessionStorage.getItem('sandbox-pending'))).not.toBeNull();
  await page.reload();
  await expect(page.locator('#service-form')).toBeVisible();
  await page.locator('#name').fill('Pessoa de Teste');
  await page.locator('#cpf').fill('529.982.247-25');
  await page.getByRole('button', { name: 'Solicitar consulta' }).click();
  await expect(page.locator('#request-id')).toHaveText(first.id);
  await expect(page.locator('#payment-id')).toHaveText(first.paymentId);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(await page.evaluate(() => sessionStorage.getItem('sandbox-pending'))).toBeNull();
});
