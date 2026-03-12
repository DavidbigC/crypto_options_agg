import { notFound } from 'next/navigation'
import PortfolioPageClient from './PortfolioPageClient'
import { isPortfolioEnabled } from '@/lib/publicRuntime.js'

export default function PortfolioPage() {
  if (!isPortfolioEnabled()) notFound()
  return <PortfolioPageClient />
}
