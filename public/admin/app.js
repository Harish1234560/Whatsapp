/* Marketing dashboard. Plain JavaScript, no build step. All dynamic text goes through esc(). */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  let pollTimer = null;

  // ─── helpers ───────────────────────────────────────────────────────────────
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (n) => (n === null || n === undefined ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
  const num = (n) => Number(n ?? 0).toLocaleString('en-IN');
  const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' }) : '—');
  const discount = (c) => (c.discountType === 'PERCENT' ? `${c.discountValue}% off` : `${inr(c.discountValue)} off`);
  const TYPE_LABEL = { BIRTHDAY: '🎂 Birthday', FESTIVAL: '🎉 Festival', MONTH_END_TOP10: '🏆 Top 10' };
  const REASONS = {
    NO_OPT_IN: 'No marketing opt-in', OPTED_OUT: 'Opted out', NO_WHATSAPP_NUMBER: 'No WhatsApp number', INVALID_PHONE: 'Invalid phone number',
    IMPLAUSIBLE_DOB: 'Date of birth looks wrong', MARKETING_LIMIT: 'Meta per-user marketing limit', NOT_ON_WHATSAPP: 'Not on WhatsApp',
    CAMPAIGN_CANCELLED: 'Campaign cancelled', TEMPLATE_NOT_APPROVED: 'Template not approved', BIRTHDAY_DISABLED: 'Birthday campaign off',
    RATE_LIMITED: 'Rate limited', NETWORK: 'Network error', SERVER_ERROR: 'WhatsApp server error', TEMPLATE_PROBLEM: 'Template problem',
    AUTH: 'WhatsApp credentials problem', INVALID_NUMBER: 'Invalid number', UNKNOWN: 'Unknown error',
  };
  const reason = (r) => REASONS[r] || r || '';
  const BADGE = {
    DRAFT: '', GENERATING: 'info', PENDING_APPROVAL: 'warn', APPROVED: 'info', SENDING: 'info', COMPLETED: 'ok', CANCELLED: '', FAILED: 'bad',
    PENDING: 'warn', SENT: 'info', DELIVERED: 'ok', READ: 'ok', SKIPPED: '', ACTIVE: 'ok', USED: 'info', EXPIRED: '', REJECTED: 'bad', PAUSED: 'warn',
  };
  const badge = (s) => `<span class="badge ${BADGE[s] ?? ''}">${esc(String(s ?? '').replace(/_/g, ' '))}</span>`;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 4500);
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.isLogin) { showLogin(); throw new Error('Sign in required.'); }
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.code = data.code; throw e; }
    return data;
  }

  function modal(html) {
    $('#modal-box').innerHTML = html;
    $('#modal').classList.remove('hidden');
    const first = $('#modal-box button, #modal-box input');
    if (first) first.focus();
  }
  const closeModal = () => $('#modal').classList.add('hidden');
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  const formData = (form) => Object.fromEntries(new FormData(form).entries());
  const numOrNull = (v) => (v === '' || v === undefined ? null : Number(v));

  // ─── auth ──────────────────────────────────────────────────────────────────
  function showLogin() {
    clearInterval(pollTimer);
    $('#shell').classList.add('hidden');
    $('#login').classList.remove('hidden');
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('/auth/login', { method: 'POST', body: formData(e.target), isLogin: true });
      e.target.reset();
      start();
    } catch (err) { $('#login-error').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  async function start() {
    try {
      const me = await api('/auth/me');
      $('#whoami').textContent = me.admin.email;
      $('#login').classList.add('hidden');
      $('#shell').classList.remove('hidden');
      route();
    } catch { /* login is showing */ }
  }

  // ─── router ────────────────────────────────────────────────────────────────
  const routes = {
    dashboard: renderDashboard, campaigns: () => renderCampaignList(null), festivals: () => renderCampaignList('FESTIVAL'),
    top10: () => renderCampaignList('MONTH_END_TOP10'), campaign: renderCampaign, birthday: renderBirthday,
    coupons: renderCoupons, messages: renderMessages, customers: renderCustomers, settings: renderSettings,
  };
  async function route() {
    clearInterval(pollTimer);
    const [name, arg] = (location.hash.replace(/^#\//, '') || 'dashboard').split('/');
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${name}`));
    const fn = routes[name] || renderDashboard;
    view.innerHTML = '<p class="muted">Loading…</p>';
    try { await fn(arg); } catch (err) { view.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`; }
    view.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);

  // ─── dashboard ─────────────────────────────────────────────────────────────
  async function renderDashboard() {
    const d = await api('/dashboard');
    const stat = (n, l) => `<div class="card stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
    const pct = (a, b) => (b ? ` (${Math.round((a / b) * 100)}%)` : '');
    const eligibleToday = d.birthdaysToday.filter((b) => b.eligible).length;
    view.innerHTML = `
      <div class="page-head"><div><h1>Dashboard</h1><div class="muted">WhatsApp provider: <b>${esc(d.provider)}</b>${d.provider === 'mock' ? ' · nothing is really sent' : ''}</div></div></div>
      <div class="grid three">
        <div class="card"><h3>🎂 Birthday</h3><div><b>${num(d.birthdaysToday.length)}</b> customers today · ${num(eligibleToday)} eligible</div>
          <div class="muted small">Automatic · ${d.birthdayEnabled ? 'ON' : 'OFF'} · no admin action required</div><p><a class="btn small" href="#/birthday">View</a></p></div>
        ${d.needsAttention.map((c) => `
          <div class="card"><h3>${esc(TYPE_LABEL[c.type])}</h3><div><b>${esc(c.name)}</b></div>
            <div class="muted small">${num(c.target_count)} customers</div><div>Status: ${badge(c.status)}</div>
            <p><a class="btn small ${c.status === 'PENDING_APPROVAL' ? 'primary' : ''}" href="#/campaign/${c.id}">Review</a></p></div>`).join('')}
        ${d.needsAttention.length ? '' : '<div class="card"><h3>Campaigns</h3><div class="muted">Nothing is waiting for approval.</div><p class="actions"><a class="btn small" href="#/festivals">New festival</a><a class="btn small" href="#/top10">New Top 10</a></p></div>'}
      </div>
      <div class="section grid stats">
        ${stat(num(d.totalCustomers), 'Total customers')}
        ${stat(num(d.eligibleCustomers), 'WhatsApp eligible')}
        ${stat(num(d.birthdayMessages), 'Birthday messages')}
        ${stat(num(d.festivalCampaigns), 'Festival campaigns')}
        ${stat(num(d.top10Campaigns), 'Top 10 campaigns')}
        ${stat(num(d.messages.sent), 'Messages sent')}
        ${stat(num(d.messages.delivered) + pct(d.messages.delivered, d.messages.sent), 'Delivered')}
        ${stat(num(d.messages.read) + pct(d.messages.read, d.messages.sent), 'Read')}
        ${stat(num(d.coupons.generated), 'Coupons generated')}
        ${stat(num(d.coupons.used) + pct(d.coupons.used, d.coupons.generated), 'Coupons used')}
      </div>
      ${d.eligibleCustomers === 0 ? '<div class="section notice">No customer has a recorded marketing opt-in yet, so nobody can be messaged. Record consent on the Customers page or through the store integration endpoint.</div>' : ''}
      ${d.failures.length ? `<div class="section card"><h2>Not delivered, by reason</h2><table><tr><th>Reason</th><th class="num">Messages</th></tr>
        ${d.failures.map((f) => `<tr><td>${esc(reason(f.error_code))}</td><td class="num">${num(f.n)}</td></tr>`).join('')}</table></div>` : ''}`;
  }

  // ─── campaign lists and creation ───────────────────────────────────────────
  async function renderCampaignList(type) {
    const { campaigns } = await api('/campaigns' + (type ? `?type=${type}` : ''));
    const title = type === 'FESTIVAL' ? '🎉 Festival campaigns' : type === 'MONTH_END_TOP10' ? '🏆 Month-End Top 10' : 'All campaigns';
    const sub = type ? 'Manual. Nothing is sent until an admin clicks Approve &amp; Send.' : 'Birthday is automatic. Festival and Top 10 need approval.';
    view.innerHTML = `
      <div class="page-head"><div><h1>${title}</h1><div class="muted">${sub}</div></div>
        <div class="actions">${type !== 'MONTH_END_TOP10' ? '<button class="btn primary" id="new-festival">New festival campaign</button>' : ''}
        ${type !== 'FESTIVAL' ? '<button class="btn primary" id="new-top10">New Top 10 campaign</button>' : ''}</div></div>
      <div class="card table-wrap"><table>
        <tr><th>Campaign</th><th>Type</th><th>Offer</th><th>Status</th><th class="num">Audience</th><th class="num">Sent</th><th class="num">Delivered</th><th class="num">Read</th><th class="num">Failed</th><th></th></tr>
        ${campaigns.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="muted small">${esc(c.targetMonth || (c.startDate ? `${c.startDate} to ${c.endDate}` : c.campaignYear || ''))}</div></td>
          <td>${esc(TYPE_LABEL[c.type])}</td><td>${esc(discount(c))}</td><td>${badge(c.status)}</td>
          <td class="num">${num(c.targetCount)}</td><td class="num">${num(c.stats.sent)}</td><td class="num">${num(c.stats.delivered)}</td><td class="num">${num(c.stats.read)}</td><td class="num">${num(c.stats.failed)}</td>
          <td><a class="btn small" href="${c.type === 'BIRTHDAY' ? '#/birthday' : `#/campaign/${c.id}`}">Open</a></td></tr>`).join('') || '<tr><td colspan="10" class="muted">No campaigns yet.</td></tr>'}
      </table></div>`;
    $('#new-festival')?.addEventListener('click', () => campaignForm('FESTIVAL'));
    $('#new-top10')?.addEventListener('click', () => campaignForm('MONTH_END_TOP10'));
  }

  function lastMonth() {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const ymd = (date) => (date ? new Date(new Date(date).getTime() + 330 * 60000).toISOString().slice(0, 10) : '');

  function campaignForm(type, existing) {
    const c = existing || {};
    const common = `
      <div class="fields">
        <label>Discount type<select name="discountType"><option value="FLAT" ${c.discountType !== 'PERCENT' ? 'selected' : ''}>Flat amount (₹)</option><option value="PERCENT" ${c.discountType === 'PERCENT' ? 'selected' : ''}>Percentage (%)</option></select></label>
        <label>Discount value<input name="discountValue" type="number" min="1" step="0.01" required value="${esc(c.discountValue ?? '')}"></label>
        <label>Minimum order (₹, optional)<input name="minimumOrderAmount" type="number" min="0" step="0.01" value="${esc(c.minimumOrderAmount ?? '')}"></label>
        <label>Maximum discount (₹, optional)<input name="maximumDiscount" type="number" min="0" step="0.01" value="${esc(c.maximumDiscount ?? '')}"></label>
      </div>`;
    const body = type === 'FESTIVAL' ? `
      <div class="fields">
        <label>Campaign name<input name="name" required placeholder="Diwali 2026" value="${esc(c.name ?? '')}"></label>
        <label>Festival name (appears in the message)<input name="festivalName" required placeholder="Diwali" value="${esc(c.festivalName ?? '')}"></label>
        <label>Offer starts<input name="startDate" type="date" required value="${esc(c.startDate ?? '')}"></label>
        <label>Offer ends<input name="endDate" type="date" required value="${esc(c.endDate ?? '')}"></label>
      </div>${common}
      <div class="fields">
        <label>Coupons<select name="couponMode"><option value="PER_CUSTOMER" ${c.couponMode !== 'SHARED' ? 'selected' : ''}>Unique code per customer (recommended)</option><option value="SHARED" ${c.couponMode === 'SHARED' ? 'selected' : ''}>One shared code</option></select></label>
        <label>Shared code (only for shared)<input name="sharedCouponCode" placeholder="DIWALI20" value="${esc(c.sharedCouponCode ?? '')}"></label>
        <label>Shared code total uses (optional)<input name="sharedUsageCap" type="number" min="1" value="${esc(c.sharedUsageCap ?? '')}"></label>
      </div><p class="muted small">Audience: all eligible customers. That means a valid WhatsApp number, a recorded opt-in, and no opt-out.</p>` : `
      <div class="fields">
        <label>Month to rank<input name="targetMonth" type="month" required value="${esc(c.targetMonth ?? lastMonth())}"></label>
        <label>Coupon valid until<input name="validUntil" type="date" required value="${esc(ymd(c.validUntil))}"></label>
      </div>${common}
      <label class="row"><input type="checkbox" name="backfill" ${c.backfill ? 'checked' : ''}> If a top spender cannot be contacted, move the next customer up (default: off)</label>`;
    modal(`<h2>${existing ? 'Edit' : 'New'} ${type === 'FESTIVAL' ? 'festival' : 'Top 10'} campaign</h2>
      ${existing && existing.status === 'PENDING_APPROVAL' ? '<div class="notice">Saving returns this campaign to Draft and discards the generated coupons and messages.</div>' : ''}
      <form id="cform" class="stack">${body}<p class="error" id="cerr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" id="ccancel">Cancel</button><button class="btn primary" type="submit">${existing ? 'Save' : 'Create draft'}</button></div></form>`);
    $('#ccancel').addEventListener('click', closeModal);
    $('#cform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const payload = { discountType: f.discountType, discountValue: Number(f.discountValue), minimumOrderAmount: numOrNull(f.minimumOrderAmount), maximumDiscount: numOrNull(f.maximumDiscount) };
      if (type === 'FESTIVAL') Object.assign(payload, { name: f.name, festivalName: f.festivalName, startDate: f.startDate, endDate: f.endDate, couponMode: f.couponMode, sharedCouponCode: f.sharedCouponCode || null, sharedUsageCap: numOrNull(f.sharedUsageCap), couponPrefix: '' });
      else Object.assign(payload, { targetMonth: f.targetMonth, validUntil: f.validUntil, backfill: f.backfill === 'on', couponPrefix: '' });
      try {
        const out = existing
          ? await api(`/campaigns/${existing.id}`, { method: 'PATCH', body: payload })
          : await api('/campaigns', { method: 'POST', body: { type, ...payload } });
        closeModal();
        if (location.hash === `#/campaign/${out.campaign.id}`) route(); else location.hash = `#/campaign/${out.campaign.id}`;
      } catch (err) { $('#cerr').textContent = err.message; }
    });
  }

  // ─── one campaign: generate, preview, approve ──────────────────────────────
  async function renderCampaign(id) {
    const [{ campaign: c, summary }, rec] = await Promise.all([api(`/campaigns/${id}`), api(`/campaigns/${id}/recipients?limit=200`)]);
    const isTop = c.type === 'MONTH_END_TOP10';
    const order = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENDING', 'COMPLETED'];
    const steps = order.map((s) => `<span class="${s === c.status ? 'on' : ''}">${s.replace('_', ' ')}</span>`).join(' → ');
    const excluded = Object.entries((c.generationSummary && c.generationSummary.excluded) || {});
    const can = { generate: ['DRAFT', 'FAILED'].includes(c.status), edit: ['DRAFT', 'PENDING_APPROVAL', 'FAILED'].includes(c.status), approve: c.status === 'PENDING_APPROVAL', cancel: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENDING', 'FAILED'].includes(c.status) };
    const sample = rec.rows.find((r) => r.rendered_body);

    view.innerHTML = `
      <div class="page-head"><div><h1>${esc(c.name)}</h1><div class="muted">${esc(TYPE_LABEL[c.type])} · ${badge(c.status)}</div><div class="steps" style="margin-top:6px">${steps}</div></div>
        <div class="actions">
          ${can.generate ? `<button class="btn primary" id="gen">${isTop ? 'Generate Top 10' : 'Generate audience'}</button>` : ''}
          ${can.edit ? '<button class="btn" id="edit">Edit</button>' : ''}
          ${can.cancel ? `<button class="btn danger" id="cancel">${c.status === 'SENDING' ? 'Stop remaining sends' : 'Cancel'}</button>` : ''}
          ${can.approve ? `<button class="btn primary" id="approve" ${summary.recipientCount === 0 ? 'disabled' : ''}>Approve &amp; Send to ${num(summary.recipientCount)} Customers</button>` : ''}
        </div></div>
      ${c.error ? `<div class="notice bad">Generation failed: ${esc(c.error)}</div>` : ''}
      ${c.status === 'DRAFT' ? '<div class="notice">Draft. Nothing has been generated and nothing can be sent.</div>' : ''}
      ${can.approve && !summary.templateApproved ? `<div class="notice bad">WhatsApp template <b>${esc(c.templateName)}</b> is not approved by Meta yet. Approval will be refused until it is. See Settings.</div>` : ''}
      ${can.approve && summary.daysNeeded > 1 ? `<div class="notice">Your daily messaging tier is ${num(summary.dailyTierLimit)}. This send will be spread over ${summary.daysNeeded} days.</div>` : ''}
      <div class="grid two section">
        <div class="card"><h2>Offer</h2><dl class="kv">
          <dt>Discount</dt><dd>${esc(discount(c))}</dd>
          ${isTop ? `<dt>Month ranked</dt><dd>${esc(c.targetMonth)}</dd><dt>Backfill</dt><dd>${c.backfill ? 'On' : 'Off'}</dd>` : `<dt>Festival</dt><dd>${esc(c.festivalName)}</dd><dt>Coupons</dt><dd>${c.couponMode === 'SHARED' ? `Shared code ${esc(c.sharedCouponCode)}` : 'Unique per customer'}</dd>`}
          <dt>Valid</dt><dd>${esc(day(c.validFrom))} to ${esc(day(c.validUntil))}</dd>
          <dt>Minimum order</dt><dd>${inr(c.minimumOrderAmount)}</dd><dt>Maximum discount</dt><dd>${inr(c.maximumDiscount)}</dd>
          <dt>Template</dt><dd class="code">${esc(c.templateName)} ${summary.templateApproved ? badge('APPROVED') : badge('PENDING')}</dd>
          <dt>Created by</dt><dd>${esc(c.createdBy)}</dd>
          ${c.approvedBy ? `<dt>Approved by</dt><dd>${esc(c.approvedBy)} · ${esc(when(c.approvedAt))}</dd>` : ''}
        </dl></div>
        <div class="card"><h2>Message preview</h2>${sample ? `<div class="bubble">${esc(sample.rendered_body)}</div><p class="muted small">Exactly what ${esc(sample.customer_name || 'the customer')} will receive.</p>` : '<p class="muted">Generate the campaign to see the messages.</p>'}
          ${c.status !== 'DRAFT' ? `<p class="small">Will message <b>${num(c.targetCount)}</b> customers. Estimated cost ${inr(summary.estimatedCostInr || 0)}.${excluded.length ? ' Excluded: ' + excluded.map(([k, v]) => `${num(v)} ${esc(reason(k).toLowerCase())}`).join(', ') + '.' : ''}</p>` : ''}</div>
      </div>
      <div class="section card"><div class="page-head" style="margin-bottom:8px"><h2>${isTop ? `${esc(c.targetMonth)} Top 10` : `Audience (${num(rec.total)})`}</h2>
        ${rec.rows.length ? '<button class="btn small" id="toggle-bodies">Preview Messages</button>' : ''}</div>
        <div class="table-wrap"><table><tr>${isTop ? '<th>#</th>' : ''}<th>Name</th><th>WhatsApp</th>${isTop ? '<th class="num">Spending</th><th class="num">Orders</th>' : ''}<th>Coupon</th><th>Message</th></tr>
        ${rec.rows.map((r) => `<tr>${isTop ? `<td>${esc(r.rank)}</td>` : ''}<td>${esc(r.customer_name || r.customer_id)}</td><td class="code">${esc(r.phone || '—')}</td>
          ${isTop ? `<td class="num">${inr(r.spending)}</td><td class="num">${num(r.order_count)}</td>` : ''}
          <td class="code">${esc(r.coupon_code || '—')}</td>
          <td>${r.contactable ? badge(r.message_status || 'PENDING') + (r.error_code ? ` <span class="muted small">${esc(reason(r.error_code))}</span>` : '') : `<span class="badge bad">Not contactable</span> <span class="muted small">${esc(reason(r.reason))}</span>`}
            ${r.rendered_body ? `<div class="bubble body hidden" style="margin-top:8px">${esc(r.rendered_body)}</div>` : ''}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">Not generated yet.</td></tr>`}
        </table></div>${rec.total > rec.rows.length ? `<p class="muted small">Showing the first ${rec.rows.length} of ${num(rec.total)}.</p>` : ''}</div>`;

    $('#toggle-bodies')?.addEventListener('click', () => view.querySelectorAll('.bubble.body').forEach((b) => b.classList.toggle('hidden')));
    $('#edit')?.addEventListener('click', () => campaignForm(c.type, c));
    $('#gen')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Generating…';
      try { await api(`/campaigns/${id}/generate`, { method: 'POST' }); toast('Generated. Review, then approve.'); } catch (err) { toast(err.message); }
      route();
    });
    $('#cancel')?.addEventListener('click', () => {
      modal(`<h2>Cancel this campaign?</h2><p>Unsent messages are stopped and unused coupons are cancelled. Coupons already delivered to customers stay valid.</p>
        <div class="actions"><button class="btn" id="m-no">Keep campaign</button><button class="btn danger" id="m-yes">Cancel campaign</button></div>`);
      $('#m-no').addEventListener('click', closeModal);
      $('#m-yes').addEventListener('click', async () => { closeModal(); try { await api(`/campaigns/${id}/cancel`, { method: 'POST' }); toast('Campaign cancelled.'); } catch (err) { toast(err.message); } route(); });
    });
    $('#approve')?.addEventListener('click', () => {
      modal(`<h2>Are you sure?</h2><p>You are about to send this campaign to:</p><div class="big">${num(summary.recipientCount)} customers</div>
        <p class="muted small">Estimated WhatsApp cost ${inr(summary.estimatedCostInr)}${summary.daysNeeded > 1 ? ` · spread over ${summary.daysNeeded} days` : ''}. This cannot be undone once messages are delivered.</p>
        <p class="error" id="m-err" role="alert"></p>
        <div class="actions"><button class="btn" id="m-no">Cancel</button><button class="btn primary" id="m-yes">Approve &amp; Send</button></div>`);
      $('#m-no').addEventListener('click', closeModal);
      $('#m-yes').addEventListener('click', async (e) => {
        e.target.disabled = true; // a second click does nothing here, and the server refuses it anyway
        try { await api(`/campaigns/${id}/approve-send`, { method: 'POST', body: { confirmRecipientCount: summary.recipientCount } }); closeModal(); toast('Approved. Messages are being sent.'); route(); }
        catch (err) { $('#m-err').textContent = err.message; }
      });
    });
    if (['SENDING', 'GENERATING', 'APPROVED'].includes(c.status)) pollTimer = setInterval(() => { if ($('#modal').classList.contains('hidden')) route(); }, 4000);
  }

  // ─── birthday ──────────────────────────────────────────────────────────────
  async function renderBirthday() {
    const { settings: s, today, history } = await api('/birthday');
    view.innerHTML = `
      <div class="page-head"><div><h1>🎂 Birthday campaign</h1><div class="muted">Automatic. Runs every day at 9:00 AM India time, with hourly catch-up. No approval needed.</div></div>
        <div class="actions"><button class="btn" id="run">Run today's check now</button></div></div>
      <div class="grid two">
        <form class="card stack" id="bform"><h2>Settings</h2>
          <label class="row"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Birthday campaign enabled</label>
          <div class="fields">
            <label>Discount type<select name="discountType"><option value="FLAT" ${s.discountType === 'FLAT' ? 'selected' : ''}>Flat amount (₹)</option><option value="PERCENT" ${s.discountType === 'PERCENT' ? 'selected' : ''}>Percentage (%)</option></select></label>
            <label>Discount value<input name="discountValue" type="number" min="1" step="0.01" required value="${esc(s.discountValue)}"></label>
            <label>Validity (days)<input name="validityDays" type="number" min="1" max="90" required value="${esc(s.validityDays)}"></label>
            <label>Coupon prefix<input name="couponPrefix" required pattern="[A-Za-z0-9]{2,12}" value="${esc(s.couponPrefix)}"></label>
            <label>Minimum order (₹, optional)<input name="minimumOrderAmount" type="number" min="0" value="${esc(s.minimumOrderAmount ?? '')}"></label>
            <label>Maximum discount (₹, optional)<input name="maximumDiscount" type="number" min="0" value="${esc(s.maximumDiscount ?? '')}"></label>
            <label>Message template<input name="templateName" required value="${esc(s.templateName)}"></label>
          </div><p class="error" id="berr" role="alert"></p><div><button class="btn primary">Save settings</button></div></form>
        <div class="card"><h2>Today (${num(today.length)})</h2><div class="table-wrap"><table><tr><th>Customer</th><th>Status</th><th>Coupon</th></tr>
          ${today.map((t) => `<tr><td>${esc(t.name || t.customerId)}<div class="muted small code">${esc(t.phone || '')}</div></td>
            <td>${t.messageStatus ? badge(t.messageStatus) : t.eligible ? '<span class="badge warn">Queued at next run</span>' : `<span class="badge">Not eligible</span> <span class="muted small">${esc(reason(t.reason))}</span>`}</td>
            <td class="code">${esc(t.couponCode || '—')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No birthdays today.</td></tr>'}</table></div></div>
      </div>
      <div class="section card"><h2>History</h2><div class="table-wrap"><table><tr><th>Customer</th><th>WhatsApp</th><th>Coupon</th><th>Status</th><th>Sent</th><th>Read</th></tr>
        ${history.map((m) => `<tr><td>${esc(m.customer_name || m.customer_id)}</td><td class="code">${esc(m.phone_number)}</td><td class="code">${esc(m.coupon_code || '—')}</td>
          <td>${badge(m.status)} <span class="muted small">${esc(reason(m.error_code))}</span></td><td>${esc(when(m.sent_at))}</td><td>${esc(when(m.read_at))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No birthday messages yet.</td></tr>'}</table></div></div>`;
    $('#bform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        await api('/birthday/settings', { method: 'PUT', body: { enabled: f.enabled === 'on', discountType: f.discountType, discountValue: Number(f.discountValue), validityDays: Number(f.validityDays), couponPrefix: f.couponPrefix.toUpperCase(), minimumOrderAmount: numOrNull(f.minimumOrderAmount), maximumDiscount: numOrNull(f.maximumDiscount), templateName: f.templateName } });
        toast('Birthday settings saved.'); route();
      } catch (err) { $('#berr').textContent = err.message; }
    });
    $('#run').addEventListener('click', async () => {
      try {
        const { result: r } = await api('/birthday/run', { method: 'POST' });
        const why = { DISABLED: 'The campaign is switched off.', OUTSIDE_WINDOW: 'Outside the sending hours.', TEMPLATE_NOT_APPROVED: 'The template is not approved by Meta yet.' }[r.status];
        toast(why || `Found ${r.found}. Queued ${r.queued}. Already handled ${r.alreadyHandled}.`);
        setTimeout(route, 1200);
      } catch (err) { toast(err.message); }
    });
  }

  // ─── simple paged tables ───────────────────────────────────────────────────
  function pagedTable({ title, subtitle, path, filters = '', head, row, empty }) {
    let offset = 0; const limit = 50; let query = '';
    async function load() {
      const data = await api(`${path}?limit=${limit}&offset=${offset}${query}`);
      $('#ptable').innerHTML = `<tr>${head}</tr>` + (data.rows.map(row).join('') || `<tr><td colspan="12" class="muted">${empty}</td></tr>`);
      $('#pinfo').textContent = data.total ? `${offset + 1}–${Math.min(offset + limit, data.total)} of ${num(data.total)}` : '';
      $('#prev').disabled = offset === 0; $('#next').disabled = offset + limit >= (data.total || 0);
    }
    view.innerHTML = `<div class="page-head"><div><h1>${title}</h1><div class="muted">${subtitle}</div></div><form id="pfilters" class="actions">${filters}</form></div>
      <div class="card"><div class="table-wrap"><table id="ptable"></table></div><div class="pager"><span id="pinfo" class="muted small"></span><button class="btn small" id="prev">Previous</button><button class="btn small" id="next">Next</button></div></div>`;
    $('#prev').addEventListener('click', () => { offset = Math.max(0, offset - limit); load(); });
    $('#next').addEventListener('click', () => { offset += limit; load(); });
    $('#pfilters').addEventListener('change', apply); $('#pfilters').addEventListener('submit', (e) => { e.preventDefault(); apply(); });
    function apply() { query = Object.entries(formData($('#pfilters'))).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join(''); offset = 0; load(); }
    return { load };
  }

  const opts = (list) => '<option value="">All statuses</option>' + list.map((s) => `<option>${s}</option>`).join('');

  async function renderCoupons() {
    await pagedTable({
      title: 'Coupons', subtitle: 'Every code is unique. Personal coupons work only for the customer they were issued to.', path: '/coupons',
      filters: `<input name="search" placeholder="Search code" aria-label="Search code"><select name="status" aria-label="Status">${opts(['ACTIVE', 'USED', 'EXPIRED', 'CANCELLED'])}</select>`,
      head: '<th>Code</th><th>Campaign</th><th>Customer</th><th>Discount</th><th>Valid until</th><th>Status</th><th>Used</th>',
      row: (k) => `<tr><td class="code">${esc(k.code)}</td><td>${esc(k.campaign_name)}</td><td class="code">${esc(k.customer_id || 'shared')}</td>
        <td>${k.discount_type === 'PERCENT' ? `${esc(k.discount_value)}%` : inr(k.discount_value)}</td><td>${esc(day(k.valid_until))}</td><td>${badge(k.status)}</td>
        <td>${k.used_count ? `${esc(when(k.used_at))}<div class="muted small code">${esc(k.used_order_id || '')}</div>` : '—'}</td></tr>`,
      empty: 'No coupons yet.',
    }).load();
  }

  async function renderMessages() {
    await pagedTable({
      title: 'Messages', subtitle: 'Every WhatsApp message, with delivery and read status from Meta.', path: '/messages',
      filters: `<select name="type" aria-label="Campaign type"><option value="">All types</option><option value="BIRTHDAY">Birthday</option><option value="FESTIVAL">Festival</option><option value="MONTH_END_TOP10">Top 10</option></select>
        <select name="status" aria-label="Status">${opts(['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED'])}</select>`,
      head: '<th>Customer</th><th>Campaign</th><th>Coupon</th><th>Status</th><th>Sent</th><th>Delivered</th><th>Read</th>',
      row: (m) => `<tr><td>${esc(m.customer_name || m.customer_id)}<div class="muted small code">${esc(m.phone_number)}</div></td><td>${esc(m.campaign_name)}</td><td class="code">${esc(m.coupon_code || '—')}</td>
        <td>${badge(m.status)}<div class="muted small">${esc(reason(m.error_code))}</div></td><td>${esc(when(m.sent_at))}</td><td>${esc(when(m.delivered_at))}</td><td>${esc(when(m.read_at))}</td></tr>`,
      empty: 'No messages yet.',
    }).load();
  }

  async function renderCustomers() {
    const table = pagedTable({
      title: 'Customers', subtitle: 'Read from the store. Only customers with a recorded opt-in and a valid WhatsApp number are ever contacted.', path: '/customers',
      filters: '<input name="search" placeholder="Search name or phone" aria-label="Search">',
      head: '<th>Customer</th><th>WhatsApp</th><th>Birthday</th><th>Marketing</th><th></th>',
      row: (c) => `<tr><td>${esc(c.name || '—')}<div class="muted small code">${esc(c.customerId)}</div></td><td class="code">${esc(c.phoneE164 || c.phone || '—')}</td><td>${esc(c.dob ? c.dob.slice(5) : '—')}</td>
        <td>${c.contactable ? '<span class="badge ok">Eligible</span>' : `<span class="badge">${esc(reason(c.reason))}</span>`}</td>
        <td>${c.optedIn && !c.optedOut ? `<button class="btn small" data-out="${esc(c.customerId)}">Record opt-out</button>` : `<button class="btn small" data-in="${esc(c.customerId)}">Record opt-in</button>`}</td></tr>`,
      empty: 'No customers found.',
    });
    await table.load();
    $('#ptable').addEventListener('click', (e) => {
      const id = e.target.dataset.in || e.target.dataset.out;
      if (!id) return;
      const optedIn = Boolean(e.target.dataset.in);
      if (!optedIn) return save(id, false, 'admin-dashboard');
      modal(`<h2>Record opt-in</h2><p>Only record consent the customer really gave. Where did they agree to WhatsApp offers?</p>
        <form id="oform" class="stack"><label>Source<input name="source" required minlength="2" placeholder="Signed form in store, 19 Sep 2026"></label>
        <div class="actions"><button type="button" class="btn" id="m-no">Cancel</button><button class="btn primary">Record opt-in</button></div></form>`);
      $('#m-no').addEventListener('click', closeModal);
      $('#oform').addEventListener('submit', (ev) => { ev.preventDefault(); closeModal(); save(id, true, formData(ev.target).source); });
    });
    async function save(id, optedIn, source) {
      try { await api(`/customers/${encodeURIComponent(id)}/preference`, { method: 'PUT', body: { optedIn, source } }); toast(optedIn ? 'Opt-in recorded.' : 'Opt-out recorded.'); table.load(); }
      catch (err) { toast(err.message); }
    }
  }

  // ─── settings ──────────────────────────────────────────────────────────────
  async function renderSettings() {
    const { general: g, templates } = await api('/settings');
    const audit = await api('/audit?limit=30');
    view.innerHTML = `
      <div class="page-head"><div><h1>Settings</h1></div></div>
      <div class="grid two">
        <form class="card stack" id="gform"><h2>Sending</h2><div class="fields">
          <label>Daily messaging tier (your WhatsApp account limit)<input name="dailyTierLimit" type="number" min="1" required value="${esc(g.dailyTierLimit)}"></label>
          <label>Estimated cost per message (₹)<input name="perMessageCostInr" type="number" min="0" step="0.01" required value="${esc(g.perMessageCostInr)}"></label>
          <label>Birthday sending starts (hour, India)<input name="sendWindowStartHour" type="number" min="0" max="23" required value="${esc(g.sendWindowStartHour)}"></label>
          <label>Birthday sending ends (hour, India)<input name="sendWindowEndHour" type="number" min="1" max="24" required value="${esc(g.sendWindowEndHour)}"></label></div>
          <label class="row"><input type="checkbox" name="requireDifferentApprover" ${g.requireDifferentApprover ? 'checked' : ''}> Approver must be a different admin from the creator</label>
          <p class="error" id="gerr" role="alert"></p><div><button class="btn primary">Save</button></div></form>
        <div class="card"><h2>WhatsApp templates</h2><p class="muted small">Message text is fixed and approved by Meta. Submit these bodies in WhatsApp Manager under the same names, in the Marketing category. New wording means a new submission. Sending is blocked until a template is approved.</p>
          <div class="actions" style="margin-bottom:10px"><button class="btn small" id="sync">Sync statuses from Meta</button></div>
          ${templates.map((t) => `<div style="margin-bottom:16px"><div class="actions"><b class="code">${esc(t.name)}</b> ${badge(t.approvalStatus)} <span class="muted small">${esc(t.language)}</span>
            <select data-template="${esc(t.name)}" aria-label="Status of ${esc(t.name)}" style="width:auto">${['PENDING', 'APPROVED', 'REJECTED', 'PAUSED'].map((s) => `<option ${s === t.approvalStatus ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
            <div class="bubble" style="margin-top:6px">${esc(t.body)}</div><div class="muted small">Variables: ${t.variables.map((v, i) => `{{${i + 1}}} ${esc(v)}`).join(' · ')}</div></div>`).join('')}</div>
      </div>
      <div class="section card"><h2>Audit log</h2><div class="table-wrap"><table><tr><th>When</th><th>Who</th><th>Action</th><th>On</th></tr>
        ${audit.rows.map((a) => `<tr><td>${esc(when(a.created_at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action.replace(/_/g, ' ').toLowerCase())}</td><td class="muted small">${esc(a.entity)} ${esc(a.entity_id || '')}</td></tr>`).join('')}</table></div></div>`;
    $('#gform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        await api('/settings/general', { method: 'PUT', body: { dailyTierLimit: Number(f.dailyTierLimit), perMessageCostInr: Number(f.perMessageCostInr), sendWindowStartHour: Number(f.sendWindowStartHour), sendWindowEndHour: Number(f.sendWindowEndHour), requireDifferentApprover: f.requireDifferentApprover === 'on' } });
        toast('Settings saved.');
      } catch (err) { $('#gerr').textContent = err.message; }
    });
    view.querySelectorAll('select[data-template]').forEach((sel) => sel.addEventListener('change', async () => {
      try { await api(`/templates/${encodeURIComponent(sel.dataset.template)}/status`, { method: 'PUT', body: { approvalStatus: sel.value } }); toast('Template status recorded.'); route(); } catch (err) { toast(err.message); }
    }));
    $('#sync').addEventListener('click', async () => { try { const r = await api('/templates/sync', { method: 'POST' }); toast(`Synced. ${r.updated} updated.`); route(); } catch (err) { toast(err.message); } });
  }

  start();
})();
