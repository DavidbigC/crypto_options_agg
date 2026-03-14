/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic tokens backed by CSS variables — auto dark mode
        surface: 'rgb(var(--c-bg) / <alpha-value>)',
        card:    'rgb(var(--c-card) / <alpha-value>)',
        muted:   'rgb(var(--c-subtle) / <alpha-value>)',
        rim:     'rgb(var(--c-border) / <alpha-value>)',
        tone:    'rgb(var(--c-accent) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--c-text-1) / <alpha-value>)',
          2: 'rgb(var(--c-text-2) / <alpha-value>)',
          3: 'rgb(var(--c-text-3) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['"Avenir Next"', '"Segoe UI"', '"Helvetica Neue"', 'ui-sans-serif', 'sans-serif'],
        serif: ['Iowan Old Style', 'Palatino', 'Book Antiqua', 'Georgia', 'serif'],
        mono: ['Monaco', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
