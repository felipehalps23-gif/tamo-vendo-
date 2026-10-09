const el = id => document.getElementById(id);
const form = el('donation-form');
const money = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const messages = { PENDING: 'Aguardando confirmação do pagamento.', PAID: 'Doação recebida! Muito obrigado por ajudar nossos animais.', FAILED: 'O pagamento não foi confirmado.', EXPIRED: 'Este Pix expirou.', REFUNDED: 'Esta doação foi reembolsada.' };
const prefix = 'anjos-';
let token;
let catalog;
let current;
let pending;
let timer;
let deadline;
let refreshing = false;
let qrUrl;
let qrId;

function error(message) { el('error').textContent = message; el('error').hidden = false; }
function clearError() { el('error').hidden = true; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir. Tente novamente.');
  return data;
}
function clearQr() {
  if (qrUrl) URL.revokeObjectURL(qrUrl);
  qrUrl = undefined; qrId = undefined; el('qr').hidden = true; el('qr').removeAttribute('src');
}
async function showQr(data) {
  if (qrId === data.id) return;
  clearQr(); qrId = data.id;
  el('qr-note').textContent = 'Carregando QR Code…';
  try {
    const response = await fetch(`/api/services/${data.id}/qr`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('QR indisponível');
    const blob = await response.blob();
    if (current?.id !== data.id || current.status !== 'PENDING' || qrId !== data.id) return;
    qrUrl = URL.createObjectURL(blob); el('qr').src = qrUrl; el('qr').hidden = false; el('qr-note').textContent = '';
  } catch {
    if (current?.id === data.id && current.status === 'PENDING') { qrId = undefined; el('qr-note').textContent = 'Use o Pix Copia e Cola abaixo. O QR Code não pôde ser carregado.'; }
  }
}
function schedule() {
  clearTimeout(timer);
  if (current?.status !== 'PENDING' || catalog.paymentsMode !== 'BRAVOPAY') return;
  if (Date.now() >= deadline) { el('poll-note').textContent = 'Use Atualizar situação para consultar novamente.'; return; }
  timer = setTimeout(refresh, 5000);
}
function render(data) {
  if (data.serviceType !== 'DOACAO') throw new Error('Esta operação não é uma doação.');
  if (current?.id !== data.id) deadline = Date.now() + 600000;
  current = data; sessionStorage.setItem(prefix + 'request', data.id);
  form.hidden = true; el('payment').hidden = false;
  el('total').textContent = money(data.amount);
  el('status').textContent = catalog.paymentsMode === 'SANDBOX' && data.status === 'PAID' ? 'Confirmação simulada de teste. Nenhuma doação real foi recebida.' : messages[data.status] || 'Situação indisponível.';
  const pix = data.provider === 'BRAVOPAY' && data.status === 'PENDING' && !!data.pix?.copyPaste;
  el('pix').hidden = !pix;
  el('pix-code').value = pix ? data.pix.copyPaste : '';
  if (pix) {
    el('expiry').textContent = `Vencimento: ${new Date(data.pix.expiresAt).toLocaleString('pt-BR')}`;
    showQr(data);
  } else clearQr();
  schedule();
}
async function refresh() {
  if (!current || refreshing) return;
  const id = current.id;
  refreshing = true; el('refresh').disabled = true; clearError();
  try { const data = await api(`/api/services/${id}`); if (current?.id === id) render(data); }
  catch (err) { if (current?.id === id) { error(err.message); schedule(); } }
  finally { refreshing = false; el('refresh').disabled = false; }
}
form.addEventListener('change', () => {
  const custom = form.elements.amount.value === 'custom';
  el('custom-group').hidden = !custom; el('custom-amount').required = custom;
  clearError();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (el('generate').disabled) return;
  clearError();
  const chosen = form.elements.amount.value;
  const text = el('custom-amount').value.trim();
  if (chosen === 'custom' && !/^\d{1,4}([,.]\d{1,2})?$/.test(text)) { error('Informe um valor válido com até duas casas decimais.'); return; }
  const amount = chosen === 'custom' ? Math.round(Number(text.replace(',', '.')) * 100) : Number(chosen);
  if (!Number.isSafeInteger(amount) || amount < catalog.donations.min || amount > catalog.donations.max) { error('Informe uma doação entre R$ 5,00 e R$ 1.000,00.'); return; }
  if (!pending || pending.amount !== amount) pending = { amount, key: crypto.randomUUID() };
  sessionStorage.setItem(prefix + 'pending', JSON.stringify(pending));
  el('generate').disabled = true; el('amount-options').disabled = true; el('sending').hidden = false; form.setAttribute('aria-busy', 'true');
  try {
    const data = await api('/api/services', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: JSON.stringify({ serviceType: 'DOACAO', amount }) });
    render(data); pending = undefined; sessionStorage.removeItem(prefix + 'pending'); el('payment').focus();
  } catch (err) { error(err.message); }
  finally { el('generate').disabled = false; el('amount-options').disabled = false; el('sending').hidden = true; form.removeAttribute('aria-busy'); }
});
el('refresh').addEventListener('click', refresh);
el('copy').addEventListener('click', async () => {
  if (el('pix').hidden || !el('pix-code').value) return;
  try { await navigator.clipboard.writeText(el('pix-code').value); el('copy-status').textContent = 'Código Pix copiado.'; }
  catch { el('pix-code').focus(); el('pix-code').select(); el('copy-status').textContent = 'Copie o código selecionado.'; }
});
el('new').addEventListener('click', () => {
  if (current?.status === 'PENDING') { error('Aguarde a confirmação ou o vencimento deste Pix antes de gerar outra doação.'); return; }
  clearTimeout(timer); clearQr(); current = undefined; pending = undefined;
  sessionStorage.removeItem(prefix + 'request'); sessionStorage.removeItem(prefix + 'pending');
  el('payment').hidden = true; form.hidden = false; form.reset(); el('custom-group').hidden = true; el('custom-amount').required = false;
  el('copy-status').textContent = ''; el('poll-note').textContent = ''; clearError(); form.elements.amount[0].focus();
});
async function init() {
  try {
    token = sessionStorage.getItem(prefix + 'session');
    if (!/^[a-f\d]{64}$/.test(token || '')) {
      token = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem(prefix + 'session', token);
    }
    catalog = await api('/api/catalog');
    for (const target of document.querySelectorAll('.beneficiary')) target.textContent = catalog.beneficiary || 'responsável ainda não informado';
    el('mode-note').hidden = catalog.paymentsMode !== 'SANDBOX';
    if (!catalog.donationsEnabled) throw new Error('Arrecadação indisponível: beneficiário ainda não verificado.');
    form.hidden = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(prefix + 'pending'));
      if (Number.isSafeInteger(saved?.amount) && /^[a-f\d-]{36}$/.test(saved?.key || '')) pending = saved;
    } catch { sessionStorage.removeItem(prefix + 'pending'); }
    const id = sessionStorage.getItem(prefix + 'request');
    if (/^[a-f\d-]{36}$/.test(id || '')) render(await api(`/api/services/${id}`));
  } catch (err) { error(`${err.message} Verifique a conexão e recarregue a página.`); }
  finally { el('loading').hidden = true; }
}
window.addEventListener('pagehide', () => { clearTimeout(timer); clearQr(); });
window.addEventListener('pageshow', event => { if (event.persisted && current) refresh(); });
init();
