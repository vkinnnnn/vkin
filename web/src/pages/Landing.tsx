import { Link } from 'react-router-dom';
import { Brand } from '../components/ui';
import { downloadUrl } from '../lib/config';
import { usePageTitle } from '../lib/hooks';

export default function Landing({ downloadHref = downloadUrl }: { downloadHref?: string } = {}) {
  usePageTitle('The Meeting Copilot');
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="wrap">
          <Brand />
          <nav className="nav" aria-label="Primary">
            <a className="hide-sm" href="#how">How it works</a>
            <a className="hide-sm" href="#different">What is different</a>
            <a href="#pricing">Pricing</a>
            <a className="hide-sm" href="#platforms">Platforms</a>
            <a className="hide-sm" href="#privacy">Privacy</a>
            <a className="hide-sm" href="#download">Download</a>
            <Link className="btn primary" to="/signin">Sign in</Link>
          </nav>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="hero" aria-labelledby="hero-title">
          <div className="wrap">
            <div>
              <p className="eyebrow">Meeting copilot</p>
              <h1 id="hero-title">Vkin <span className="dash">—</span> The Meeting Copilot</h1>
              <p className="sub">Real-time assistance. Personal context. Continuity across meetings.</p>
              <div className="row">
                <Link className="btn primary" to="/signin">Open the web dashboard</Link>
                <a className="btn" href="#how">See how it works</a>
              </div>
              <p className="hint" style={{ marginTop: '1rem' }}>
                Live help runs in the Windows desktop app. The web dashboard is where you prepare, review memory and look back.
                No API keys needed, and every account starts with a free trial.
              </p>
            </div>

            <aside className="structure" aria-labelledby="structure-title">
              <h2 id="structure-title">How your meetings are organized</h2>
              <ol>
                <li style={{ ['--depth' as string]: 0 }}>
                  <strong>Copilot</strong>
                  <span>A workspace: purpose, instructions, answer preferences.</span>
                </li>
                <li style={{ ['--depth' as string]: 1 }}>
                  <strong>Thread</strong>
                  <span>One ongoing relationship, such as one company or one supervisor.</span>
                </li>
                <li style={{ ['--depth' as string]: 2 }}>
                  <strong>Session</strong>
                  <span>A single meeting.</span>
                </li>
                <li style={{ ['--depth' as string]: 3 }}>
                  <strong>Memory you approve</strong>
                  <span>Drafts stay drafts until you approve them.</span>
                </li>
              </ol>
            </aside>
          </div>
        </section>

        <section className="block" id="how" aria-labelledby="how-title">
          <div className="wrap">
            <h2 id="how-title">How it works</h2>
            <p className="lede">A copilot is a context setup, not a retrained model. You decide what it knows and what it keeps.</p>
            <ol className="steps">
              <li>
                <h3>Create a copilot workspace</h3>
                <p>Name it, say what it is for, and set how you like answers to sound.</p>
              </li>
              <li>
                <h3>Prepare documents and instructions</h3>
                <p>Add the background and rules it should work from, and list claims it must never make for you.</p>
              </li>
              <li>
                <h3>Get live help in the Windows desktop app</h3>
                <p>During a meeting the desktop app listens and suggests what to say.</p>
              </li>
              <li>
                <h3>Approve what to remember</h3>
                <p>After a session, review draft memory. Approve, edit or forget each item.</p>
              </li>
              <li>
                <h3>Continue next time</h3>
                <p>The next meeting in the same thread starts from the memory you approved.</p>
              </li>
            </ol>
          </div>
        </section>

        <section className="block alt" id="different" aria-labelledby="diff-title">
          <div className="wrap">
            <h2 id="diff-title">What makes it different</h2>
            <div className="features">
              <article className="card">
                <h3>Grounded answers</h3>
                <p>Answers are checked against your own approved facts, so the copilot is held to what you have actually said is true.</p>
              </article>
              <article className="card">
                <h3>Memory you control</h3>
                <p>Nothing becomes memory until you approve it. You can edit any item, and forgetting one clears its text.</p>
              </article>
              <article className="card">
                <h3>No API keys needed</h3>
                <p>
                  Vkin is a hosted service. Answers run on NVIDIA Nemotron models served by Nebius Token Factory, live transcription is
                  by Deepgram, and screenshot and coding help may use Google Gemini (free tier). There is no AI provider to set up.
                </p>
              </article>
              <article className="card">
                <h3>Transcripts are off by default</h3>
                <p>Full transcripts are only saved if you turn that on, and you can choose it per session.</p>
              </article>
            </div>
          </div>
        </section>

        <section className="block" id="built" aria-labelledby="built-title">
          <div className="wrap">
            <h2 id="built-title">Built with NVIDIA Nemotron on Nebius Token Factory</h2>
            <p className="lede">The models behind live help, and what each one is used for.</p>
            <dl className="stack-list">
              <div>
                <dt>Everyday answers</dt>
                <dd>Nemotron 3.5 Lightning, the fast default model.</dd>
              </div>
              <div>
                <dt>Deeper answer</dt>
                <dd>When you ask for a deeper answer, Vkin uses Nemotron 3 Ultra.</dd>
              </div>
              <div>
                <dt>Live transcription</dt>
                <dd>Deepgram, in English.</dd>
              </div>
              <div>
                <dt>Screenshots and coding help</dt>
                <dd>May use Google Gemini, on its free tier.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="block alt" id="pricing" aria-labelledby="price-title">
          <div className="wrap">
            <h2 id="price-title">Pricing</h2>
            <p className="lede">Start free. Minutes are only used while the copilot is live in a meeting.</p>
            <div className="pricing">
              <article className="card price-card">
                <p className="status"><span className="badge confirmed">Available now</span></p>
                <h3>Free trial</h3>
                <p className="price">10 minutes</p>
                <p>10 minutes of active copilot time per account.</p>
                <p className="muted">
                  Time counts while the copilot is live in the desktop app, including while it is listening. Pausing stops it.
                  Preparing in the web dashboard does not use minutes.
                </p>
              </article>
              <article className="card price-card">
                <p className="status"><span className="badge note">Coming soon</span></p>
                <h3>Minute pack</h3>
                <p className="price">$10 <span className="muted">for 180 minutes</span></p>
                <p>Prepaid, no subscription.</p>
                <p className="muted">Not on sale yet. There is nothing to buy today.</p>
              </article>
            </div>
          </div>
        </section>

        <section className="block" id="platforms" aria-labelledby="plat-title">
          <div className="wrap">
            <h2 id="plat-title">Where it works, honestly</h2>
            <p className="lede">Live meeting help needs access to your computer's audio, which a web page cannot get. That decides what lives where.</p>
            <div className="platforms">
              <article className="card">
                <p className="status"><span className="badge confirmed">Supported</span></p>
                <h3>Windows desktop app</h3>
                <p>Live audio help during meetings. Live transcription is English.</p>
              </article>
              <article className="card">
                <p className="status"><span className="badge confirmed">Supported</span></p>
                <h3>Web dashboard</h3>
                <p>Preparation, memory and history, in desktop and mobile browsers, including phones.</p>
              </article>
              <article className="card">
                <p className="status"><span className="badge note">Not possible</span></p>
                <h3>Live help in a browser</h3>
                <p>A browser cannot capture the audio of other apps' meetings, so live help is not offered on the web.</p>
              </article>
              <article className="card">
                <p className="status"><span className="badge">Not yet validated</span></p>
                <h3>macOS</h3>
                <p>We have not validated a macOS version yet, so we do not claim support.</p>
              </article>
            </div>
          </div>
        </section>

        <section className="block alt" id="privacy" aria-labelledby="priv-title">
          <div className="wrap">
            <h2 id="priv-title">Privacy, in short</h2>
            <ul className="checklist">
              <li>
                During a live session the desktop app sends meeting audio and your prompts to the Vkin server, which passes them to
                Deepgram for transcription and to Nebius (and Google Gemini for screenshots) for answers.
              </li>
              <li>The Vkin server does not store transcripts or prompts. It keeps usage counts to measure your minutes.</li>
              <li>Copilots and memory are stored in your account in Supabase only if you sign in and sync.</li>
              <li>Only memory you have approved is used to answer. Drafts exist so you can edit them.</li>
              <li>Forgetting an item clears its text. Deleting a thread removes its sessions, memory and saved transcript lines.</li>
              <li>Transcripts are not saved to your account unless you turn that on.</li>
              <li>Your private "today's context" note is optional and is only used for small talk.</li>
              <li>You can export everything as a JSON file from your browser, and delete all your data from the dashboard.</li>
              <li>This website has no analytics and no trackers.</li>
            </ul>
          </div>
        </section>

        <section className="block" id="download" aria-labelledby="dl-title">
          <div className="wrap">
            <h2 id="dl-title">Download</h2>
            {downloadHref ? (
              <div className="download-box">
                <p>
                  <a className="btn primary" href={downloadHref} rel="noopener">Download for Windows</a>
                </p>
                <p>Windows only. Sign in inside the app with your Vkin account to use your free trial minutes.</p>
                <p className="muted" style={{ marginBottom: 0 }}>
                  This build is not code-signed yet, so Windows SmartScreen may warn you. Choose <strong>More info</strong>, then{' '}
                  <strong>Run anyway</strong>.
                </p>
              </div>
            ) : (
              <div className="download-box">
                <p><strong>The Windows release candidate link will appear here.</strong></p>
                <p className="muted" style={{ marginBottom: 0 }}>
                  There is nothing to download yet. When the release candidate is published, its link will be added to this section.
                </p>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="wrap">
          <div>
            <p><strong>Vkin — The Meeting Copilot</strong></p>
            <p style={{ marginBottom: 0 }}>Pre-release. Features described here may not all be available yet.</p>
          </div>
          <ul aria-label="Footer">
            <li><a href="#how">How it works</a></li>
            <li><a href="#pricing">Pricing</a></li>
            <li><a href="#privacy">Privacy</a></li>
            <li><Link to="/signin">Sign in</Link></li>
          </ul>
        </div>
      </footer>
    </>
  );
}
