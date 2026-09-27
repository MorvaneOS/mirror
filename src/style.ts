// The MorvaneOS palette, shared by the homepage and the directory listings.
// Dark by default, light when the browser asks for it.

export const FAVICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100.00 100.00' width='100' height='100' role='img' aria-label='MorvaneOS'><path fill='%23F4A6C6' d='M8 86 L32 30 L50 62 L68 30 L92 86 Z'/></svg>";

export const PALETTE = `:root {
  color-scheme: dark light;
  --bg: #120C16; --text: #F5EEF3; --muted: #B8AEC0; --link: #B9A3E6;
  --button: #F4A6C6; --button-text: #120C16; --code: #1F1626; --line: #3A2D42;
  --logo-peaks: #F4A6C6; --logo-name: #F4A6C6; --logo-accent: #B9A3E6;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #F5EEF3; --text: #120C16; --muted: #5E5064; --link: #8E4570;
    --button: #8E4570; --button-text: #F5EEF3; --code: #EADFE7; --line: #D9C8D4;
    --logo-peaks: #8E4570; --logo-name: #120C16; --logo-accent: #8E4570;
  }
}
* { box-sizing: border-box; }
a { color: var(--link); }
code, pre { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 0.9rem; }`;
