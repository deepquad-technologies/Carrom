/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared packages ship TypeScript source, so Next compiles them itself.
  transpilePackages: [
    '@carrom/types',
    '@carrom/config',
    '@carrom/physics',
    '@carrom/game-engine',
    '@carrom/content',
    '@carrom/ui',
  ],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.fbcdn.net' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
};

export default nextConfig;
