/** @type {import('tailwindcss').Config} */
// Colors map directly to §5.2 of the spec. Exposed as CSS variables in
// src/index.css so a light/dark theme can override at runtime.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: 'var(--c-brand-primary)',   // #075E54  dark green
          action: 'var(--c-brand-action)',     // #25D366  light green
          link: 'var(--c-brand-link)',         // #128C7E  teal
        },
        chat: {
          bg: 'var(--c-chat-bg)',              // #ECE5DD  conversation area
          out: 'var(--c-bubble-out)',          // #DCF8C6  outbound bubble
          in: 'var(--c-bubble-in)',            // #FFFFFF  inbound bubble
          list: 'var(--c-list-bg)',            // #F0F2F5  chat list bg
        },
        ink: {
          DEFAULT: 'var(--c-text)',            // #111B21  primary text
          muted: 'var(--c-text-muted)',        // #667781  secondary text
        },
        check: {
          read: 'var(--c-check-read)',         // #53BDEB  read indicator
        },
      },
      fontFamily: {
        sans: ['"Segoe UI"', 'Helvetica', 'Arial', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
