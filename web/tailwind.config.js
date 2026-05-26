/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#141414',
        surface: '#1e1e1e',
        border: '#2a2a2a',
        accent: '#7c5cfc',
        'accent-hover': '#9b7fff',
        fg: '#e5e5e5',
        muted: '#8a8a8a'
      }
    }
  },
  plugins: []
}
