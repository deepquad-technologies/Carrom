import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      opacity: { 4: '0.04', 6: '0.06', 8: '0.08', 12: '0.12' },
      colors: {
        ink: { 950: '#07080d', 900: '#0c0e15', 850: '#12151f', 800: '#181c28', 700: '#232838' },
        brass: { 400: '#f2c94c', 600: '#b3862a' },
      },
    },
  },
  plugins: [],
};
export default config;
