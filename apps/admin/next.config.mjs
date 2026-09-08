/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@carrom/types', '@carrom/config', '@carrom/content'],
};
export default nextConfig;
