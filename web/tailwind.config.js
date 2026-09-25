/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FDFDFD',
        primary: {
          DEFAULT: '#2563EB',
          dark: '#1D4ED8',
          soft: '#EFF4FF',
        },
        accent: '#FF5F57',
        ink: '#3D3D3D',
        muted: '#6B7280',
        line: '#EFEFEF',
        link: '#B42318',
      },
      borderRadius: {
        card: '14px',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(16,24,40,0.04), 0 8px 24px -12px rgba(16,24,40,0.12)',
        pop: '0 4px 12px rgba(16,24,40,0.08), 0 16px 40px -16px rgba(16,24,40,0.18)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
