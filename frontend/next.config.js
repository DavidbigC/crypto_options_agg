/** @type {import('next').NextConfig} */
const backendBaseUrl = process.env.BACKEND_BASE_URL || 'http://localhost:3500'

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${backendBaseUrl}/api/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
