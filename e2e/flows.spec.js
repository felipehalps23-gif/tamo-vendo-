import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
test.beforeEach(async ({ page }) => {
  await page.route('https://connect.facebook.net/**', route => route.abort());
  await page.route('https://www.facebook.com/**', route => route.abort());
});
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
  await page.goto('/atendimento?status=paid');
  await expect(page.locator('#personal-details')).toBeHidden();
  await expect(page.locator('.panel .independence')).toBeVisible();
  await expect(page.locator('main .independence')).toHaveCount(1);
  expect(await page.locator('.panel').evaluate(el => !!(el.compareDocumentPosition(document.querySelector('aside')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.getByRole('heading', { name: 'Quem realiza o atendimento?' })).toBeVisible();
  await expect(page.locator('#team-details')).not.toHaveAttribute('open', '');
  await page.locator('#team-details summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#team-details')).toHaveAttribute('open', '');
  await expect(page.locator('#team-details')).toContainText('organizar documentos');
  await accessibility(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#team-details')).not.toHaveAttribute('open', '');
  await accessibility(page);
  await page.getByRole('radio', { name: /Consultar atendimento/ }).check();
  await expect(page.getByRole('button', { name: 'Continuar consulta' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Seu atendimento de forma simples.');
  await expect(page.getByRole('link', { name: 'inssnet@gmai.com' })).toHaveAttribute('href', 'mailto:inssnet@gmai.com');
  await expect(page.locator('footer')).toContainText('Responsável pelo serviço: Aposentei.net');
  await expect(page.locator('footer')).toContainText('Este serviço não substitui os canais oficiais do INSS ou do gov.br.');
  await expect(page.locator('#service-fee')).toContainText('30,00');
  expect(await page.locator('body').innerText()).not.toMatch(/sandbox|homologa|ambiente de teste|simulad|fictíci/i);
  expect(await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(18);
  await accessibility(page);
  await page.screenshot({ path: testInfo.outputPath('initial.png'), fullPage: true });
  await page.locator('#name').fill('Pessoa de Teste');
  await page.locator('#cpf').fill('11111111111');
  await page.getByRole('button', { name: 'Continuar consulta' }).click();
  await expect(page.getByRole('alert')).toContainText('CPF válido');
  await expect(page.locator('#cpf')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#cpf')).toBeFocused();
  await page.locator('#cpf').fill('529.982.247-25');
  await expect(page.locator('#cpf-error')).toBeHidden();
  await page.getByRole('button', { name: 'Continuar consulta' }).click();
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
  await page.getByRole('button', { name: 'Continuar atendimento' }).click();
  await expect(page.locator('#request-amount')).toContainText('50,00');
  await confirm(page, request, 5000);
  await expect(page.locator('#result')).toBeHidden();
  await accessibility(page);
  expect(errors).toEqual([]);
});

test('navegação por teclado mostra foco e permite criar solicitação', async ({ page }) => {
  await page.goto('/atendimento');
  await expect(page.locator('#service-form')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ir para o conteúdo' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('radio', { name: /Consultar atendimento/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#personal-details')).toBeVisible();
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
  await page.goto('/atendimento');
  await expect(page.locator('#service-form')).toBeVisible();
  await page.getByRole('radio', { name: /Consultar atendimento/ }).check();
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
  await page.getByRole('button', { name: 'Continuar consulta' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain('52998224725');
  expect(storage).not.toContain('529.982.247-25');
  expect(storage).not.toContain('Pessoa de Teste');
  expect(await page.evaluate(() => sessionStorage.getItem('sandbox-pending'))).not.toBeNull();
  await page.reload();
  await expect(page.locator('#service-form')).toBeVisible();
  await page.getByRole('radio', { name: /Consultar atendimento/ }).check();
  await page.locator('#name').fill('Pessoa de Teste');
  await page.locator('#cpf').fill('529.982.247-25');
  await page.getByRole('button', { name: 'Continuar consulta' }).click();
  await expect(page.locator('#request-id')).toHaveText(first.id);
  await expect(page.locator('#payment-id')).toHaveText(first.paymentId);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(await page.evaluate(() => sessionStorage.getItem('sandbox-pending'))).toBeNull();
});
