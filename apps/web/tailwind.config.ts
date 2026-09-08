import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // Tailwind only ships opacities in steps of 5; the panel and border
      // treatments here need finer steps than that.
      opacity: {
        2: '0.02', 3: '0.03', 4: '0.04', 6: '0.06', 7: '0.07', 8: '0.08',
        9: '0.09', 12: '0.12', 14: '0.14', 16: '0.16', 18: '0.18', 22: '0.22',
      },
      colors: {
        // Deep table-felt palette; the board supplies the colour on screen.
        ink: {
          950: 'rgb(var(--c-ink-950) / <alpha-value>)',
          900: 'rgb(var(--c-ink-900) / <alpha-value>)',
          850: 'rgb(var(--c-ink-850) / <alpha-value>)',
          800: 'rgb(var(--c-ink-800) / <alpha-value>)',
          700: 'rgb(var(--c-ink-700) / <alpha-value>)',
          600: 'rgb(var(--c-ink-600) / <alpha-value>)',
          500: 'rgb(var(--c-ink-500) / <alpha-value>)',
        },
        brass: {
          400: 'rgb(var(--c-brass-400) / <alpha-value>)',
          500: 'rgb(var(--c-brass-500) / <alpha-value>)',
          600: 'rgb(var(--c-brass-600) / <alpha-value>)',
        },
        felt: {
          400: 'rgb(var(--c-felt-400) / <alpha-value>)',
          500: 'rgb(var(--c-felt-500) / <alpha-value>)',
        },
        rare: '#4aa8f0',
        epic: '#a78bfa',
        mythic: '#f2618c',
        legendary: '#f2c94c',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 12px 32px -12px rgba(0,0,0,0.7)',
        glow: '0 0 24px -4px var(--tw-shadow-color)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.86)' },
          '70%': { opacity: '1', transform: 'scale(1.04)' },
          '100%': { transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.8' },
          '100%': { transform: 'scale(1.6)', opacity: '0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'coin-flip': {
          '0%': { transform: 'rotateY(0deg)' },
          '100%': { transform: 'rotateY(360deg)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s ease-out both',
        'pop-in': 'pop-in 0.4s cubic-bezier(0.2,0.9,0.3,1.3) both',
        shimmer: 'shimmer 2.4s linear infinite',
        'pulse-ring': 'pulse-ring 1.2s ease-out infinite',
        float: 'float 3s ease-in-out infinite',
        'coin-flip': 'coin-flip 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
