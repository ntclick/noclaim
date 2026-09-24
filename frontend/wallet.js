/**
 * Wallet, network and the small helpers every page here needs.
 *
 * Extracted rather than copied. The chain-switch path in particular took three
 * attempts to get right - MetaMask reports an unrecognised chain with the 4902
 * code nested inside err.data.originalError, adding a network does not reliably
 * select it, and handing createClient an endpoint alongside a provider stops
 * writes being signed by the wallet at all. Two copies of that would mean
 * fixing it twice and forgetting once.
 *
 * Each page owns its own rendering; this module owns the state and hands back
 * what changed.
 */
import { createClient } from 'genlayer-js';
import { studioDevnet } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';

export const RPC = 'https://studio-next.genlayer.com/api';
export const EXPLORER = 'https://explorer-studio-dev.genlayer.com';
export const CHAIN_ID_HEX = '0xf22d'; // 61997
export const ONE_GEN = 10n ** 18n;

const MODE_STORAGE = 'gl_signer_mode';

// Chains a wallet is likely to be sitting on, so a wrong one can be named
// rather than shown as a bare hex id nobody reads.
const KNOWN_CHAINS = {
  '0xf22d': 'GenLayer Studio Next',
  '0xf22f': 'GenLayer StudioNet',
  '0x1': 'Ethereum mainnet',
  '0xaa36a7': 'Sepolia',
  '0x89': 'Polygon',
  '0x38': 'BNB Chain',
  '0x2105': 'Base',
  '0xa4b1': 'Arbitrum One',
};

export const signer = {
  mode: null,      // null = signed out, 'wallet' once connected
  address: null,
  client: null,
  chainId: null,
};

// Reading is not an account action, so it gets its own client and works signed
// out. Browsing is how somebody decides whether to connect at all.
export let readClient = null;

let onChange = () => {};

// --- formatting ------------------------------------------------------

export const $ = (id) => document.getElementById(id);

export function gen(wei, dp = 3) {
  const n = typeof wei === 'bigint' ? wei : BigInt(wei || 0);
  return (Number(n) / Number(ONE_GEN)).toFixed(dp);
}

export function toWei(amount) {
  const [whole, frac = ''] = String(amount).split('.');
  return BigInt(whole || 0) * ONE_GEN + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

export function shorten(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '-';
}

// --- EIP-55 Checksum Address Implementation ---
function keccak256(data) {
  if (typeof data === 'string') data = new TextEncoder().encode(data);
  const state = new BigUint64Array(25);
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
  ];
  const ROTS = [
    0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14
  ];
  const rate = 136;
  const padLen = rate - (data.length % rate);
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let word = 0n;
      for (let b = 0; b < 8; b++) word |= BigInt(padded[offset + i * 8 + b]) << BigInt(b * 8);
      state[i] ^= word;
    }
    for (let round = 0; round < 24; round++) {
      const C = new BigUint64Array(5);
      for (let x = 0; x < 5; x++) C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      const D = new BigUint64Array(5);
      for (let x = 0; x < 5; x++) {
        const left = C[(x + 1) % 5];
        D[x] = C[(x + 4) % 5] ^ ((left << 1n) | (left >> 63n));
      }
      for (let i = 0; i < 25; i++) state[i] ^= D[i % 5];
      const B = new BigUint64Array(25);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const idx = x + 5 * y;
          const r = BigInt(ROTS[idx]);
          const w = state[idx];
          B[y + 5 * ((2 * x + 3 * y) % 5)] = (w << r) | (w >> (64n - r));
        }
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const idx = x + 5 * y;
          state[idx] = B[idx] ^ ((~B[((x + 1) % 5) + 5 * y]) & B[((x + 2) % 5) + 5 * y]);
        }
      }
      state[0] ^= RC[round];
    }
  }

  let hex = '';
  for (let i = 0; i < 4; i++) {
    let w = state[i];
    for (let b = 0; b < 8; b++) hex += (Number((w >> BigInt(b * 8)) & 0xffn)).toString(16).padStart(2, '0');
  }
  return hex;
}

export function toChecksumAddress(address) {
  if (!address || typeof address !== 'string') return address;
  const clean = address.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length !== 40) return address;
  const hash = keccak256(clean);
  let ret = '0x';
  for (let i = 0; i < clean.length; i++) {
    ret += parseInt(hash[i], 16) >= 8 ? clean[i].toUpperCase() : clean[i];
  }
  return ret;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

export function toast(message, kind = 'info') {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 9000 : 5000);
}

/** Contract errors arrive wrapped in transport noise; the useful part is the
 *  message the contract itself raised. */
export function cleanError(e) {
  const raw = String(e?.message || e);
  if (raw.includes('Disconnected') || raw.includes('Page reload required') || raw.includes('write after end')) {
    return 'Wallet extension disconnected. Please reload the page (Ctrl+F5).';
  }
  const m = raw.match(/UserError[^"]*?:?\s*([^"'\\}]{5,200})/);
  if (m) return m[1].trim();
  return raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
}

let busy = false;
export const isBusy = () => busy;

let activeTxStatusCallback = null;

export function updateTxStatus(message, percent = null, state = 'info') {
  if (activeTxStatusCallback) {
    activeTxStatusCallback(message, percent, state);
  }
}

function getOrCreateInlineStatus(btn) {
  if (!btn) return null;
  const parent = btn.parentElement;
  let stat = parent ? parent.querySelector('.inline-status') : null;
  if (!stat) {
    stat = document.createElement('span');
    stat.className = 'inline-status';
    btn.insertAdjacentElement('afterend', stat);
  }
  return stat;
}

function getOrCreateTxPopup() {
  let popup = $('tx-popup');
  if (popup) return popup;
  popup = document.createElement('div');
  popup.id = 'tx-popup';
  popup.className = 'tx-popup';
  popup.hidden = true;
  popup.innerHTML = `
    <div class="tx-popup-card" id="tx-popup-card">
      <div class="tx-popup-header">
        <div class="tx-popup-status-badge" id="tx-popup-badge">
          <span class="tx-spinner small" id="tx-popup-spinner"></span>
          <span id="tx-popup-icon" hidden></span>
        </div>
        <div class="tx-popup-headings">
          <div class="tx-popup-title-row">
            <strong id="tx-popup-title">Transaction in Progress</strong>
            <span id="tx-popup-timer" class="tx-popup-timer">0s</span>
          </div>
          <div id="tx-popup-label" class="tx-popup-label"></div>
        </div>
        <button type="button" id="tx-popup-close" class="tx-popup-close" title="Dismiss" hidden aria-label="Close">&times;</button>
      </div>
      <div class="tx-popup-body">
        <div class="tx-popup-msg-row">
          <span id="tx-popup-msg">Waiting for wallet approval...</span>
        </div>
        <div class="tx-progress-bar">
          <div class="tx-progress-fill" id="tx-progress-fill" style="width: 15%"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(popup);
  const closeBtn = popup.querySelector('#tx-popup-close');
  if (closeBtn) closeBtn.onclick = () => { popup.hidden = true; };
  return popup;
}

/** Runs an action with the buttons disabled, showing inline status next to the button
 *  and a floating progress popup so the user is informed at every step. */
export async function withBusy(label, fn, triggerBtn = null) {
  if (busy) {
    toast('Still waiting on the previous transaction', 'info');
    return;
  }
  busy = true;
  document.body.classList.add('busy');

  const btn = triggerBtn || (document.activeElement instanceof HTMLButtonElement ? document.activeElement : null);
  const inlineEl = btn ? getOrCreateInlineStatus(btn) : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }

  const popup = getOrCreateTxPopup();
  const card = $('tx-popup-card');
  const titleEl = $('tx-popup-title');
  const timerEl = $('tx-popup-timer');
  const labelEl = $('tx-popup-label');
  const msgEl = $('tx-popup-msg');
  const fillEl = $('tx-progress-fill');
  const spinnerEl = $('tx-popup-spinner');
  const iconEl = $('tx-popup-icon');
  const closeBtn = $('tx-popup-close');

  if (card) card.className = 'tx-popup-card';
  if (titleEl) titleEl.textContent = 'Transaction in Progress';
  if (labelEl) labelEl.textContent = label;
  if (msgEl) msgEl.textContent = 'Preparing transaction...';
  if (timerEl) timerEl.textContent = '0s';
  if (fillEl) fillEl.style.width = '15%';
  if (spinnerEl) spinnerEl.hidden = false;
  if (iconEl) iconEl.hidden = true;
  if (closeBtn) closeBtn.hidden = true;
  popup.hidden = false;

  if (inlineEl) {
    inlineEl.className = 'inline-status is-loading';
    inlineEl.innerHTML = `<span class="tx-spinner small"></span> <span class="tx-inline-text">${escapeHtml(label)}...</span>`;
    inlineEl.hidden = false;
  }

  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (timerEl) timerEl.textContent = `${elapsed}s`;
  }, 1000);

  activeTxStatusCallback = (text, percent = null, state = 'info') => {
    if (msgEl) msgEl.textContent = text;
    if (percent !== null && fillEl) fillEl.style.width = `${percent}%`;
    if (inlineEl) {
      const textSpan = inlineEl.querySelector('.tx-inline-text');
      if (textSpan) textSpan.textContent = text;
    }
  };

  try {
    toast(`${label}... this takes about a minute to reach consensus`);
    const result = await fn();

    if (card) card.classList.add('is-success');
    if (titleEl) titleEl.textContent = 'Transaction Confirmed';
    if (msgEl) msgEl.textContent = 'Finalized on GenLayer Studio Next!';
    if (fillEl) fillEl.style.width = '100%';
    if (spinnerEl) spinnerEl.hidden = true;
    if (iconEl) {
      iconEl.textContent = '✓';
      iconEl.hidden = false;
    }
    if (closeBtn) closeBtn.hidden = false;

    if (inlineEl) {
      inlineEl.className = 'inline-status is-success';
      inlineEl.innerHTML = `<span>✓</span> <span class="tx-inline-text">Confirmed!</span>`;
      setTimeout(() => {
        if (!busy) inlineEl.hidden = true;
      }, 4000);
    }

    setTimeout(() => {
      if (!busy) popup.hidden = true;
    }, 4500);

    return result;
  } catch (e) {
    console.error(e);
    const errText = cleanError(e);
    toast(errText, 'error');

    if (card) card.classList.add('is-error');
    if (titleEl) titleEl.textContent = 'Transaction Failed';
    if (msgEl) msgEl.textContent = errText;
    if (spinnerEl) spinnerEl.hidden = true;
    if (iconEl) {
      iconEl.textContent = '!';
      iconEl.hidden = false;
    }
    if (closeBtn) closeBtn.hidden = false;

    if (inlineEl) {
      inlineEl.className = 'inline-status is-error';
      inlineEl.innerHTML = `<span>✕</span> <span class="tx-inline-text">${escapeHtml(errText)}</span>`;
      setTimeout(() => {
        if (!busy) inlineEl.hidden = true;
      }, 7000);
    }

    setTimeout(() => {
      if (!busy) popup.hidden = true;
    }, 8500);
  } finally {
    clearInterval(timerInterval);
    activeTxStatusCallback = null;
    busy = false;
    document.body.classList.remove('busy');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

/**
 * Every call to StudioNet goes through here, one at a time.
 *
 * The node rate-limits: reads get 300 a minute, writes far fewer. When it
 * refuses, it answers 429 *without* CORS headers, so the browser cannot read
 * the response and reports "blocked by CORS policy" instead - which sends you
 * hunting for a CORS bug that does not exist. The give-away is
 * `X-RateLimit-Remaining` in the headers of every successful reply.
 *
 * Retrying naively made this worse: each failure fired three more requests into
 * a bucket that was already empty. So calls are serialised, spaced, and backed
 * off when refused, and the page is told to stop asking rather than to ask
 * harder.
 */
let queue = Promise.resolve();
let backoffUntil = 0;
let rateLimitNotified = 0;

const MIN_GAP_MS = 120;     // never fire two calls back to back
let lastCallAt = 0;

export const isRateLimited = () => Date.now() < backoffUntil;

function looksRateLimited(e) {
  const s = String(e?.message || e).toLowerCase();
  return s.includes('rate limit') || s.includes('429')
    // A 429 with no CORS headers reaches the browser as an opaque network
    // failure, so this shape has to count as rate limiting too.
    || s.includes('failed to fetch') || s.includes('load failed');
}

function noteRateLimit(seconds = 20) {
  backoffUntil = Math.max(backoffUntil, Date.now() + seconds * 1000);
  // Say it once per pause rather than once per call.
  if (Date.now() - rateLimitNotified > 30000) {
    rateLimitNotified = Date.now();
    toast(`StudioNet is rate limiting this page. Pausing for ${seconds}s - the numbers below may be a moment behind.`, 'info');
  }
}

/** Serialises everything onto one lane, with a floor on the gap between calls. */
function enqueue(fn) {
  const run = queue.then(async () => {
    if (isRateLimited()) {
      await new Promise((r) => setTimeout(r, backoffUntil - Date.now()));
    }
    const gap = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastCallAt = Date.now();
    return fn();
  });
  // Keep the lane open even when one call throws.
  queue = run.catch(() => {});
  return run;
}

export async function rpc(method, params, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await enqueue(async () => {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        });
        if (res.status === 429) {
          noteRateLimit(Number(res.headers.get('Retry-After')) || 20);
          throw new Error('rate limited');
        }
        const body = await res.json();
        if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
        return body.result;
      });
    } catch (e) {
      last = e;
      if (looksRateLimited(e)) { noteRateLimit(); break; }
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
}

// --- network ---------------------------------------------------------

export function getProvider() {
  if (window.ethereum?.providers?.length) {
    const mm = window.ethereum.providers.find((p) => p.isMetaMask && !p.isOkxWallet);
    if (mm) return mm;
    return window.ethereum.providers[0];
  }
  return window.ethereum || window.okxwallet || null;
}

/** MetaMask reports "unrecognised chain" in more than one shape: sometimes as
 *  err.code, sometimes buried in err.data.originalError.code. Missing the
 *  nested one means never offering to add the network. */
function isUnknownChainError(err) {
  const codes = [err?.code, err?.data?.originalError?.code, err?.data?.code, err?.cause?.code];
  return codes.includes(4902) || codes.includes(-32603);
}

export async function readChainId() {
  const provider = getProvider();
  if (!provider) return null;
  try {
    return await provider.request({ method: 'eth_chainId' });
  } catch {
    return null;
  }
}

/** Put the wallet on StudioNet, and say plainly whether it worked. Returns a
 *  boolean rather than throwing: a refused switch should leave the wallet
 *  connected and the problem visible, not discard the account just approved. */
export async function ensureStudioChain() {
  const provider = getProvider();
  if (!provider) return false;
  if ((await readChainId()) === CHAIN_ID_HEX) return true;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (!isUnknownChainError(err)) {
      console.error('switch chain failed', err);
      return (await readChainId()) === CHAIN_ID_HEX;
    }
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_ID_HEX,
          chainName: 'GenLayer Studio Next',
          rpcUrls: [RPC],
          nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
          blockExplorerUrls: [EXPLORER],
        }],
      });
      // Adding a network does not reliably select it, so ask again.
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_ID_HEX }],
        });
      } catch { /* verified below */ }
    } catch (addErr) {
      console.error('add chain failed', addErr);
      return false;
    }
  }
  return (await readChainId()) === CHAIN_ID_HEX;
}

export function chainLabel() {
  const id = signer.chainId;
  if (id === CHAIN_ID_HEX) return { name: 'GenLayer Studio Next (61997)', ok: true };
  if (!id) return { name: 'Unknown', ok: false };
  return { name: `${KNOWN_CHAINS[id] || 'Unknown chain'} (${parseInt(id, 16)}) - wrong network`, ok: false };
}

// --- signing in ------------------------------------------------------

export const isSignedIn = () => signer.mode !== null;

/** The proven call shape: chain + account + provider, and no endpoint. Handing
 *  it an HTTP endpoint as well is what stops writes going through the wallet. */
function attachWallet(address, provider) {
  signer.mode = 'wallet';
  signer.address = address;
  signer.client = createClient({ chain: studioDevnet, account: address, provider });
  localStorage.setItem(MODE_STORAGE, 'wallet');
}

function bindProviderEvents(provider) {
  if (provider._glBound) return;
  provider._glBound = true;

  provider.on?.('accountsChanged', async (accs) => {
    if (signer.mode !== 'wallet') return;
    if (!accs || !accs.length) { signOut(); return; }
    attachWallet(accs[0], provider);
    onChange();
    toast(`Switched to ${shorten(accs[0])}`);
  });

  // Reloading on every network change loses whatever the user was doing.
  provider.on?.('chainChanged', async (id) => {
    signer.chainId = id;
    onChange();
  });

  provider.on?.('disconnect', async (err) => {
    console.warn('Wallet disconnected:', err);
    toast('Wallet extension disconnected. Please reload page (Ctrl+F5).', 'error');
    signOut();
  });
}

export async function connectWallet({ silent = false } = {}) {
  const provider = getProvider();
  if (!provider) {
    if (!silent) toast('No wallet found - install MetaMask or another EVM wallet', 'error');
    return false;
  }

  let accounts;
  try {
    accounts = await provider.request({
      method: silent ? 'eth_accounts' : 'eth_requestAccounts',
    });
  } catch (e) {
    console.error('wallet connect rejected', e);
    const msg = String(e?.message || e);
    if (msg.includes('Disconnected') || msg.includes('Page reload required') || msg.includes('write after end')) {
      if (!silent) toast('Wallet extension disconnected. Please reload the page (Ctrl+F5).', 'error');
      return false;
    }
    if (!silent) toast(e?.code === 4001 ? 'Connection cancelled' : cleanError(e), 'error');
    return false;
  }
  if (!accounts || !accounts.length) {
    if (!silent) toast('Your wallet returned no accounts - unlock it and try again', 'error');
    return false;
  }

  // Register the account BEFORE touching the network. Switching chains can fail
  // or be refused, and none of that is a reason to throw away a wallet the user
  // just approved.
  attachWallet(accounts[0], provider);
  bindProviderEvents(provider);

  signer.chainId = await readChainId();
  if (signer.chainId !== CHAIN_ID_HEX) {
    const ok = await ensureStudioChain();
    signer.chainId = await readChainId();
    if (!ok && !silent) {
      toast('Connected, but your wallet is not on Studio Next - use Switch', 'error');
    }
  }

  onChange();
  if (!silent && signer.chainId === CHAIN_ID_HEX) {
    toast(`Connected ${shorten(accounts[0])} on Studio Next`, 'success');
  }
  return true;
}

export function signOut() {
  signer.mode = null;
  signer.address = null;
  signer.client = null;
  signer.chainId = null;
  localStorage.removeItem(MODE_STORAGE);
  onChange();
  toast('Disconnected. Your wallet keeps its keys - nothing of yours was stored here.');
}

/** Sets up the read client and restores a previous session, but only in ways
 *  that need no permission: opening a page must never raise a prompt. */
export async function initWallet({ onAuthChange = () => {} } = {}) {
  onChange = onAuthChange;
  readClient = createClient({ chain: studioDevnet, endpoint: RPC });

  if (localStorage.getItem(MODE_STORAGE) === 'wallet') {
    // MetaMask can inject after this script runs, so give it a moment.
    for (let i = 0; i < 20 && !getProvider(); i++) await new Promise((r) => setTimeout(r, 100));
    if (getProvider()) await connectWallet({ silent: true });
  }
  onChange();
}

// --- contract calls --------------------------------------------------

export function makeContract(address) {
  return {
    address,

    async read(functionName, args = [], tries = 2) {
      let last;
      for (let i = 0; i < tries; i++) {
        try {
          return await enqueue(() =>
            (readClient || signer.client).readContract({ address, functionName, args }));
        } catch (e) {
          last = e;
          // Backing off beats retrying into an empty bucket.
          if (looksRateLimited(e)) { noteRateLimit(); break; }
          await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
        }
      }
      throw last;
    },

    async write(functionName, args = [], value = 0n) {
      // A wallet signs for whatever chain it is on, and a signature against the
      // wrong one fails confusingly rather than loudly.
      const ok = await ensureStudioChain();
      signer.chainId = await readChainId();
      onChange();
      if (!ok) {
        throw new Error('Your wallet is not on GenLayer Studio Next (chain 61997). Switch network and try again.');
      }
      updateTxStatus('Please confirm transaction in your wallet...', 25);
      let hash;
      const fees = {
        distribution: {
          rotations: [0],
          appealRounds: 0,
          totalMessageFees: 0,
          executionConsumed: 0,
          receiptFeeMaxGasPrice: 300000000,
          storageFeeMaxGasPrice: 300000000,
          maxPriceGenPerTimeUnit: 2,
          executionBudgetPerRound: 250000000000000n,
          leaderTimeunitsAllocation: 100,
          validatorTimeunitsAllocation: 200,
        },
        feeValue: 250000000002588n,
      };
      try {
        hash = await enqueue(() =>
          signer.client.writeContract({ address, functionName, args, value, fees }));
      } catch (e) {
        // Writes have their own, much smaller budget. Say what actually
        // happened rather than letting a CORS-shaped error stand.
        if (looksRateLimited(e)) {
          noteRateLimit(30);
          throw new Error('Studio Next is rate limiting transactions right now. Wait about half a minute and try again.');
        }
        throw e;
      }
      updateTxStatus(`Tx submitted (${shorten(hash)}). Waiting for consensus (~30-60s)...`, 60);
      try {
        await signer.client.waitForTransactionReceipt({
          hash, waitUntil: 'finalized', interval: 3000, retries: 60,
        });
      } catch {
        await signer.client.waitForTransactionReceipt({
          hash, status: TransactionStatus.ACCEPTED, interval: 3000, retries: 60,
        });
      }
      updateTxStatus('Consensus reached! Finalizing state...', 90);
      // ACCEPTED does not mean a read will see it yet: reading straight after a
      // write returned pre-transaction state, so a success message appeared over
      // unchanged numbers. Waiting a beat removes that.
      await new Promise((r) => setTimeout(r, 4000));
      updateTxStatus('Transaction complete!', 100);
      return hash;
    },
  };
}
