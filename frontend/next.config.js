/** @type {import('next').NextConfig} */
const backendBaseUrl = process.env.BACKEND_BASE_URL || 'http://localhost:3501'

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  // Disable Next.js built-in gzip — it buffers streaming responses (SSE) before compressing,
  // which prevents real-time event delivery. In production, Caddy handles compression instead.
  compress: false,
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
