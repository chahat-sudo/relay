import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

const styles = `
@font-face{font-family:DM;src:url('/example/frame-font') format('woff2');font-weight:100 900;font-display:swap}
:root{color-scheme:light;--ink:#173139;--muted:#526a70;--teal:#087b6b;--paper:#f7f6f0;--line:#d8ded7}
*{box-sizing:border-box}body{margin:0;color:var(--ink);font:16px/1.6 DM,system-ui,sans-serif;background:var(--paper)}
::selection{background:#c5e5d7;color:#173139}a{color:inherit;text-underline-offset:5px}a:focus-visible,summary:focus-visible{outline:3px solid #087b6b;outline-offset:5px}button,a{touch-action:manipulation}
.brand{font-size:22px;font-weight:750;letter-spacing:-.03em;text-decoration:none;display:inline-flex;align-items:center;gap:10px}.mark{display:inline-flex;align-items:center;justify-content:center;background:var(--teal);color:white;width:30px;height:30px;border-radius:8px}.mark svg{width:19px;height:19px}
.button{display:inline-flex;align-items:center;justify-content:center;gap:12px;min-height:48px;padding:12px 22px;background:var(--teal);color:white;text-decoration:none;border-radius:7px;font-weight:600;transition:background .18s ease-out}.button:hover{background:#066656}.button svg,.external svg{width:18px;height:18px;flex-shrink:0}
.external{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;text-decoration:none}.external:hover{text-decoration:underline}.muted{color:var(--muted)}
.demo-body{height:100dvh;display:flex;flex-direction:column;background:#eef2f1}.demo-bar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 28px;background:white;border-bottom:1px solid var(--line)}.demo-id{display:flex;align-items:center;gap:20px}.demo-id span{font-size:13px;color:var(--muted);border-left:1px solid var(--line);padding-left:20px}.demo-info{padding:14px 28px;display:flex;align-items:flex-start;justify-content:space-between;gap:24px;font-size:13px}.demo-info p{margin:0;max-width:65ch}.address-list{display:grid;grid-template-columns:auto 1fr;column-gap:14px;row-gap:2px;margin:0;min-width:0}.address-list dt{color:var(--muted)}.address-list dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:12px}.demo-frame{display:block;width:100%;flex:1;min-height:280px;border:0;background:var(--paper)}
.landing{max-width:1200px;margin:auto;padding:0 56px}.landing-nav{height:100px;display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid var(--line)}.landing-nav nav{display:flex;align-items:center;gap:30px;font-size:14px}.landing-nav nav a{text-decoration:none}.landing-nav nav a:hover{text-decoration:underline}.hero{display:grid;grid-template-columns:1.05fr 1fr;gap:72px;align-items:center;padding:76px 0 80px}.hero h1{font-size:clamp(42px,5.1vw,70px);font-weight:600;letter-spacing:-.04em;line-height:1.06;margin:0 0 28px;max-width:10ch;text-wrap:balance}.hero h1 em{font-family:Georgia,serif;font-weight:400;color:var(--teal)}.hero-copy>p{color:var(--muted);max-width:38ch;margin:0 0 30px;font-size:17px}.hero-copy small{display:block;margin-top:16px;font-size:12px;color:var(--muted)}
.notebook-scene{padding:36px 28px;background:#e4ebe3;border-radius:12px;transform:rotate(1.5deg)}.notebook{background:#fffef9;padding:30px 30px 36px;transform:rotate(-3deg);box-shadow:0 18px 36px #17313916;min-height:355px}.notebook-top{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:14px;letter-spacing:.04em}.notebook h2{font:italic 32px/1.2 Georgia,serif;margin:30px 0 20px}.notebook p{font-size:14px;margin:0 0 20px;max-width:32ch}.note-line{display:flex;gap:12px;align-items:center;border-top:1px solid var(--line);padding:13px 0;font-size:13px}.note-box{width:13px;height:13px;border:1px solid #7d9691;flex-shrink:0}.note-line:last-child{color:#526a70}.note-bottom{font-size:10px;color:var(--muted);text-align:right;margin-top:22px}
.inside{border-top:1px solid var(--line);padding:36px 0 44px;display:grid;grid-template-columns:1fr 2fr;gap:50px}.inside h2{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:0}.inside details{border-bottom:1px solid var(--line);padding:0 0 16px;margin:0 0 16px}.inside summary{font-weight:600;cursor:pointer;min-height:32px}.inside details p{margin:10px 0 0;color:var(--muted);font-size:14px;max-width:65ch}.footer{display:flex;justify-content:space-between;gap:16px;padding:22px 0;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.preview{max-width:760px;padding:56px 28px;margin:auto}.preview h1{font-size:clamp(36px,6vw,56px);line-height:1.1;letter-spacing:-.035em;font-weight:600;margin:56px 0 22px}.preview>p{max-width:60ch;color:var(--muted)}.preview .notebook{margin:36px 0;transform:none;min-height:0}.preview-actions{display:flex;gap:24px;align-items:center;flex-wrap:wrap}.preview-footer{font-size:12px;margin-top:40px;color:var(--muted)}
@media(max-width:760px){.landing{padding:0 25px}.landing-nav{height:78px}.landing-nav nav{gap:16px}.hero{gap:36px;padding:45px 0;grid-template-columns:1fr}.hero h1{font-size:54px;max-width:12ch}.hero-copy>p{max-width:44ch}.notebook-scene{max-width:480px;width:100%;justify-self:center}.inside{grid-template-columns:1fr;gap:24px}.demo-bar{padding:12px 16px}.demo-info{padding:12px 16px;flex-direction:column;gap:10px}.demo-id{gap:12px}.demo-id span{padding-left:12px}.demo-bar .external{font-size:12px}.footer{flex-direction:column;gap:4px}}
@media(max-width:420px){.demo-id span{display:none}.landing-nav nav a:first-child{display:none}.landing-nav nav{font-size:13px}.hero h1{font-size:46px}.hero-copy>p{font-size:16px}.notebook-scene{padding:24px 18px}.notebook{padding:25px 22px}.notebook h2{font-size:28px}.address-list{font-size:12px;column-gap:8px}.address-list dd{font-size:11px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;

const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
const external = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 4h6v6m-9 3 9-9M10 4H4v16h16v-6"/></svg>';
const brand = '<a class="brand" href="/example/landing"><span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 5h12v15H6zM9 3v4m6-4v4M9 11h6m-6 4h4"/></svg></span>fieldnote.</a>';

function page(title: string, body: string, className = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${title}</title><style>${styles}</style></head><body class="${className}">${body}</body></html>`;
}

// Deliberately fixed local destinations: this demo cannot frame a caller-supplied URL.
export async function serveIframeDemo(res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/example/frame-font') {
    const font = await readFile(new URL('../node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=3600' }); res.end(font); return true;
  }
  const routes = ['/example/frame', '/example/landing', '/example/landing/preview'];
  if (!routes.includes(url.pathname)) return false;
  const port = url.port ? `:${url.port}` : '';
  const otherHost = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  const destination = `http://${otherHost}${port}/example/landing`;
  const parentOrigins = `http://localhost${port} http://127.0.0.1${port}`;
  // Only the example destination opts into framing, by these two local origins.
  const ancestors = url.pathname === '/example/frame' ? "'none'" : parentOrigins;
  const collecting = url.pathname === '/example/landing' && /^[a-f0-9-]{36}$/.test(url.searchParams.get('relay_request') ?? '');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${collecting ? "'self'" : "'none'"}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-src ${parentOrigins}; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`);
  res.setHeader('Cache-Control', 'no-store');
  let content: string;
  if (url.pathname === '/example/frame') {
    content = page('Relay · Branded iframe example', `
      <header class="demo-bar"><div class="demo-id"><a class="brand" href="/">relay.</a><span>Live iframe example</span></div><a class="external" href="${destination}" target="_blank" rel="noopener noreferrer">Open destination ${external}</a></header>
      <section class="demo-info" aria-label="How this example works"><p><strong>Watch your address bar.</strong> Explore the sample below, then open its notebook. The outer URL stays here while the embedded page navigates.</p><dl class="address-list"><dt>Outer page</dt><dd>${url.origin}/example/frame</dd><dt>Embedded page</dt><dd>${destination}</dd></dl></section>
      <iframe class="demo-frame" src="${destination}" title="Fieldnote sample landing page" sandbox="allow-same-origin"></iframe>
    `, 'demo-body');
  } else if (url.pathname === '/example/landing') {
    content = page('Fieldnote · A home for your next good idea', `<div class="landing">
      <header class="landing-nav">${brand}<nav aria-label="Main navigation"><a href="#inside">What’s inside</a><a href="/example/landing/preview">Open the notebook</a></nav></header>
      <main><section class="hero"><div class="hero-copy"><h1>A home for your next <em>good idea.</em></h1><p>A little less noise. A little more space to think. Meet a simple notebook for the plans, lists, and small things worth keeping.</p><a class="button" href="/example/landing/preview">Explore the notebook ${arrow}</a><small>Interactive sample. No account or purchase required.</small></div>
      <div class="notebook-scene"><article class="notebook" aria-label="Sample notebook page"><div class="notebook-top"><span>FIELDNOTE / PERSONAL</span><span>MONDAY</span></div><h2>Start with a little space.</h2><p>You don’t need the whole plan.<br>Just somewhere to put the first thought.</p><div class="note-line"><span class="note-box" aria-hidden="true"></span>Make something useful</div><div class="note-line"><span class="note-box" aria-hidden="true"></span>Leave room for a better idea</div><div class="note-bottom">A PAGE OF POSSIBILITIES</div></article></div></section>
      <section class="inside" id="inside"><h2>Room for the<br>way you think.</h2><div><details open><summary>Ideas, before they’re ready</summary><p>A blank page for loose thoughts, rough plans, and the sentence you don’t want to forget.</p></details><details><summary>A simple place to begin</summary><p>This fictional notebook is a working landing-page example. Open the notebook to navigate to another page inside the frame.</p></details><details><summary>One page, two ways to view it</summary><p>You can view this page inside Relay’s frame, or use “Open destination” above to see its own URL in a separate browser tab.</p></details></div></section></main>
      <footer class="footer"><span>fieldnote. &nbsp; Make room for what matters.</span><span>Fictional product · Local iframe demonstration</span></footer>
    </div>`);
  } else {
    content = page('Fieldnote · Your sample notebook', `<main class="preview">${brand}<h1>Every good idea<br>starts somewhere.</h1><p>You’ve opened another page inside the iframe. If you came from Relay’s example, the browser’s address bar still shows the outer page.</p><article class="notebook"><div class="notebook-top"><span>YOUR SAMPLE NOTEBOOK</span><span>PAGE 01</span></div><h2>What’s on your mind?</h2><p>One thing I’d like to make space for this week:</p><div class="note-line">A project I keep putting off.</div><div class="note-line">A thought worth coming back to.</div><div class="note-line">A little time without a screen.</div></article><div class="preview-actions"><a class="button" href="/example/landing">Back to the landing page ${arrow}</a></div><p class="preview-footer">Sample content only. No information is collected or saved.</p></main>`);
  }
  if (collecting) content = content.replace('</head>', '<script defer src="/t/collector.js"></script></head>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(content); return true;
}
