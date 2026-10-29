// Hosted-service UI: trial minutes card, /v1/me client, Google sign-in flag, pricing and landing copy.
// Components are rendered to static HTML in Node (no DOM library), so effects do not run here.
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchMe, fmtMinutes, getMe, type FetchLike, type Me } from './lib/api';
import MinutesCard, { MinutesCardView } from './components/MinutesCard';
import Landing from './pages/Landing';

/** Visible text of server-rendered HTML, with React's text separators and tags removed. */
function textOf(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const render = (el: ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

const me = (over: Partial<Me> = {}): Me => ({
  userId: 'u1',
  email: 'a@example.com',
  trialSeconds: 600,
  purchasedSeconds: 0,
  usedSeconds: 150,
  remainingSeconds: 450,
  activeLease: null,
  ...over,
});

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { impl, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('GET /v1/me client', () => {
  it('sends the access token in the Authorization header and never in the URL', async () => {
    const token = 'eyJhbGciOi.secret-token.sig';
    const f = fakeFetch(200, me());
    const client = { auth: { getSession: async () => ({ data: { session: { access_token: token } } }) } };
    const out = await getMe(client, 'https://api.example.com/', { fetchImpl: f.impl });
    expect(out.remainingSeconds).toBe(450);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://api.example.com/v1/me');
    expect(f.calls[0]!.url).not.toContain(token);
    expect(f.calls[0]!.url).not.toContain('?');
    expect(f.calls[0]!.init.method).toBe('GET');
    expect(f.calls[0]!.init.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('does not call the API without a session', async () => {
    const f = fakeFetch(200, me());
    const client = { auth: { getSession: async () => ({ data: { session: null } }) } };
    await expect(getMe(client, 'https://api.example.com', { fetchImpl: f.impl })).rejects.toBeInstanceOf(ApiError);
    expect(f.calls).toHaveLength(0);
  });

  it('turns HTTP and network failures into short messages', async () => {
    const unauth = fakeFetch(401, { error: 'unauthorized', message: 'nope' });
    await expect(fetchMe('https://api.example.com', 't', { fetchImpl: unauth.impl })).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: expect.stringMatching(/sign in again/i),
    });
    const down: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(fetchMe('https://api.example.com', 't', { fetchImpl: down })).rejects.toMatchObject({ code: 'network' });
  });

  it('formats seconds as minutes', () => {
    expect(fmtMinutes(600)).toBe('10 min');
    expect(fmtMinutes(450)).toBe('7 min 30 s');
    expect(fmtMinutes(45)).toBe('45 s');
    expect(fmtMinutes(-5)).toBe('0 s');
  });
});

describe('minutes card', () => {
  const noop = () => {};

  it('is hidden when the hosted API is not configured', () => {
    expect(renderToStaticMarkup(<MinutesCard apiUrl="" />)).toBe('');
  });

  it('shows a loading state', () => {
    expect(textOf(renderToStaticMarkup(<MinutesCardView state={{ status: 'loading' }} onRetry={noop} />))).toContain('Loading your minutes');
  });

  it('shows remaining and used minutes', () => {
    const t = textOf(renderToStaticMarkup(<MinutesCardView state={{ status: 'ready', me: me() }} onRetry={noop} />));
    expect(t).toContain('7 min 30 s left');
    expect(t).toContain('2 min 30 s used of 10 min free trial');
    expect(t).toMatch(/Pausing stops it/);
    expect(t).not.toContain('Live on');
  });

  it('says the trial is used when nothing remains', () => {
    const t = textOf(
      renderToStaticMarkup(<MinutesCardView state={{ status: 'ready', me: me({ usedSeconds: 600, remainingSeconds: 0 }) }} onRetry={noop} />),
    );
    expect(t).toContain('Trial used — paid minutes coming soon');
    expect(t).not.toContain('left');
  });

  it('shows the live device when a lease is active', () => {
    const lease = { id: 'l1', device: 'Work laptop', startedAt: new Date().toISOString() };
    const t = textOf(renderToStaticMarkup(<MinutesCardView state={{ status: 'ready', me: me({ activeLease: lease }) }} onRetry={noop} />));
    expect(t).toMatch(/Live on Work laptop since \S+/);
  });

  it('shows an error with a retry button', () => {
    const html = renderToStaticMarkup(
      <MinutesCardView state={{ status: 'error', message: 'Could not reach the Vkin server.' }} onRetry={noop} />,
    );
    expect(textOf(html)).toContain('Could not reach the Vkin server.');
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
  });
});

describe('config flags', () => {
  it('enables Google only for exactly "1" and normalises the API URL', async () => {
    vi.stubEnv('VITE_GOOGLE_ENABLED', '1');
    vi.stubEnv('VITE_VKIN_API_URL', 'https://vkin-api.example.com/');
    vi.stubEnv('VITE_DOWNLOAD_URL', 'javascript:alert(1)');
    let cfg = await import('./lib/config');
    expect(cfg.googleEnabled).toBe(true);
    expect(cfg.vkinApiUrl).toBe('https://vkin-api.example.com');
    expect(cfg.downloadUrl).toBe('');

    vi.resetModules();
    vi.stubEnv('VITE_GOOGLE_ENABLED', 'true');
    vi.stubEnv('VITE_VKIN_API_URL', '');
    cfg = await import('./lib/config');
    expect(cfg.googleEnabled).toBe(false);
    expect(cfg.vkinApiUrl).toBe('');
  });
});

describe('sign-in page', () => {
  async function renderSignIn(flag: string): Promise<string> {
    vi.resetModules();
    vi.stubEnv('VITE_GOOGLE_ENABLED', flag);
    vi.stubGlobal('window', { location: { hash: '', origin: 'http://localhost:5173' } });
    // Import after stubbing so config reads the flag; auth and SignIn share the fresh module graph.
    const { AuthProvider } = await import('./lib/auth');
    const { default: SignIn } = await import('./pages/SignIn');
    const client = {} as Parameters<typeof AuthProvider>[0]['client']; // effects do not run during static rendering
    return textOf(render(<AuthProvider client={client}><SignIn /></AuthProvider>));
  }

  it('shows "Continue with Google" only when VITE_GOOGLE_ENABLED is 1', async () => {
    const on = await renderSignIn('1');
    expect(on).toContain('Continue with Google');
    expect(on).toContain('Email me a code');

    const off = await renderSignIn('');
    expect(off).not.toContain('Continue with Google');
    expect(off).toContain('Email me a code');
  });
});

describe('landing page', () => {
  const html = render(<Landing downloadHref="" />);
  const text = textOf(html);

  it('has a pricing section with the free trial and a "Coming soon" paid pack, and no other plans', () => {
    const pricing = /id="pricing"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    const p = textOf(pricing);
    expect(p).toContain('Free trial');
    expect(p).toContain('10 minutes of active copilot time per account');
    expect(p).toContain('Pausing stops it');
    expect(p).toContain('Coming soon');
    expect(p).toContain('$10');
    expect(p).toContain('180 minutes');
    expect(p).toContain('no subscription');
    expect(pricing).not.toMatch(/<a |<button/); // nothing to buy yet
    expect(text).not.toMatch(/weekly|per week|\/\s*week|\$50/i);
    expect(html).toContain('href="#pricing"');
  });

  it('describes the hosted service honestly, with no bring-your-own-key text', () => {
    expect(text).not.toMatch(/bring your own|byok|your own (ai )?(provider )?keys/i);
    expect(text).not.toMatch(/end-to-end/i);
    expect(text).toContain('No API keys needed');
    expect(text).toContain('Built with NVIDIA Nemotron on Nebius Token Factory');
    expect(text).toContain('Nemotron 3.5 Lightning');
    expect(text).toContain('Nemotron 3 Ultra');
    expect(text).toContain('Deepgram');
    expect(text).toMatch(/Google Gemini \(free tier\)/);
  });

  it('keeps the placeholder when no download URL is set', () => {
    expect(text).toContain('There is nothing to download yet');
    expect(text).not.toContain('Download for Windows');
  });

  it('links the Windows download with a SmartScreen note when a URL is set', () => {
    const withLink = render(<Landing downloadHref="https://example.com/Vkin-Setup.exe" />);
    expect(withLink).toMatch(/<a[^>]*href="https:\/\/example.com\/Vkin-Setup.exe"[^>]*>Download for Windows<\/a>/);
    const t = textOf(withLink);
    expect(t).toContain('SmartScreen');
    expect(t).toContain('More info');
    expect(t).toContain('Run anyway');
    expect(t).not.toContain('There is nothing to download yet');
  });
});

describe('source copy', () => {
  it('no page or component still claims bring-your-own keys', () => {
    const files = import.meta.glob(['./pages/**/*.tsx', './components/**/*.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >;
    expect(Object.keys(files).length).toBeGreaterThan(5);
    for (const [name, src] of Object.entries(files)) {
      expect(src, name).not.toMatch(/bring your own|byok|own (ai )?(provider )?keys|keys stay on/i);
    }
  });
});
