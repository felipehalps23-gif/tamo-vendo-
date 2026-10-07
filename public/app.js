const byId = id => document.getElementById(id);
const form = byId('service-form');
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100);
const labels = { PENDING: 'Aguardando pagamento', PAID: 'Pagamento confirmado', FAILED: 'Não foi possível confirmar o pagamento', EXPIRED: 'Pagamento expirado', REFUNDED: 'Pagamento reembolsado' };
let paymentsMode;
let token;
let currentId;
let pending;
let pollTimer;
let pollId;
let pollDeadline;
let requestController;
let refreshing = false;

function applyMode(mode) {
  if (!['SANDBOX', 'BRAVOPAY'].includes(mode)) throw new Error('Modo de pagamento indisponível.');
  paymentsMode = mode;
  updateService();
}

function stopPolling() {
  clearTimeout(pollTimer); pollTimer = undefined; pollId = undefined;
  requestController?.abort();
  byId('polling-note').hidden = true;
}

function schedulePolling(data) {
  if (paymentsMode !== 'BRAVOPAY' || data.status !== 'PENDING') { stopPolling(); return; }
  if (pollId !== data.id) { stopPolling(); pollId = data.id; pollDeadline = Date.now() + 10 * 60 * 1000; }
  clearTimeout(pollTimer);
  const id = pollId;
  pollTimer = setTimeout(async () => {
    if (id !== currentId || id !== pollId) return;
    if (Date.now() >= pollDeadline) {
      pollTimer = undefined;
      byId('polling-note').textContent = 'Atualização automática encerrada. Use “Atualizar situação” para consultar o pagamento.';
      byId('polling-note').hidden = false; return;
    }
    await refreshStatus(id);
  }, 5000);
}

async function refreshStatus(id = currentId) {
  if (!id || refreshing) return;
  refreshing = true; byId('refresh').disabled = true; clearError();
  requestController = new AbortController();
  const controller = requestController;
  const timeout = setTimeout(() => controller.abort(new DOMException('A consulta demorou demais. Tente atualizar novamente.', 'TimeoutError')), 15000);
  try {
    const data = await api(`/api/services/${id}`, { signal: requestController.signal });
    if (id === currentId) render(data);
  } catch (err) {
    if (err.name !== 'AbortError' && id === currentId) {
      error(err.message);
      if (pollId === id) schedulePolling({ id, status: 'PENDING' });
    }
  } finally { clearTimeout(timeout); refreshing = false; byId('refresh').disabled = false; }
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir. Tente novamente.');
  return data;
}

function error(message) { byId('error').hidden = false; byId('error').textContent = message; }
function clearError() { byId('error').hidden = true; }

function render(data) {
  currentId = data.id;
  sessionStorage.setItem('sandbox-request', currentId);
  form.hidden = true;
  byId('request').hidden = false;
  byId('request-id').textContent = data.id;
  byId('request-type').textContent = data.serviceType === 'CONSULTA' ? 'Consulta' : 'Iniciar atendimento';
  byId('request-amount').textContent = money(data.amount);
  byId('request-status').textContent = labels[data.status] || 'Situação indisponível';
  byId('payment-id').textContent = data.paymentId;
  byId('pending-note').hidden = data.status !== 'PENDING';
  const showPix = paymentsMode === 'BRAVOPAY' && data.provider === 'BRAVOPAY' && data.status === 'PENDING' && typeof data.pix?.copyPaste === 'string' && !!data.pix.copyPaste;
  byId('pix-payment').hidden = !showPix;
  if (byId('pix-code').value !== (showPix ? data.pix.copyPaste : '')) byId('copy-status').textContent = '';
  byId('pix-code').value = showPix ? data.pix.copyPaste : '';
  if (showPix) {
    byId('pix-amount').textContent = money(data.amount);
    const expiration = new Date(data.pix.expiresAt);
    byId('pix-expiration').textContent = Number.isFinite(expiration.getTime())
      ? `Vencimento do PIX: ${expiration.toLocaleString('pt-BR')}` : 'Vencimento do PIX: consulte a situação do pagamento.';
  }
  const result = data.result?.fictitious ? null : data.result;
  byId('result').hidden = !result;
  byId('result-data').replaceChildren();
  if (result) {
    byId('result-message').textContent = result.message;
    const entries = result.processes || [{ protocol: result.protocol, status: 'Atendimento registrado' }];
    for (const entry of entries) {
      const item = document.createElement('li');
      item.textContent = `${entry.protocol}: ${entry.status}`;
      byId('result-data').append(item);
    }
  }
  schedulePolling(data);
}

function updateService() {
  const opening = form.elements.serviceType.value === 'ABERTURA';
  byId('description-group').hidden = !opening;
  byId('description').required = opening;
  byId('submit').textContent = opening ? 'Continuar atendimento' : 'Continuar para consulta';
  byId('service-fee').textContent = byId(opening ? 'abertura-price' : 'consulta-price').textContent;
}
form.addEventListener('change', updateService);

form.addEventListener('submit', async event => {
  event.preventDefault(); clearError();
  byId('submit').disabled = true;
  const body = {
    serviceType: form.elements.serviceType.value,
    name: byId('name').value, cpf: byId('cpf').value,
    description: form.elements.serviceType.value === 'ABERTURA' ? byId('description').value : ''
  };
  const serialized = JSON.stringify(body);
  try {
    // Preserva a operação após resposta perdida/reload, sem guardar CPF ou nome.
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (!pending || pending.digest !== digest) pending = { digest, key: crypto.randomUUID() };
    sessionStorage.setItem('sandbox-pending', JSON.stringify(pending));
    const data = await api('/api/services', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: serialized });
    // Analytics cannot change the outcome of a successful service request.
    try {
      const marker = 'meta-lead-' + pending.key;
      if (!sessionStorage.getItem(marker) && typeof window.fbq === 'function') {
        sessionStorage.setItem(marker, '1');
        window.fbq('track', 'Lead');
      }
    } catch { /* Tracking failures must not affect payments or the interface. */ }
    render(data); pending = null; sessionStorage.removeItem('sandbox-pending'); byId('request').focus();
  } catch (err) { error(err.message); }
  finally { byId('submit').disabled = false; }
});

byId('refresh').addEventListener('click', () => refreshStatus());

byId('copy-pix').addEventListener('click', async () => {
  const code = byId('pix-code').value;
  if (!code || byId('pix-payment').hidden) return;
  try { await navigator.clipboard.writeText(code); byId('copy-status').textContent = 'Código PIX copiado.'; }
  catch {
    byId('pix-code').focus(); byId('pix-code').select();
    byId('copy-status').textContent = 'Não foi possível copiar automaticamente. Copie o código selecionado.';
  }
});

byId('new-request').addEventListener('click', () => {
  stopPolling(); byId('pix-code').value = ''; byId('pix-payment').hidden = true;
  sessionStorage.removeItem('sandbox-request'); currentId = null; pending = null;
  sessionStorage.removeItem('sandbox-pending');
  byId('request').hidden = true; form.hidden = false; clearError();
  byId('name').focus();
});

async function init() {
  try {
    token = sessionStorage.getItem('sandbox-session');
    if (!/^[a-f\d]{64}$/.test(token || '')) {
      token = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('sandbox-session', token);
    }
    const catalog = await api('/api/catalog');
    applyMode(catalog.paymentsMode);
    try {
      const savedPending = JSON.parse(sessionStorage.getItem('sandbox-pending'));
      if (/^[a-f\d]{64}$/.test(savedPending?.digest || '') && /^[a-f\d-]{36}$/.test(savedPending?.key || '')) pending = savedPending;
    } catch { sessionStorage.removeItem('sandbox-pending'); }
    byId('consulta-price').textContent = money(catalog.prices.CONSULTA);
    byId('abertura-price').textContent = money(catalog.prices.ABERTURA);
    updateService();
    form.hidden = false;
    const saved = sessionStorage.getItem('sandbox-request');
    if (saved && /^[a-f\d-]{36}$/.test(saved)) render(await api(`/api/services/${saved}`));
  } catch (err) { error(`${err.message} Verifique a conexão e recarregue a página.`); }
  finally { byId('loading').hidden = true; }
}
window.addEventListener('pagehide', stopPolling);
init();
