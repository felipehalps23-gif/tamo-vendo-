import { test, expect } from '@playwright/test';

test('Pixel: PageView, Lead somente no sucesso, deduplicação e isolamento', async ({ page }) => {
  await page.route('https://connect.facebook.net/**', route => route.fulfill({
    contentType: 'text/javascript', body: `window.metaEvents = window.fbq.queue.map(args => Array.from(args));
      window.fbq = (...args) => window.metaEvents.push(args);`
  }));
  await page.route('https://www.facebook.com/**', route => route.abort());
  await page.route('**/api/catalog', route => route.fulfill({ json: {
    paymentsMode: 'BRAVOPAY', prices: { CONSULTA: 3000, ABERTURA: 5000 }
  } }));
  const service = { id: '11111111-2222-4333-8444-555555555555', paymentId: 'private-payment',
    serviceType: 'CONSULTA', amount: 3000, provider: 'BRAVOPAY', status: 'PENDING', result: null };
  let fail = true;
  await page.route('**/api/services', route => route.fulfill(fail
    ? { status: 400, json: { error: 'Não foi possível concluir.' } }
    : { status: 201, json: service }));
  await page.route(`**/api/services/${service.id}`, route => route.fulfill({ json: service }));
  await page.clock.install();
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.metaEvents)).toEqual([
    ['init', '3467821023378401'], ['track', 'PageView']
  ]);
  await page.getByRole('radio', { name: /Consultar atendimento/ }).check();
  await page.locator('#name').fill('Pessoa Pixel');
  await page.locator('#cpf').fill('52998224725');
  await page.locator('#submit').click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => window.metaEvents)).toHaveLength(2);
  fail = false;
  await page.locator('#submit').click();
  await expect(page.locator('#request')).toBeVisible();
  expect(await page.evaluate(() => window.metaEvents)).toEqual([
    ['init', '3467821023378401'], ['track', 'PageView'], ['track', 'Lead']
  ]);
  await page.clock.runFor(5000);
  await page.locator('#refresh').click();
  expect(await page.evaluate(() => window.metaEvents)).toHaveLength(3);
  await page.reload();
  await expect(page.locator('#request')).toBeVisible();
  expect(await page.evaluate(() => window.metaEvents)).toEqual([
    ['init', '3467821023378401'], ['track', 'PageView']
  ]);
  // Reuse the frontend operation marker without changing backend idempotency.
  await page.locator('#new-request').click();
  await page.getByRole('radio', { name: /Consultar atendimento/ }).check();
  await page.locator('#name').fill('Pessoa Pixel');
  await page.locator('#cpf').fill('52998224725');
  await page.evaluate(async () => {
    const body = JSON.stringify({ serviceType: 'CONSULTA', name: 'Pessoa Pixel', cpf: '52998224725', description: '' });
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map(v => v.toString(16).padStart(2, '0')).join('');
    const key = Object.keys(sessionStorage).find(k => k.startsWith('meta-lead-')).slice(10);
    sessionStorage.setItem('sandbox-pending', JSON.stringify({ digest, key }));
  });
  await page.reload();
  await page.getByRole('radio', { name: /Consultar atendimento/ }).check();
  await page.locator('#name').fill('Pessoa Pixel');
  await page.locator('#cpf').fill('52998224725');
  await page.locator('#submit').click();
  await expect(page.locator('#request')).toBeVisible();
  expect(await page.evaluate(() => window.metaEvents)).toHaveLength(2);
});
